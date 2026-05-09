// PriceChart.jsx
// Smart chart: line/area when < 10 real trades in view (looks clean for sparse data),
// OHLC candlesticks with forward-fill when >= 10 trades (looks like a real trading chart).
// Intervals: 1M, 5M, 30M, 1H, ALL | Toggle: PRICE / MCAP
// Hover crosshair, USD primary, SUI secondary.

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const TOTAL_SUPPLY_WHOLE = 1_000_000_000;
const CANDLE_THRESHOLD   = 10; // switch to candles above this many real trades in view

const INTERVALS = [
  { label: '1M',  ms: 60_000,    window: 60_000 },
  { label: '5M',  ms: 300_000,   window: 300_000 },
  { label: '30M', ms: 1_800_000, window: 1_800_000 },
  { label: '1H',  ms: 3_600_000, window: 3_600_000 },
  { label: 'ALL', ms: 0,         window: 0 },
];
const VIEWS = ['PRICE', 'MCAP'];

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function filterByWindow(points, windowMs) {
  if (!windowMs) return points;
  const cutoff = Date.now() - windowMs;
  const out = points.filter(p => p.time >= cutoff);
  return out.length === 0 && points.length > 0 ? [points[points.length - 1]] : out;
}

// Forward-fill candles: empty buckets carry previous close as a flat doji.
function toCandles(points, intervalMs, windowMs) {
  if (points.length === 0) return [];

  let ms = intervalMs;
  if (!ms) {
    if (points.length <= 1) return [{ time: points[0].time, o: points[0].price, h: points[0].price, l: points[0].price, c: points[0].price, empty: false }];
    const span = points[points.length - 1].time - points[0].time;
    const snaps = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 86_400_000];
    ms = snaps.find(s => s >= span / 60) ?? snaps[snaps.length - 1];
  }

  const now        = Date.now();
  const winStart   = windowMs ? now - windowMs : points[0].time;
  const firstBucket = Math.floor(winStart / ms) * ms;
  const lastBucket  = Math.floor(now / ms) * ms;

  // Group trades into buckets
  const tradeMap = {};
  for (const p of points) {
    if (p.time < winStart) continue;
    const b = Math.floor(p.time / ms) * ms;
    if (!tradeMap[b]) tradeMap[b] = [];
    tradeMap[b].push(p.price);
  }

  // prevClose = last known price before window
  const pre = points.filter(p => p.time < winStart);
  let prevClose = pre.length > 0 ? pre[pre.length - 1].price : points[0].price;

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

// Smooth cubic bezier path for line chart
function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], c = pts[i];
    const cpx = ((p[0] + c[0]) / 2).toFixed(1);
    d += ` C ${cpx},${p[1].toFixed(1)} ${cpx},${c[1].toFixed(1)} ${c[0].toFixed(1)},${c[1].toFixed(1)}`;
  }
  return d;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PriceChart({ curveId, refreshKey }) {
  const client = useSuiClient();
  const svgRef = useRef(null);

  const [rawTrades, setRawTrades]   = useState([]);
  const [suiUsd,    setSuiUsd]      = useState(0);
  const [intervalIdx, setIntervalIdx] = useState(4);
  const [view,      setView]        = useState('PRICE');
  const [hover,     setHover]       = useState(null);
  const [loading,   setLoading]     = useState(true);
  const [animKey,   setAnimKey]     = useState(0);

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
            ? (Number(p.sui_in ?? 0) / 1e9) / (Number(p.tokens_out ?? 1) / 1e6)
            : (Number(p.sui_out ?? 0) / 1e9) / (Number(p.tokens_in ?? 1) / 1e6);
          return { time: Number(e.timestampMs), price, kind: e.kind };
        }).filter(t => t.price > 0);

        if (!cancelled) { setRawTrades(points); setLoading(false); setAnimKey(k => k + 1); }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client, refreshKey]);

  const { ms: intervalMs, window: windowMs } = INTERVALS[intervalIdx];

  // Points visible in this window
  const visiblePoints = useMemo(
    () => filterByWindow(rawTrades, windowMs),
    [rawTrades, windowMs, intervalIdx]
  );

  // Decide render mode
  const useCandles = visiblePoints.length >= CANDLE_THRESHOLD;

  // Build candle data (always computed, only rendered when useCandles)
  const candles = useMemo(
    () => toCandles(rawTrades, intervalMs, windowMs),
    [rawTrades, intervalMs, windowMs]
  );

  const mul = view === 'MCAP' ? TOTAL_SUPPLY_WHOLE : 1;

  // Line chart data — one point per trade
  const lineData = useMemo(
    () => visiblePoints.map(p => ({ ...p, value: p.price * mul })),
    [visiblePoints, mul]
  );

  // Candle chart data
  const candleData = useMemo(
    () => candles.map(c => ({ ...c, o: c.o*mul, h: c.h*mul, l: c.l*mul, c: c.c*mul, value: c.c*mul })),
    [candles, mul]
  );

  // ── SVG layout ──────────────────────────────────────────────────────────────
  const W = 600, H = 200, PL = 68, PR = 8, PT = 12, PB = 28;
  const cW = W - PL - PR, cH = H - PT - PB;

  // Price range
  const allVals = useCandles
    ? candleData.flatMap(d => [d.h, d.l])
    : lineData.map(d => d.value);
  const rawMin  = allVals.length ? Math.min(...allVals) : 0;
  const rawMax  = allVals.length ? Math.max(...allVals) : 1;
  const pad     = (rawMax - rawMin) * 0.1 || rawMax * 0.05 || 1e-10;
  const minV    = rawMin - pad;
  const maxV    = rawMax + pad;
  const rangeV  = maxV - minV || 1;

  const toY = v => PT + (1 - (v - minV) / rangeV) * cH;

  // ── Line chart coords ───────────────────────────────────────────────────────
  const toXLine = i => PL + (i / Math.max(lineData.length - 1, 1)) * cW;
  const linePts  = lineData.map((d, i) => [toXLine(i), toY(d.value)]);
  const pathD    = linePts.length >= 2 ? smoothPath(linePts) : null;
  const areaD    = pathD
    ? `${pathD} L ${toXLine(lineData.length-1)},${H-PB} L ${PL},${H-PB} Z`
    : null;
  const isLineUp = lineData.length >= 2 && lineData[lineData.length-1].value >= lineData[0].value;
  const lineColor = isLineUp ? '#84CC16' : '#EF4444';
  const gradId    = `ag${animKey % 4}`;

  // ── Candle chart coords ─────────────────────────────────────────────────────
  const n           = candleData.length;
  const candleSlot  = n > 1 ? cW / n : cW;
  const candleW     = Math.max(2, Math.min(12, candleSlot * 0.55));
  const candleCX    = i => PL + (i + 0.5) * candleSlot;

  // ── Y-axis ticks ────────────────────────────────────────────────────────────
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y: PT + (1 - t) * cH,
    value: minV + t * rangeV,
  }));

  // ── X-axis ticks ────────────────────────────────────────────────────────────
  const xSource = useCandles ? candleData : lineData;
  const xTicks  = xSource.length >= 2
    ? [0, Math.floor(xSource.length / 2), xSource.length - 1].map(i => ({
        x: useCandles ? candleCX(i) : toXLine(i),
        label: xSource[i]
          ? new Date(xSource[i].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '',
      }))
    : [];

  // ── Formatters ──────────────────────────────────────────────────────────────
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
    if (usd === 0)   return '$0.00';
    return `$${usd.toPrecision(4)}`;
  };

  // ── Mouse interaction ────────────────────────────────────────────────────────
  const handleMouseMove = useCallback(e => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX  = ((e.clientX - rect.left) / rect.width) * W;
    if (svgX < PL || svgX > W - PR) { setHover(null); return; }

    if (useCandles) {
      const idx = Math.max(0, Math.min(n - 1, Math.floor(((svgX - PL) / cW) * n)));
      const d   = candleData[idx];
      if (d) setHover({ idx, x: candleCX(idx), y: toY(d.c), mode: 'candle' });
    } else {
      const idx = Math.max(0, Math.min(lineData.length - 1, Math.round(((svgX - PL) / cW) * (lineData.length - 1))));
      const d   = lineData[idx];
      if (d) setHover({ idx, x: toXLine(idx), y: toY(d.value), mode: 'line' });
    }
  }, [useCandles, candleData, lineData, n]);

  const curCandle = hover?.mode === 'candle' ? candleData[hover.idx] : (candleData.length > 0 ? candleData[candleData.length - 1] : null);
  const curLine   = hover?.mode === 'line'   ? lineData[hover.idx]   : (lineData.length > 0   ? lineData[lineData.length - 1]     : null);
  const curValue  = useCandles ? curCandle?.c : curLine?.value;
  const curTime   = useCandles ? curCandle?.time : curLine?.time;
  const isUp      = useCandles
    ? (candleData.length >= 2 && candleData[candleData.length-1].c >= candleData[0].o)
    : isLineUp;
  const accentColor = isUp ? '#84CC16' : '#EF4444';

  // ── Render ───────────────────────────────────────────────────────────────────
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
      {curValue != null && (
        <div className="flex items-baseline gap-3 mb-1.5">
          {fmtUsd(curValue) ? (
            <>
              <span className="text-lg font-bold font-mono" style={{ color: accentColor }}>{fmtUsd(curValue)}</span>
              <span className="text-xs font-mono text-lime-700">{fmtPrice(curValue)} SUI</span>
            </>
          ) : (
            <span className="text-lg font-bold font-mono" style={{ color: accentColor }}>{fmtPrice(curValue)} SUI</span>
          )}
          {hover && curTime && (
            <span className="text-[10px] font-mono text-lime-800 ml-auto">
              {new Date(curTime).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* OHLC summary on candle hover */}
      {useCandles && hover?.mode === 'candle' && curCandle && (
        <div className="flex gap-3 mb-1.5 text-[9px] font-mono">
          <span className="text-white/40">O <span className="text-white/60">{fmtPrice(curCandle.o)}</span></span>
          <span className="text-white/40">H <span className="text-lime-500">{fmtPrice(curCandle.h)}</span></span>
          <span className="text-white/40">L <span className="text-red-500">{fmtPrice(curCandle.l)}</span></span>
          <span className="text-white/40">C <span className="text-white/60">{fmtPrice(curCandle.c)}</span></span>
        </div>
      )}

      {loading ? (
        <div className="h-48 flex items-center justify-center text-[10px] font-mono text-lime-900">LOADING TRADES…</div>
      ) : (lineData.length < 1 && candleData.length < 1) ? (
        <div className="h-48 flex items-center justify-center text-[10px] font-mono text-lime-900">NO TRADES YET — BE THE FIRST TO BUY</div>
      ) : (
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full cursor-crosshair select-none"
          style={{ height: '200px' }} onMouseMove={handleMouseMove} onMouseLeave={() => setHover(null)}
          preserveAspectRatio="none">

          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={lineColor} stopOpacity="0.20" />
              <stop offset="100%" stopColor={lineColor} stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {/* Grid */}
          {yTicks.map((t, i) => (
            <line key={i} x1={PL} x2={W-PR} y1={t.y} y2={t.y} stroke="#141414" strokeWidth="1" />
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

          {/* ── LINE CHART (sparse) ─────────────────────────────────────────── */}
          {!useCandles && areaD && (
            <path key={`a${animKey}`} d={areaD} fill={`url(#${gradId})`}
              style={{ animation: 'chartFade 0.45s ease-out forwards', opacity: 0 }} />
          )}
          {!useCandles && pathD && (
            <path key={`l${animKey}`} d={pathD} fill="none" stroke={lineColor} strokeWidth="1.5"
              strokeLinejoin="round" strokeLinecap="round"
              style={{ strokeDasharray: 3000, strokeDashoffset: 3000, animation: 'chartDraw 0.55s ease-out forwards' }} />
          )}
          {!useCandles && lineData.map((d, i) => (
            <circle key={i} cx={toXLine(i)} cy={toY(d.value)} r="2.5"
              fill={d.kind === 'sell' ? '#EF4444' : '#84CC16'} opacity="0.6" />
          ))}

          {/* ── CANDLE CHART (dense) ────────────────────────────────────────── */}
          {useCandles && candleData.map((d, i) => {
            if (d.empty) return null; // skip empty flat candles entirely
            const isGreen    = d.c >= d.o;
            const color      = isGreen ? '#84CC16' : '#EF4444';
            const cx         = candleCX(i);
            const bodyTop    = toY(Math.max(d.o, d.c));
            const bodyBottom = toY(Math.min(d.o, d.c));
            const bodyH      = Math.max(2, bodyBottom - bodyTop);
            const wickTop    = toY(d.h);
            const wickBottom = toY(d.l);
            const isHovered  = hover?.idx === i;
            return (
              <g key={i} opacity={isHovered ? 1 : 0.88}>
                <line x1={cx} x2={cx} y1={wickTop}    y2={bodyTop}    stroke={color} strokeWidth="1" />
                <rect x={cx - candleW/2} y={bodyTop} width={candleW} height={bodyH}
                  fill={color} fillOpacity={isGreen ? 0.9 : 0.85} rx="0.5" />
                <line x1={cx} x2={cx} y1={bodyBottom} y2={wickBottom} stroke={color} strokeWidth="1" />
              </g>
            );
          })}

          {/* Crosshair */}
          {hover && (
            <>
              <line x1={hover.x} x2={hover.x} y1={PT} y2={H-PB}
                stroke="#84CC16" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5" />
              <line x1={PL} x2={W-PR} y1={hover.y} y2={hover.y}
                stroke="#84CC16" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5" />
              <circle cx={hover.x} cy={hover.y} r="3" fill={accentColor} stroke="#000" strokeWidth="1.5" />
            </>
          )}
        </svg>
      )}

      <style>{`
        @keyframes chartDraw { to { stroke-dashoffset: 0; } }
        @keyframes chartFade { to { opacity: 1; } }
      `}</style>
    </div>
  );
}
