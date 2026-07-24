// BountyBoard.jsx -- CONTENT BOUNTY subtab body for the leaderboard page.
//
// Renders the live content-bounty leaderboard: a contest header (prize pool,
// dates, countdown to end), the scoring formula stated plainly, a manual submit
// box, and the ranked table (rank, author, post link, the three component
// metrics, total score, and a subtle marker on posts flagged for human review).
//
// Data comes from the indexer's bounty routes (GET /bounty/leaderboard, POST
// /bounty/submit). Terminal aesthetic ported from LeaderboardPage / HolderList /
// BundleBadge (lime-on-void, JetBrains Mono, white/opacity cards). No new
// runtime dependencies: React + fetch + lucide-react (already a dependency).
//
// Honest states: an unreachable endpoint shows an ERROR panel (never an empty
// table masquerading as "no entries"); an empty-but-reachable board shows how to
// enter; a stale board shows its real "LAST UPDATED" time so staleness is
// visible rather than quietly wrong.
import React, { useState, useEffect, useCallback } from 'react';
import { Trophy, ExternalLink, AlertTriangle, Send, RefreshCw } from 'lucide-react';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

// Compact metric formatting (1234 -> 1.2k), matching the board's number style.
function fmt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(v);
}

// Relative "time ago" for the LAST UPDATED line.
function ago(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - Number(ms)) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// Countdown pieces from a target epoch-ms; null once elapsed.
function countdown(targetMs, nowMs) {
  const diff = Number(targetMs) - nowMs;
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  return { d, h, m, s };
}

function fmtDate(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return 'TBA';
  return new Date(v).toISOString().slice(0, 10);
}

const RANK_COLORS = { 1: 'text-yellow-400', 2: 'text-white/60', 3: 'text-amber-600' };
const RANK_RING = {
  1: 'border-yellow-400/30 bg-yellow-400/[0.05]',
  2: 'border-white/15 bg-white/[0.03]',
  3: 'border-amber-600/25 bg-amber-600/[0.05]',
};

function SuspiciousFlag() {
  return (
    <span
      title="Unusual engagement spike flagged for manual review. Winners are chosen by a human; this is not an automatic disqualification."
      className="inline-flex items-center gap-1 shrink-0 border rounded-full px-1.5 py-0.5 text-[7.5px] font-mono font-bold tracking-wide border-amber-500/35 bg-amber-500/[0.08] text-[#f59e0b]"
    >
      <AlertTriangle size={8} />
      REVIEW
    </span>
  );
}

export default function BountyBoard() {
  const [data, setData] = useState(null);     // { updated_ms, contest, entries }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Submit box state.
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState(null); // { ok:boolean, text:string }

  const load = useCallback(async () => {
    if (!INDEXER_URL) { setError(true); setLoading(false); return; }
    try {
      const res = await fetch(`${INDEXER_URL}/bounty/leaderboard?limit=100`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error('bad status ' + res.status);
      const json = await res.json();
      setData(json);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(load, 60_000);   // refresh the board each minute
    const clock = setInterval(() => setNow(Date.now()), 1000); // countdown ticks
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [load]);

  async function submit(e) {
    e.preventDefault();
    const value = url.trim();
    if (!value) { setSubmitMsg({ ok: false, text: 'Paste an x.com post link first.' }); return; }
    if (!/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(value)) {
      setSubmitMsg({ ok: false, text: 'That is not a valid x.com/twitter.com status link.' });
      return;
    }
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      const res = await fetch(`${INDEXER_URL}/bounty/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_url: value }),
        signal: AbortSignal.timeout(15000),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setSubmitMsg({ ok: true, text: 'Submitted. It will appear on the board at the next scoring pass.' });
        setUrl('');
        load();
      } else {
        setSubmitMsg({ ok: false, text: json.error || ('Submit failed (' + res.status + ').') });
      }
    } catch {
      setSubmitMsg({ ok: false, text: 'Could not reach the tracker. Try again shortly.' });
    } finally {
      setSubmitting(false);
    }
  }

  const contest = data?.contest ?? null;
  const entries = data?.entries ?? [];
  const cd = contest ? countdown(contest.end_ms, now) : null;
  const started = contest && contest.start_ms > 0 ? now >= contest.start_ms : true;
  const preStart = contest && contest.start_ms > 0 && now < contest.start_ms;
  const preCd = preStart ? countdown(contest.start_ms, now) : null;

  return (
    <div className="p-4 space-y-4">

      {/* Contest header */}
      <div className="rounded-xl border border-lime-400/20 bg-lime-400/[0.04] p-4 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-40 h-16 bg-lime-400/[0.10] blur-3xl rounded-full pointer-events-none" />
        <div className="relative">
          <div className="flex items-center gap-2 mb-2">
            <Trophy className="text-lime-400" size={16} />
            <h2 className="text-sm font-extrabold font-mono tracking-tight text-white">CONTENT BOUNTY</h2>
            <span className="text-[9px] font-mono text-lime-400/70 border border-lime-400/25 rounded px-1.5 py-0.5">2 WEEKS</span>
          </div>
          <p className="text-[10.5px] font-mono text-white/40 leading-relaxed max-w-xl">
            Post about SuiPump on X. Best-performing posts win. We discover posts automatically and you can submit your own below.
          </p>

          {/* Prizes */}
          <div className="flex flex-wrap gap-2 mt-3">
            {(contest?.prizes ?? [{ rank: 1, usd: 100 }, { rank: 2, usd: 75 }, { rank: 3, usd: 25 }]).map(p => (
              <div key={p.rank} className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 ${RANK_RING[p.rank] || 'border-white/10 bg-white/[0.02]'}`}>
                <span className={`text-xs font-mono font-bold ${RANK_COLORS[p.rank] || 'text-white/50'}`}>#{p.rank}</span>
                <span className="text-sm font-mono font-extrabold text-white">${p.usd}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-1.5">
              <span className="text-[9px] font-mono text-white/35">POOL</span>
              <span className="text-sm font-mono font-extrabold text-lime-400">${contest?.pool_usd ?? 200}</span>
            </div>
          </div>

          {/* Dates + countdown */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[10px] font-mono text-white/45">
            <span>{fmtDate(contest?.start_ms)} {'->'} {fmtDate(contest?.end_ms)}</span>
            {preStart ? (
              <span className="text-white/60">STARTS IN {preCd ? `${preCd.d}d ${preCd.h}h ${preCd.m}m` : 'soon'}</span>
            ) : cd ? (
              <span className="text-lime-400/80">ENDS IN {cd.d}d {String(cd.h).padStart(2, '0')}h {String(cd.m).padStart(2, '0')}m {String(cd.s).padStart(2, '0')}s</span>
            ) : contest && contest.end_ms > 0 ? (
              <span className="text-red-400/80">CONTEST ENDED</span>
            ) : (
              <span className="text-white/40">DATES TBA</span>
            )}
          </div>
        </div>
      </div>

      {/* Scoring formula */}
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
        <div className="text-[9px] font-mono font-semibold text-white/35 tracking-[0.14em] mb-1.5">HOW POSTS ARE SCORED</div>
        <div className="font-mono text-xs text-white/80">
          SCORE = <span className="text-lime-400">REPOSTS</span> x{contest?.scoring?.retweets ?? 3}
          {' + '}<span className="text-lime-400">LIKES</span> x{contest?.scoring?.likes ?? 2}
          {' + '}<span className="text-lime-400">REPLIES</span> x{contest?.scoring?.replies ?? 1}
        </div>
        <div className="text-[9.5px] font-mono text-white/30 mt-1.5 leading-relaxed">
          Scored from each post{"'"}s latest snapshot. We keep the full engagement history, so implausible spikes get flagged
          for manual review and marked REVIEW below. Winners are chosen by a human; flags are not automatic disqualification.
        </div>
      </div>

      {/* Submit box */}
      <form onSubmit={submit} className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
        <div className="text-[9px] font-mono font-semibold text-white/35 tracking-[0.14em] mb-2">SUBMIT YOUR POST</div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={url}
            onChange={e => { setUrl(e.target.value); setSubmitMsg(null); }}
            placeholder="https://x.com/you/status/123..."
            className="flex-1 min-w-0 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-white/80 placeholder:text-white/20 focus:border-lime-400/40 focus:outline-none"
          />
          <button
            type="submit"
            disabled={submitting}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 text-[10px] font-mono font-bold px-4 py-2 rounded-lg border border-lime-400/30 bg-lime-400/[0.10] text-lime-400 hover:bg-lime-400/[0.18] disabled:opacity-40 transition-colors"
          >
            <Send size={11} /> {submitting ? 'SUBMITTING...' : 'SUBMIT'}
          </button>
        </div>
        {submitMsg && (
          <div className={`text-[10px] font-mono mt-2 ${submitMsg.ok ? 'text-lime-400' : 'text-red-400'}`}>
            {submitMsg.text}
          </div>
        )}
      </form>

      {/* Last updated + manual refresh */}
      <div className="flex items-center justify-between px-1">
        <div className="text-[9.5px] font-mono text-white/30">
          LAST UPDATED <span className={data?.updated_ms ? 'text-white/50' : 'text-white/30'}>{data?.updated_ms ? ago(data.updated_ms) : 'never'}</span>
        </div>
        <button onClick={load} className="inline-flex items-center gap-1 text-[9.5px] font-mono text-white/30 hover:text-lime-400 transition-colors">
          <RefreshCw size={10} /> REFRESH
        </button>
      </div>

      {/* Board body: error / loading / empty / rows */}
      {error ? (
        <div className="rounded-xl border border-red-400/20 bg-red-400/[0.04] py-8 px-4 text-center">
          <div className="text-xs font-mono text-red-400/90 mb-1">Could not reach the bounty tracker.</div>
          <div className="text-[10px] font-mono text-white/35">The leaderboard is temporarily unavailable, not empty. Try REFRESH.</div>
        </div>
      ) : loading ? (
        <div className="py-10 text-center text-xs font-mono text-white/25">Loading leaderboard...</div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.015] py-10 px-4 text-center">
          <div className="text-xs font-mono text-white/50 mb-1">No entries yet.</div>
          <div className="text-[10px] font-mono text-white/35 leading-relaxed max-w-sm mx-auto">
            Post about SuiPump on X and it will be discovered automatically, or paste your link in SUBMIT YOUR POST above to enter now.
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.015] overflow-hidden divide-y divide-white/[0.04]">
          {entries.map(e => {
            const top = e.rank <= 3;
            return (
              <div key={e.post_id} className={`flex items-center gap-3 px-4 py-3 ${top ? (RANK_RING[e.rank] || '') : ''}`}>
                <span className={`w-6 shrink-0 text-center text-xs font-mono font-bold ${RANK_COLORS[e.rank] || 'text-white/25'}`}>
                  {e.rank}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <a
                      href={e.post_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-mono font-semibold text-white/85 hover:text-lime-400 transition-colors truncate inline-flex items-center gap-1"
                    >
                      @{e.author_handle}
                      <ExternalLink size={9} className="opacity-40 shrink-0" />
                    </a>
                    {e.suspicious && <SuspiciousFlag />}
                  </div>
                  {e.text && (
                    <div className="text-[9.5px] font-mono text-white/30 mt-1 truncate">{e.text}</div>
                  )}
                  <div className="flex items-center gap-2.5 mt-1.5 text-[9.5px] font-mono text-white/40">
                    <span title="reposts"><span className="text-white/25">RT</span> {fmt(e.retweets)}</span>
                    <span title="likes"><span className="text-white/25">LK</span> {fmt(e.likes)}</span>
                    <span title="replies"><span className="text-white/25">RE</span> {fmt(e.replies)}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-mono font-extrabold text-lime-400">{fmt(e.score)}</div>
                  <div className="text-[8.5px] font-mono text-white/25 mt-0.5">SCORE</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
