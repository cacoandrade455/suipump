// S1AirdropCounter.jsx — SSE real-time, no polling
import React, { useState, useEffect, useRef } from 'react';

const INDEXER_URL  = import.meta.env.VITE_INDEXER_URL || '';
const MIST_PER_SUI = 1e9;

async function fetchSuiUsd() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    return parseFloat((await r.json()).price) || 0;
  } catch { return 0; }
}

function fmtSui(sui) {
  if (sui >= 1000) return `${sui.toFixed(2)} SUI`;
  return `${sui.toFixed(4)} SUI`;
}
function fmtUsd(usd) {
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(2)}k`;
  return `$${usd.toFixed(2)}`;
}

export default function S1AirdropCounter() {
  const [poolSui,    setPoolSui]    = useState(0);
  const [volumeSui,  setVolumeSui]  = useState(0);
  const [tradeCount, setTradeCount] = useState(0);
  const [suiUsd,     setSuiUsd]     = useState(0);
  const [loading,    setLoading]    = useState(true);
  const esRef    = useRef(null);
  const timerRef = useRef(null);

  // SUI/USD price every 30s
  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const t = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(t);
  }, []);

  // Initial load
  useEffect(() => {
    if (!INDEXER_URL) return;
    fetch(`${INDEXER_URL}/stats`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        setPoolSui(d.s1PoolSui   ?? 0);
        setVolumeSui(d.totalVolume ?? 0);
        setTradeCount(d.totalTrades ?? 0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // SSE — update on every trade
  useEffect(() => {
    if (!INDEXER_URL) return;

    function connect() {
      const es = new EventSource(`${INDEXER_URL}/stream`);
      esRef.current = es;

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'connected') return;
          const isTrade = event.type === 'TokensPurchased' ||
                          event.type === 'TokensBought'    ||
                          event.type === 'TokensSold';
          if (!isTrade) return;

          const d      = event.data ?? {};
          const isBuy  = event.type !== 'TokensSold';
          const sui    = Number(isBuy ? d.sui_in ?? 0 : d.sui_out ?? 0) / MIST_PER_SUI;
          const proto  = Number(d.protocol_fee ?? 0) / MIST_PER_SUI;

          setVolumeSui(prev => prev + sui);
          setPoolSui(prev => prev + proto * 0.5);
          setTradeCount(prev => prev + 1);
        } catch {}
      };

      es.onerror = () => {
        es.close();
        timerRef.current = setTimeout(connect, 3_000);
      };
    }

    connect();
    return () => { esRef.current?.close(); clearTimeout(timerRef.current); };
  }, []);

  const poolUsd   = poolSui   * suiUsd;
  const volumeUsd = volumeSui * suiUsd;

  return (
    <div className="border border-lime-500/30 bg-gradient-to-br from-lime-950/20 to-black p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono tracking-widest text-lime-400 mb-1">
            🎁 SEASON 1 AIRDROP POOL
          </div>
          <div className="text-[10px] font-mono text-lime-900">
            EST. 50% OF PROTOCOL FEES · DISTRIBUTED AT SEASON CLOSE
          </div>
        </div>
        <div className="text-[9px] font-mono text-amber-800 border border-amber-900/40 px-2 py-1 text-right">
          TESTNET PREVIEW<br />MAINNET S1 TBD
        </div>
      </div>

      <div className="mb-4">
        {loading ? (
          <div className="h-8 bg-lime-950/30 rounded animate-pulse w-32" />
        ) : (
          <>
            <div className="text-3xl font-bold font-mono text-lime-400">
              {suiUsd > 0 ? fmtUsd(poolUsd) : fmtSui(poolSui)}
            </div>
            {suiUsd > 0 && (
              <div className="text-xs font-mono text-lime-800 mt-0.5">{fmtSui(poolSui)}</div>
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 text-[10px] font-mono">
        <div className="bg-lime-950/20 border border-lime-900/30 rounded-lg p-2.5">
          <div className="text-lime-900 mb-1">TOTAL VOLUME</div>
          <div className="text-lime-400 font-bold">
            {suiUsd > 0 ? fmtUsd(volumeUsd) : fmtSui(volumeSui)}
          </div>
        </div>
        <div className="bg-lime-950/20 border border-lime-900/30 rounded-lg p-2.5">
          <div className="text-lime-900 mb-1">TOTAL TRADES</div>
          <div className="text-lime-400 font-bold">{tradeCount.toLocaleString()}</div>
        </div>
      </div>
    </div>
  );
}
