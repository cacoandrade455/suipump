// PriceChart.jsx
// TradingView Lightweight Charts wrapper.
// Same library used by Binance, Coinbase, Bybit, OKX, pump.fun.
// We feed it our trade events; it handles zoom, pan, crosshair, candles, etc.

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { createChart, CandlestickSeries, AreaSeries } from 'lightweight-charts';
import { ALL_PACKAGE_IDS } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

const TOTAL_SUPPLY_WHOLE = 1_000_000_000;

// Candle bucket (in seconds, lightweight-charts uses unix seconds)
const INTERVALS = [
  { label: '1M',  seconds: 60 },
  { label: '5M',  seconds: 300 },
  { label: '30M', seconds: 1_800 },
  { label: '1H',  seconds: 3_600 },
  { label: 'ALL', seconds: 0 }, // auto
];
const VIEWS = ['PRICE', 'MCAP'];

async function fetchSuiUsd() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    return parseFloat((await r.json()).price) || 0;
  } catch {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd');
      return (await r.json())?.sui?.usd || 0;
    } catch { return 0; }
  }
}

// Build OHLC candles from trades, forward-filling empty buckets so the
// chart shows a continuous price line even with gaps in trading activity.
function buildCandles(points, bucketSeconds) {
  if (points.length === 0) return [];

  let s = bucketSeconds;
  if (!s) {
    // Auto bucket — aim for ~80 candles across history
    const span = points[points.length - 1].time - points[0].time;
    const raw  = span / 80;
    const snaps = [60, 300, 900, 1800, 3600, 14_400, 86_400];
    s = snaps.find(x => x >= raw) ?? snaps[snaps.length - 1];
  }

  // Group trades by bucket
  const buckets = new Map();
  for (const p of points) {
    const t = Math.floor(p.time / s) * s;
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t).push(p.price);
  }

  // Forward-fill from first to now
  const firstBucket = Math.floor(points[0].time / s) * s;
  const lastBucket  = Math.floor(Date.now() / 1000 / s) * s;

  const candles = [];
  let prevClose = points[0].price;
  for (let t = firstBucket; t <= lastBucket; t += s) {
    const trades = buckets.get(t);
    if (trades?.length > 0) {
      const open  = prevClose;
      const close = trades[trades.length - 1];
      candles.push({
        time: t,
        open,
        high: Math.max(open, ...trades),
        low:  Math.min(open, ...trades),
        close,
      });
      prevClose = close;
    } else {
      // Empty bucket — flat doji (TradingView renders this as a horizontal tick automatically)
      candles.push({ time: t, open: prevClose, high: prevClose, low: prevClose, close: prevClose });
    }
  }
  return candles;
}

export default function PriceChart({ curveId, refreshKey }) {
  const client = useSuiClient();
  const containerRef = useRef(null);
  const chartRef     = useRef(null);
  const seriesRef    = useRef(null);

  const [rawTrades, setRawTrades]     = useState([]);
  const [suiUsd,    setSuiUsd]        = useState(0);
  const [intervalIdx, setIntervalIdx] = useState(4); // ALL by default
  const [view,      setView]          = useState('PRICE');
  const [loading,   setLoading]       = useState(true);

  // ── Fetch SUI/USD ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const t = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(t);
  }, []);

  // ── Fetch trades ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // Try indexer first — instant, pre-computed per token
        if (INDEXER_URL) {
          try {
            const res = await fetch(`${INDEXER_URL}/token/${curveId}/ohlc`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const points = await res.json();
              if (!cancelled) { setRawTrades(points); setLoading(false); }
              return;
            }
          } catch {}
        }
        // Fall back to RPC pagination — query all package versions (v4/v5/v6)
        const buyTypes  = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensPurchased`);
        const sellTypes = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensSold`);
        const eventMap = await paginateMultipleEvents(client, [...buyTypes, ...sellTypes], { order: 'ascending', maxPages: 20 });
        const all = [
          ...buyTypes.flatMap(bt  => (eventMap[bt]  || []).map(e => ({ ...e, kind: 'buy'  }))),
          ...sellTypes.flatMap(st => (eventMap[st] || []).map(e => ({ ...e, kind: 'sell' }))),
        ]
          .filter(e => e.parsedJson?.curve_id === curveId)
          .sort((a, b) => Number(a.timestampMs) - Number(b.timestampMs));

        const points = all.map(e => {
          const p = e.parsedJson;
          const price = e.kind === 'buy'
            ? (Number(p.sui_in   ?? 0) / 1e9) / (Number(p.tokens_out ?? 1) / 1e6)
            : (Number(p.sui_out  ?? 0) / 1e9) / (Number(p.tokens_in  ?? 1) / 1e6);
          return { time: Math.floor(Number(e.timestampMs) / 1000), price, kind: e.kind };
        }).filter(p => p.price > 0);

        if (!cancelled) { setRawTrades(points); setLoading(false); }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client, refreshKey]);

  // ── Initialize chart once ───────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: 'solid', color: '#000000' },
        textColor:  '#84CC16',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#141414' },
        horzLines: { color: '#141414' },
      },
      rightPriceScale: {
        borderColor: '#1a3a0a',
        textColor:   '#4B5563',
      },
      timeScale: {
        borderColor:    '#1a3a0a',
        timeVisible:    true,
        secondsVisible: false,
      },
      crosshair: {
        mode: 1, // CrosshairMode.Normal — follows mouse exactly
        vertLine: {
          color: '#84CC16',
          width: 1,
          style: 3, // dashed
          labelBackgroundColor: '#84CC16',
        },
        horzLine: {
          color: '#84CC16',
          width: 1,
          style: 3,
          labelBackgroundColor: '#84CC16',
        },
      },
      width:  containerRef.current.clientWidth,
      height: 280,
      autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor:        '#84CC16',
      downColor:      '#EF4444',
      borderVisible:  false,
      wickUpColor:    '#84CC16',
      wickDownColor:  '#EF4444',
      // Current price line — white for clarity against green/red candles
      priceLineColor: '#FFFFFF',
      priceLineWidth: 1,
      priceLineStyle: 4, // sparse-dashed (LineStyle.LargeDashed)
      lastValueVisible: true,
    });

    chartRef.current  = chart;
    seriesRef.current = series;

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current  = null;
      seriesRef.current = null;
    };
  }, []);

  // ── Build candle data and apply to chart ────────────────────────────────────
  const candles = useMemo(() => {
    const mul = view === 'MCAP' ? TOTAL_SUPPLY_WHOLE : 1;
    const built = buildCandles(rawTrades, INTERVALS[intervalIdx].seconds);
    return built.map(c => ({
      time:  c.time,
      open:  c.open  * mul,
      high:  c.high  * mul,
      low:   c.low   * mul,
      close: c.close * mul,
    }));
  }, [rawTrades, intervalIdx, view]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    if (candles.length === 0) {
      seriesRef.current.setData([]);
      return;
    }

    seriesRef.current.setData(candles);

    // Force a visible price range even when most candles are flat dojis.
    // Without this, lightweight-charts auto-fits to the tiny variation
    // and renders the candles too small to see.
    if (candles.length > 0) {
      const lows  = candles.map(c => c.low);
      const highs = candles.map(c => c.high);
      const minP  = Math.min(...lows);
      const maxP  = Math.max(...highs);
      const pad   = Math.max((maxP - minP) * 0.5, maxP * 0.05);
      seriesRef.current.applyOptions({
        autoscaleInfoProvider: () => ({
          priceRange: { minValue: minP - pad, maxValue: maxP + pad },
        }),
      });
    }

    // Custom price formatter for tiny values
    seriesRef.current.applyOptions({
      priceFormat: {
        type: 'custom',
        formatter: (price) => {
          if (suiUsd > 0) {
            const usd = price * suiUsd;
            if (usd >= 1)     return `$${usd.toFixed(4)}`;
            if (usd >= 1e-4) return `$${usd.toFixed(6)}`;
            return `$${usd.toPrecision(4)}`;
          }
          if (view === 'MCAP') {
            if (price >= 1e6) return `${(price/1e6).toFixed(2)}M`;
            if (price >= 1e3) return `${(price/1e3).toFixed(1)}k`;
            return price.toFixed(0);
          }
          if (price < 1e-6) return price.toExponential(2);
          return price.toFixed(7);
        },
        minMove: 1e-9,
      },
    });

    chartRef.current.timeScale().fitContent();
  }, [candles, suiUsd, view]);

  // ── Latest price for header display ─────────────────────────────────────────
  const latestPrice = candles.length > 0 ? candles[candles.length - 1].close : null;
  const firstPrice  = candles.length > 0 ? candles[0].open : null;
  const isUp        = latestPrice != null && firstPrice != null && latestPrice >= firstPrice;
  const accentColor = isUp ? '#84CC16' : '#EF4444';

  const fmtUsd = (v) => {
    if (!suiUsd || v == null) return null;
    const usd = v * suiUsd;
    if (usd >= 1e6)  return `$${(usd/1e6).toFixed(3)}M`;
    if (usd >= 1e3)  return `$${(usd/1e3).toFixed(2)}k`;
    if (usd >= 1)    return `$${usd.toFixed(4)}`;
    if (usd >= 1e-4) return `$${usd.toFixed(6)}`;
    return `$${usd.toPrecision(4)}`;
  };

  const fmtSui = (v) => {
    if (v == null) return '-';
    if (view === 'MCAP') {
      if (v >= 1e6) return `${(v/1e6).toFixed(2)}M`;
      if (v >= 1e3) return `${(v/1e3).toFixed(1)}k`;
      return v.toFixed(1);
    }
    if (v < 1e-7)  return v.toExponential(2);
    if (v < 0.001) return v.toFixed(7);
    return v.toFixed(5);
  };

  return (
    <div className="border border-lime-900/30 bg-black p-3 rounded-xl">
      {/* Controls */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1">
          {VIEWS.map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`text-[10px] font-mono px-2 py-0.5 border transition-colors ${
                view === v ? 'bg-lime-400 text-black border-lime-400' : 'text-lime-700 border-lime-900 hover:border-lime-600'
              }`}>{v}</button>
          ))}
        </div>
        <div className="flex gap-1">
          {INTERVALS.map((iv, i) => (
            <button key={iv.label} onClick={() => setIntervalIdx(i)}
              className={`text-[10px] font-mono px-2 py-0.5 border transition-colors ${
                intervalIdx === i ? 'bg-lime-950 text-lime-400 border-lime-600' : 'text-lime-900 border-lime-950 hover:border-lime-800'
              }`}>{iv.label}</button>
          ))}
        </div>
      </div>

      {/* Price display */}
      {latestPrice != null && (
        <div className="flex items-baseline gap-3 mb-2">
          {fmtUsd(latestPrice) ? (
            <>
              <span className="text-lg font-bold font-mono" style={{ color: accentColor }}>{fmtUsd(latestPrice)}</span>
              <span className="text-xs font-mono text-lime-700">{fmtSui(latestPrice)} SUI</span>
            </>
          ) : (
            <span className="text-lg font-bold font-mono" style={{ color: accentColor }}>{fmtSui(latestPrice)} SUI</span>
          )}
        </div>
      )}

      {/* Chart container — always mounted so the chart instance has a target */}
      <div className="relative">
        <div ref={containerRef} style={{ width: '100%', height: '280px' }} />
        {(loading || rawTrades.length === 0) && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-lime-900 bg-black pointer-events-none">
            {loading ? 'LOADING TRADES…' : 'NO TRADES YET — BE THE FIRST TO BUY'}
          </div>
        )}
      </div>

      {/* Required attribution per Apache 2.0 license */}
      <div className="text-[8px] font-mono text-lime-900/40 mt-1 text-right">
        chart by{' '}
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer"
          className="hover:text-lime-700 transition-colors">
          TradingView
        </a>
      </div>
    </div>
  );
}
