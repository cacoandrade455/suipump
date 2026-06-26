// PointsCounter.jsx — connected-wallet airdrop points, shown in the header
// where the STRATEGIES nav button used to be.
//
// Self-contained: reads the connected account, polls the indexer's
// GET /points/:address, and renders "⚡ <points> pts · #<rank>" in the
// SuiPump lime/black/mono style. Renders nothing when no wallet is connected
// (so the header simply has no counter for logged-out users) and a quiet
// "⚡ — pts" while the first fetch is in flight.
//
// Drop-in: place where the STRATEGIES <Link>/<button> was in App.jsx. It needs
// no props; lang is optional and only affects the (currently English) label.
//
// Endpoint shape (indexer/points.js):
//   GET /points/:address -> { points, rank, buyVolumeSui, buys, distinctTokens,
//                             totalWallets, pointsPerSui }

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { Zap } from 'lucide-react';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';
const REFRESH_MS  = 30_000;

// Compact number formatting to match the rest of the app (12,500 -> 12.5k).
function fmtPoints(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.floor(n));
}

export default function PointsCounter({ lang = 'en' }) {
  const navigate = useNavigate();
  const account  = useCurrentAccount();
  const address  = account?.address ?? null;

  const [points, setPoints] = useState(null);
  const [rank,   setRank]   = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // No wallet -> show nothing. Reset so a disconnect clears stale numbers.
    if (!address || !INDEXER_URL) {
      setPoints(null); setRank(null); setLoaded(false);
      return;
    }
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`${INDEXER_URL}/points/${address}`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`points ${res.status}`);
        const d = await res.json();
        if (cancelled) return;
        setPoints(Number(d.points ?? 0));
        setRank(d.rank ?? null);
        setLoaded(true);
      } catch {
        // Keep last good value on a transient failure; just mark loaded so the
        // counter shows something rather than spinning forever.
        if (!cancelled) setLoaded(true);
      }
    }

    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [address]);

  // Logged-out: render nothing (header simply omits the counter).
  if (!address) return null;

  const label = loaded ? `${fmtPoints(points)} pts` : '— pts';

  return (
    <button
      onClick={() => navigate('/leaderboard')}
      title={rank ? `Airdrop points · rank #${rank}` : 'Airdrop points'}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-lime-400/10 border border-lime-400/30 hover:bg-lime-400/20 transition-colors"
      style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
    >
      <Zap size={13} className="text-lime-400" style={{ filter: 'drop-shadow(0 0 4px rgba(132,204,22,0.5))' }} />
      <span className="text-xs font-bold text-lime-400 tracking-wide">{label}</span>
      {rank != null && (
        <span className="text-[10px] font-mono text-lime-400/60">#{rank}</span>
      )}
    </button>
  );
}
