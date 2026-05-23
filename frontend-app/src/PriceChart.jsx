// PriceChart.jsx
// TradingView Lightweight Charts wrapper.
// Data: initial fetch from indexer /ohlc + real-time SSE via useTokenPageFeed.

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createChart, CandlestickSeries } from 'lightweight-charts';


const INDEXER_URL        = import.meta.env.VITE_INDEXER_URL || '';
const TOTAL_SUPPLY_WHOLE = 1_000_000_000;

const INTERVALS = [
  { label: '1M',  seconds: 60 },
  { label: '5M',  seconds: 300 },
  { label: '30M', seconds: 1_800 },
  { label: '1H',  seconds: 3_600 },
  { label: 'ALL', seconds: 0 },
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

function buildCandles(points, bucketSeconds) {
  if (points.length === 0) return [];

  let s = bucketSeconds;
  if (!s) {
    const span = points[points.length - 1].time - points[0].time;
    const raw  = span / 80;
    const snaps = [60, 300, 900, 1800, 3600, 14_400, 86_400];
    s = snaps.find(x => x >= raw) ?? snaps[snaps.length - 1];
  }

  const buckets = new Map();
  for (const p of points) {
    const t = Math.floor(p.time / s) * s;
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t).push(p.price);
  }

  const firstBucket = Math.floor(points[0].time / s) * s;
  const lastBucket  = Math.floor(Date.now() / 1000 / s) * s;

  const candles  = [];
  let prevClose  = points[0].price;
  for (let t = firstBucket; t <= lastBucket; t += s) {
    const trades = buckets.get(t);
    if (trades?.length > 0) {
      const open  = prevClose;
      const close = trades[trades.length - 1];
      candles.push({ time: t, open, high: Math.max(open, ...trades), low: Math.min(open, ...trades), close });
      prevClose = close;
    } else {
      candles.push({ time: t, open: prevClose, high: prevClose, low: prevClose, close: prevClose });
    }
  }
  return candles;
}

function fmtUsd(price) {
  if (!price) return '';
  if (price >= 1)    return `$${price.toFixed(4)}`;
  if (price >= 1e-4) return `$${price.toFixed(6)}`;
  return `$${price.toPrecision(4)}`;
}

function fmtSui(price) {
  if (!price || !isFinite(price)) return '';
  if (price < 1e-6) return price.toExponential(2) + ' SUI';
  return price.toFixed(7) + ' SUI';
}

export default function PriceChart({ curveId }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);
  const seriesRef    = useRef(null);

  const [suiUsd,      setSuiUsd]      = useState(0);
  const [intervalIdx, setIntervalIdx] = useState(4);
  const [view,        setView]        = useState('PRICE');

  // ── Initial fetch + SSE real-time append ─────────────────────────────────
  const [rawTrades, setRawTrades] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [connected, setConnected] = useState(false);
  const sseRef   = useRef(null);
  const sseTimer = useRef(null);

  useEffect(() => {
    if (!curveId || !INDEXER_URL) return;
    let cancelled = false;
    fetch(`${INDEXER_URL}/token/${curveId}/ohlc`)
      .then(r => r.ok ? r.json() : [])
      .then(pts => { if (!cancelled) { setRawTrades(pts); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [curveId]);

  useEffect(() => {
    if (!curveId || !INDEXER_URL) return;
    function connect() {
      const es = new EventSource(`${INDEXER_URL}/stream?curveId=${curveId}`);
      sseRef.current = es;
      es.onopen = () => setConnected(true);
      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'connected') return;
          const isTrade = event.type === 'TokensPurchased' || event.type === 'TokensBought' || event.type === 'TokensSold';
          if (!isTrade) return;
          const isBuy = event.type !== 'TokensSold';
          const d = event.data ?? {};
          // Use spot price from new reserves — same formula as /ohlc endpoint
          const VIRTUAL_SUI    = 3500 * 1e9;
          const VIRTUAL_TOKENS = 800_000_000 * 1e6;
          const suiRes  = Number(d.new_sui_reserve   ?? 0) + VIRTUAL_SUI;
          const tokRes  = Number(d.new_token_reserve ?? 1) + VIRTUAL_TOKENS;
          if (tokRes <= 0) return;
          const price = (suiRes / 1e9) / (tokRes / 1e6);
          const time  = Math.floor((event.ts ?? Date.now()) / 1000);
          setRawTrades(prev => [...prev, { time, price, kind: isBuy ? 'buy' : 'sell' }].sort((a,b) => a.time - b.time));
        } catch {}
      };
      es.onerror = () => { setConnected(false); es.close(); sseTimer.current = setTimeout(connect, 3000); };
    }
    connect();
    return () => { sseRef.current?.close(); clearTimeout(sseTimer.current); };
  }, [curveId]);

  // ── SUI/USD price ─────────────────────────────────────────────────────────
  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const t = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(t);
  }, []);

  // ── Initialize chart once ─────────────────────────────────────────────────
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
      rightPriceScale: { borderColor: '#1a3a0a', textColor: '#4B5563' },
      timeScale: { borderColor: '#1a3a0a', timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: 1,
        vertLine: { color: '#84CC16', width: 1, style: 3, labelBackgroundColor: '#84CC16' },
        horzLine: { color: '#84CC16', width: 1, style: 3, labelBackgroundColor: '#84CC16' },
      },
      width:    containerRef.current.clientWidth,
      height:   280,
      autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor:          '#84CC16',
      downColor:        '#EF4444',
      borderVisible:    false,
      wickUpColor:      '#84CC16',
      wickDownColor:    '#EF4444',
      priceLineColor:   '#FFFFFF',
      priceLineWidth:   1,
      priceLineStyle:   4,
      lastValueVisible: true,
    });

    chartRef.current  = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  // ── Build + apply candles ─────────────────────────────────────────────────
  const candles = useMemo(() => {
    let mul;
    if (view === 'MCAP') {
      mul = TOTAL_SUPPLY_WHOLE * (suiUsd > 0 ? suiUsd : 1);
    } else {
      mul = suiUsd > 0 ? suiUsd : 1;
    }
    // Deduplicate by time+price and sort ascending before building candles
    const seen = new Set();
    const deduped = rawTrades
      .filter(p => { const k = `${p.time}_${p.price}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.time - b.time);
    const built = buildCandles(deduped, INTERVALS[intervalIdx].seconds);
    return built.map(c => ({
      time:  c.time,
      open:  c.open  * mul,
      high:  c.high  * mul,
      low:   c.low   * mul,
      close: c.close * mul,
    }));
  }, [rawTrades, intervalIdx, view, suiUsd]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    if (candles.length === 0) { seriesRef.current.setData([]); return; }

    seriesRef.current.setData(candles);

    if (candles.length > 0) {
      const lows  = candles.map(c => c.low);
      const highs = candles.map(c => c.high);
      const minP  = Math.min(...lows);
      const maxP  = Math.max(...highs);
      const pad   = Math.max((maxP - minP) * 0.5, maxP * 0.05);
      seriesRef.current.applyOptions({
        autoscaleInfoProvider: () => ({ priceRange: { minValue: minP - pad, maxValue: maxP + pad } }),
      });
    }

    seriesRef.current.applyOptions({
      priceFormat: {
        type: 'custom',
        formatter: (price) => {
          if (suiUsd > 0) {
            if (view === 'MCAP') {
              if (price >= 1e6) return `$${(price/1e6).toFixed(2)}M`;
              if (price >= 1e3) return `$${(price/1e3).toFixed(1)}k`;
              return `$${price.toFixed(0)}`;
            }
            if (price >= 1)    return `$${price.toFixed(4)}`;
            if (price >= 1e-4) return `$${price.toFixed(6)}`;
            return `$${price.toPrecision(4)}`;
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

  const latestPrice = candles.length > 0 ? candles[candles.length - 1].close : null;
  const accentColor = '#84CC16';

  return (
    <div className="bg-black border border-lime-950 rounded-2xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex gap-1">
          {VIEWS.map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors ${
                view === v ? 'bg-lime-950 text-lime-400 border border-lime-600' : 'text-lime-900 border border-lime-950 hover:border-lime-800'
              }`}>{v}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-lime-400' : 'bg-white/20'}`} title={connected ? 'Live' : 'Connecting…'} />
          <div className="flex gap-1">
            {INTERVALS.map((iv, i) => (
              <button key={iv.label} onClick={() => setIntervalIdx(i)}
                className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors ${
                  intervalIdx === i ? 'bg-lime-950 text-lime-400 border border-lime-600' : 'text-lime-900 border border-lime-950 hover:border-lime-800'
                }`}>{iv.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Price display */}
      {latestPrice != null && (
        <div className="flex items-baseline gap-3 mb-2">
          {suiUsd > 0 ? (
            <>
              <span className="text-lg font-bold font-mono" style={{ color: accentColor }}>{fmtUsd(latestPrice)}</span>
              <span className="text-xs font-mono text-lime-700">{suiUsd > 0 ? fmtSui(latestPrice / suiUsd) : ''}</span>
            </>
          ) : (
            <span className="text-lg font-bold font-mono" style={{ color: accentColor }}>{fmtSui(latestPrice)}</span>
          )}
        </div>
      )}

      {/* Chart */}
      <div className="relative">
        <div ref={containerRef} style={{ width: '100%', height: '280px' }} />
        {(loading || rawTrades.length === 0) && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-lime-900 bg-black pointer-events-none">
            {loading ? 'LOADING TRADES…' : 'NO TRADES YET — BE THE FIRST TO BUY'}
          </div>
        )}
      </div>

      <div className="text-[8px] font-mono text-lime-900/40 mt-1 text-right">
        chart by{' '}
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer"
          className="hover:text-lime-700 transition-colors">TradingView</a>
      </div>
    </div>
  );
}
