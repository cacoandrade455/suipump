/// suipump::enclave_registry  (V12 -- Nautilus trust-minimization Phase 2)
///
/// THE MISSING PROOF: Phase 1 (Turnkey) put per-session signing keys inside a
/// TEE, but the CHAIN cannot tell an enclave-held key from any other address --
/// users trust SuiPump's word that the key is enclave-born. This module closes
/// that gap using Sui's NATIVE AWS Nitro attestation verifier
/// (sui::nitro_attestation::load_nitro_attestation): the enclave presents its
/// attestation document on-chain, the framework natively verifies the COSE
/// signature chain to the AWS Nitro root and the document freshness, and this
/// module checks the PCR measurements against the admin-registered expected
/// values before approving the enclave's ed25519 key. From then on, the chain
/// itself has verified that ONLY code matching the published measurements holds
/// that key. agent_session::open_and_share_attested requires session_address
/// to be an approved key -- "the signer is enclave-held" becomes a chain-
/// verified fact instead of an operator claim.
///
/// TRUST ANALYSIS:
///   - Admin (AdminCap) can only set WHICH measurements are acceptable. Admin
///     cannot approve an arbitrary key: register_enclave_key is permissionless
///     and gated purely by a valid, PCR-matching attestation.
///   - Reproducible builds are what make the PCRs meaningful: publish the
///     enclave source + build instructions so anyone can reproduce PCR0/1/2.
///   - Key loss (enclaves have no persistent storage) can never lock funds:
///     owner-signed close/revoke/sweep in agent_session are untouched.
///   - PCR rotation (enclave code update) = update_pcrs + re-register keys;
///     existing approved keys remain approved (sessions in flight keep
///     working) unless explicitly revoked via revoke_key.
module suipump::enclave_registry {
    use sui::dynamic_field as df;
    use sui::event;
    use sui::hash;
    use sui::nitro_attestation::{Self, NitroAttestationDocument};
    use suipump::bonding_curve::AdminCap;

    // ---------- Errors ----------
    const EPcrMismatch:        u64 = 1; // attestation PCRs != registered measurements
    const ENoPublicKey:        u64 = 2; // attestation document carries no public key
    const EBadKeyLength:       u64 = 3; // attested key is not 32-byte ed25519
    const EAlreadyRegistered:  u64 = 4; // this key/address already approved
    const ENotRegistered:      u64 = 5; // revoke of an unknown key

    const ED25519_FLAG: u8 = 0;

    // ---------- Registry (shared) ----------
    /// Expected enclave measurements. Approved session addresses are stored as
    /// dynamic fields (address -> attested public key bytes) so the object
    /// scales to any number of keys without table plumbing.
    public struct EnclaveRegistry has key {
        id:   UID,
        pcr0: vector<u8>,
        pcr1: vector<u8>,
        pcr2: vector<u8>,
    }

    // ---------- Events ----------
    public struct RegistryCreated has copy, drop { registry_id: ID }
    public struct PcrsUpdated     has copy, drop { registry_id: ID }
    public struct EnclaveKeyRegistered has copy, drop {
        registry_id:     ID,
        session_address: address,
    }
    public struct EnclaveKeyRevoked has copy, drop {
        registry_id:     ID,
        session_address: address,
    }

    // ---------- Admin: create / rotate measurements ----------
    public fun create_registry(
        _admin: &AdminCap,
        pcr0:   vector<u8>,
        pcr1:   vector<u8>,
        pcr2:   vector<u8>,
        ctx:    &mut TxContext,
    ) {
        let registry = EnclaveRegistry { id: object::new(ctx), pcr0, pcr1, pcr2 };
        event::emit(RegistryCreated { registry_id: object::id(&registry) });
        transfer::share_object(registry);
    }

    public fun update_pcrs(
        _admin:   &AdminCap,
        registry: &mut EnclaveRegistry,
        pcr0:     vector<u8>,
        pcr1:     vector<u8>,
        pcr2:     vector<u8>,
    ) {
        registry.pcr0 = pcr0;
        registry.pcr1 = pcr1;
        registry.pcr2 = pcr2;
        event::emit(PcrsUpdated { registry_id: object::id(registry) });
    }

    /// Admin kill switch for a compromised-measurement scenario. Sessions
    /// already open keep their on-chain caps/expiry/revoke protections; this
    /// only blocks NEW attested opens with that key.
    public fun revoke_key(
        _admin:          &AdminCap,
        registry:        &mut EnclaveRegistry,
        session_address: address,
    ) {
        assert!(df::exists(&registry.id, session_address), ENotRegistered);
        let _: vector<u8> = df::remove(&mut registry.id, session_address);
        event::emit(EnclaveKeyRevoked { registry_id: object::id(registry), session_address });
    }

    // ---------- Permissionless: register an attested key ----------
    /// Anyone may call: the gate is the attestation itself. Sui's verifier
    /// (sui::nitro_attestation::load_nitro_attestation) is an ENTRY function --
    /// callable only as a direct transaction command, never from another
    /// module -- so registration is a two-command PTB:
    ///   1. 0x2::nitro_attestation::load_nitro_attestation(bytes, clock)
    ///      -> natively verifies the COSE signature chain to the AWS Nitro
    ///         root CA and document freshness, returns NitroAttestationDocument
    ///   2. register_enclave_key(registry, doc) -- this function
    /// A NitroAttestationDocument can therefore ONLY exist if step 1's native
    /// verification succeeded; this module checks the PCR measurements and
    /// derives the Sui address of the attested ed25519 public key
    /// (blake2b-256 over flag(0x00) || pubkey -- the wallet-stack derivation).
    public fun register_enclave_key(
        registry: &mut EnclaveRegistry,
        doc:      NitroAttestationDocument,
        _ctx:     &mut TxContext,
    ): address {
        assert_pcrs(registry, &doc);

        let pk_opt = nitro_attestation::public_key(&doc);
        assert!(option::is_some(pk_opt), ENoPublicKey);
        let pk = *option::borrow(pk_opt);
        assert!(vector::length(&pk) == 32, EBadKeyLength);

        let session_address = sui_address_for_ed25519(&pk);
        assert!(!df::exists(&registry.id, session_address), EAlreadyRegistered);
        df::add(&mut registry.id, session_address, pk);

        event::emit(EnclaveKeyRegistered { registry_id: object::id(registry), session_address });
        session_address
    }

    /// Chain-verified test used by agent_session::open_and_share_attested.
    public fun is_registered(registry: &EnclaveRegistry, session_address: address): bool {
        df::exists(&registry.id, session_address)
    }

    // ---------- Internal ----------
    fun assert_pcrs(registry: &EnclaveRegistry, doc: &NitroAttestationDocument) {
        let entries = nitro_attestation::pcrs(doc);
        let mut ok0 = false;
        let mut ok1 = false;
        let mut ok2 = false;
        let mut i = 0;
        let n = vector::length(entries);
        while (i < n) {
            let entry = vector::borrow(entries, i);
            let idx = nitro_attestation::index(entry);
            let val = nitro_attestation::value(entry);
            if (idx == 0) { ok0 = (*val == registry.pcr0); };
            if (idx == 1) { ok1 = (*val == registry.pcr1); };
            if (idx == 2) { ok2 = (*val == registry.pcr2); };
            i = i + 1;
        };
        assert!(ok0 && ok1 && ok2, EPcrMismatch);
    }

    /// Sui address of a raw 32-byte ed25519 public key:
    /// blake2b_256( scheme_flag(0x00) || pubkey_bytes ).
    fun sui_address_for_ed25519(pk: &vector<u8>): address {
        let mut buf = vector[];
        vector::push_back(&mut buf, ED25519_FLAG);
        let mut i = 0;
        while (i < 32) {
            vector::push_back(&mut buf, *vector::borrow(pk, i));
            i = i + 1;
        };
        sui::address::from_bytes(hash::blake2b256(&buf))
    }
}
