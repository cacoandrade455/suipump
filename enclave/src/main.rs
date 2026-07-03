// suipump-session-enclave -- trust-minimization Phase 2 (Nautilus).
//
// A minimal signing enclave for per-user SuiPump agent sessions:
//   1. On boot, generates an ed25519 keypair INSIDE the enclave. The private
//      key exists only in enclave memory -- never written, never exported.
//      (Nitro enclaves have no persistent storage; key loss on restart is by
//      design and can never lock user funds: owner-signed close/revoke/sweep
//      in agent_session are chain-enforced exits.)
//   2. GET /attestation returns the AWS Nitro attestation document with this
//      key's PUBLIC key embedded. Anyone submits it to
//      suipump::enclave_registry::register_enclave_key, where Sui NATIVELY
//      verifies the COSE chain to the AWS root and this module's PCRs are
//      checked on-chain -- after which the chain itself has proven this
//      exact code holds the key.
//   3. POST /sign takes a pre-hashed 32-byte digest (hex) and returns the raw
//      ed25519 signature split as { r, s } -- deliberately the SAME response
//      shape as Turnkey's signRawPayload with HASH_FUNCTION_NOT_APPLICABLE,
//      so the bridge's existing signer plumbing adapts with a URL swap.
//
// Deployment notes:
//   - Real Nitro: enclaves have no NIC; the parent instance proxies vsock <->
//     TCP (socat/vsock-proxy). Marlin Oyster handles this plumbing as a
//     managed service. This binary just listens on TCP.
//   - Build reproducibly (pinned toolchain + locked deps) so published PCR0/1/2
//     match what the EnclaveRegistry pins.
//   - This scaffold intentionally has NO policy engine: trade-level limits
//     (spend cap / expiry / revoke) are enforced ON-CHAIN by agent_session,
//     which is where they belong.

use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

struct Enclave {
    signing_key: SigningKey,
}

#[derive(Deserialize)]
struct SignRequest {
    /// Hex of the 32-byte digest to sign (Sui: blake2b-256 over the intent
    /// message). The enclave signs it AS-IS -- no re-hashing -- matching
    /// Turnkey's HASH_FUNCTION_NOT_APPLICABLE semantics.
    payload: String,
}

#[derive(Serialize)]
struct SignResponse {
    /// First 32 bytes of the ed25519 signature, hex (Turnkey-compatible name).
    r: String,
    /// Last 32 bytes of the ed25519 signature, hex.
    s: String,
}

#[derive(Serialize)]
struct PublicKeyResponse {
    /// Raw 32-byte ed25519 public key, hex. Its Sui address is
    /// blake2b-256(0x00 || pubkey) -- derived by the registry on-chain and by
    /// the bridge's suiAddressForPublicKeyHex off-chain.
    public_key: String,
}

#[derive(Serialize)]
struct AttestationResponse {
    /// The raw Nitro attestation document (CBOR/COSE), hex -- submit verbatim
    /// as the `attestation` argument of register_enclave_key.
    attestation: String,
}

#[tokio::main]
async fn main() {
    // Key is born here, inside the enclave, and lives only in this process.
    let signing_key = SigningKey::generate(&mut OsRng);
    let pk_hex = hex::encode(signing_key.verifying_key().to_bytes());
    println!("[enclave] session signing key generated; public_key={pk_hex}");

    let state = Arc::new(Enclave { signing_key });

    let app = Router::new()
        .route("/health", get(health))
        .route("/public_key", get(public_key))
        .route("/attestation", get(attestation))
        .route("/sign", post(sign))
        .with_state(state);

    let addr = std::env::var("ENCLAVE_LISTEN").unwrap_or_else(|_| "0.0.0.0:7746".to_string());
    println!("[enclave] listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}

async fn health() -> &'static str {
    "ok"
}

async fn public_key(State(state): State<Arc<Enclave>>) -> Json<PublicKeyResponse> {
    Json(PublicKeyResponse {
        public_key: hex::encode(state.signing_key.verifying_key().to_bytes()),
    })
}

async fn sign(
    State(state): State<Arc<Enclave>>,
    Json(req): Json<SignRequest>,
) -> Result<Json<SignResponse>, (StatusCode, String)> {
    let raw = req.payload.trim().trim_start_matches("0x");
    let digest = hex::decode(raw)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("payload is not hex: {e}")))?;
    if digest.len() != 32 {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("payload must be a 32-byte digest, got {} bytes", digest.len()),
        ));
    }
    let sig = state.signing_key.sign(&digest).to_bytes(); // 64 bytes: R || S
    Ok(Json(SignResponse {
        r: hex::encode(&sig[..32]),
        s: hex::encode(&sig[32..]),
    }))
}

/// Nitro attestation with our public key embedded. Compiled in only with
/// --features nsm (requires /dev/nsm, i.e. a real Nitro enclave or Oyster).
#[cfg(feature = "nsm")]
async fn attestation(
    State(state): State<Arc<Enclave>>,
) -> Result<Json<AttestationResponse>, (StatusCode, String)> {
    use aws_nitro_enclaves_nsm_api::api::{Request, Response};
    use aws_nitro_enclaves_nsm_api::driver::{nsm_exit, nsm_init, nsm_process_request};

    let fd = nsm_init();
    if fd < 0 {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "NSM device unavailable (not inside a Nitro enclave?)".to_string(),
        ));
    }
    let req = Request::Attestation {
        user_data: None,
        nonce: None,
        public_key: Some(serde_bytes::ByteBuf::from(
            state.signing_key.verifying_key().to_bytes().to_vec(),
        )),
    };
    let resp = nsm_process_request(fd, req);
    nsm_exit(fd);
    match resp {
        Response::Attestation { document } => Ok(Json(AttestationResponse {
            attestation: hex::encode(document),
        })),
        other => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("unexpected NSM response: {other:?}"),
        )),
    }
}

#[cfg(not(feature = "nsm"))]
async fn attestation(
    State(_state): State<Arc<Enclave>>,
) -> Result<Json<AttestationResponse>, (StatusCode, String)> {
    Err((
        StatusCode::NOT_IMPLEMENTED,
        "built without --features nsm: attestation requires a real Nitro enclave".to_string(),
    ))
}
