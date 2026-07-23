// ReferralsPage.jsx - the referral program dashboard (an EARNINGS LEDGER, not a
// claim surface). Referral SUI is paid directly to the referrer's wallet on
// every referred trade at on-chain settlement; there is NOTHING TO CLAIM here.
//
// Surfaces:
//   - YOUR CODE: claim a vanity code (live validation + availability), or the
//     claimed code + full share link with a copy button.
//   - EARNINGS: total SUI earned + total referred volume.
//   - RECENT PAYMENTS: reverse-chronological feed of individual payouts (the
//     proof-it-works surface).
//   - REFERRED WALLETS: full untruncated addresses, bound date, volume, fees.
//   - WHO REFERRED YOU: the referrer's full address + a one-line explainer.
//   - HOW IT WORKS: factual, states plainly that nothing needs claiming.
//
// Aesthetic: lime-on-void terminal, JetBrains Mono, matching AIAnalysis /
// HolderList / BundleBadge. Full 66-char identifiers everywhere (hard rule 2).

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { ArrowLeft, Copy, Check, Users, TrendingUp, Gift, Link2, ExternalLink } from 'lucide-react';
import { t } from './i18n.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';
const SHARE_ORIGIN = 'https://suipump.org';

// Client-side mirror of the server A2 rules (server remains source of truth).
const RESERVED = new Set([
  'SUIPUMP', 'ADMIN', 'OFFICIAL', 'SUPPORT', 'TEAM', 'SYSTEM', 'NULL', 'UNDEFINED', 'MOD', 'STAFF',
]);
function validateCodeClient(raw) {
  const code = String(raw ?? '').trim().toUpperCase();
  if (!code) return { code, ok: false, error: '' };
  if (code.length < 3)  return { code, ok: false, error: 'Too short (min 3 characters)' };
  if (code.length > 20) return { code, ok: false, error: 'Too long (max 20 characters)' };
  if (!/^[A-Z0-9_]+$/.test(code)) return { code, ok: false, error: 'Letters, numbers and underscore only' };
  if (code.startsWith('0X')) return { code, ok: false, error: 'Cannot look like an address' };
  if (RESERVED.has(code)) return { code, ok: false, error: 'That code is reserved' };
  return { code, ok: true, error: '' };
}

function fmtSui(n, d = 4) {
  const x = Number(n ?? 0);
  if (!Number.isFinite(x)) return '0';
  if (Math.abs(x) >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (Math.abs(x) >= 1e3) return (x / 1e3).toFixed(2) + 'k';
  return x.toFixed(d);
}

function fmtWhen(ms) {
  if (!ms) return '-';
  const diff = Date.now() - Number(ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function fmtDate(ms) {
  if (!ms) return '-';
  try { return new Date(Number(ms)).toISOString().slice(0, 10); } catch { return '-'; }
}

const suiscanTx  = (d) => `https://suiscan.xyz/testnet/tx/${d}`;
const suiscanAcc = (a) => `https://suiscan.xyz/testnet/account/${a}`;

// -- Copy button --------------------------------------------------------------
function CopyBtn({ text, label = 'COPY' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => {}); }}
      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-lime-400/30 bg-lime-400/[0.06] text-lime-400 text-[9px] font-mono font-bold hover:bg-lime-400/15 transition-colors"
    >
      {done ? <Check size={10} /> : <Copy size={10} />} {done ? 'COPIED' : label}
    </button>
  );
}

// -- Stat block ---------------------------------------------------------------
function Stat({ label, value, sub, accent = false }) {
  return (
    <div className={`rounded-xl border p-4 ${accent ? 'border-lime-400/25 bg-lime-400/[0.05]' : 'border-white/[0.08] bg-white/[0.015]'}`}>
      <div className="text-[9px] font-mono text-white/35 tracking-widest uppercase">{label}</div>
      <div className={`text-[20px] font-mono font-bold mt-1.5 ${accent ? 'text-lime-400' : 'text-white'}`}>{value}</div>
      {sub != null && <div className="text-[9px] font-mono text-white/30 mt-1">{sub}</div>}
    </div>
  );
}

// -- Full address (never truncated) -------------------------------------------
function FullAddr({ addr, className = '' }) {
  if (!addr) return <span className="text-white/25">-</span>;
  return (
    <a href={suiscanAcc(addr)} target="_blank" rel="noreferrer"
      className={`font-mono text-[10px] text-lime-400/80 hover:text-lime-300 break-all transition-colors ${className}`}>
      {addr}
    </a>
  );
}

// -- Claim panel --------------------------------------------------------------
function ClaimPanel({ owner, onClaimed }) {
  const [input, setInput]     = useState('');
  const [avail, setAvail]     = useState(null);   // null unknown | true | false
  const [checking, setChecking] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');
  const debounceRef = useRef(null);

  const v = validateCodeClient(input);

  // Live availability check (debounced) once the code is locally valid.
  useEffect(() => {
    setAvail(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!v.ok || !INDEXER_URL) return;
    debounceRef.current = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await fetch(`${INDEXER_URL}/referral/code/${encodeURIComponent(v.code)}`, { signal: AbortSignal.timeout(4000) });
        if (res.status === 404) { setAvail(true); }
        else if (res.ok) {
          const d = await res.json();
          // Available to THIS owner if it is theirs already (idempotent) or free.
          setAvail(d?.owner ? String(d.owner).toLowerCase() === String(owner).toLowerCase() : true);
        } else { setAvail(null); }
      } catch { setAvail(null); }
      finally { setChecking(false); }
    }, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [v.code, v.ok, owner]);

  const claim = useCallback(async () => {
    setErr('');
    const vv = validateCodeClient(input);
    if (!vv.ok) { setErr(vv.error || 'Invalid code'); return; }
    if (!INDEXER_URL) { setErr('Indexer unavailable'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${INDEXER_URL}/referral/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, code: vv.code }),
        signal: AbortSignal.timeout(8000),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(d?.error || `Claim failed (${res.status})`); return; }
      onClaimed(d.code);
    } catch (e) { setErr('Network error, try again'); }
    finally { setBusy(false); }
  }, [input, owner, onClaimed]);

  const canClaim = v.ok && avail !== false && !busy;

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center rounded-xl border border-white/10 bg-black/30 px-3 h-11 focus-within:border-lime-400/40 transition-colors">
          <span className="text-white/30 font-mono text-[11px] shrink-0">/?ref=</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase().slice(0, 20))}
            placeholder="YOURCODE"
            spellCheck={false}
            className="flex-1 bg-transparent outline-none font-mono text-[13px] text-lime-400 placeholder:text-white/20 ml-1 tracking-wider"
          />
          {input && v.ok && (
            <span className="text-[9px] font-mono shrink-0">
              {checking ? <span className="text-white/30">checking...</span>
                : avail === true ? <span className="text-lime-400">available</span>
                : avail === false ? <span className="text-red-400">taken</span>
                : <span className="text-white/25">-</span>}
            </span>
          )}
        </div>
        <button
          onClick={claim}
          disabled={!canClaim}
          className={`h-11 px-5 rounded-xl font-mono text-[11px] font-bold tracking-widest transition-colors ${canClaim ? 'bg-lime-400 text-black hover:bg-lime-300' : 'bg-white/5 text-white/25 cursor-not-allowed'}`}
        >
          {busy ? 'CLAIMING' : 'CLAIM'}
        </button>
      </div>
      <div className="h-4 mt-1.5">
        {input && !v.ok && v.error && <span className="text-[9px] font-mono text-red-400/80">{v.error}</span>}
        {avail === false && v.ok && <span className="text-[9px] font-mono text-red-400/80">That code is already taken - try another.</span>}
        {err && <span className="text-[9px] font-mono text-red-400/80">{err}</span>}
        {!input && <span className="text-[9px] font-mono text-white/25">3-20 characters, letters, numbers or underscore.</span>}
      </div>
    </div>
  );
}

// -- Compact card for the portfolio page --------------------------------------
// Own-wallet only. Shows the claimed code + share link, or a prompt to set one,
// and links through to the full /referrals page.
export function ReferralLinkCard({ lang = 'en' }) {
  const account = useCurrentAccount();
  const owner   = account?.address ? account.address.toLowerCase() : null;
  const [code, setCode] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!owner || !INDEXER_URL) { setLoaded(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${INDEXER_URL}/referral/mine?owner=${encodeURIComponent(owner)}`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) { const d = await res.json(); if (!cancelled) setCode(d?.code ?? null); }
      } catch {}
      finally { if (!cancelled) setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [owner]);

  if (!owner || !loaded) return null;
  const link = code ? `${SHARE_ORIGIN}/?ref=${code}` : null;

  return (
    <div className="rounded-2xl border border-lime-400/20 bg-lime-400/[0.04] p-4 flex items-center justify-between gap-3 flex-wrap"
      style={{ backgroundImage: 'radial-gradient(circle at 100% 0%, rgba(132,204,22,.07), transparent 60%)' }}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-xl border border-lime-400/30 bg-lime-400/10 flex items-center justify-center shrink-0">
          <Gift size={15} className="text-lime-400" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-mono font-bold text-white tracking-wide">Referrals</div>
          {code
            ? <div className="text-[10px] font-mono text-lime-400/80 truncate">{link}</div>
            : <div className="text-[10px] font-mono text-white/40">Earn 10% of the trade fee on every trade your invites make.</div>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {code && link && <CopyBtn text={link} label="COPY LINK" />}
        <a href="/referrals" className="inline-flex items-center gap-1 px-3 h-8 rounded-lg border border-white/10 text-white/60 text-[9px] font-mono font-bold hover:text-white hover:border-white/25 transition-colors">
          {code ? 'DASHBOARD' : 'GET LINK'} <ExternalLink size={9} />
        </a>
      </div>
    </div>
  );
}

// -- How it works (factual; no claim button anywhere) -------------------------
function HowItWorks() {
  const rows = [
    ['1', '10% of the trade fee', 'The referrer earns 10% of the 1.00% protocol trade fee on every buy and sell the referred wallet makes. It costs the trader nothing extra.'],
    ['2', 'Paid automatically on-chain', 'The referral SUI is transferred straight to the referrer wallet at settlement, on every referred trade. It arrives in your wallet directly.'],
    ['3', 'Nothing to claim', 'Unlike creator, protocol and airdrop fees, referral rewards are NOT pooled and there is NO claim button. This page is a ledger of what already landed in your wallet.'],
    ['4', 'First touch, permanent', 'A wallet is bound to the first referrer whose link it used, on its first trade. That binding never changes.'],
  ];
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-5">
      <div className="text-[10px] font-mono font-bold text-white/70 tracking-widest uppercase mb-3">How it works</div>
      <div className="space-y-3">
        {rows.map(([n, head, body]) => (
          <div key={n} className="flex gap-3">
            <div className="w-5 h-5 rounded-md border border-lime-400/30 bg-lime-400/10 text-lime-400 text-[10px] font-mono font-bold flex items-center justify-center shrink-0">{n}</div>
            <div>
              <div className="text-[11px] font-mono font-bold text-white">{head}</div>
              <div className="text-[10px] font-mono text-white/40 leading-relaxed mt-0.5">{body}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// -- Main page ----------------------------------------------------------------
export default function ReferralsPage({ onBack, lang = 'en' }) {
  const account = useCurrentAccount();
  const owner   = account?.address ? account.address.toLowerCase() : null;

  const [mine, setMine]   = useState({ code: null, referrer: null });
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const load = useCallback(async () => {
    if (!owner || !INDEXER_URL) return;
    setLoading(true);
    try {
      const [mRes, sRes] = await Promise.all([
        fetch(`${INDEXER_URL}/referral/mine?owner=${encodeURIComponent(owner)}`, { signal: AbortSignal.timeout(6000) }),
        fetch(`${INDEXER_URL}/referral/stats?owner=${encodeURIComponent(owner)}`, { signal: AbortSignal.timeout(8000) }),
      ]);
      if (mRes.ok) setMine(await mRes.json());
      if (sRes.ok) setStats(await sRes.json());
    } catch {}
    finally { setLoading(false); }
  }, [owner]);

  useEffect(() => { load(); }, [load]);

  const code = mine.code ?? stats?.code ?? null;
  const link = code ? `${SHARE_ORIGIN}/?ref=${code}` : null;

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors">
        <ArrowLeft size={12} /> {t(lang, 'backToHome')}
      </button>

      <div className="max-w-[1000px] mx-auto flex flex-col gap-[14px]">

        {/* Title */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl border border-lime-400/30 bg-lime-400/10 flex items-center justify-center">
            <Gift size={18} className="text-lime-400" />
          </div>
          <div>
            <div className="text-[16px] font-mono font-bold text-white tracking-wide">Referrals</div>
            <div className="text-[10px] font-mono text-white/35">Earn 10% of the trade fee, paid straight to your wallet.</div>
          </div>
        </div>

        {/* Disconnected */}
        {!owner && (
          <>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
              <div className="text-sm font-mono text-white/40">Connect your wallet to claim a referral code and see your earnings.</div>
            </div>
            <HowItWorks />
          </>
        )}

        {owner && (
          <>
            {/* YOUR CODE */}
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-5"
              style={{ backgroundImage: 'radial-gradient(circle at 12% 0%, rgba(132,204,22,.07), transparent 55%)' }}>
              <div className="text-[10px] font-mono font-bold text-white/70 tracking-widest uppercase mb-3">Your referral link</div>
              {code ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex-1 min-w-[220px] flex items-center gap-2 rounded-xl border border-lime-400/25 bg-black/30 px-3 h-11">
                    <Link2 size={13} className="text-lime-400 shrink-0" />
                    <span className="font-mono text-[12px] text-lime-400 break-all">{link}</span>
                  </div>
                  <button
                    onClick={() => { navigator.clipboard.writeText(link).then(() => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1500); }).catch(() => {}); }}
                    className="h-11 px-5 rounded-xl bg-lime-400 text-black font-mono text-[11px] font-bold tracking-widest hover:bg-lime-300 transition-colors inline-flex items-center gap-1.5"
                  >
                    {linkCopied ? <Check size={12} /> : <Copy size={12} />} {linkCopied ? 'COPIED' : 'COPY'}
                  </button>
                </div>
              ) : (
                <ClaimPanel owner={owner} onClaimed={(c) => { setMine(m => ({ ...m, code: c })); load(); }} />
              )}
            </div>

            {/* EARNINGS */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-[14px]">
              <Stat accent label="Total earned" value={<>{fmtSui(stats?.total_earned_sui)} <span className="text-[12px] text-lime-400/50">SUI</span></>} sub="Paid to your wallet" />
              <Stat label="Referred volume" value={<>{fmtSui(stats?.total_volume_sui, 2)} <span className="text-[12px] text-white/40">SUI</span></>} sub="Across your referrals" />
              <Stat label="Referrals" value={stats?.referral_count ?? 0} sub="Wallets bound to you" />
            </div>

            {/* RECENT PAYMENTS - the proof-it-works surface */}
            <div className="rounded-2xl border border-lime-400/20 bg-white/[0.015] p-5">
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp size={13} className="text-lime-400" />
                <div className="text-[10px] font-mono font-bold text-white/70 tracking-widest uppercase">Recent payments</div>
              </div>
              {stats?.recent_payments?.length ? (
                <div className="flex flex-col gap-1.5">
                  {stats.recent_payments.map((p, i) => (
                    <a key={`${p.tx_digest}-${i}`} href={suiscanTx(p.tx_digest)} target="_blank" rel="noreferrer"
                      className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5 hover:border-lime-400/25 transition-colors">
                      <div className="min-w-0">
                        <div className="text-[11px] font-mono font-bold text-lime-400">+{fmtSui(p.earned_sui)} SUI</div>
                        <div className="text-[9px] font-mono text-white/35 break-all mt-0.5">
                          {p.token_symbol ? <span className="text-white/55">${p.token_symbol}</span> : 'token'} <span className="text-white/25">from</span> {p.wallet}
                        </div>
                      </div>
                      <div className="text-[9px] font-mono text-white/30 shrink-0 text-right">
                        {fmtWhen(p.ts_ms)}
                        <div className="mt-0.5 inline-flex items-center gap-1 text-white/25">tx <ExternalLink size={8} /></div>
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] font-mono text-white/30 py-4 text-center">
                  No referral payments yet. When someone trades through your link, their referral fee lands in your wallet and shows up here.
                </div>
              )}
            </div>

            {/* REFERRED WALLETS */}
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-5">
              <div className="flex items-center gap-2 mb-3">
                <Users size={13} className="text-white/50" />
                <div className="text-[10px] font-mono font-bold text-white/70 tracking-widest uppercase">Referred wallets</div>
              </div>
              {stats?.referred?.length ? (
                <div className="flex flex-col gap-2">
                  <div className="hidden sm:grid grid-cols-[1fr,90px,90px,90px] gap-2 px-2 text-[8px] font-mono text-white/25 tracking-widest uppercase">
                    <span>Wallet</span><span className="text-right">Bound</span><span className="text-right">Volume</span><span className="text-right">Fees</span>
                  </div>
                  {stats.referred.map((r) => (
                    <div key={r.wallet} className="grid grid-cols-1 sm:grid-cols-[1fr,90px,90px,90px] gap-1 sm:gap-2 rounded-xl border border-white/[0.06] bg-black/20 px-2.5 py-2 items-center">
                      <FullAddr addr={r.wallet} />
                      <span className="text-[9px] font-mono text-white/40 sm:text-right">{fmtDate(r.bound_ms)}</span>
                      <span className="text-[9px] font-mono text-white/55 sm:text-right">{fmtSui(r.volume_sui, 2)}</span>
                      <span className="text-[9px] font-mono text-lime-400/80 sm:text-right">{fmtSui(r.fees_earned_sui)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] font-mono text-white/30 py-4 text-center">
                  No referrals yet. Share your link - a wallet is bound to you when it makes its first trade after visiting it.
                </div>
              )}
            </div>

            {/* WHO REFERRED YOU */}
            {mine.referrer && (
              <div className="rounded-2xl border border-violet-400/20 bg-violet-400/[0.04] p-5">
                <div className="text-[10px] font-mono font-bold text-[#a78bfa] tracking-widest uppercase mb-2">Who referred you</div>
                <FullAddr addr={mine.referrer} />
                <div className="text-[10px] font-mono text-white/40 leading-relaxed mt-2">
                  This wallet earns a share of the protocol trade fee on your trades. It costs you nothing extra - the total fee is unchanged.
                </div>
              </div>
            )}

            <HowItWorks />
          </>
        )}
      </div>
    </div>
  );
}
