// AIAnalysis.jsx — AI-powered token analysis card
import React, { useState } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { Sparkles, AlertTriangle, TrendingUp, Minus } from 'lucide-react';
import { ALL_PACKAGE_IDS } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';
const TOKEN_SCALE = 1e6;

function fmt(n, d = 2) {
  if (n == null) return '-';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
}

export default function AIAnalysis({ curveId, tokenType, name, symbol, progress, reserveSui, creatorFeesSui, graduated, tokensSoldWhole }) {
  const client = useSuiClient();
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  // Fetches trade + holder stats from the SAME source HolderList uses
  // (indexer first, RPC fallback) so the AI's numbers match the holder list.
  async function fetchTradeStats() {
    try {
      let buys = [], sells = [];

      // ── Indexer path (complete data, up to 500 trades) ──────────────────
      if (INDEXER_URL) {
        try {
          const res = await fetch(`${INDEXER_URL}/token/${curveId}/trades?limit=500`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const rows = await res.json();
            buys  = rows.filter(r => r.event_type.includes('TokensPurchased'))
                        .map(r => ({ parsedJson: { ...r.data, curve_id: curveId } }));
            sells = rows.filter(r => r.event_type.includes('TokensSold'))
                        .map(r => ({ parsedJson: { ...r.data, curve_id: curveId } }));
          }
        } catch {}
      }

      // ── RPC fallback — all package versions (v4/v5/v6) ──────────────────
      if (buys.length === 0 && sells.length === 0) {
        const buyTypes  = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensPurchased`);
        const sellTypes = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensSold`);
        const eventMap  = await paginateMultipleEvents(client, [...buyTypes, ...sellTypes], { order: 'descending', maxPages: 20 });
        buys  = buyTypes.flatMap(bt  => (eventMap[bt]  || []).filter(e => e.parsedJson?.curve_id === curveId));
        sells = sellTypes.flatMap(st => (eventMap[st] || []).filter(e => e.parsedJson?.curve_id === curveId));
      }

      const buyCount  = buys.length;
      const sellCount = sells.length;

      // Volume from buy sui_in + sell sui_out (event-derived = exact)
      const volumeSui =
        buys.reduce((acc, e)  => acc + Number(e.parsedJson?.sui_in  ?? 0), 0) / 1e9 +
        sells.reduce((acc, e) => acc + Number(e.parsedJson?.sui_out ?? 0), 0) / 1e9;

      // Holder balances — REAL on-chain balances, not netted trade events.
      // Netting events is wrong: a wallet that sold tokens acquired before
      // the queried window nets negative while still holding a real balance.
      // We collect every address that ever traded (candidates), then query
      // each one's actual current balance. Identical method to HolderList.
      const candidates = new Set();
      for (const e of buys)  { const a = e.parsedJson?.buyer;  if (a) candidates.add(a); }
      for (const e of sells) { const a = e.parsedJson?.seller; if (a) candidates.add(a); }

      let holderRaws = [];
      if (tokenType && candidates.size > 0) {
        const balances = await Promise.all(
          [...candidates].map(async (addr) => {
            try {
              const bal = await client.getBalance({ owner: addr, coinType: tokenType });
              return BigInt(bal.totalBalance ?? '0');
            } catch {
              return 0n;
            }
          })
        );
        holderRaws = balances.filter(v => v > 0n);
      }

      const holderCount = holderRaws.length;

      // Top-3 concentration as % of total 1B supply
      const TOTAL_SUPPLY_ATOMIC = 1_000_000_000 * TOKEN_SCALE;
      const top3 = [...holderRaws].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0)).slice(0, 3)
        .reduce((a, b) => a + b, 0n);
      const topHolderPct = (Number(top3) / TOTAL_SUPPLY_ATOMIC) * 100;

      return { buys: buyCount, sells: sellCount, volumeSui, holderCount, topHolderPct };
    } catch {
      return { buys: 0, sells: 0, volumeSui: 0, holderCount: 0, topHolderPct: 0 };
    }
  }

  const getRiskColor = (text) => {
    if (!text) return 'text-white/50';
    const lower = text.toLowerCase();
    if (lower.includes('low'))    return 'text-lime-400';
    if (lower.includes('high'))   return 'text-red-400';
    if (lower.includes('medium')) return 'text-yellow-400';
    return 'text-white/50';
  };

  const getRiskIcon = (text) => {
    if (!text) return null;
    const lower = text.toLowerCase();
    if (lower.includes('low'))    return <TrendingUp  size={11} className="text-lime-400"   />;
    if (lower.includes('high'))   return <AlertTriangle size={11} className="text-red-400"  />;
    if (lower.includes('medium')) return <Minus        size={11} className="text-yellow-400" />;
    return null;
  };

  const analyze = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setDone(false);

    try {
      const { buys, sells, volumeSui, holderCount, topHolderPct } = await fetchTradeStats();
      const totalTrades  = buys + sells;
      const buySellRatio = sells > 0 ? ((buys / sells) * 100).toFixed(0) : '100';

      const prompt = `You are a DeFi token analyst on SuiPump, a bonding curve token launchpad on the Sui blockchain.

Analyze this token and write exactly 3 sentences covering: (1) holder concentration risk, (2) trading momentum, (3) one specific thing to watch. Then on a new line write ONLY the risk rating in this exact format: "Risk: Low" or "Risk: Medium" or "Risk: High". No fluff, no intro, be direct and specific.

IMPORTANT framing rules:
- If the token has zero or very few trades and holders, do NOT describe it as "fairly distributed" or "no concentration risk" — a token with no activity is not well-distributed, it is simply untested. Frame it as "too early to assess distribution" instead.
- Lack of trading activity is itself the primary risk for an early-stage token; say so plainly.
- Never present an absence of data as a positive signal.

Token data:
- Name: ${name} ($${symbol})
- Status: ${graduated ? 'GRADUATED — now trading on Cetus DEX' : 'Active on bonding curve'}
- Curve progress: ${fmt(progress, 1)}% filled (${fmt(reserveSui, 1)} SUI raised of ~35,000 SUI target)
- Holders: ${holderCount}
- Top holder concentration: ${fmt(topHolderPct, 1)}% of total 1B supply held by top 3 wallets
- Total trades: ${totalTrades} (${buys} buys / ${sells} sells)
- Buy/sell ratio: ${buySellRatio}% buys
- Volume: ${fmt(volumeSui, 2)} SUI
- Creator fees earned: ${fmt(creatorFeesSui, 3)} SUI (this is normal protocol revenue, not a risk signal)`;

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Analysis failed');
      setResult(data.result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setDone(true);
    }
  };

  const lines        = result ? result.split('\n').filter(Boolean) : [];
  const riskLine     = lines.find(l => l.toLowerCase().startsWith('risk:'));
  const analysisLines = lines.filter(l => !l.toLowerCase().startsWith('risk:'));
  const riskText     = riskLine ? riskLine.replace(/^risk:\s*/i, '').trim() : null;

  return (
    <div className="border border-white/10 rounded-lg p-4 bg-black/40">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles size={11} className="text-lime-400" />
          <span className="text-[10px] font-mono text-white/35 tracking-widest">AI ANALYSIS</span>
        </div>
        {!loading && !done && (
          <button
            onClick={analyze}
            className="text-[10px] font-mono font-bold tracking-widest px-3 py-1.5 rounded border border-lime-400/60 text-lime-400 hover:bg-lime-400/10 transition-colors"
          >
            ANALYZE
          </button>
        )}
        {done && !loading && (
          <button
            onClick={analyze}
            className="text-[9px] font-mono text-white/25 hover:text-white/50 transition-colors"
          >
            REFRESH
          </button>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 py-2">
          <div className="flex gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <span className="text-[10px] font-mono text-white/35">Analyzing on-chain data…</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-[11px] font-mono text-red-400/80 py-1">
          Analysis unavailable. Try again.
        </div>
      )}

      {/* Result */}
      {result && !loading && (
        <div className="space-y-2">
          <p className="text-[11px] font-mono text-white/70 leading-relaxed">
            {analysisLines.join(' ')}
          </p>
          {riskText && (
            <div className="flex items-center gap-1.5 pt-1 border-t border-white/5 mt-2">
              {getRiskIcon(riskText)}
              <span className={`text-[10px] font-mono font-bold tracking-widest ${getRiskColor(riskText)}`}>
                {riskText.toUpperCase()} RISK
              </span>
            </div>
          )}
        </div>
      )}

      {/* Idle */}
      {!loading && !result && !error && (
        <p className="text-[10px] font-mono text-white/25 leading-relaxed">
          Get an AI-generated risk assessment based on holder concentration, trading momentum, and curve progress.
        </p>
      )}

      <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-end">
        <span className="text-[9px] font-mono text-white/15 tracking-widest">ANALYSIS BY CLAUDE · ANTHROPIC</span>
      </div>
    </div>
  );
}
