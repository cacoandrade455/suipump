// PriceChart.jsx
// TradingView-style chart apparatus:
//   - X-axis = real timestamps (not array indices)
//   - Mouse wheel zoom — anchored at mouse X position
//   - Click+drag pan
//   - Pixel-perfect crosshair that flows smoothly through every point
//   - Line chart for sparse data (< 10 trades), candlesticks for dense
//   - Forward-fill: always shows current price even with no recent trades
//   - Interval buttons set default viewport width

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const TOTAL_SUPPLY_WHOLE = 1_000_000_000;
const CANDLE_THRESHOLD   = 10;

// Interval definitions: ms = candle bucket size, defaultWindow = initial viewport width
const INTERVALS = [
  { label: '1M',  ms: 60_000,    defaultWindow: 60_000 * 60 },        // show 1h of 1m candles
  { label: '5M',  ms: 300_000,   defaultWindow: 300_000 * 48 },       // show 4h of 5m candles
  { label: '30M', ms: 1_800_000, defaultWindow: 1_800_000 * 48 },     // show 24h of 30m candles
  { label: '1H',  ms: 3_600_000, defaultWindow: 3_600_000 * 72 },     // show 3d of 1h candles
  { label: 'ALL', ms: 0,         defaultWindow: 0 },                   // show everything
];
const VIEWS = ['PRICE', 'MCAP'];

// ── Fetch SUI/USD ─────────────────────────────────────────────────────────────
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

// ── Candle builder with forward-fill ─────────────────────────────────────────
// Always fills from viewStart to now so chart is never blank.
function buildCandles(points, bucketMs, viewStart, viewEnd) {
  if (points.length === 0) return [];

  let ms = bucketMs;
  if (!ms) {
    // AUTO bucket: ~60 candles across the visible window
    const span = viewEnd - viewStart;
    const raw  = span / 60;
    const snaps = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 86_400_000];
    ms = snaps.find(s => s >= raw) ?? snaps[snaps.length - 1];
  }

  const firstBucket = Math.floor(viewStart / ms) * ms;
  const lastBucket  = Math.floor(viewEnd   / ms) * ms;

  // Group all trades into buckets
  const tradeMap = {};
  for (const p of points) {
    const b = Math.floor(p.time / ms) * ms;
    if (!tradeMap[b]) tradeMap[b] = [];
    tradeMap[b].push(p.price);
  }

  // prevClose = last trade price before the viewport
  const preTrades = points.filter(p => p.time < viewStart);
  let prevClose   = preTrades.length > 0
    ? preTrades[preTrades.length - 1].price
    : points[0].price;

  const result = [];
  for (let b = firstBucket; b <= lastBucket; b += ms) {
    const trades = tradeMap[b];
    if (trades?.length > 0) {
      const o = prevClose;
      const c = trades[trades.length - 1];
      result.push({ time: b, o, h: Math.max(o, ...trades), l: Math.min(o, ...trades), c, empty: false });
      prevClose = c;
    } else {
      result.push({ time: b, o: prevClose, h: prevClose, l: prevClose, c: prevClose, empty: true });
    }
  }
  return result;
}

// ── Smooth bezier path ────────────────────────────────────────────────────────
function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i-1], c = pts[i];
    const cpx = ((p[0] + c[0]) / 2).toFixed(1);
    d += ` C ${cpx},${p[1].toFixed(1)} ${cpx},${c[1].toFixed(1)} ${c[0].toFixed(1)},${c[1].toFixed(1)}`;
  }
  return d;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function PriceChart({ curveId, refreshKey }) {
  const client = useSuiClient();
  const svgRef = useRef(null);
  const containerRef = useRef(null);

  const [rawTrades, setRawTrades]     = useState([]);
  const [suiUsd,    setSuiUsd]        = useState(0);
  const [intervalIdx, setIntervalIdx] = useState(4);
  const [view,      setView]          = useState('PRICE');
  const [loading,   setLoading]       = useState(true);

  // Viewport: start/end timestamps
  const [viewStart, setViewStart] = useState(null);
  const [viewEnd,   setViewEnd]   = useState(null);

  // Crosshair
  const [crosshair, setCrosshair] = useState(null); // { x, y, time, price }

  // Pan state
  const panRef = useRef({ active: false, startX: 0, startViewStart: 0, startViewEnd: 0 });

  // ── Fetch trades ─────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const t = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const buyType  = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
        const sellType = `${PACKAGE_ID}::bonding_curve::TokensSold`;
        const eventMap = await paginateMultipleEvents(client, [buyType, sellType], { order: 'ascending', maxPages: 20 });
        const all = [
          ...eventMap[buyType].map(e => ({ ...e, kind: 'buy' })),
          ...eventMap[sellType].map(e => ({ ...e, kind: 'sell' })),
        ]
          .filter(e => e.parsedJson?.curve_id === curveId)
          .sort((a, b) => Number(a.timestampMs) - Number(b.timestampMs));

        const points = all.map(e => {
          const p = e.parsedJson;
          const price = e.kind === 'buy'
            ? (Number(p.sui_in   ?? 0) / 1e9) / (Number(p.tokens_out ?? 1) / 1e6)
            : (Number(p.sui_out  ?? 0) / 1e9) / (Number(p.tokens_in  ?? 1) / 1e6);
          return { time: Number(e.timestampMs), price, kind: e.kind };
        }).filter(p => p.price > 0);

        if (!cancelled) {
          setRawTrades(points);
          setLoading(false);
        }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client, refreshKey]);

  // ── Set initial viewport when data loads or interval changes ─────────────────
  useEffect(() => {
    const now = Date.now();
    const { defaultWindow } = INTERVALS[intervalIdx];

    if (rawTrades.length === 0) {
      // No data — show last hour
      setViewStart(now - 3_600_000);
      setViewEnd(now + 60_000);
      return;
    }

    const firstTrade = rawTrades[0].time;
    const lastTrade  = rawTrades[rawTrades.length - 1].time;

    if (defaultWindow === 0) {
      // ALL: show everything with 5% padding
      const span = Math.max(lastTrade - firstTrade, 60_000);
      setViewStart(firstTrade - span * 0.05);
      setViewEnd(now + span * 0.05);
    } else {
      // Fixed window ending at now
      setViewStart(now - defaultWindow);
      setViewEnd(now + defaultWindow * 0.03); // small right padding
    }
  }, [intervalIdx, rawTrades.length]);

  // ── Chart data from viewport ──────────────────────────────────────────────────
  const mul = view === 'MCAP' ? TOTAL_SUPPLY_WHOLE : 1;

  const { ms: intervalMs } = INTERVALS[intervalIdx];

  // Count real trades in viewport
  const tradesInView = useMemo(() => {
    if (!viewStart || !viewEnd) return [];
    return rawTrades.filter(p => p.time >= viewStart && p.time <= viewEnd);
  }, [rawTrades, viewStart, viewEnd]);

  const useCandles = tradesInView.length >= CANDLE_THRESHOLD;

  // Build candle data
  const candleData = useMemo(() => {
    if (!viewStart || !viewEnd) return [];
    return buildCandles(rawTrades, intervalMs, viewStart, viewEnd)
      .map(c => ({ ...c, o: c.o*mul, h: c.h*mul, l: c.l*mul, c: c.c*mul }));
  }, [rawTrades, intervalMs, viewStart, viewEnd, mul]);

  // Line data — all trades in view + synthetic anchor if needed
  const lineData = useMemo(() => {
    if (!viewStart || !viewEnd) return [];
    // Include last trade before viewport for left edge anchor
    const lastBefore = [...rawTrades].reverse().find(p => p.time < viewStart);
    const inView     = rawTrades.filter(p => p.time >= viewStart && p.time <= viewEnd);
    const pts = [];
    if (lastBefore) pts.push({ ...lastBefore, time: viewStart, synthetic: true });
    pts.push(...inView);
    // Extend to now
    if (pts.length > 0) pts.push({ ...pts[pts.length - 1], time: viewEnd, synthetic: true });
    return pts.map(p => ({ ...p, value: p.price * mul }));
  }, [rawTrades, viewStart, viewEnd, mul]);

  // ── SVG layout ────────────────────────────────────────────────────────────────
  const W = 600, H = 200, PL = 68, PR = 8, PT = 12, PB = 28;
  const cW = W - PL - PR, cH = H - PT - PB;

  // Price range
  const priceVals = useCandles
    ? candleData.filter(d => !d.empty).flatMap(d => [d.h, d.l])
    : lineData.map(d => d.value);
  const rawMin = priceVals.length ? Math.min(...priceVals) : 0;
  const rawMax = priceVals.length ? Math.max(...priceVals) : 1;
  const pad    = (rawMax - rawMin) * 0.1 || rawMax * 0.05 || 1e-10;
  const minV   = rawMin - pad;
  const maxV   = rawMax + pad;
  const rangeV = maxV - minV || 1;

  // Time → X pixel (based on viewport)
  const toX = useCallback(t => {
    if (!viewStart || !viewEnd) return PL;
    return PL + ((t - viewStart) / (viewEnd - viewStart)) * cW;
  }, [viewStart, viewEnd]);

  const toY = useCallback(v => PT + (1 - (v - minV) / rangeV) * cH, [minV, rangeV]);

  // X pixel → time
  const toTime = useCallback(x => {
    if (!viewStart || !viewEnd) return Date.now();
    return viewStart + ((x - PL) / cW) * (viewEnd - viewStart);
  }, [viewStart, viewEnd]);

  // ── Candle layout ─────────────────────────────────────────────────────────────
  const candlePixelW = useMemo(() => {
    if (candleData.length < 2 || !viewStart || !viewEnd) return 8;
    const slot = (toX(candleData[1].time) - toX(candleData[0].time));
    return Math.max(2, Math.min(16, slot * 0.6));
  }, [candleData, toX]);

  // ── Y ticks ───────────────────────────────────────────────────────────────────
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y: PT + (1 - t) * cH,
    value: minV + t * rangeV,
  }));

  // ── X ticks: evenly spaced time labels ───────────────────────────────────────
  const xTicks = useMemo(() => {
    if (!viewStart || !viewEnd) return [];
    const ticks = [];
    const span  = viewEnd - viewStart;
    // Pick a nice label interval
    const labelIntervals = [
      60_000, 300_000, 900_000, 1_800_000, 3_600_000,
      14_400_000, 86_400_000, 604_800_000,
    ];
    const labelMs = labelIntervals.find(ms => span / ms <= 8) ?? labelIntervals[labelIntervals.length - 1];
    const start   = Math.ceil(viewStart / labelMs) * labelMs;
    for (let t = start; t <= viewEnd; t += labelMs) {
      const x = toX(t);
      if (x >= PL && x <= W - PR) {
        const d = new Date(t);
        const label = span < 86_400_000
          ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        ticks.push({ x, label });
      }
    }
    return ticks;
  }, [viewStart, viewEnd, toX]);

  // ── Formatters ────────────────────────────────────────────────────────────────
  const fmtPrice = v => {
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

  const fmtUsd = suiVal => {
    if (!suiUsd || suiVal == null) return null;
    const usd = suiVal * suiUsd;
    if (usd >= 1e6)  return `$${(usd/1e6).toFixed(3)}M`;
    if (usd >= 1e3)  return `$${(usd/1e3).toFixed(2)}k`;
    if (usd >= 1)    return `$${usd.toFixed(4)}`;
    if (usd >= 1e-4) return `$${usd.toFixed(6)}`;
    return `$${usd.toPrecision(4)}`;
  };

  // ── Mouse interaction ─────────────────────────────────────────────────────────

  const getSvgX = useCallback(clientX => {
    if (!svgRef.current) return 0;
    const rect = svgRef.current.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * W;
  }, []);

  // Find nearest data point to a timestamp
  const nearestPoint = useCallback(time => {
    if (useCandles) {
      const real = candleData.filter(d => !d.empty);
      if (!real.length) return null;
      return real.reduce((best, d) => Math.abs(d.time - time) < Math.abs(best.time - time) ? d : best);
    } else {
      const real = lineData.filter(d => !d.synthetic);
      if (!real.length) return null;
      return real.reduce((best, d) => Math.abs(d.time - time) < Math.abs(best.time - time) ? d : best);
    }
  }, [useCandles, candleData, lineData]);

  const handleMouseMove = useCallback(e => {
    const svgX = getSvgX(e.clientX);
    if (svgX < PL || svgX > W - PR) { setCrosshair(null); return; }
    if (panRef.current.active) return;

    const time = toTime(svgX);
    const pt   = nearestPoint(time);
    const val  = useCandles ? pt?.c : pt?.value;

    setCrosshair(pt ? {
      x: toX(pt.time),
      y: toY(val),
      mouseX: svgX, // vertical line follows mouse exactly
      time: pt.time,
      price: val,
      candle: useCandles ? pt : null,
    } : null);
  }, [getSvgX, toTime, toX, toY, nearestPoint, useCandles]);

  // ── Zoom (mouse wheel) ────────────────────────────────────────────────────────
  const handleWheel = useCallback(e => {
    e.preventDefault();
    if (!viewStart || !viewEnd) return;

    const svgX    = getSvgX(e.clientX);
    const anchor  = toTime(svgX); // zoom anchored at mouse position
    const span    = viewEnd - viewStart;
    const factor  = e.deltaY > 0 ? 1.15 : 0.87; // scroll down = zoom out, up = zoom in
    const newSpan = Math.max(60_000, Math.min(365 * 86_400_000, span * factor));

    // Keep the time under the mouse fixed
    const ratio = (anchor - viewStart) / span;
    const newStart = anchor - ratio * newSpan;
    const newEnd   = anchor + (1 - ratio) * newSpan;

    setViewStart(newStart);
    setViewEnd(newEnd);
    setCrosshair(null);
  }, [viewStart, viewEnd, getSvgX, toTime]);

  // ── Pan (drag) ────────────────────────────────────────────────────────────────
  const handleMouseDown = useCallback(e => {
    if (!viewStart || !viewEnd) return;
    panRef.current = {
      active: true,
      startX: e.clientX,
      startViewStart: viewStart,
      startViewEnd:   viewEnd,
    };
    setCrosshair(null);
  }, [viewStart, viewEnd]);

  const handleMouseMoveGlobal = useCallback(e => {
    if (!panRef.current.active) return;
    const { startX, startViewStart, startViewEnd } = panRef.current;
    if (!svgRef.current) return;
    const rect  = svgRef.current.getBoundingClientRect();
    const dxPx  = e.clientX - startX;
    const dxPct = dxPx / rect.width;
    const span  = startViewEnd - startViewStart;
    const shift = -dxPct * span; // drag right = go back in time
    setViewStart(startViewStart + shift);
    setViewEnd(startViewEnd + shift);
  }, []);

  const handleMouseUp = useCallback(() => {
    panRef.current.active = false;
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMoveGlobal);
    window.addEventListener('mouseup',   handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMoveGlobal);
      window.removeEventListener('mouseup',   handleMouseUp);
    };
  }, [handleMouseMoveGlobal, handleMouseUp]);

  // Attach wheel with non-passive listener
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // ── Line chart paths ──────────────────────────────────────────────────────────
  const linePts = lineData.map(d => [toX(d.time), toY(d.value)]);
  const pathD   = linePts.length >= 2 ? smoothPath(linePts) : null;
  const areaD   = pathD
    ? `${pathD} L ${toX(viewEnd)},${H-PB} L ${PL},${H-PB} Z`
    : null;
  const allSynthetic = lineData.length > 0 && lineData.every(d => d.synthetic);
  const realLineData = lineData.filter(d => !d.synthetic);
  const isLineUp     = realLineData.length >= 2
    ? realLineData[realLineData.length-1].value >= realLineData[0].value
    : true;
  const lineColor    = isLineUp ? '#84CC16' : '#EF4444';
  const gradId       = 'chartGrad';

  // ── Display price ─────────────────────────────────────────────────────────────
  const displayCandle = crosshair?.candle
    ?? (candleData.filter(d => !d.empty)[candleData.filter(d => !d.empty).length - 1] ?? null);
  const displayPrice  = crosshair
    ? crosshair.price
    : (useCandles ? displayCandle?.c : (realLineData[realLineData.length-1]?.value ?? null));
  const isUp = useCandles
    ? (candleData.filter(d=>!d.empty).length >= 2
        ? candleData.filter(d=>!d.empty)[candleData.filter(d=>!d.empty).length-1].c >= candleData.filter(d=>!d.empty)[0].o
        : true)
    : isLineUp;
  const accentColor = isUp ? '#84CC16' : '#EF4444';

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="border border-lime-900/30 bg-black p-3 rounded-xl" ref={containerRef}>

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
      {displayPrice != null && (
        <div className="flex items-baseline gap-3 mb-1.5">
          {fmtUsd(displayPrice) ? (
            <>
              <span className="text-lg font-bold font-mono" style={{ color: accentColor }}>{fmtUsd(displayPrice)}</span>
              <span className="text-xs font-mono text-lime-700">{fmtPrice(displayPrice)} SUI</span>
            </>
          ) : (
            <span className="text-lg font-bold font-mono" style={{ color: accentColor }}>{fmtPrice(displayPrice)} SUI</span>
          )}
          {crosshair && (
            <span className="text-[10px] font-mono text-lime-800 ml-auto">
              {new Date(crosshair.time).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* OHLC on candle hover */}
      {crosshair?.candle && (
        <div className="flex gap-3 mb-1.5 text-[9px] font-mono">
          <span className="text-white/40">O <span className="text-white/60">{fmtPrice(crosshair.candle.o)}</span></span>
          <span className="text-white/40">H <span className="text-lime-500">{fmtPrice(crosshair.candle.h)}</span></span>
          <span className="text-white/40">L <span className="text-red-500">{fmtPrice(crosshair.candle.l)}</span></span>
          <span className="text-white/40">C <span className="text-white/60">{fmtPrice(crosshair.candle.c)}</span></span>
        </div>
      )}

      {loading ? (
        <div className="h-48 flex items-center justify-center text-[10px] font-mono text-lime-900">LOADING TRADES…</div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full select-none"
          style={{ height: '200px', cursor: panRef.current.active ? 'grabbing' : 'crosshair' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setCrosshair(null)}
          onMouseDown={handleMouseDown}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={lineColor} stopOpacity="0.20" />
              <stop offset="100%" stopColor={lineColor} stopOpacity="0.01" />
            </linearGradient>
            <clipPath id="chartClip">
              <rect x={PL} y={PT} width={cW} height={cH} />
            </clipPath>
          </defs>

          {/* Grid */}
          {yTicks.map((t, i) => (
            <line key={i} x1={PL} x2={W-PR} y1={t.y} y2={t.y} stroke="#141414" strokeWidth="1" />
          ))}
          {xTicks.map((t, i) => (
            <line key={i} x1={t.x} x2={t.x} y1={PT} y2={H-PB} stroke="#141414" strokeWidth="1" />
          ))}

          {/* Y labels */}
          {yTicks.map((t, i) => (
            <text key={i} x={PL-4} y={t.y+3} textAnchor="end" fontSize="7.5" fill="#4B5563" fontFamily="monospace">
              {fmtUsd(t.value) ?? fmtPrice(t.value)}
            </text>
          ))}

          {/* X labels */}
          {xTicks.map((t, i) => (
            <text key={i} x={t.x} y={H-4} textAnchor="middle" fontSize="7" fill="#374151" fontFamily="monospace">
              {t.label}
            </text>
          ))}

          {/* ── LINE CHART ──────────────────────────────────────────────────── */}
          {!useCandles && (
            <g clipPath="url(#chartClip)">
              {areaD && !allSynthetic && (
                <path d={areaD} fill={`url(#${gradId})`} opacity="0.8" />
              )}
              {pathD && (
                <path d={pathD} fill="none"
                  stroke={allSynthetic ? 'rgba(132,204,22,0.2)' : lineColor}
                  strokeWidth={allSynthetic ? '1' : '1.5'}
                  strokeDasharray={allSynthetic ? '4,4' : 'none'}
                  strokeLinejoin="round" strokeLinecap="round" />
              )}
              {/* Trade dots — real trades only */}
              {realLineData.map((d, i) => (
                <circle key={i} cx={toX(d.time)} cy={toY(d.value)} r="2.5"
                  fill={d.kind === 'sell' ? '#EF4444' : '#84CC16'} opacity="0.7" />
              ))}
            </g>
          )}

          {/* ── CANDLE CHART ─────────────────────────────────────────────────── */}
          {useCandles && (
            <g clipPath="url(#chartClip)">
              {candleData.map((d, i) => {
                if (d.empty) return null;
                const isGreen    = d.c >= d.o;
                const color      = isGreen ? '#84CC16' : '#EF4444';
                const cx         = toX(d.time);
                const bodyTop    = toY(Math.max(d.o, d.c));
                const bodyBottom = toY(Math.min(d.o, d.c));
                const bodyH      = Math.max(2, bodyBottom - bodyTop);
                const isHovered  = crosshair?.candle?.time === d.time;
                return (
                  <g key={i} opacity={isHovered ? 1 : 0.88}>
                    <line x1={cx} x2={cx} y1={toY(d.h)}   y2={bodyTop}    stroke={color} strokeWidth="1" />
                    <rect x={cx - candlePixelW/2} y={bodyTop} width={candlePixelW} height={bodyH}
                      fill={color} fillOpacity={isGreen ? 0.9 : 0.85} rx="0.5" />
                    <line x1={cx} x2={cx} y1={bodyBottom} y2={toY(d.l)}   stroke={color} strokeWidth="1" />
                  </g>
                );
              })}
            </g>
          )}

          {/* ── Crosshair ────────────────────────────────────────────────────── */}
          {crosshair && (
            <>
              {/* Vertical line follows mouse X exactly */}
              <line x1={crosshair.mouseX} x2={crosshair.mouseX} y1={PT} y2={H-PB}
                stroke="#84CC16" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.6" />
              {/* Horizontal line snaps to nearest data point price */}
              <line x1={PL} x2={W-PR} y1={crosshair.y} y2={crosshair.y}
                stroke="#84CC16" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.6" />
              {/* Price label on Y axis */}
              <rect x={0} y={crosshair.y - 8} width={PL - 2} height={14}
                fill="#84CC16" rx="2" />
              <text x={PL - 5} y={crosshair.y + 3.5}
                textAnchor="end" fontSize="7.5" fill="#000" fontFamily="monospace" fontWeight="bold">
                {fmtUsd(crosshair.price) ?? fmtPrice(crosshair.price)}
              </text>
              {/* Dot at snapped data point */}
              <circle cx={crosshair.x} cy={crosshair.y} r="3.5"
                fill={accentColor} stroke="#000" strokeWidth="1.5" />
            </>
          )}

          {/* Current price line (always visible, no hover needed) */}
          {displayPrice != null && !crosshair && (() => {
            const py = toY(displayPrice);
            return (
              <>
                <line x1={PL} x2={W-PR} y1={py} y2={py}
                  stroke={accentColor} strokeWidth="0.5" strokeDasharray="2,4" opacity="0.35" />
                <rect x={W-PR+1} y={py-7} width={PR+1} height={13} fill={accentColor} rx="1" opacity="0.9" />
              </>
            );
          })()}
        </svg>
      )}

      <div className="text-[9px] font-mono text-lime-900/50 mt-1 text-right">scroll to zoom · drag to pan</div>
    </div>
  );
}
