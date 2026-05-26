// useTokenStats.js
// Loads all token stats from indexer on mount, then updates in real-time
// via SSE — only re-fetches stats for the specific curve that traded.
import { useState, useEffect, useRef } from 'react';
import { useCurrentClient } from '@mysten/dapp-kit-react';

const INDEXER_URL  = import.meta.env.VITE_INDEXER_URL || '';
const MIST_PER_SUI = 1e9;

// ── Holder count (RPC, runs every 60s) ────────────────────────────────────────
async function fetchHolderCount(client, coinType) {
  const holders = new Set();
  let cursor = null;
  let pages  = 0;
  while (pages < 20) {
    let result;
    try {
      // New API: listCoins
      result = await client.listCoins({ owner: '0x0', coinType, cursor, limit: 50 });
    } catch { break; }
    for (const coin of result.objects ?? []) {
      if (coin.balance && coin.balance !== '0') {
        holders.add(coin.objectId);
        if (coin.owner) {
          const ownerAddr = coin.owner?.$kind === 'AddressOwner'
            ? coin.owner.AddressOwner
            : coin.owner?.$kind === 'ObjectOwner'
              ? coin.owner.ObjectOwner
              : null;
          if (ownerAddr) holders.add(ownerAddr);
        }
      }
    }
    if (!result.hasNextPage) break;
    cursor = result.cursor;
    pages++;
  }
  return holders.size;
}

function mapIndexerRow(s, holderCounts) {
  return {
    volume:        s.volume_sui,
    trades:        s.trades,
    buys:          s.buys,
    sells:         s.sells,
    recentTrades:  s.recent_trades,
    lastTradeTime: s.last_trade_time,
    lastPrice:     s.last_price,
    firstPrice:    s.first_price,
    volume24h:     s.volume_24h,
    commentCount:  s.comment_count,
    pctChange:     s.first_price && s.last_price && s.first_price > 0
      ? ((s.last_price - s.first_price) / s.first_price) * 100
      : null,
    sparkline24h:  s.sparkline24h || [],
    holderCount:   holderCounts[s.curve_id] ?? 0,
    devBuyMist:    0,
  };
}

export function useTokenStats(tokens) {
  const client          = useCurrentClient();
  const [stats, setStats] = useState({});
  const holderCountsRef = useRef({});
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
          map[s.curve_id] = mapIndexerRow(s, holderCountsRef.current);
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
            const price      = tok > 0 ? sui / tok : cur.lastPrice;
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
                [curveId]: mapIndexerRow(s, holderCountsRef.current),
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

  // ── Holder count (RPC, 60s) ───────────────────────────────────────────────
  useEffect(() => {
    if (!tokens || tokens.length === 0) return;
    const queryable = tokens.filter(t => t.tokenType);
    if (queryable.length === 0) return;
    let cancelled = false;

    async function loadHolders() {
      for (const token of queryable) {
        if (cancelled) return;
        try {
          const count = await fetchHolderCount(client, token.tokenType);
          if (cancelled) return;
          holderCountsRef.current[token.curveId] = count;
          setStats(prev => {
            if (!prev[token.curveId]) return prev;
            return { ...prev, [token.curveId]: { ...prev[token.curveId], holderCount: count } };
          });
        } catch {}
        await new Promise(r => setTimeout(r, 300));
      }
    }

    const initial  = setTimeout(loadHolders, 5_000);
    const interval = setInterval(loadHolders, 60_000);
    return () => { cancelled = true; clearTimeout(initial); clearInterval(interval); };
  }, [tokens, client]);

  return stats;
}
