// LaunchModal.jsx — v5 wired
import React, { useState, useCallback } from 'react';
import { useCurrentAccount, useDAppKit, useCurrentClient } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { X, Plus, Trash2, Rocket, CheckCircle } from 'lucide-react';
import wasmInit, * as bytecodeTemplate from '@mysten/move-bytecode-template';
import { PACKAGE_ID, PACKAGE_ID_V5, PACKAGE_ID_V7, MIST_PER_SUI, ANTI_BOT_NONE, ANTI_BOT_15S, ANTI_BOT_30S, GRAD_TARGET_CETUS, GRAD_TARGET_DEEPBOOK, GRAD_TARGET_TURBOS, isV7OrLater, isV9OrLater, EPOCH_PKG, EPOCH_TREASURY, EPOCH_CUT_MIST, PROTOCOL_SURCHARGE_MIST, PROTOCOL_WALLET, EPOCH_SIGN_URL, EPOCH_CHECK_URL, EPOCH_SESSION_PROXY, EPOCH_RECOVERY_PROXY, EPOCH_NETWORK } from './constants.js';
import { t } from './i18n.js';

// Vesting modes / durations — must match bonding_curve.move v7
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

// Placeholder constants — must exactly match coin-template/sources/template.move
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
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-[9px] font-mono text-white/20 tracking-widest mb-3">PREVIEW</div>
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-full border-2 border-white/10 flex items-center justify-center bg-lime-950/30 overflow-hidden shrink-0">
          {iconUrl
            ? <img src={iconUrl} alt="icon" className="w-full h-full object-cover" onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='block'; }} />
            : null}
          <span className="text-2xl" style={{ display: iconUrl ? 'none' : 'block' }}>🔥</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-white font-mono truncate">{name || 'Token Name'}</div>
          <div className="text-xs text-lime-400/70 font-mono">${symbol || 'SYMBOL'}</div>
        </div>
        <div className="text-right">
          <div className="text-[9px] text-white/20 font-mono">BONDING CURVE</div>
          <div className="text-xs text-white/40 font-mono">0.0%</div>
        </div>
      </div>
      <div className="mt-3 h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div className="h-full w-0 bg-gradient-to-r from-lime-600 to-lime-400 rounded-full" />
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
  const [launching, setLaunching] = useState(false);
  const [txStep, setTxStep] = useState(null);
  const [tx1Digest, setTx1Digest] = useState(null);
  const [tx2Digest, setTx2Digest] = useState(null);
  const [error, setError] = useState(null);
  const [newCurveId, setNewCurveId] = useState(null);

  // ── Epoch launch-with-site state ────────────────────────────────────────────
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

  // ── Epoch launch-with-site helpers ──────────────────────────────────────────

  // The live site URL is deterministic from the name: <name>.epoch always maps
  // to https://<name>.epochsui.com/. Derive it from the verified name rather than
  // trusting the callback's `site` param — so the site autofills reliably even if
  // the redirect ever drops that param. Strips an optional trailing ".epoch".
  const epochSiteUrl = useCallback((rawName) => {
    const label = String(rawName || '').trim().toLowerCase().replace(/\.epoch$/i, '');
    return label ? `https://${label}.epochsui.com/` : null;
  }, []);

  // Handoff: authorize ONE comped registration server-side (proxy holds the
  // secret), then redirect the creator to Epoch's sign page carrying the session.
  // No client-side name check — Epoch validates on its side (public /partner/check
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
      // redirect), so Epoch takes it from there — the browser can't spoof it.
      const returnUrl = `${window.location.origin}${window.location.pathname}?epoch_return=1`;
      // Server-to-server auth — proxy injects the Bearer secret, never the browser.
      const r = await fetch(EPOCH_SESSION_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionId, network: EPOCH_NETWORK, return_url: returnUrl }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`session ${r.status}`);
      // Redirect carries name + partner + session (no return= — Epoch has it from
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
    // told us "this wallet registered, here's the NameCap id" — so confirming
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

  // Manual "Verify" retry — if auto-verify missed (finalization lag, etc.), the
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

      const res1raw = await dAppKit.signAndExecuteTransaction({ transaction: tx1 });
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

      // Extract CoinMetadata objectId from Tx1 — type includes 'CoinMetadata'
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

        let buyArgs;
        if (isV9OrLater(PACKAGE_ID)) {
          // V9+ buy: sui_price_scaled before clock
          // Signature: buy(curve, payment, min_out, referral, sui_price_scaled, clock, ctx)
          buyArgs = [
            curve,
            devPayment,
            tx2.pure.u64(0),
            tx2.pure.option('address', null),
            tx2.pure.u64(0),              // sui_price_scaled = 0 (oracle fallback)
            tx2.object(SUI_CLOCK_ID),
          ];
        } else if (PACKAGE_ID_V5) {
          // V5+ buy: curve, payment, min_tokens_out, referral (none), clock
          buyArgs = [
            curve,
            devPayment,
            tx2.pure.u64(0),
            tx2.pure.option('address', null), // Option::none<address> for referral
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

      // ── Epoch launch-with-site surcharge (only when a site is verified) ─────
      // 5 SUI surcharge on top of the 2 SUI base, composed into THIS same tx2 so
      // the user signs once and Epoch's cut is sent automatically inside their
      // own transaction. 3 → Epoch treasury via record_partner_launch (deposits +
      // emits PartnerLaunch), 2 → protocol wallet. SuiPump never custodies the 3.
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
        tx2.transferObjects([protocolCut], PROTOCOL_WALLET);
      }

      tx2.moveCall({ target: `${PACKAGE_ID}::bonding_curve::share_curve`, typeArguments: [newTokenType], arguments: [curve] });
      tx2.transferObjects([cap], account.address);

      const res2raw = await dAppKit.signAndExecuteTransaction({ transaction: tx2 });
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4">
      <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#0a0a0a] font-mono shadow-2xl shadow-black/50 overflow-hidden max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <div>
            <div className="text-[9px] tracking-widest text-white/20">SUIPUMP</div>
            <div className="text-lg font-bold text-white">{t(lang, 'launchATokenTitle')}</div>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white transition-colors rounded-xl p-1.5 hover:bg-white/5">
            <X size={18} />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex px-6 pt-5 gap-2">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex-1 flex flex-col items-center gap-1.5">
              <div className={`w-full h-1 rounded-full transition-all duration-300 ${
                i < step ? 'bg-lime-400' : i === step ? 'bg-lime-400/60' : 'bg-white/10'
              }`} />
              <div className={`text-[9px] font-mono tracking-widest transition-colors ${
                i === step ? 'text-lime-400' : i < step ? 'text-lime-400/50' : 'text-white/20'
              }`}>
                {i < step ? '✓' : t(lang, s.labelKey).toUpperCase()}
              </div>
            </div>
          ))}
        </div>

        <div className="px-6 py-5 space-y-4 min-h-[320px]">

          {/* Step 0: Token details */}
          {step === 0 && (
            <div className="space-y-4">
              <TokenPreview name={form.name} symbol={form.symbol} iconUrl={form.iconUrl} />

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">{t(lang, 'tokenName')} *</label>
                  <input
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    placeholder="Moon Coin"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">{t(lang, 'symbol')} *</label>
                  <input
                    value={form.symbol}
                    onChange={e => setForm({ ...form, symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 9) })}
                    placeholder="MOON"
                    className={`w-full bg-white/5 border rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none transition-colors ${
                      form.symbol && !symbolValid ? 'border-red-500/50 focus:border-red-400' : 'border-white/10 focus:border-lime-400/50'
                    }`}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-[9px] tracking-widest text-white/30">{t(lang, 'description')}</label>
                  <span className={`text-[9px] font-mono ${
                    form.description.length > MAX_DESCRIPTION_CHARS * 0.9
                      ? form.description.length >= MAX_DESCRIPTION_CHARS ? 'text-red-400' : 'text-lime-400'
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
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors resize-none"
                />
              </div>

              {/* Icon URL */}
              <div>
                <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">{t(lang, 'iconUrl')}</label>
                <div className="flex gap-2">
                  <input
                    value={form.iconUrl}
                    onChange={e => setForm({ ...form, iconUrl: e.target.value })}
                    placeholder="https://i.imgur.com/..."
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors"
                  />
                  <label className="shrink-0 px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-[10px] font-mono text-white/50 hover:text-white hover:border-lime-400/30 transition-colors cursor-pointer">
                    {form.uploading ? <span className="animate-pulse">…</span> : t(lang, 'uploadImage')}
                    <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                  </label>
                </div>
                {form.uploadError && (
                  <div className="mt-1 text-[10px] font-mono text-red-400">{form.uploadError}</div>
                )}
                <div className="mt-1 text-[9px] font-mono text-white/20">{t(lang, 'orPasteUrl')}</div>
              </div>

              {/* Graduation DEX toggle */}
              <div className="space-y-2 pt-1">
                <div className="text-[9px] tracking-widest text-white/20">GRADUATES TO</div>
                <div className="flex gap-2">
                  {[
                    { id: 'cetus',    label: 'Cetus',    sub: 'AMM · LP position' },
                    { id: 'deepbook', label: 'DeepBook', sub: 'CLOB · Order book' },
                    { id: 'turbos',   label: 'Turbos',   sub: 'CLMM · Concentrated' },
                  ].map(({ id, label, sub }) => (
                    <button
                      key={id}
                      onClick={() => setForm(f => ({ ...f, graduationDex: id }))}
                      className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 rounded-xl border text-[10px] font-mono transition-colors ${
                        form.graduationDex === id
                          ? 'border-lime-400/50 bg-lime-400/10 text-lime-400'
                          : 'border-white/10 text-white/30 hover:border-white/25 hover:text-white/50'
                      }`}
                    >
                      <span className="font-bold">{label}</span>
                      <span className="text-[8px] opacity-60">{sub}</span>
                    </button>
                  ))}
                </div>
                {!PACKAGE_ID_V5 && (
                  <div className="text-[8px] font-mono text-white/15 text-center">
                    Cetus · DeepBook · Turbos — selection stored on-chain
                  </div>
                )}
              </div>

              {/* Anti-bot delay — v5 only */}
              {PACKAGE_ID_V5 && (
                <div className="space-y-2 pt-1">
                  <div className="text-[9px] tracking-widest text-white/20">ANTI-BOT DELAY</div>
                  <div className="flex gap-2">
                    {[
                      { val: ANTI_BOT_NONE, label: 'None',  sub: 'No delay' },
                      { val: ANTI_BOT_15S,  label: '15s',   sub: 'Block bots 15s' },
                      { val: ANTI_BOT_30S,  label: '30s',   sub: 'Block bots 30s' },
                    ].map(({ val, label, sub }) => (
                      <button
                        key={val}
                        onClick={() => setForm(f => ({ ...f, antiBotDelay: val }))}
                        className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 rounded-xl border text-[10px] font-mono transition-colors ${
                          form.antiBotDelay === val
                            ? 'border-lime-400/50 bg-lime-400/10 text-lime-400'
                            : 'border-white/10 text-white/30 hover:border-white/25 hover:text-white/50'
                        }`}
                      >
                        <span className="font-bold">{label}</span>
                        <span className="text-[8px] opacity-60">{sub}</span>
                      </button>
                    ))}
                  </div>
                  <div className="text-[8px] font-mono text-white/15 text-center">
                    Only your wallet can buy during the delay window
                  </div>
                </div>
              )}

              {/* Social links — website row pairs with Create Token Page side by side */}
              <div className="space-y-2 pt-1">
                <div className="text-[9px] tracking-widest text-white/20">SOCIAL LINKS (OPTIONAL)</div>
                <input
                  value={form.twitter}
                  onChange={e => setForm({ ...form, twitter: e.target.value })}
                  placeholder="https://x.com/yourtoken"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors"
                />
                <input
                  value={form.telegram}
                  onChange={e => setForm({ ...form, telegram: e.target.value })}
                  placeholder="https://t.me/yourtoken"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors"
                />
                {/* Website + Create Token Page, side by side, same height */}
                <div className="flex gap-2">
                  <input
                    value={form.website}
                    onChange={e => setForm({ ...form, website: e.target.value })}
                    placeholder="https://yourtoken.xyz"
                    className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors"
                  />
                  {epochSite ? (
                    <button
                      type="button"
                      onClick={() => { setEpochSite(null); setEpochName(''); }}
                      title="Site attached — click to remove"
                      className="shrink-0 px-4 py-2.5 rounded-xl text-[11px] font-mono font-bold whitespace-nowrap transition-colors"
                      style={{ background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.5)', color: '#60a5fa' }}
                    >
                      {epochSite.name} ✓
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={startEpochSite}
                      disabled={epochVerifying}
                      className="shrink-0 px-4 py-2.5 rounded-xl text-[11px] font-mono font-bold whitespace-nowrap transition-colors disabled:opacity-40"
                      style={{ background: '#3b82f6', color: '#ffffff' }}
                    >
                      {epochVerifying ? 'Verifying…' : 'Create Token Page (+5 SUI)'}
                    </button>
                  )}
                </div>
                {epochError && (
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[9px] font-mono text-red-400">{epochError}</div>
                    {epochPending && !epochSite && (
                      <button
                        type="button"
                        onClick={retryEpochVerify}
                        disabled={epochVerifying}
                        className="shrink-0 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold whitespace-nowrap transition-colors disabled:opacity-40"
                        style={{ background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.5)', color: '#60a5fa' }}
                      >
                        {epochVerifying ? 'Verifying…' : 'Verify'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 1: Payouts */}
          {step === 1 && (
            <div className="space-y-3">
              <div className="text-[9px] font-mono text-white/30 tracking-widest mb-2">FEE RECIPIENTS</div>
              {payouts.map((p, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <div className="flex-1 space-y-1.5">
                    <input
                      value={p.address}
                      onChange={e => updatePayout(i, 'address', e.target.value)}
                      placeholder="0x…"
                      className={`w-full bg-white/5 border rounded-xl px-3 py-2 text-white text-xs focus:outline-none transition-colors ${
                        p.address && (!p.address.startsWith('0x') || p.address.length !== 66)
                          ? 'border-red-500/40' : 'border-white/10 focus:border-lime-400/50'
                      }`}
                    />
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={p.bps}
                        onChange={e => updatePayout(i, 'bps', e.target.value)}
                        min={1} max={10000}
                        className="w-24 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-lime-400/50 transition-colors"
                      />
                      <span className="text-[10px] font-mono text-white/30">bps = {((parseInt(p.bps)||0)/100).toFixed(2)}%</span>
                    </div>
                  </div>
                  {payouts.length > 1 && (
                    <button onClick={() => removePayout(i)} className="mt-2 text-white/20 hover:text-red-400 transition-colors">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
              <div className={`text-[10px] font-mono ${payoutSum === 10000 ? 'text-lime-400' : 'text-red-400'}`}>
                Total: {payoutSum} / 10000 bps ({(payoutSum/100).toFixed(2)}%)
              </div>
              {payouts.length < 10 && (
                <button
                  onClick={addPayout}
                  className="flex items-center gap-1.5 text-[10px] font-mono text-white/30 hover:text-lime-400 transition-colors"
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
                <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">{t(lang, 'devBuyAmount')}</label>
                <input
                  type="number"
                  value={devBuy}
                  onChange={e => setDevBuy(e.target.value)}
                  placeholder="0"
                  min="0"
                  step="0.1"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors"
                />
                <div className="mt-1.5 text-[9px] font-mono text-white/20">{t(lang, 'devBuyHint')}</div>
              </div>
              {parseFloat(devBuy) > 5 && (
                <div className="rounded-xl border border-yellow-500/20 bg-yellow-950/20 p-3 text-[10px] font-mono text-yellow-400">
                  {t(lang, 'devBuyWarning')}
                </div>
              )}

              {/* Optional dev-buy vesting lock — V7+ only */}
              {parseFloat(devBuy) > 0 && isV7OrLater(PACKAGE_ID) && (
                <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4 space-y-3">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={lockDevBuy}
                      onChange={e => setLockDevBuy(e.target.checked)}
                      className="accent-lime-400 w-3.5 h-3.5"
                    />
                    <span className="text-[11px] font-mono text-white/70">
                      Lock my dev-buy tokens (anti-rug)
                    </span>
                  </label>
                  <p className="text-[9px] font-mono text-white/25 leading-relaxed">
                    Your dev-buy tokens go into an on-chain vesting lock. The terms
                    are immutable — you cannot shorten or cancel the lock once set.
                  </p>

                  {lockDevBuy && (
                    <div className="space-y-3 pt-1">
                      {/* Mode */}
                      <div>
                        <div className="text-[9px] tracking-widest text-white/30 mb-1.5">VESTING MODE</div>
                        <div className="grid grid-cols-3 gap-1.5">
                          {[
                            { v: VEST_MODE_CLIFF,   label: 'Cliff' },
                            { v: VEST_MODE_LINEAR,  label: 'Linear' },
                            { v: VEST_MODE_MONTHLY, label: 'Monthly' },
                          ].map(({ v, label }) => {
                            // Monthly requires >= 30d
                            const disabled = v === VEST_MODE_MONTHLY && lockDuration === '7d';
                            return (
                              <button
                                key={v}
                                disabled={disabled}
                                onClick={() => setLockMode(v)}
                                className={`py-2 rounded-lg text-[10px] font-mono transition-colors ${
                                  disabled
                                    ? 'bg-white/5 text-white/15 cursor-not-allowed'
                                    : lockMode === v
                                      ? 'bg-lime-400 text-black'
                                      : 'bg-white/5 text-white/40 hover:text-white/70'
                                }`}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      {/* Duration */}
                      <div>
                        <div className="text-[9px] tracking-widest text-white/30 mb-1.5">DURATION</div>
                        <div className="grid grid-cols-4 gap-1.5">
                          {['7d', '30d', '180d', '365d'].map(d => (
                            <button
                              key={d}
                              onClick={() => {
                                setLockDuration(d);
                                // Monthly is invalid for 7d — fall back to cliff
                                if (d === '7d' && lockMode === VEST_MODE_MONTHLY) {
                                  setLockMode(VEST_MODE_CLIFF);
                                }
                              }}
                              className={`py-2 rounded-lg text-[10px] font-mono transition-colors ${
                                lockDuration === d
                                  ? 'bg-lime-400 text-black'
                                  : 'bg-white/5 text-white/40 hover:text-white/70'
                              }`}
                            >
                              {d}
                            </button>
                          ))}
                        </div>
                      </div>
                      <p className="text-[9px] font-mono text-lime-400/70 leading-relaxed">
                        {lockMode === VEST_MODE_CLIFF   && `100% unlocks at the end of ${lockDuration}.`}
                        {lockMode === VEST_MODE_LINEAR  && `Tokens unlock continuously over ${lockDuration}.`}
                        {lockMode === VEST_MODE_MONTHLY && `Tokens unlock in equal monthly steps over ${lockDuration}.`}
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4 space-y-2">
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-white/30">{t(lang, 'launchFee')}</span>
                  <span className="text-white">{epochSite ? '7 SUI' : '2 SUI'}</span>
                </div>
                {parseFloat(devBuy) > 0 && (
                  <div className="flex justify-between text-[10px] font-mono">
                    <span className="text-white/30">{t(lang, 'devBuyAmount')}</span>
                    <span className="text-white">{parseFloat(devBuy).toFixed(2)} SUI</span>
                  </div>
                )}
                {epochSite && (
                  <div className="flex justify-between text-[10px] font-mono">
                    <span className="text-white/30">Token page ({epochSite.name})</span>
                    <span className="text-white">5.00 SUI</span>
                  </div>
                )}
                <div className="border-t border-white/5 pt-2 flex justify-between text-[10px] font-mono font-bold">
                  <span className="text-white/50">{t(lang, 'total')}</span>
                  <span className="text-lime-400">{(2 + (parseFloat(devBuy) || 0) + (epochSite ? 5 : 0)).toFixed(2)} SUI + gas</span>
                </div>
              </div>
              <div className="text-[9px] font-mono text-white/20 text-center">{t(lang, 'twoSignaturesRequired')}</div>
            </div>
          )}

          {/* Step 3: Review / launch */}
          {step === 3 && (
            <div className="space-y-4">
              {!txStep && !error && (
                <>
                  <TokenPreview name={form.name} symbol={form.symbol} iconUrl={form.iconUrl} />
                  <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4 space-y-2 text-[10px] font-mono">
                    <div className="flex justify-between">
                      <span className="text-white/30">Name</span>
                      <span className="text-white">{form.name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-white/30">Symbol</span>
                      <span className="text-lime-400">${form.symbol}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-white/30">Graduates to</span>
                      <span className="text-white capitalize">{form.graduationDex}</span>
                    </div>
                    {PACKAGE_ID_V5 && (
                      <div className="flex justify-between">
                        <span className="text-white/30">Anti-bot delay</span>
                        <span className="text-white">{form.antiBotDelay === 0 ? 'None' : `${form.antiBotDelay}s`}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-white/30">Recipients</span>
                      <span className="text-white">{payouts.length}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-white/30">Dev buy</span>
                      <span className="text-white">{parseFloat(devBuy) > 0 ? `${parseFloat(devBuy)} SUI` : 'none'}</span>
                    </div>
                    {epochSite && (
                      <div className="flex justify-between">
                        <span className="text-white/30">Token page</span>
                        <span className="text-white">{epochSite.name} · 5 SUI</span>
                      </div>
                    )}
                    <div className="border-t border-white/5 pt-2 flex justify-between font-bold">
                      <span className="text-white/50">{t(lang, 'total')}</span>
                      <span className="text-lime-400">{(2 + (parseFloat(devBuy) || 0) + (epochSite ? 5 : 0)).toFixed(2)} SUI + gas</span>
                    </div>
                  </div>
                </>
              )}

              {txStep === 'tx1' && (
                <div className="space-y-4 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full border-2 border-lime-400 border-t-transparent animate-spin" />
                    <div>
                      <div className="text-sm text-white font-bold">{t(lang, 'publishing')}</div>
                      <div className="text-[10px] text-white/30">{t(lang, 'approveInWallet')} — Tx 1 {t(lang, 'of')} 2</div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 h-1.5 bg-lime-400/60 rounded-full animate-pulse" />
                    <div className="flex-1 h-1.5 bg-white/10 rounded-full" />
                  </div>
                </div>
              )}

              {txStep === 'tx2' && (
                <div className="space-y-4 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full border-2 border-lime-400 border-t-transparent animate-spin" />
                    <div>
                      <div className="text-sm text-white font-bold">{t(lang, 'creating')}</div>
                      <div className="text-[10px] text-white/30">{t(lang, 'approveInWallet')} — Tx 2 {t(lang, 'of')} 2</div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 h-1.5 bg-lime-400 rounded-full" />
                    <div className="flex-1 h-1.5 bg-lime-400/60 rounded-full animate-pulse" />
                  </div>
                </div>
              )}

              {txStep === 'done' && (
                <div className="space-y-4 py-4 text-center">
                  <CheckCircle size={40} className="text-lime-400 mx-auto" />
                  <div className="text-lg font-bold text-white">{t(lang, 'success')}</div>
                  {newCurveId && (
                    <>
                      <div className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 flex items-center gap-2">
                        <span className="text-[10px] font-mono text-white/40 flex-1 truncate text-left">
                          suipump.org/token/{newCurveId.slice(0,8)}…
                        </span>
                        <button
                          onClick={() => navigator.clipboard.writeText(`${window.location.origin}/token/${newCurveId}`)}
                          className="text-[9px] font-mono text-lime-400 hover:text-lime-300 whitespace-nowrap border border-lime-400/30 px-2 py-1 rounded-lg transition-colors"
                        >
                          COPY LINK
                        </button>
                      </div>
                      <button
                        onClick={() => { onClose(); window.location.href = `/token/${newCurveId}`; }}
                        className="w-full py-3 bg-lime-400 text-black font-bold rounded-xl text-sm font-mono hover:bg-lime-300 transition-colors"
                      >
                        {t(lang, 'viewToken')}
                      </button>
                    </>
                  )}
                </div>
              )}

              {error && (
                <div className="rounded-xl border border-red-500/20 bg-red-950/20 p-4 text-xs font-mono text-red-400">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer nav */}
        {!txStep && !error && (
          <div className="px-6 pb-6 flex gap-3">
            {step > 0 && step < 3 && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="flex-1 py-3 rounded-xl border border-white/10 text-sm font-mono text-white/50 hover:text-white hover:border-white/25 transition-colors"
              >
                {t(lang, 'back')}
              </button>
            )}
            {step === 3 && !txStep && (
              <button
                onClick={() => setStep(2)}
                className="flex-1 py-3 rounded-xl border border-white/10 text-sm font-mono text-white/50 hover:text-white hover:border-white/25 transition-colors"
              >
                {t(lang, 'back')}
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={() => canNext && setStep(s => s + 1)}
                disabled={!canNext}
                className={`flex-1 py-3 rounded-xl text-sm font-mono font-bold transition-colors ${
                  canNext
                    ? 'bg-lime-400 text-black hover:bg-lime-300'
                    : 'bg-white/5 text-white/20 cursor-not-allowed'
                }`}
              >
                {t(lang, 'next')}
              </button>
            ) : (
              !txStep && (
                <button
                  onClick={handleLaunch}
                  disabled={!account || launching}
                  className={`flex-1 py-3 rounded-xl text-sm font-mono font-bold transition-colors flex items-center justify-center gap-2 ${
                    !account || launching
                      ? 'bg-white/5 text-white/20 cursor-not-allowed'
                      : 'bg-lime-400 text-black hover:bg-lime-300'
                  }`}
                >
                  <Rocket size={14} />
                  {t(lang, 'launchATokenTitle')}
                </button>
              )
            )}
          </div>
        )}

        {/* Error retry */}
        {error && (
          <div className="px-6 pb-6 flex gap-3">
            <button
              onClick={() => { setError(null); setStep(3); }}
              className="flex-1 py-3 rounded-xl border border-white/10 text-sm font-mono text-white/50 hover:text-white transition-colors"
            >
              {t(lang, 'back')}
            </button>
            <button
              onClick={handleLaunch}
              className="flex-1 py-3 rounded-xl bg-lime-400 text-black font-bold text-sm font-mono hover:bg-lime-300 transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
