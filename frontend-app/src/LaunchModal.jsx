// LaunchModal.jsx - v5 wired
import React, { useState, useCallback } from 'react';
import { useCurrentAccount, useDAppKit, useCurrentClient } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { X, Plus, Trash2, Rocket, CheckCircle } from 'lucide-react';
import wasmInit, * as bytecodeTemplate from '@mysten/move-bytecode-template';
import { PACKAGE_ID, PACKAGE_ID_V5, PACKAGE_ID_V7, MIST_PER_SUI, ANTI_BOT_NONE, ANTI_BOT_15S, ANTI_BOT_30S, GRAD_TARGET_CETUS, GRAD_TARGET_DEEPBOOK, GRAD_TARGET_TURBOS, isV7OrLater, isV9OrLater, isV10OrLater, EPOCH_PKG, EPOCH_TREASURY, EPOCH_CUT_MIST, PROTOCOL_SURCHARGE_MIST, PROTOCOL_WALLET, EPOCH_SIGN_URL, EPOCH_CHECK_URL, EPOCH_SESSION_PROXY, EPOCH_RECOVERY_PROXY, EPOCH_NETWORK } from './constants.js';
import { t } from './i18n.js';
import { executeTx } from './lib/executeTx.js';
import { resolveReferralArg } from './useReferral.js';

// Vesting modes / durations - must match bonding_curve.move v7
const VEST_MODE_CLIFF   = 0;
const VEST_MODE_LINEAR  = 1;
const VEST_MODE_MONTHLY = 2;
const VEST_DURATIONS = {
  '7d':   7   * 24 * 60 * 60 * 1000,
  '30d':  30  * 24 * 60 * 60 * 1000,
  '180d': 180 * 24 * 60 * 60 * 1000,
  '365d': 365 * 24 * 60 * 60 * 1000,
};

const LAUNCH_FEE_MIST = 2_000_000_000n;

// BCS Option<address> none
function bcsOptionNone() { return new Uint8Array([0]); }
const TEMPLATE_URL = '/template.mv';
const MAX_DESCRIPTION_CHARS = 500;

// SUI clock object ID (same on all networks)
const SUI_CLOCK_ID = '0x6';

let wasmReady = false;
async function ensureWasm() {
  if (!wasmReady) { await wasmInit(); wasmReady = true; }
}

function uleb128(n) {
  const bytes = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return bytes;
}

function bcsBytes(str) {
  const buf = new TextEncoder().encode(str);
  const lenBytes = uleb128(buf.length);
  const out = new Uint8Array(lenBytes.length + buf.length);
  out.set(lenBytes, 0);
  out.set(buf, lenBytes.length);
  return out;
}

function bcsVectorAddress(addrs) {
  const out = [addrs.length];
  for (const a of addrs) {
    const hex = a.replace('0x', '').padStart(64, '0');
    for (let i = 0; i < 64; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return new Uint8Array(out);
}

function bcsVectorU64(nums) {
  const buf = new DataView(new ArrayBuffer(1 + nums.length * 8));
  buf.setUint8(0, nums.length);
  nums.forEach((n, i) => buf.setBigUint64(1 + i * 8, BigInt(n), true));
  return new Uint8Array(buf.buffer);
}

function encodeDescription(desc, links) {
  const hasLinks = links.telegram || links.twitter || links.website || links.dex;
  if (!hasLinks) return desc;
  const linksObj = {};
  if (links.telegram) linksObj.telegram = links.telegram.trim();
  if (links.twitter)  linksObj.twitter  = links.twitter.trim();
  if (links.website)  linksObj.website  = links.website.trim();
  if (links.dex)      linksObj.dex      = links.dex;
  return `${desc}||${JSON.stringify(linksObj)}`;
}

// Placeholder constants - must exactly match coin-template/sources/template.move
const PLACEHOLDER_NAME = 'Template Coin';
const PLACEHOLDER_SYM  = 'TMPLSYMBL';
const PLACEHOLDER_DESC = 'Template description placeholder that is intentionally long to accommodate real token descriptions.';
const PLACEHOLDER_ICON = 'https://suipump.test/icon-placeholder.png';

const STEPS = [
  { id: 'details', labelKey: 'details' },
  { id: 'payouts', labelKey: 'payouts' },
  { id: 'devbuy',  labelKey: 'devBuy' },
  { id: 'launch',  labelKey: 'review' },
];

function TokenPreview({ name, symbol, iconUrl }) {
  return (
    <div className="rounded-xl border border-white/[0.09] bg-white/[0.02] p-4">
      <div className="text-[9px] font-mono font-semibold tracking-[0.14em] text-white/[0.35] mb-3">PREVIEW</div>
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-full border-2 border-white/10 flex items-center justify-center bg-lime-950/30 overflow-hidden shrink-0">
          {iconUrl
            ? <img src={iconUrl} alt="icon" className="w-full h-full object-cover" onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='block'; }} />
            : null}
          <span className="text-2xl" style={{ display: iconUrl ? 'none' : 'block' }}>🔥</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-white font-mono truncate">{name || 'Token Name'}</div>
          <div className="text-xs text-sp-glow/70 font-mono font-semibold">${symbol || 'SYMBOL'}</div>
        </div>
        <div className="text-right">
          <div className="text-[9px] font-mono font-semibold tracking-[0.12em] text-white/30">BONDING CURVE</div>
          <div className="text-xs text-white/40 font-mono">0.0%</div>
        </div>
      </div>
      <div className="mt-3 h-1 bg-white/[0.12] rounded-[3px] overflow-hidden">
        <div className="h-full w-0 bg-sp-pump rounded-[3px]" />
      </div>
    </div>
  );
}

export default function LaunchModal({ onClose, onLaunched, lang = 'en' }) {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    name: '', symbol: '', description: '', iconUrl: '',
    uploading: false, uploadError: null,
    telegram: '', twitter: '', website: '',
    graduationDex: 'cetus',
    antiBotDelay: ANTI_BOT_NONE, // 0 / 15 / 30
  });
  const [payouts, setPayouts] = useState([{ address: account?.address ?? '', bps: 10000 }]);
  const [devBuy, setDevBuy] = useState('');
  // Optional dev-buy vesting lock (V7+ only)
  const [lockDevBuy, setLockDevBuy] = useState(false);
  const [lockMode, setLockMode] = useState(VEST_MODE_CLIFF);   // 0 cliff / 1 linear / 2 monthly
  const [lockDuration, setLockDuration] = useState('30d');     // 7d / 30d / 180d / 365d
  // V10 creator buyback (carved from the creator's own 40% fee slice).
  const [buybackEnabled, setBuybackEnabled] = useState(false);
  const [buybackBps,     setBuybackBps]     = useState(2000);  // 0-10000; default 20%
  const [buybackBurn,    setBuybackBurn]    = useState(true);  // true=burn, false=return to creator
  const [launching, setLaunching] = useState(false);
  const [txStep, setTxStep] = useState(null);
  const [tx1Digest, setTx1Digest] = useState(null);
  const [tx2Digest, setTx2Digest] = useState(null);
  const [error, setError] = useState(null);
  const [newCurveId, setNewCurveId] = useState(null);

  // -- Epoch launch-with-site state --------------------------------------------
  // epochSite holds the VERIFIED site once the creator registered through our ref
  // and we confirmed they own the NameCap: { name: 'foo.epoch', nameCap, sessionId }.
  // The 5-SUI surcharge is only added to the launch PTB when epochSite is set.
  const [epochName,      setEpochName]      = useState('');     // .epoch name once verified
  const [epochSite,      setEpochSite]      = useState(null);   // verified site or null
  const [epochVerifying, setEpochVerifying] = useState(false);
  const [epochError,     setEpochError]     = useState('');
  const [epochPending,   setEpochPending]   = useState(null);   // {name, nft, session} for manual retry
  const [epochOpen,      setEpochOpen]      = useState(false);  // inline name-picker revealed

  const symbolValid = /^[A-Z][A-Z0-9]{0,8}$/.test(form.symbol);
  const nameValid = form.name.trim().length >= 2 && form.name.trim().length <= 64;
  const payoutSum = payouts.reduce((s, p) => s + (parseInt(p.bps) || 0), 0);
  const payoutsValid = payouts.length >= 1 && payouts.length <= 10 && payoutSum === 10000
    && payouts.every(p => p.address.startsWith('0x') && p.address.length === 66);

  const canNext = [nameValid && symbolValid, payoutsValid, true, true][step];

  const addPayout = () => {
    if (payouts.length >= 10) return;
    const remaining = 10000 - payouts.slice(0, -1).reduce((s, p) => s + (parseInt(p.bps) || 0), 0);
    setPayouts([...payouts, { address: '', bps: remaining }]);
  };
  const removePayout = (i) => { if (payouts.length > 1) setPayouts(payouts.filter((_, idx) => idx !== i)); };

  // -- Epoch launch-with-site helpers ------------------------------------------

  // The live site URL is deterministic from the name: <name>.epoch always maps
  // to https://<name>.epochsui.com/. Derive it from the verified name rather than
  // trusting the callback's `site` param - so the site autofills reliably even if
  // the redirect ever drops that param. Strips an optional trailing ".epoch".
  const epochSiteUrl = useCallback((rawName) => {
    const label = String(rawName || '').trim().toLowerCase().replace(/\.epoch$/i, '');
    return label ? `https://${label}.epochsui.com/` : null;
  }, []);

  // Handoff: authorize ONE comped registration server-side (proxy holds the
  // secret), then redirect the creator to Epoch's sign page carrying the session.
  // No client-side name check - Epoch validates on its side (public /partner/check
  // is enforced on their sign page) and the contract is the final guard. The
  // desired .epoch name defaults to the token symbol (or name), lowercased and
  // cleaned to Epoch's charset; the creator can change it on Epoch's sign page.
  const startEpochSite = useCallback(async () => {
    setEpochError('');
    if (!account?.address) { setEpochError('Connect your wallet first.'); return; }
    // Derive a sensible default name from what the creator already typed.
    const raw = (form.symbol || form.name || '').toLowerCase();
    const name = raw.replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 63);
    if (!name) { setEpochError('Enter a token name or symbol first.'); return; }
    const sessionId = crypto.randomUUID();
    try { sessionStorage.setItem('epoch_session', sessionId); } catch {}
    // Persist the in-progress launch form so it survives the full-page redirect
    // to Epoch and back. On return, App reopens the modal and we restore this.
    try {
      sessionStorage.setItem('epoch_launch_form', JSON.stringify({
        form, payouts, devBuy, lockDevBuy, lockMode, lockDuration, step,
        savedAt: Date.now(),
      }));
    } catch {}
    try {
      // The return URL is sent in the SERVER-SIDE session call (not the browser
      // redirect), so Epoch takes it from there - the browser can't spoof it.
      const returnUrl = `${window.location.origin}${window.location.pathname}?epoch_return=1`;
      // Server-to-server auth - proxy injects the Bearer secret, never the browser.
      const r = await fetch(EPOCH_SESSION_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionId, network: EPOCH_NETWORK, return_url: returnUrl }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`session ${r.status}`);
      // Redirect carries name + partner + session (no return= - Epoch has it from
      // the session call). The creator can adjust the name on Epoch's sign page.
      const url = `${EPOCH_SIGN_URL}?name=${encodeURIComponent(name)}&partner=suipump&session=${encodeURIComponent(sessionId)}`;
      window.location.href = url; // full redirect; we come back via ?epoch_return=1
    } catch (e) {
      setEpochError('Could not start the landing-page flow. Try again.');
    }
  }, [form, payouts, devBuy, lockDevBuy, lockMode, lockDuration, step, account]);

  // Verify the launching wallet owns the handed-back NameCap before honoring the
  // surcharge. Direct getObject ownership check, with an owned-objects fallback.
  const verifyEpochOwnership = useCallback(async ({ name, nameCapId }) => {
    if (!account?.address) return null;
    const owner = account.address.toLowerCase();
    if (!nameCapId) return null;

    // Verify by OBJECT OWNERSHIP of the exact NameCap Epoch handed back. Epoch
    // told us "this wallet registered, here's the NameCap id" - so confirming
    // that object is owned by the launching wallet IS the proof. No StructType
    // assumption (Epoch's struct name was never confirmed and is irrelevant here).
    //
    // Retry a few times: the register tx may not have propagated to the read
    // node the instant the redirect lands, so a fresh NameCap can briefly read
    // as not-found or not-yet-owned. Short backoff covers finalization lag.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1200));
      try {
        // v2 GraphQL client shape (same as bridge.js): objectId (NOT id), no
        // options, result at obj.object.* (NOT obj.data.*). The JSON-RPC shape
        // { id, options } throws "address is required but not provided".
        const obj = await client.getObject({ objectId: nameCapId });
        const ownerField = obj?.object?.owner;
        // Address-owned objects: owner.AddressOwner. Also tolerate a bare string
        // or an { address } shape across client versions.
        const ownedBy =
          (typeof ownerField === 'string' ? ownerField : null) ??
          ownerField?.AddressOwner ?? ownerField?.address ?? ownerField?.ObjectOwner ?? null;
        if (ownedBy && String(ownedBy).toLowerCase() === owner) {
          return { name, nameCap: nameCapId };
        }
        // eslint-disable-next-line no-console
        console.log('[epoch] verify attempt', attempt, 'owner=', ownedBy, 'want=', owner, 'raw=', ownerField);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log('[epoch] verify getObject error attempt', attempt, e?.message);
      }
    }
    return null;
  }, [account, client]);

  // On return from Epoch (?epoch_return=1): read the redirect params, verify
  // ownership, set epochSite. Recovery fallback if the redirect dropped its data.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('epoch_return') !== '1') return;
    let cancelled = false;

    // Restore the launch form persisted before the redirect, so the creator
    // doesn't come back to an empty modal and lose everything they typed.
    try {
      const saved = sessionStorage.getItem('epoch_launch_form');
      if (saved) {
        const s = JSON.parse(saved);
        if (s.form)         setForm(s.form);
        if (s.payouts)      setPayouts(s.payouts);
        if (s.devBuy != null)       setDevBuy(s.devBuy);
        if (s.lockDevBuy != null)   setLockDevBuy(s.lockDevBuy);
        if (s.lockMode != null)     setLockMode(s.lockMode);
        if (s.lockDuration != null) setLockDuration(s.lockDuration);
        if (s.step != null)         setStep(s.step);
      }
    } catch {}

    (async () => {
      setEpochVerifying(true);
      setEpochError('');
      try {
        let name   = params.get('name');
        let wallet = params.get('wallet');
        let nft    = params.get('nft');
        // New builder flow (Steve, Jun 26): Publish registers the name AND sets
        // the site in one tx, then redirects with status=published plus the live
        // site URL and the Walrus blob id. Old register-only flow used
        // status=registered with no blob/site. Accept both; capture extras.
        const status = params.get('status');     // 'published' (new) | 'registered' (old)
        const blob   = params.get('blob') || null; // Walrus blob id of the built site
        const site   = params.get('site') || null; // live page URL, e.g. https://<name>.epochsui.com
        const session = params.get('session') || (() => { try { return sessionStorage.getItem('epoch_session'); } catch { return null; } })();

        // Recovery: if the redirect didn't carry the registration, ask our proxy.
        if ((!name || !nft) && session) {
          try {
            const r = await fetch(`${EPOCH_RECOVERY_PROXY}?session=${encodeURIComponent(session)}`, { signal: AbortSignal.timeout(8000) });
            if (r.ok) { const d = await r.json(); name = d.name ?? name; wallet = d.wallet ?? wallet; nft = d.name_cap_id ?? d.nameCap ?? nft; }
          } catch {}
        }

        if (!name) { setEpochError('No site found. Try building it again.'); return; }

        // Stash for the manual retry button (the URL gets cleaned below).
        setEpochPending({ name, nft, session, blob, site, status });

        const verified = await verifyEpochOwnership({ name, nameCapId: nft });
        if (cancelled) return;
        if (verified) {
          const liveUrl = epochSiteUrl(verified.name) || site;
          setEpochSite({ name: verified.name, nameCap: verified.nameCap, sessionId: session, blob, site: liveUrl, status });
          setEpochName(verified.name.replace(/\.epoch$/i, ''));
          // Autofill the token's website with the live .epoch page.
          if (liveUrl) setForm(f => ({ ...f, website: liveUrl }));
          setEpochPending(null);
        } else {
          setEpochError('Could not verify your site yet — it may still be settling. Tap Verify to retry.');
        }
      } finally {
        if (!cancelled) {
          setEpochVerifying(false);
          // Clear the persisted form + clean the URL so a refresh doesn't re-run.
          try { sessionStorage.removeItem('epoch_launch_form'); } catch {}
          try {
            const clean = window.location.origin + window.location.pathname;
            window.history.replaceState({}, '', clean);
          } catch {}
        }
      }
    })();
    return () => { cancelled = true; };
  }, [verifyEpochOwnership, epochSiteUrl]);

  // Manual "Verify" retry - if auto-verify missed (finalization lag, etc.), the
  // creator can re-trigger it. Re-fetches the registration via recovery (in case
  // the nft id needs refreshing) then re-runs the ownership check.
  const retryEpochVerify = useCallback(async () => {
    if (!epochPending) return;
    setEpochVerifying(true);
    setEpochError('');
    try {
      let { name, nft, session, blob, site, status } = epochPending;
      // Refresh from recovery in case we never had a good nft id.
      if (session && !nft) {
        try {
          const r = await fetch(`${EPOCH_RECOVERY_PROXY}?session=${encodeURIComponent(session)}`, { signal: AbortSignal.timeout(8000) });
          if (r.ok) { const d = await r.json(); name = d.name ?? name; nft = d.name_cap_id ?? d.nameCap ?? nft; }
        } catch {}
      }
      const verified = await verifyEpochOwnership({ name, nameCapId: nft });
      if (verified) {
        const liveUrl = epochSiteUrl(verified.name) || site;
        setEpochSite({ name: verified.name, nameCap: verified.nameCap, sessionId: session, blob, site: liveUrl, status });
        setEpochName(verified.name.replace(/\.epoch$/i, ''));
        if (liveUrl) setForm(f => ({ ...f, website: liveUrl }));
        setEpochPending(null);
      } else {
        setEpochError('Still settling — wait a few seconds and tap Verify again.');
      }
    } finally {
      setEpochVerifying(false);
    }
  }, [epochPending, verifyEpochOwnership, epochSiteUrl]);

  const updatePayout = (i, field, value) => {
    const next = [...payouts];
    next[i] = { ...next[i], [field]: field === 'bps' ? (parseInt(value) || 0) : value };
    setPayouts(next);
  };

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setForm(f => ({ ...f, uploading: true, uploadError: null }));
    try {
      const fd = new FormData();
      fd.append('image', file);
      const res = await fetch('https://api.imgur.com/3/image', {
        method: 'POST',
        headers: { Authorization: 'Client-ID 546c25a59c58ad7' },
        body: fd,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.data?.error || 'Upload failed');
      setForm(f => ({ ...f, iconUrl: json.data.link, uploading: false }));
    } catch (err) {
      setForm(f => ({ ...f, uploadError: err.message, uploading: false }));
    }
  };

  const handleLaunch = useCallback(async () => {
    if (!account || launching) return;
    setLaunching(true);
    setError(null);
    setTxStep('tx1');

    try {
      await ensureWasm();

      const templateBytes = await fetch(TEMPLATE_URL).then(r => r.arrayBuffer()).then(b => new Uint8Array(b));

      const tokenName = form.name.trim();
      const tokenSymbol = form.symbol.trim().toUpperCase();
      const descWithLinks = encodeDescription(form.description.trim(), {
        telegram: form.telegram, twitter: form.twitter, website: form.website,
        dex: form.graduationDex,
      });

      const safeName = tokenName.slice(0, PLACEHOLDER_NAME.length).padEnd(PLACEHOLDER_NAME.length, ' ');
      const safeSym  = tokenSymbol.slice(0, PLACEHOLDER_SYM.length).padEnd(PLACEHOLDER_SYM.length, ' ');
      const safeDesc = descWithLinks.slice(0, PLACEHOLDER_DESC.length).padEnd(PLACEHOLDER_DESC.length, ' ');
      const safeIcon = (form.iconUrl || '').slice(0, PLACEHOLDER_ICON.length).padEnd(PLACEHOLDER_ICON.length, ' ');

      let patched = bytecodeTemplate.update_constants(templateBytes, bcsBytes(safeName), bcsBytes(PLACEHOLDER_NAME), 'Vector(U8)');
      patched = bytecodeTemplate.update_constants(patched, bcsBytes(safeSym),  bcsBytes(PLACEHOLDER_SYM),  'Vector(U8)');
      patched = bytecodeTemplate.update_constants(patched, bcsBytes(safeDesc), bcsBytes(PLACEHOLDER_DESC), 'Vector(U8)');
      patched = bytecodeTemplate.update_constants(patched, bcsBytes(safeIcon), bcsBytes(PLACEHOLDER_ICON), 'Vector(U8)');

      const tx1 = new Transaction();
      const [upgradeCap] = tx1.publish({ modules: [[...patched]], dependencies: ['0x1', '0x2'] });
      tx1.transferObjects([upgradeCap], account.address);

      const res1raw = await executeTx(dAppKit, null, tx1, account.address);
      if (res1raw.$kind === 'FailedTransaction') throw new Error('Tx1 signing failed: ' + res1raw.FailedTransaction.status.error);
      setTx1Digest(res1raw.Transaction?.digest ?? res1raw.digest ?? '');

      const res1 = await client.waitForTransaction({
        digest: res1raw.Transaction?.digest ?? res1raw.digest,
        include: { objectTypes: true },
      });
      if (res1.$kind === 'FailedTransaction') throw new Error('Tx1 failed: ' + res1.FailedTransaction.status.error);

      // Find TreasuryCap in objectTypes map (objectId -> typeString)
      const objectTypes1 = res1.Transaction.objectTypes ?? {};
      const treasuryCapEntry = Object.entries(objectTypes1).find(([, t]) => t?.includes('TreasuryCap'));
      if (!treasuryCapEntry) throw new Error('TreasuryCap not found in Tx1 output');

      const treasuryCapId = treasuryCapEntry[0];
      const newTokenType = treasuryCapEntry[1].match(/<(.+)>/)?.[1];
      if (!newTokenType) throw new Error('Could not parse token type');

      // Extract CoinMetadata objectId from Tx1 - type includes 'CoinMetadata'
      const metaEntry1 = Object.entries(objectTypes1).find(([, t]) => t?.includes('CoinMetadata'));
      const tx1MetadataId = metaEntry1?.[0] ?? null;

      setTxStep('tx2');

      // Determine graduation target u8
      const graduationTarget = form.graduationDex === 'deepbook'
        ? GRAD_TARGET_DEEPBOOK
        : form.graduationDex === 'turbos'
          ? GRAD_TARGET_TURBOS
          : GRAD_TARGET_CETUS;

      const tx2 = new Transaction();
      const [launchFeeCoin] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(LAUNCH_FEE_MIST)]);

      const payoutAddrs = payouts.map(p => p.address);
      const payoutBps   = payouts.map(p => parseInt(p.bps));

      let curve, cap;

      if (PACKAGE_ID_V5) {
        // V5: create_and_return includes description, graduation_target, anti_bot_delay, clock
        [curve, cap] = tx2.moveCall({
          target: `${PACKAGE_ID}::bonding_curve::create_and_return`,
          typeArguments: [newTokenType],
          arguments: [
            tx2.object(treasuryCapId),
            launchFeeCoin,
            tx2.pure.string(tokenName),
            tx2.pure.string(tokenSymbol),
            tx2.pure.string(descWithLinks),
            tx2.pure(bcsVectorAddress(payoutAddrs)),
            tx2.pure(bcsVectorU64(payoutBps)),
            tx2.pure.u8(graduationTarget),
            tx2.pure.u8(form.antiBotDelay),
            tx2.object(SUI_CLOCK_ID),
          ],
        });
      } else {
        // V4: create_and_return without description/clock/v5 params
        [curve, cap] = tx2.moveCall({
          target: `${PACKAGE_ID}::bonding_curve::create_and_return`,
          typeArguments: [newTokenType],
          arguments: [
            tx2.object(treasuryCapId),
            launchFeeCoin,
            tx2.pure.string(tokenName),
            tx2.pure.string(tokenSymbol),
            tx2.pure(bcsVectorAddress(payoutAddrs)),
            tx2.pure(bcsVectorU64(payoutBps)),
          ],
        });
      }

      const devBuyAmount = parseFloat(devBuy);
      if (devBuyAmount > 0) {
        const devBuyMist = BigInt(Math.floor(devBuyAmount * Number(MIST_PER_SUI)));
        const [devPayment] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(devBuyMist)]);

        // Referral on the launcher's dev-buy: the launcher's own first-touch
        // referrer (or null). Null on any failure or self-referral, so the
        // dev-buy always proceeds with option::none() and never blocks a launch.
        const referralArg = await resolveReferralArg(account?.address);

        let buyArgs;
        if (isV9OrLater(PACKAGE_ID)) {
          // V9+ buy: sui_price_scaled before clock
          // Signature: buy(curve, payment, min_out, referral, sui_price_scaled, clock, ctx)
          buyArgs = [
            curve,
            devPayment,
            tx2.pure.u64(0),
            tx2.pure.option('address', referralArg),
            tx2.pure.u64(0),              // sui_price_scaled = 0 (oracle fallback)
            tx2.object(SUI_CLOCK_ID),
          ];
        } else if (PACKAGE_ID_V5) {
          // V5+ buy: curve, payment, min_tokens_out, referral, clock
          buyArgs = [
            curve,
            devPayment,
            tx2.pure.u64(0),
            tx2.pure.option('address', referralArg),
            tx2.object(SUI_CLOCK_ID),
          ];
        } else {
          buyArgs = [curve, devPayment, tx2.pure.u64(0)];
        }

        const [tokens, refund] = tx2.moveCall({
          target: `${PACKAGE_ID}::bonding_curve::buy`,
          typeArguments: [newTokenType],
          arguments: buyArgs,
        });

        // Optional: route the dev-buy tokens into an immutable VestingLock.
        // V7+ only. lock_tokens(&Curve, Coin<T>, mode, duration_ms, clock).
        // The refund (if any) always goes back to the creator.
        if (lockDevBuy && isV7OrLater(PACKAGE_ID)) {
          const durationMs = VEST_DURATIONS[lockDuration] ?? VEST_DURATIONS['30d'];
          tx2.moveCall({
            target: `${PACKAGE_ID}::bonding_curve::lock_tokens`,
            typeArguments: [newTokenType],
            arguments: [
              curve,
              tokens,
              tx2.pure.u8(lockMode),
              tx2.pure.u64(durationMs),
              tx2.object(SUI_CLOCK_ID),
            ],
          });
          tx2.transferObjects([refund], account.address);
        } else {
          tx2.transferObjects([tokens, refund], account.address);
        }
      }

      // -- Epoch launch-with-site surcharge (only when a site is verified) -----
      // 5 SUI surcharge on top of the 2 SUI base, composed into THIS same tx2 so
      // the user signs once and Epoch's cut is sent automatically inside their
      // own transaction. 3 -> Epoch treasury via record_partner_launch (deposits +
      // emits PartnerLaunch), 2 -> protocol wallet. SuiPump never custodies the 3.
      // If record_partner_launch aborts, the whole launch reverts (atomic).
      if (epochSite && epochSite.name) {
        const [epochCut] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(EPOCH_CUT_MIST)]);
        tx2.moveCall({
          target: `${EPOCH_PKG}::walrus_names::record_partner_launch`,
          arguments: [
            tx2.object(EPOCH_TREASURY),
            tx2.pure.string('suipump'),
            tx2.pure.string(epochSite.name), // e.g. "foo.epoch"
            epochCut,
          ],
        });
        const [protocolCut] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(PROTOCOL_SURCHARGE_MIST)]);
        if (isV10OrLater(PACKAGE_ID)) {
          // V10: route the +2 SUI into the curve's protocol_fees bucket (claimable
          // via AdminCap) instead of a raw wallet transfer. Must run while `curve`
          // is still owned - i.e. before share_curve below.
          tx2.moveCall({
            target: `${PACKAGE_ID}::bonding_curve::collect_protocol_surcharge`,
            typeArguments: [newTokenType],
            arguments: [curve, protocolCut],
          });
        } else {
          // Legacy active package (pre-V10): interim direct transfer to protocol wallet.
          tx2.transferObjects([protocolCut], PROTOCOL_WALLET);
        }
      }

      // -- V10: optional creator buyback config at launch ---------------------
      // If the creator opted in, set the fraction of THEIR fee slice routed to
      // buyback and whether bought tokens are burned or returned. Uses `cap`
      // before it is transferred below. buyback_bps is 0-10000.
      if (isV10OrLater(PACKAGE_ID) && buybackEnabled && buybackBps > 0) {
        tx2.moveCall({
          target: `${PACKAGE_ID}::bonding_curve::set_buyback_config`,
          typeArguments: [newTokenType],
          arguments: [
            cap,
            curve,
            tx2.pure.u64(BigInt(buybackBps)),
            tx2.pure.bool(buybackBurn),
            tx2.object(SUI_CLOCK_ID),
          ],
        });
      }

      tx2.moveCall({ target: `${PACKAGE_ID}::bonding_curve::share_curve`, typeArguments: [newTokenType], arguments: [curve] });
      tx2.transferObjects([cap], account.address);

      const res2raw = await executeTx(dAppKit, null, tx2, account.address);
      if (res2raw.$kind === 'FailedTransaction') throw new Error('Tx2 signing failed: ' + res2raw.FailedTransaction.status.error);
      const res2 = await client.waitForTransaction({
        digest: res2raw.Transaction?.digest ?? res2raw.digest,
        include: { events: true },
      });
      if (res2.$kind === 'FailedTransaction') throw new Error('Tx2 failed: ' + res2.FailedTransaction.status.error);
      setTx2Digest(res2raw.Transaction?.digest ?? res2raw.digest ?? '');

      const curveEvent = res2.Transaction.events?.find(e => e.eventType?.includes('CurveCreated'));
      const curveId = curveEvent?.json?.curve_id;
      setNewCurveId(curveId);

      // POST metadata objectId + ISV to indexer for instant availability
      try {
        const IURL_LM = import.meta.env.VITE_INDEXER_URL || '';
        if (IURL_LM && curveId && tx1MetadataId) {
          // ISV = version from Tx1 objectChanges for the metadata object
          const objChanges1 = res1.Transaction?.objectChanges ?? [];
          const metaChange = objChanges1.find(c => (c.objectId ?? c.id) === tx1MetadataId);
          const metaIsv = metaChange?.version ?? metaChange?.initialSharedVersion ?? null;
          fetch(`${IURL_LM}/internal/store-metadata-isv`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              curveId,
              metadataObjectId: tx1MetadataId,
              initialSharedVersion: metaIsv ? Number(metaIsv) : null,
            }),
          }).catch(() => {});
        }
      } catch {}

      setTxStep('done');
      if (onLaunched) onLaunched({ curveId, tokenType: newTokenType, name: tokenName, symbol: tokenSymbol });
    } catch (err) {
      setError(err.message || String(err));
      setTxStep(null);
    } finally {
      setLaunching(false);
    }
  }, [form, payouts, devBuy, account, client, dAppKit, onLaunched, epochSite]);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-start justify-center bg-black/[0.62] backdrop-blur-sm sm:px-4 sm:pt-9 sm:pb-6">
      <div className="w-full sm:max-w-[620px] rounded-none sm:rounded-[20px] border border-white/[0.12] bg-sp-ink font-mono shadow-[0_50px_120px_rgba(0,0,0,0.8)] max-h-full sm:max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="px-4 sm:px-7 pt-4 sm:pt-6">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[15px] sm:text-[17px] font-extrabold text-white">{t(lang, 'launchATokenTitle')}</div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-semibold text-white/40">STEP {step + 1}/4</span>
              <button onClick={onClose} className="w-8 h-8 -mr-2 flex items-center justify-center text-white/[0.35] hover:text-white transition-colors">
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="text-[10.5px] font-medium text-white/[0.38] mb-4">2 SUI · fair launch · no pre-mine · 1B supply, 800M on the curve</div>

          {/* Step indicator */}
          <div className="flex gap-1.5 mb-3">
            {STEPS.map((s, i) => (
              <div key={s.id} className={`flex-1 h-1 rounded-[3px] transition-colors duration-300 ${
                i <= step ? 'bg-sp-pump' : 'bg-white/[0.12]'
              }`} />
            ))}
          </div>
          <div className="text-[9.5px] font-semibold tracking-[0.16em] text-white/[0.35]">
            {t(lang, STEPS[step].labelKey).toUpperCase()}
          </div>
        </div>

        <div className="px-4 sm:px-7 py-4 sm:py-5 space-y-4 min-h-[320px]">

          {/* Step 0: Token details */}
          {step === 0 && (
            <div className="space-y-4">
              <TokenPreview name={form.name} symbol={form.symbol} iconUrl={form.iconUrl} />

              {/* Icon tile + name / symbol / description */}
              <div className="flex gap-4">
                <label className="w-[92px] h-[92px] shrink-0 border-[1.5px] border-dashed border-lime-400/40 rounded-2xl flex flex-col items-center justify-center gap-1.5 bg-lime-400/[0.04] cursor-pointer overflow-hidden">
                  {form.iconUrl ? (
                    <img src={form.iconUrl} alt="icon" className="w-full h-full object-cover" />
                  ) : form.uploading ? (
                    <span className="text-sp-glow animate-pulse text-lg">…</span>
                  ) : (
                    <>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a3e635" strokeWidth="1.6" strokeLinecap="round"><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" /></svg>
                      <span className="text-[8.5px] font-semibold text-white/40">ICON 512²</span>
                    </>
                  )}
                  <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                </label>
                <div className="flex-1 min-w-0 flex flex-col gap-2.5">
                  <div className="grid grid-cols-[1fr_110px] gap-2.5">
                    <div className="border border-white/[0.12] focus-within:border-lime-400/50 rounded-[11px] px-[13px] py-[11px] transition-colors">
                      <div className="text-[8.5px] font-semibold tracking-[0.12em] text-white/30 mb-1.5">{t(lang, 'tokenName')} *</div>
                      <input
                        value={form.name}
                        onChange={e => setForm({ ...form, name: e.target.value })}
                        placeholder="Moon Coin"
                        className="w-full bg-transparent text-[13px] font-semibold text-white placeholder:text-white/25 focus:outline-none"
                      />
                    </div>
                    <div className={`border rounded-[11px] px-[13px] py-[11px] transition-colors ${
                      form.symbol && !symbolValid ? 'border-sp-dump/50' : 'border-white/[0.12] focus-within:border-lime-400/50'
                    }`}>
                      <div className="text-[8.5px] font-semibold tracking-[0.12em] text-white/30 mb-1.5">{t(lang, 'symbol')} *</div>
                      <input
                        value={form.symbol}
                        onChange={e => setForm({ ...form, symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 9) })}
                        placeholder="MOON"
                        className="w-full bg-transparent text-[13px] font-semibold text-white placeholder:text-white/25 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="border border-white/[0.12] focus-within:border-lime-400/50 rounded-[11px] px-[13px] py-[11px] transition-colors">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-[8.5px] font-semibold tracking-[0.12em] text-white/30">{t(lang, 'description')}</div>
                  <span className={`text-[9px] ${
                    form.description.length > MAX_DESCRIPTION_CHARS * 0.9
                      ? form.description.length >= MAX_DESCRIPTION_CHARS ? 'text-sp-dump' : 'text-sp-glow'
                      : 'text-white/20'
                  }`}>
                    {form.description.length}/{MAX_DESCRIPTION_CHARS}
                  </span>
                </div>
                <textarea
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value.slice(0, MAX_DESCRIPTION_CHARS) })}
                  placeholder={'Describe your token…'}
                  rows={3}
                  className="w-full bg-transparent text-[11.5px] leading-[1.5] text-white/60 placeholder:text-white/25 focus:outline-none resize-none"
                />
              </div>

              {/* Icon URL */}
              <div className="border border-white/[0.12] focus-within:border-lime-400/50 rounded-[11px] px-[13px] py-[11px] transition-colors">
                <div className="text-[8.5px] font-semibold tracking-[0.12em] text-white/30 mb-1.5">{t(lang, 'iconUrl')}</div>
                <input
                  value={form.iconUrl}
                  onChange={e => setForm({ ...form, iconUrl: e.target.value })}
                  placeholder="https://i.imgur.com/..."
                  className="w-full bg-transparent text-[11px] text-white/[0.75] placeholder:text-white/25 focus:outline-none"
                />
                {form.uploadError && (
                  <div className="mt-1 text-[10px] text-sp-dump">{form.uploadError}</div>
                )}
                <div className="mt-1 text-[9px] text-white/20">{t(lang, 'orPasteUrl')}</div>
              </div>

              {/* Graduation DEX toggle */}
              <div className="space-y-2 pt-1">
                <div className="text-[9px] font-semibold tracking-[0.14em] text-white/[0.35]">GRADUATION TARGET</div>
                <div className="grid grid-cols-3 gap-2.5">
                  {[
                    { id: 'cetus',    label: 'Cetus',    sub: 'AMM · deepest liquidity · recommended' },
                    { id: 'deepbook', label: 'DeepBook', sub: 'CLOB · pro order-book flow' },
                    { id: 'turbos',   label: 'Turbos',   sub: 'CLMM · concentrated liquidity' },
                  ].map(({ id, label, sub }) => (
                    <button
                      key={id}
                      onClick={() => setForm(f => ({ ...f, graduationDex: id }))}
                      className={`text-left rounded-xl border px-[13px] py-3 transition-colors ${
                        form.graduationDex === id
                          ? 'border-lime-400/[0.45] bg-lime-400/[0.07]'
                          : 'border-white/[0.12] hover:border-white/25'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`text-xs font-bold ${form.graduationDex === id ? 'text-sp-glow' : 'text-white/70'}`}>{label}</span>
                        {form.graduationDex === id && (
                          <span className="w-3.5 h-3.5 rounded-full bg-sp-pump flex items-center justify-center text-[9px] font-extrabold text-sp-void">✓</span>
                        )}
                      </div>
                      <div className="text-[9.5px] leading-[1.5] text-white/40 mt-1.5">{sub}</div>
                    </button>
                  ))}
                </div>
                {!PACKAGE_ID_V5 && (
                  <div className="text-[8px] text-white/15 text-center">
                    Cetus · DeepBook · Turbos — selection stored on-chain
                  </div>
                )}
              </div>

              {/* Anti-bot delay - v5 only */}
              {PACKAGE_ID_V5 && (
                <div className="space-y-2 pt-1">
                  <div className="text-[9px] font-semibold tracking-[0.14em] text-white/[0.35]">ANTI-BOT COOLDOWN <span className="text-white/20 tracking-normal">· only your wallet can buy during the delay</span></div>
                  <div className="flex gap-1.5">
                    {[
                      { val: ANTI_BOT_NONE, label: 'OFF' },
                      { val: ANTI_BOT_15S,  label: '15s' },
                      { val: ANTI_BOT_30S,  label: '30s' },
                    ].map(({ val, label }) => (
                      <button
                        key={val}
                        onClick={() => setForm(f => ({ ...f, antiBotDelay: val }))}
                        className={`flex-1 text-center py-[9px] rounded-[9px] border text-[10.5px] transition-colors ${
                          form.antiBotDelay === val
                            ? 'border-lime-400/[0.45] bg-lime-400/[0.08] font-bold text-sp-glow'
                            : 'border-white/[0.12] font-semibold text-white/[0.45] hover:text-white/70'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Social links */}
              <div className="space-y-2 pt-1">
                <div className="text-[9px] font-semibold tracking-[0.14em] text-white/[0.35]">SOCIAL LINKS <span className="text-white/20 tracking-normal">· optional</span></div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div className="border border-white/[0.12] focus-within:border-lime-400/50 rounded-[11px] px-[13px] py-2.5 flex items-center gap-2 transition-colors">
                    <span className="text-[10px] font-semibold text-white/[0.35]">X</span>
                    <input
                      value={form.twitter}
                      onChange={e => setForm({ ...form, twitter: e.target.value })}
                      placeholder="https://x.com/yourtoken"
                      className="w-full min-w-0 bg-transparent text-[11px] text-white/[0.75] placeholder:text-white/[0.35] focus:outline-none"
                    />
                  </div>
                  <div className="border border-white/[0.12] focus-within:border-lime-400/50 rounded-[11px] px-[13px] py-2.5 flex items-center gap-2 transition-colors">
                    <span className="text-[10px] font-semibold text-white/[0.35]">TG</span>
                    <input
                      value={form.telegram}
                      onChange={e => setForm({ ...form, telegram: e.target.value })}
                      placeholder="https://t.me/yourtoken"
                      className="w-full min-w-0 bg-transparent text-[11px] text-white/[0.75] placeholder:text-white/[0.35] focus:outline-none"
                    />
                  </div>
                  <div className="border border-white/[0.12] focus-within:border-lime-400/50 rounded-[11px] px-[13px] py-2.5 flex items-center gap-2 transition-colors">
                    <span className="text-[10px] font-semibold text-white/[0.35]">WEB</span>
                    <input
                      value={form.website}
                      onChange={e => setForm({ ...form, website: e.target.value })}
                      placeholder="https://yourtoken.xyz"
                      className="w-full min-w-0 bg-transparent text-[11px] text-white/[0.75] placeholder:text-white/[0.35] focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Epoch site card */}
              <div className="space-y-2 pt-1">
                <div className="text-[9px] font-semibold tracking-[0.14em] text-white/[0.35]">EPOCH SITE <span className="text-white/20 tracking-normal">· launch with a .epoch website in the same tx</span></div>
                <div className="border border-lime-400/[0.35] bg-lime-400/[0.05] rounded-xl px-[15px] py-[13px]">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 sm:gap-3">
                    {epochSite ? (
                      <>
                        <div className="flex-1 min-w-0 flex items-center gap-2 border border-white/[0.14] rounded-[9px] px-3 py-[9px] bg-black/30">
                          <span className="text-xs font-semibold text-white truncate">{epochSite.name.replace(/\.epoch$/i, '')}</span>
                          <span className="text-xs font-semibold text-white/[0.35]">.epoch</span>
                          <span className="ml-auto text-[9px] font-semibold text-sp-glow whitespace-nowrap">attached ✓</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => { setEpochSite(null); setEpochName(''); }}
                          title="Site attached — click to remove"
                          className="h-[34px] px-3.5 rounded-[9px] border border-white/[0.14] text-[10.5px] font-bold text-white/50 hover:text-sp-dump hover:border-sp-dump/40 transition-colors shrink-0"
                        >
                          REMOVE
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={startEpochSite}
                          disabled={epochVerifying}
                          className="h-[34px] w-full sm:w-auto px-3.5 rounded-[9px] bg-sp-pump text-sp-void text-[10.5px] font-bold whitespace-nowrap transition-colors disabled:opacity-40 shrink-0"
                        >
                          {epochVerifying ? 'VERIFYING…' : 'AUTHORIZE & BUILD ↗'}
                        </button>
                        <span className="text-[11px] font-bold text-sp-glow shrink-0">+5 SUI</span>
                      </>
                    )}
                  </div>
                  <div className="text-[9.5px] leading-[1.5] text-white/40 mt-2.5">
                    authorizes a comped session → redirects to <span className="text-white/[0.65]">names.epochsui.com/build</span> → sign your site there → returns here → deploys in your launch PTB · 3 SUI → Epoch treasury · 2 SUI → protocol
                  </div>
                  {epochError && (
                    <div className="flex items-center justify-between gap-2 mt-2">
                      <div className="text-[9px] text-sp-dump">{epochError}</div>
                      {epochPending && !epochSite && (
                        <button
                          type="button"
                          onClick={retryEpochVerify}
                          disabled={epochVerifying}
                          className="shrink-0 px-3 py-1.5 rounded-[7px] border border-lime-400/[0.45] bg-lime-400/[0.08] text-[10px] font-bold text-sp-glow whitespace-nowrap transition-colors disabled:opacity-40"
                        >
                          {epochVerifying ? 'VERIFYING…' : 'VERIFY'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Payouts */}
          {step === 1 && (
            <div className="space-y-3">
              <div className="text-[9px] font-semibold tracking-[0.14em] text-white/[0.35]">FEE RECIPIENTS <span className="text-white/20 tracking-normal">· up to 10 · bps must sum to 10000</span></div>
              {payouts.map((p, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <div className="flex-1 space-y-1.5">
                    <div className={`border rounded-[11px] px-[13px] py-2.5 transition-colors ${
                      p.address && (!p.address.startsWith('0x') || p.address.length !== 66)
                        ? 'border-sp-dump/40' : 'border-white/[0.12] focus-within:border-lime-400/50'
                    }`}>
                      <input
                        value={p.address}
                        onChange={e => updatePayout(i, 'address', e.target.value)}
                        placeholder="0x…"
                        className="w-full bg-transparent text-xs text-white placeholder:text-white/25 focus:outline-none"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-28 border border-white/[0.12] focus-within:border-lime-400/50 rounded-[9px] px-[13px] py-2 transition-colors">
                        <input
                          type="number"
                          value={p.bps}
                          onChange={e => updatePayout(i, 'bps', e.target.value)}
                          min={1} max={10000}
                          className="w-full bg-transparent text-xs text-white focus:outline-none"
                        />
                      </div>
                      <span className="text-[10px] text-white/30">bps = {((parseInt(p.bps)||0)/100).toFixed(2)}%</span>
                    </div>
                  </div>
                  {payouts.length > 1 && (
                    <button onClick={() => removePayout(i)} className="mt-2 text-white/20 hover:text-sp-dump transition-colors">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
              <div className={`text-[10px] ${payoutSum === 10000 ? 'text-sp-glow' : 'text-sp-dump'}`}>
                Total: {payoutSum} / 10000 bps ({(payoutSum/100).toFixed(2)}%)
              </div>
              {payouts.length < 10 && (
                <button
                  onClick={addPayout}
                  className="flex items-center gap-1.5 text-[10px] font-semibold text-white/30 hover:text-sp-glow transition-colors"
                >
                  <Plus size={12} /> {t(lang, 'addPayout')}
                </button>
              )}
            </div>
          )}

          {/* Step 2: Dev buy */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <div className="text-[9px] font-semibold tracking-[0.14em] text-white/[0.35] mb-2">{t(lang, 'devBuyAmount')} <span className="text-white/20 tracking-normal">· same tx, before anyone</span></div>
                <div className="flex items-center border border-white/[0.12] focus-within:border-lime-400/50 rounded-[9px] px-[13px] py-[9px] transition-colors">
                  <input
                    type="number"
                    value={devBuy}
                    onChange={e => setDevBuy(e.target.value)}
                    placeholder="0"
                    min="0"
                    step="0.1"
                    className="w-full min-w-0 bg-transparent text-xs font-bold text-white placeholder:text-white/25 focus:outline-none"
                  />
                  <span className="ml-auto pl-2 text-[10px] font-semibold text-white/40">SUI</span>
                </div>
                <div className="mt-1.5 text-[9px] text-white/20">{t(lang, 'devBuyHint')}</div>
              </div>
              {parseFloat(devBuy) > 5 && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 p-3 text-[10px] text-sp-creator">
                  {t(lang, 'devBuyWarning')}
                </div>
              )}

              {/* Optional dev-buy vesting lock - V7+ only */}
              {parseFloat(devBuy) > 0 && isV7OrLater(PACKAGE_ID) && (
                <div className="space-y-2">
                  <div className="text-[9px] font-semibold tracking-[0.14em] text-white/[0.35]">LOCK DEV BUY <span className="text-white/20 tracking-normal">· immutable on-chain vesting · signal you can't dump</span></div>
                  <div className="border border-amber-500/30 bg-amber-500/[0.03] rounded-xl px-[15px] py-3 space-y-3">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={lockDevBuy}
                        onChange={e => setLockDevBuy(e.target.checked)}
                        className="sr-only"
                      />
                      <span className={`relative w-[34px] h-5 rounded-[20px] transition-colors shrink-0 ${lockDevBuy ? 'bg-sp-creator' : 'bg-white/[0.12]'}`}>
                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-sp-void transition-all ${lockDevBuy ? 'left-4' : 'left-0.5'}`} />
                      </span>
                      <span className={`text-[10.5px] font-semibold ${lockDevBuy ? 'text-sp-creator' : 'text-white/[0.75]'}`}>
                        Lock my dev-buy tokens (anti-rug)
                      </span>
                      <span className="ml-auto text-[9px] leading-[1.4] text-white/30 text-right">terms immutable<br />once set</span>
                    </label>

                    {lockDevBuy && (
                      <div className="space-y-3 pt-1">
                        {/* Mode */}
                        <div className="flex flex-wrap items-center gap-1.5">
                          {[
                            { v: VEST_MODE_CLIFF,   label: 'CLIFF' },
                            { v: VEST_MODE_LINEAR,  label: 'LINEAR' },
                            { v: VEST_MODE_MONTHLY, label: 'MONTHLY' },
                          ].map(({ v, label }) => {
                            // Monthly requires >= 30d
                            const disabled = v === VEST_MODE_MONTHLY && lockDuration === '7d';
                            return (
                              <button
                                key={v}
                                disabled={disabled}
                                onClick={() => setLockMode(v)}
                                className={`px-[9px] py-1.5 rounded-[7px] border text-[9.5px] transition-colors ${
                                  disabled
                                    ? 'border-white/[0.08] font-semibold text-white/15 cursor-not-allowed'
                                    : lockMode === v
                                      ? 'border-amber-500/[0.45] bg-amber-500/[0.08] font-bold text-sp-creator'
                                      : 'border-white/[0.12] font-semibold text-white/40 hover:text-white/70'
                                }`}
                              >
                                {label}
                              </button>
                            );
                          })}
                          <span className="w-px h-4 bg-white/[0.12] mx-1" />
                          {/* Duration */}
                          {['7d', '30d', '180d', '365d'].map(d => (
                            <button
                              key={d}
                              onClick={() => {
                                setLockDuration(d);
                                // Monthly is invalid for 7d - fall back to cliff
                                if (d === '7d' && lockMode === VEST_MODE_MONTHLY) {
                                  setLockMode(VEST_MODE_CLIFF);
                                }
                              }}
                              className={`px-[9px] py-1.5 rounded-[7px] border text-[9.5px] transition-colors ${
                                lockDuration === d
                                  ? 'border-amber-500/[0.45] bg-amber-500/[0.08] font-bold text-sp-creator'
                                  : 'border-white/[0.12] font-semibold text-white/40 hover:text-white/70'
                              }`}
                            >
                              {d}
                            </button>
                          ))}
                        </div>
                        <p className="text-[9px] text-sp-creator/70 leading-relaxed">
                          {lockMode === VEST_MODE_CLIFF   && `100% unlocks at the end of ${lockDuration}.`}
                          {lockMode === VEST_MODE_LINEAR  && `Tokens unlock continuously over ${lockDuration}.`}
                          {lockMode === VEST_MODE_MONTHLY && `Tokens unlock in equal monthly steps over ${lockDuration}.`}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* V10: creator buyback config - carved from the creator's own fee slice */}
              {isV10OrLater(PACKAGE_ID) && (
                <div className="space-y-2">
                  <div className="text-[9px] font-semibold tracking-[0.14em] text-white/[0.35]">CREATOR SETTINGS</div>
                  <div className="border border-amber-500/30 bg-amber-500/[0.04] rounded-xl p-[13px] space-y-3">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={buybackEnabled}
                        onChange={e => setBuybackEnabled(e.target.checked)}
                        className="sr-only"
                      />
                      <span className={`relative w-[34px] h-5 rounded-[20px] transition-colors shrink-0 ${buybackEnabled ? 'bg-sp-creator' : 'bg-white/[0.12]'}`}>
                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-sp-void transition-all ${buybackEnabled ? 'left-4' : 'left-0.5'}`} />
                      </span>
                      <span className={`text-[10.5px] font-semibold ${buybackEnabled ? 'text-sp-creator' : 'text-white/[0.75]'}`}>
                        on-chain auto buyback
                      </span>
                      {buybackEnabled && (
                        <span className="ml-auto text-[13px] font-extrabold text-sp-creator">{(buybackBps / 100).toFixed(0)}%</span>
                      )}
                    </label>
                    <p className="text-[9px] text-white/[0.35] leading-[1.4]">
                      A slice of YOUR creator fees (not the total fee) is set aside on
                      every trade. You trigger the buyback later; bought tokens are
                      burned or returned to you. Does not change the 1% trade fee.
                    </p>

                    {buybackEnabled && (
                      <div className="space-y-3 pt-1">
                        <div>
                          <div className="flex justify-between text-[9px] font-semibold tracking-[0.1em] text-white/[0.35] mb-1.5">
                            <span>BUYBACK % OF CREATOR FEES</span>
                            <span className="text-sp-creator">{(buybackBps / 100).toFixed(0)}%</span>
                          </div>
                          <input
                            type="range" min={0} max={10000} step={500}
                            value={buybackBps}
                            onChange={e => setBuybackBps(parseInt(e.target.value, 10))}
                            className="w-full accent-[#f59e0b]"
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[9px] font-semibold tracking-[0.1em] text-white/[0.35]">TOKENS GO TO:</span>
                          <button
                            onClick={() => setBuybackBurn(true)}
                            className={`px-2.5 py-1.5 rounded-[7px] border text-[9.5px] transition-colors ${buybackBurn ? 'border-amber-500/50 bg-amber-500/10 font-bold text-sp-creator' : 'border-white/[0.12] font-semibold text-white/40 hover:text-white/70'}`}>
                            BURN
                          </button>
                          <button
                            onClick={() => setBuybackBurn(false)}
                            className={`px-2.5 py-1.5 rounded-[7px] border text-[9.5px] transition-colors ${!buybackBurn ? 'border-amber-500/50 bg-amber-500/10 font-bold text-sp-creator' : 'border-white/[0.12] font-semibold text-white/40 hover:text-white/70'}`}>
                            RETURN TO WALLET
                          </button>
                          <span className="ml-auto text-[9px] leading-[1.4] text-white/[0.35]">burn destroys supply · return sends tokens to you</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-white/[0.09] bg-white/[0.02] px-[15px] py-[13px] space-y-[7px]">
                <div className="flex justify-between text-[10.5px] font-medium">
                  <span className="text-white/40">{t(lang, 'launchFee')}</span>
                  <span className="text-white/[0.75]">2.0 SUI</span>
                </div>
                {parseFloat(devBuy) > 0 && (
                  <div className="flex justify-between text-[10.5px] font-medium">
                    <span className="text-white/40">{t(lang, 'devBuyAmount')}</span>
                    <span className="text-white/[0.75]">{parseFloat(devBuy).toFixed(2)} SUI</span>
                  </div>
                )}
                {epochSite && (
                  <div className="flex justify-between text-[10.5px] font-medium">
                    <span className="text-white/40">epoch site (3 epoch · 2 protocol) · {epochSite.name}</span>
                    <span className="text-white/[0.75]">5.0 SUI</span>
                  </div>
                )}
                {isV10OrLater(PACKAGE_ID) && buybackEnabled && buybackBps > 0 && (
                  <div className="flex justify-between text-[10.5px] font-medium">
                    <span className="text-white/40">creator buyback</span>
                    <span className="text-sp-creator">{(buybackBps / 100).toFixed(0)}% · {buybackBurn ? 'burn' : 'return'}</span>
                  </div>
                )}
                <div className="border-t border-white/[0.08] pt-[9px] flex justify-between text-[11.5px] font-bold">
                  <span className="text-white/60">{t(lang, 'total')}</span>
                  <span className="text-white">{(2 + (parseFloat(devBuy) || 0) + (epochSite ? 5 : 0)).toFixed(2)} SUI + gas</span>
                </div>
              </div>
              <div className="text-[9px] text-white/25 text-center">{t(lang, 'twoSignaturesRequired')}</div>
            </div>
          )}

          {/* Step 3: Review / launch */}
          {step === 3 && (
            <div className="space-y-4">
              {!txStep && !error && (
                <>
                  <TokenPreview name={form.name} symbol={form.symbol} iconUrl={form.iconUrl} />
                  <div className="rounded-xl border border-white/[0.09] bg-white/[0.02] px-[15px] py-[13px] space-y-[7px] text-[10.5px] font-medium">
                    <div className="flex justify-between">
                      <span className="text-white/40">Name</span>
                      <span className="text-white/[0.75]">{form.name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-white/40">Symbol</span>
                      <span className="text-sp-glow">${form.symbol}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-white/40">Graduates to</span>
                      <span className="text-white/[0.75] capitalize">{form.graduationDex}</span>
                    </div>
                    {PACKAGE_ID_V5 && (
                      <div className="flex justify-between">
                        <span className="text-white/40">Anti-bot delay</span>
                        <span className="text-white/[0.75]">{form.antiBotDelay === 0 ? 'None' : `${form.antiBotDelay}s`}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-white/40">Recipients</span>
                      <span className="text-white/[0.75]">{payouts.length}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-white/40">Dev buy</span>
                      <span className="text-white/[0.75]">{parseFloat(devBuy) > 0 ? `${parseFloat(devBuy)} SUI` : 'none'}</span>
                    </div>
                    {epochSite && (
                      <div className="flex justify-between">
                        <span className="text-white/40">Token page</span>
                        <span className="text-white/[0.75]">{epochSite.name} · 5 SUI</span>
                      </div>
                    )}
                    <div className="border-t border-white/[0.08] pt-[9px] flex justify-between text-[11.5px] font-bold">
                      <span className="text-white/60">{t(lang, 'total')}</span>
                      <span className="text-white">{(2 + (parseFloat(devBuy) || 0) + (epochSite ? 5 : 0)).toFixed(2)} SUI + gas</span>
                    </div>
                  </div>
                </>
              )}

              {txStep === 'tx1' && (
                <div className="space-y-4 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full border-2 border-sp-pump border-t-transparent animate-spin" />
                    <div>
                      <div className="text-sm text-white font-bold">{t(lang, 'publishing')}</div>
                      <div className="text-[10px] text-white/30">{t(lang, 'approveInWallet')} — Tx 1 {t(lang, 'of')} 2</div>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <div className="flex-1 h-1 bg-sp-pump/60 rounded-[3px] animate-pulse" />
                    <div className="flex-1 h-1 bg-white/[0.12] rounded-[3px]" />
                  </div>
                </div>
              )}

              {txStep === 'tx2' && (
                <div className="space-y-4 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full border-2 border-sp-pump border-t-transparent animate-spin" />
                    <div>
                      <div className="text-sm text-white font-bold">{t(lang, 'creating')}</div>
                      <div className="text-[10px] text-white/30">{t(lang, 'approveInWallet')} — Tx 2 {t(lang, 'of')} 2</div>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <div className="flex-1 h-1 bg-sp-pump rounded-[3px]" />
                    <div className="flex-1 h-1 bg-sp-pump/60 rounded-[3px] animate-pulse" />
                  </div>
                </div>
              )}

              {txStep === 'done' && (
                <div className="space-y-4 py-4 text-center">
                  <CheckCircle size={40} className="text-sp-pump mx-auto" />
                  <div className="text-lg font-extrabold text-white">{t(lang, 'success')}</div>
                  {newCurveId && (
                    <>
                      <div className="bg-black/30 border border-white/[0.14] rounded-[9px] px-3 py-2.5 flex items-center gap-2">
                        <span className="text-[10px] font-mono text-white/40 flex-1 truncate text-left">
                          suipump.org/token/{newCurveId.slice(0,8)}…
                        </span>
                        <button
                          onClick={() => navigator.clipboard.writeText(`${window.location.origin}/token/${newCurveId}`)}
                          className="text-[9px] font-mono font-bold text-sp-glow hover:text-sp-pump whitespace-nowrap border border-lime-400/30 px-2 py-1 rounded-[7px] transition-colors"
                        >
                          COPY LINK
                        </button>
                      </div>
                      <button
                        onClick={() => { onClose(); window.location.href = `/token/${newCurveId}`; }}
                        className="w-full h-12 bg-sp-pump text-sp-void font-extrabold rounded-[13px] text-sm font-mono hover:bg-sp-glow transition-colors shadow-[0_10px_32px_rgba(132,204,22,0.3)]"
                      >
                        {t(lang, 'viewToken')}
                      </button>
                    </>
                  )}
                </div>
              )}

              {error && (
                <div className="rounded-xl border border-sp-dump/20 bg-red-950/20 p-4 text-xs font-mono text-sp-dump">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer nav */}
        {!txStep && !error && (
          <div className="sticky bottom-0 bg-[rgba(7,7,7,0.97)] border-t border-white/[0.08] px-4 sm:px-7 pt-3 pb-4 sm:pb-5">
            <div className="flex justify-between text-[10px] font-medium mb-2.5 sm:hidden">
              <span className="text-white/40">total so far</span>
              <span className="text-white/80">{(2 + (parseFloat(devBuy) || 0) + (epochSite ? 5 : 0)).toFixed(2)} SUI + gas</span>
            </div>
            <div className="flex gap-3">
              {step > 0 && step < 3 && (
                <button
                  onClick={() => setStep(s => s - 1)}
                  className="flex-1 h-12 rounded-[13px] border border-white/[0.12] text-sm font-mono font-semibold text-white/50 hover:text-white hover:border-white/25 transition-colors"
                >
                  {t(lang, 'back')}
                </button>
              )}
              {step === 3 && !txStep && (
                <button
                  onClick={() => setStep(2)}
                  className="flex-1 h-12 rounded-[13px] border border-white/[0.12] text-sm font-mono font-semibold text-white/50 hover:text-white hover:border-white/25 transition-colors"
                >
                  {t(lang, 'back')}
                </button>
              )}
              {step < 3 ? (
                <button
                  onClick={() => canNext && setStep(s => s + 1)}
                  disabled={!canNext}
                  className={`flex-1 h-12 rounded-[13px] text-sm font-mono font-extrabold transition-colors ${
                    canNext
                      ? 'bg-sp-pump text-sp-void hover:bg-sp-glow shadow-[0_10px_32px_rgba(132,204,22,0.3)]'
                      : 'bg-white/5 text-white/20 cursor-not-allowed'
                  }`}
                >
                  {t(lang, 'next')} →
                </button>
              ) : (
                !txStep && (
                  <button
                    onClick={handleLaunch}
                    disabled={!account || launching}
                    className={`flex-1 h-12 rounded-[13px] text-sm font-mono font-extrabold transition-colors flex items-center justify-center gap-2 ${
                      !account || launching
                        ? 'bg-white/5 text-white/20 cursor-not-allowed'
                        : 'bg-sp-pump text-sp-void hover:bg-sp-glow shadow-[0_10px_32px_rgba(132,204,22,0.3)]'
                    }`}
                  >
                    <Rocket size={14} />
                    {symbolValid ? `LAUNCH $${form.symbol}` : t(lang, 'launchATokenTitle')}
                  </button>
                )
              )}
            </div>
          </div>
        )}

        {/* Error retry */}
        {error && (
          <div className="sticky bottom-0 bg-[rgba(7,7,7,0.97)] border-t border-white/[0.08] px-4 sm:px-7 pt-3 pb-4 sm:pb-5 flex gap-3">
            <button
              onClick={() => { setError(null); setStep(3); }}
              className="flex-1 h-12 rounded-[13px] border border-white/[0.12] text-sm font-mono font-semibold text-white/50 hover:text-white transition-colors"
            >
              {t(lang, 'back')}
            </button>
            <button
              onClick={handleLaunch}
              className="flex-1 h-12 rounded-[13px] bg-sp-pump text-sp-void font-extrabold text-sm font-mono hover:bg-sp-glow transition-colors shadow-[0_10px_32px_rgba(132,204,22,0.3)]"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
