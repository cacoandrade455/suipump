// AIAnalysis.jsx — AI-powered token analysis card
import React, { useState } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { Sparkles, AlertTriangle, TrendingUp, Minus } from 'lucide-react';
import { PACKAGE_ID } from './constants.js';

function fmt(n, d = 2) {
  if (n == null) return '-';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
}

export default function AIAnalysis({ curveId, name, symbol, progress, reserveSui, creatorFeesSui, graduated, tokensSoldWhole }) {
  const client = useSuiClient();
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  async function fetchTradeStats() {
    try {
      const [buysRes, sellsRes] = await Promise.all([
        client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensPurchased` },
          limit: 50,
        }),
        client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensSold` },
          limit: 50,
        }),
      ]);

      const buyEvents  = (buysRes.data  || []).filter(e => e.parsedJson?.curve_id === curveId);
      const sellEvents = (sellsRes.data || []).filter(e => e.parsedJson?.curve_id === curveId);

      const buys  = buyEvents.length;
      const sells = sellEvents.length;

      // Volume from buy sui_in + sell sui_out
      const volumeSui =
        buyEvents.reduce((acc, e)  => acc + Number(e.parsedJson?.sui_in  ?? 0), 0) / 1e9 +
        sellEvents.reduce((acc, e) => acc + Number(e.parsedJson?.sui_out ?? 0), 0) / 1e9;

      // Approximate holder balances from events
      const balances = {};
      buyEvents.forEach(e => {
        const addr   = e.parsedJson?.buyer;
        const tokens = Number(e.parsedJson?.tokens_out ?? 0);
        if (addr) balances[addr] = (balances[addr] || 0) + tokens;
      });
      sellEvents.forEach(e => {
        const addr   = e.parsedJson?.seller;
        const tokens = Number(e.parsedJson?.tokens_in ?? 0);
        if (addr) balances[addr] = (balances[addr] || 0) - tokens;
      });

      const holders    = Object.values(balances).filter(v => v > 0);
      const holderCount = holders.length;
      const top3        = [...holders].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
      // % of total 1B supply (atomic units = 1B * 1e6)
      const TOTAL_SUPPLY_ATOMIC = 1_000_000_000 * 1e6;
      const topHolderPct = (top3 / TOTAL_SUPPLY_ATOMIC) * 100;

      return { buys, sells, volumeSui, holderCount, topHolderPct };
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
