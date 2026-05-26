// useTokenStats.js
// Loads all token stats from indexer on mount, then updates in real-time
// via SSE — only re-fetches stats for the specific curve that traded.
import { useState, useEffect, useRef } from 'react';


const INDEXER_URL  = import.meta.env.VITE_INDEXER_URL || '';
const MIST_PER_SUI = 1e9;

function mapIndexerRow(s, holderCounts) {
  // api.js sends start_price = vSui/1B for all tokens (even zero-trade)
  // and last_price using (vSui + reserve) / 1B formula (correct, matches OHLC)
  const lastPrice  = s.last_price  ?? s.start_price ?? null;
  const firstPrice = s.first_price ?? s.start_price ?? null;
  return {
    volume:        s.volume_sui,
    trades:        s.trades,
    buys:          s.buys,
    sells:         s.sells,
    recentTrades:  s.recent_trades,
    lastTradeTime: s.last_trade_time,
    lastPrice,
    firstPrice,
    volume24h:     s.volume_24h,
    commentCount:  s.comment_count,
    pctChange:     firstPrice && lastPrice && firstPrice > 0
      ? ((lastPrice - firstPrice) / firstPrice) * 100
      : null,
    sparkline24h:  s.sparkline24h || [],
    holderCount:   holderCounts?.[s.curve_id] ?? 0,
    devBuyMist:    0,
  };
}

export function useTokenStats(tokens) {
  const [stats, setStats] = useState({});
  const esRef           = useRef(null);
  const timerRef        = useRef(null);

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!tokens || tokens.length === 0) return;
    if (!INDEXER_URL) return;

    fetch(`${INDEXER_URL}/tokens/stats`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : [])
      .then(rows => {
        const map = {};
        for (const s of rows) {
          map[s.curve_id] = mapIndexerRow(s);
        }
        setStats(map);
      })
      .catch(() => {});
  }, [tokens?.length]);

  // ── SSE: update stats for any curve that gets a new trade ─────────────────
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
          if (!isTrade || !event.curveId) return;

          const curveId = event.curveId;
          const isBuy   = event.type !== 'TokensSold';
          const d       = event.data ?? {};
          const sui     = Number(isBuy ? d.sui_in ?? 0 : d.sui_out ?? 0) / MIST_PER_SUI;
          const tok     = Number(isBuy ? d.tokens_out ?? 0 : d.tokens_in ?? 0) / 1e6;

          setStats(prev => {
            const cur = prev[curveId] ?? {
              volume: 0, trades: 0, buys: 0, sells: 0,
              recentTrades: 0, lastTradeTime: null,
              lastPrice: null, firstPrice: null,
              volume24h: 0, commentCount: 0, pctChange: null,
              sparkline24h: [], holderCount: 0, devBuyMist: 0,
            };
            // Use (vSui + new_sui_reserve) / 1B — matches OHLC chart exactly
            const token = tokens?.find(t => t.curveId === curveId);
            const { virtualSui: vSui } = curveShapeFor(token?.packageId);
            const newReserveMist = Number(d.new_sui_reserve ?? 0);
            const price = newReserveMist > 0
              ? (vSui + newReserveMist / MIST_PER_SUI) / 1_000_000_000
              : cur.lastPrice;
            const now        = Date.now();
            const oneDayAgo  = now - 86_400_000;
            const tsMs       = event.ts ?? now;
            const inDay      = tsMs > oneDayAgo;
            const pctChange  = cur.firstPrice && price && cur.firstPrice > 0
              ? ((price - cur.firstPrice) / cur.firstPrice) * 100
              : cur.pctChange;

            return {
              ...prev,
              [curveId]: {
                ...cur,
                volume:        cur.volume + sui,
                trades:        cur.trades + 1,
                buys:          isBuy ? cur.buys + 1 : cur.buys,
                sells:         isBuy ? cur.sells : cur.sells + 1,
                recentTrades:  cur.recentTrades + 1,
                lastTradeTime: tsMs,
                lastPrice:     price ?? cur.lastPrice,
                firstPrice:    cur.firstPrice ?? price,
                volume24h:     inDay ? cur.volume24h + sui : cur.volume24h,
                pctChange,
                sparkline24h:  inDay && price
                  ? [...(cur.sparkline24h || []), { t: tsMs, p: price }].slice(-100)
                  : cur.sparkline24h,
              },
            };
          });

          fetch(`${INDEXER_URL}/token/${curveId}/stats`)
            .then(r => r.ok ? r.json() : null)
            .then(s => {
              if (!s) return;
              setStats(prev => ({
                ...prev,
                [curveId]: mapIndexerRow(s),
              }));
            })
            .catch(() => {});

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

  return stats;
}
