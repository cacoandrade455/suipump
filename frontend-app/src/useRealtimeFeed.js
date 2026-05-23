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
// Combines initial HTTP fetch + SSE stream for a single token page.
// Handles initial load + real-time updates in one hook.

export function useTokenPageFeed(curveId) {
  const [trades,    setTrades]    = useState([]);
  const [ohlc,      setOhlc]      = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [connected, setConnected] = useState(false);
  const esRef    = useRef(null);
  const timerRef = useRef(null);

  // Initial HTTP fetch
  useEffect(() => {
    if (!curveId || !INDEXER_URL) return;
    let cancelled = false;

    async function fetchInitial() {
      try {
        const [tradesRes, ohlcRes] = await Promise.all([
          fetch(`${INDEXER_URL}/token/${curveId}/trades?limit=200`),
          fetch(`${INDEXER_URL}/token/${curveId}/ohlc`),
        ]);
        if (tradesRes.ok) {
          const rows = await tradesRes.json();
          if (!cancelled) {
            setTrades(rows.map(r => ({
              kind:     r.event_type?.includes('TokensPurchased') ? 'buy' : 'sell',
              sui:      r.event_type?.includes('TokensPurchased') ? Number(r.data.sui_in) / MIST_PER_SUI : Number(r.data.sui_out) / MIST_PER_SUI,
              tokens:   r.event_type?.includes('TokensPurchased') ? Number(r.data.tokens_out) / 1e6      : Number(r.data.tokens_in)  / 1e6,
              who:      r.data.buyer ?? r.data.seller,
              ts:       r.timestamp_ms ? Number(r.timestamp_ms) : null,
              curveId,
            })));
          }
        }
        if (ohlcRes.ok) {
          const points = await ohlcRes.json();
          if (!cancelled) setOhlc(points);
        }
      } catch {}
      if (!cancelled) setLoading(false);
    }

    fetchInitial();
    return () => { cancelled = true; };
  }, [curveId]);

  // SSE stream for real-time updates
  useEffect(() => {
    if (!curveId || !INDEXER_URL) return;

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

          const isBuy = event.type !== 'TokensSold';
          const d     = event.data ?? {};
          const trade = {
            kind:    isBuy ? 'buy' : 'sell',
            sui:     isBuy ? Number(d.sui_in  ?? 0) / MIST_PER_SUI : Number(d.sui_out ?? 0) / MIST_PER_SUI,
            tokens:  isBuy ? Number(d.tokens_out ?? 0) / 1e6       : Number(d.tokens_in  ?? 0) / 1e6,
            who:     d.buyer ?? d.seller ?? null,
            ts:      event.ts,
            curveId,
          };

          setTrades(prev => [trade, ...prev].slice(0, MAX_TRADES));

          // Append OHLC point
          if (trade.tokens > 0) {
            const price = trade.sui / trade.tokens;
            setOhlc(prev => [...prev, { time: Math.floor(trade.ts / 1000), price, kind: trade.kind }]);
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
    return () => {
      esRef.current?.close();
      clearTimeout(timerRef.current);
    };
  }, [curveId]);

  return { trades, ohlc, loading, connected, setTrades, setOhlc };
}
