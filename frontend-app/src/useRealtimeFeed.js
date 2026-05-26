// useRealtimeFeed.js
// Subscribes to the indexer SSE /stream endpoint for real-time updates.
// Replaces polling in TradeHistory, PriceChart, LiveFeedSidebar, useTokenStats.
//
// Usage:
//   const { trades, connected } = useRealtimeFeed(curveId);
//   const { events, connected } = useRealtimeFeed(); // all events

import { useState, useEffect, useRef, useCallback } from 'react';

const INDEXER_URL  = import.meta.env.VITE_INDEXER_URL || '';
const MIST_PER_SUI = 1e9;
const RECONNECT_MS = 3_000;
const MAX_TRADES   = 200;

function parseTrade(event) {
  const d    = event.data ?? {};
  const isBuy = event.type === 'TokensPurchased' || event.type === 'TokensBought';
  return {
    kind:     isBuy ? 'buy' : 'sell',
    sui:      isBuy ? Number(d.sui_in  ?? 0) / MIST_PER_SUI : Number(d.sui_out ?? 0) / MIST_PER_SUI,
    tokens:   isBuy ? Number(d.tokens_out ?? 0) / 1e6       : Number(d.tokens_in  ?? 0) / 1e6,
    who:      d.buyer ?? d.seller ?? null,
    ts:       event.ts ?? null,
    curveId:  event.curveId,
    eventType: event.eventType,
  };
}

// ── useRealtimeFeed ───────────────────────────────────────────────────────────
// curveId: optional — if provided, only emits events for that curve
// Returns { trades, latestEvent, connected, stats }

export function useRealtimeFeed(curveId = null) {
  const [trades,      setTrades]      = useState([]);
  const [latestEvent, setLatestEvent] = useState(null);
  const [connected,   setConnected]   = useState(false);
  const [stats,       setStats]       = useState(null);
  const esRef    = useRef(null);
  const timerRef = useRef(null);

  const connect = useCallback(() => {
    if (!INDEXER_URL) return;

    const url = curveId
      ? `${INDEXER_URL}/stream?curveId=${curveId}`
      : `${INDEXER_URL}/stream`;

    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === 'connected') return;

        setLatestEvent(event);

        const isTrade = event.type === 'TokensPurchased' ||
                        event.type === 'TokensBought'    ||
                        event.type === 'TokensSold';

        if (isTrade) {
          const trade = parseTrade(event);
          setTrades(prev => [trade, ...prev].slice(0, MAX_TRADES));

          // Update inline stats
          setStats(prev => {
            if (!prev) return prev;
            const isBuy = trade.kind === 'buy';
            return {
              ...prev,
              trades:    (prev.trades    ?? 0) + 1,
              buys:      isBuy ? (prev.buys  ?? 0) + 1 : (prev.buys  ?? 0),
              sells:     isBuy ? (prev.sells ?? 0)     : (prev.sells ?? 0) + 1,
              volume_sui: (prev.volume_sui ?? 0) + trade.sui,
              last_price: trade.tokens > 0 ? trade.sui / trade.tokens : prev.last_price,
            };
          });
        }
      } catch {}
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      // Reconnect after delay
      timerRef.current = setTimeout(connect, RECONNECT_MS);
    };
  }, [curveId]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      clearTimeout(timerRef.current);
    };
  }, [connect]);

  return { trades, latestEvent, connected, stats, setStats };
}

// ── useTokenPageFeed ──────────────────────────────────────────────────────────
// Single SSE connection + parallel HTTP backfill for a token page.
// SSE and HTTP fetch start simultaneously — loading clears as soon as either
// resolves, so the first trade event from SSE renders instantly with no gate.
// Trades are deduplicated by tx_digest+ts so HTTP backfill never doubles SSE events.
// Exposes latestOhlcPoint so useTPSL can consume price updates without its own connection.

export function useTokenPageFeed(curveId) {
  const [trades,          setTrades]          = useState([]);
  const [ohlc,            setOhlc]            = useState([]);
  const [loading,         setLoading]         = useState(true);
  const [connected,       setConnected]       = useState(false);
  const [latestOhlcPoint, setLatestOhlcPoint] = useState(null);

  const esRef       = useRef(null);
  const timerRef    = useRef(null);
  const seenRef     = useRef(new Set());   // tx_digest+ts dedup
  const loadingRef  = useRef(true);        // mirror of loading for use inside closures

  useEffect(() => {
    if (!curveId || !INDEXER_URL) return;
    let cancelled = false;

    // ── SSE — starts immediately, clears loading on first trade ──────────────
    function connect() {
      const es = new EventSource(`${INDEXER_URL}/stream?curveId=${curveId}`);
      esRef.current = es;

      es.onopen = () => setConnected(true);

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'connected') return;

          const isTrade = event.type === 'TokensPurchased' ||
                          event.type === 'TokensBought'    ||
                          event.type === 'TokensSold';
          if (!isTrade) return;

          // Clear loading on first SSE trade — no need to wait for HTTP
          if (loadingRef.current) {
            loadingRef.current = false;
            if (!cancelled) setLoading(false);
          }

          const isBuy  = event.type !== 'TokensSold';
          const d      = event.data ?? {};
          const dedupKey = `${d.tx_digest ?? event.ts}_${event.ts}`;

          // Skip if HTTP backfill already delivered this trade
          if (seenRef.current.has(dedupKey)) return;
          seenRef.current.add(dedupKey);

          const trade = {
            id:      dedupKey,
            kind:    isBuy ? 'buy' : 'sell',
            sui:     isBuy ? Number(d.sui_in  ?? 0) / MIST_PER_SUI : Number(d.sui_out ?? 0) / MIST_PER_SUI,
            tokens:  isBuy ? Number(d.tokens_out ?? 0) / 1e6       : Number(d.tokens_in  ?? 0) / 1e6,
            who:     d.buyer ?? d.seller ?? null,
            ts:      event.ts,
            curveId,
          };

          if (!cancelled) setTrades(prev => [trade, ...prev].slice(0, MAX_TRADES));

          // OHLC point for chart + TP/SL
          if (trade.tokens > 0) {
            const pt = { time: Math.floor(event.ts / 1000), price: trade.sui / trade.tokens, kind: trade.kind };
            if (!cancelled) {
              setOhlc(prev => [...prev, pt]);
              setLatestOhlcPoint(pt);
            }
          }
        } catch {}
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        timerRef.current = setTimeout(connect, RECONNECT_MS);
      };
    }

    connect();

    // ── HTTP backfill — runs in parallel, merges with SSE trades ─────────────
    async function fetchBackfill() {
      try {
        const [tradesRes, ohlcRes] = await Promise.all([
          fetch(`${INDEXER_URL}/token/${curveId}/trades?limit=200`),
          fetch(`${INDEXER_URL}/token/${curveId}/ohlc`),
        ]);

        if (tradesRes.ok && !cancelled) {
          const rows = await tradesRes.json();
          const items = rows.map(r => {
            const isBuy = r.event_type?.includes('TokensPurchased');
            const key   = `${r.tx_digest ?? r.curve_id}_${r.timestamp_ms}`;
            seenRef.current.add(key);
            return {
              id:     key,
              kind:   isBuy ? 'buy' : 'sell',
              sui:    Number(isBuy ? r.data.sui_in ?? 0 : r.data.sui_out ?? 0) / MIST_PER_SUI,
              tokens: Number(isBuy ? r.data.tokens_out ?? 0 : r.data.tokens_in ?? 0) / 1e6,
              who:    r.data.buyer ?? r.data.seller,
              ts:     r.timestamp_ms ? Number(r.timestamp_ms) : null,
              curveId,
            };
          });
          // Merge: backfill provides history, SSE may have already added recent trades.
          // Replace state with backfill, then re-append any SSE trades not in backfill.
          if (!cancelled) {
            setTrades(prev => {
              const backfillKeys = new Set(items.map(t => t.id));
              const sseOnly = prev.filter(t => !backfillKeys.has(t.id));
              return [...sseOnly, ...items].slice(0, MAX_TRADES);
            });
          }
        }

        if (ohlcRes.ok && !cancelled) {
          const points = await ohlcRes.json();
          if (!cancelled) setOhlc(prev => {
            // Merge: keep SSE points that are newer than the last HTTP point
            const lastHttpTime = points.length > 0 ? points[points.length - 1].time : 0;
            const sseNewer = prev.filter(p => p.time > lastHttpTime);
            return [...points, ...sseNewer];
          });
        }
      } catch {}

      // Always clear loading after backfill attempt even if SSE hasn't fired yet
      if (!cancelled && loadingRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }

    fetchBackfill();

    return () => {
      cancelled = true;
      esRef.current?.close();
      clearTimeout(timerRef.current);
      seenRef.current.clear();
    };
  }, [curveId]);

  return { trades, ohlc, loading, connected, latestOhlcPoint, setTrades, setOhlc };
}
