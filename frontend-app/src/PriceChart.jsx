// PriceChart.jsx
// Interactive price/market cap chart for a SuiPump bonding curve token.
// Features:
//   - Time intervals: 1M, 5M, 30M, 1H, ALL
//   - Toggle: PRICE | MCAP
//   - Real OHLC candlestick rendering — bodies + wicks, green/red
//   - Hover crosshair with USD primary, SUI secondary tooltip
//   - SUI/USD price from Binance public API
//   - Fetches ALL events via cursor pagination

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const TOTAL_SUPPLY_WHOLE = 1_000_000_000;
const INTERVALS = [
  { label: '1M',  ms: 60_000,     window: 60_000 },
  { label: '5M',  ms: 300_000,    window: 300_000 },
  { label: '30M', ms: 1_800_000,  window: 1_800_000 },
  { label: '1H',  ms: 3_600_000,  window: 3_600_000 },
  { label: 'ALL', ms: 0,          window: 0 },
];
const VIEWS = ['PRICE', 'MCAP'];

async function fetchSuiUsd() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    const j = await res.json();
    return parseFloat(j.price) || 0;
  } catch {
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd');
      const j = await res.json();
      return j?.sui?.usd || 0;
    } catch { return 0; }
  }
}

// Build OHLC candles with forward-fill.
// Key insight: on a bonding curve, price is constant between trades.
// So empty buckets inherit the previous close as a flat candle — just
// like a real exchange during a quiet period.
function toCandles(points, intervalMs, windowMs) {
  if (points.length === 0) return [];

  // Determine bucket size
  let ms = intervalMs;
  if (!ms) {
    // ALL: auto-pick bucket so we get ~60 candles across the full history
    if (points.length === 1) {
      const p = points[0];
      return [{ time: p.time, o: p.price, h: p.price, l: p.price, c: p.price, empty: false }];
    }
    const span = points[points.length - 1].time - points[0].time;
    const raw  = span / 60;
    const snaps = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 86_400_000];
    ms = snaps.find(s => s >= raw) ?? snaps[snaps.length - 1];
  }

  // Determine time range for forward-fill
  const now     = Date.now();
  const earliest = windowMs
    ? Math.max(points[0].time, now - windowMs)
    : points[0].time;
  const latest   = now;

  // Fill all bucket slots from earliest to now
  const firstBucket = Math.floor(earliest / ms) * ms;
  const lastBucket  = Math.floor(latest  / ms) * ms;

  // Group trades into buckets
  const tradeMap = {};
  for (const p of points) {
    if (windowMs && p.time < now - windowMs) continue;
    const b = Math.floor(p.time / ms) * ms;
    if (!tradeMap[b]) tradeMap[b] = [];
    tradeMap[b].push(p.price);
  }

  // Walk every bucket from first to last, forward-filling gaps
  const result = [];
  let prevClose = points[0].price; // price before the window starts

  // Find the last trade price before the window to use as initial prevClose
  const preWindow = points.filter(p => windowMs ? p.time < now - windowMs : false);
  if (preWindow.length > 0) prevClose = preWindow[preWindow.length - 1].price;

  for (let b = firstBucket; b <= lastBucket; b += ms) {
    const trades = tradeMap[b];
    if (trades && trades.length > 0) {
      const open  = prevClose;           // open = previous close (continuous)
      const close = trades[trades.length - 1];
      const high  = Math.max(open, ...trades);
      const low   = Math.min(open, ...trades);
      result.push({ time: b, o: open, h: high, l: low, c: close, empty: false });
      prevClose = close;
    } else {
      // Empty bucket — flat doji at prevClose
      result.push({ time: b, o: prevClose, h: prevClose, l: prevClose, c: prevClose, empty: true });
    }
  }

  return result;
}

function filterByWindow(points, windowMs) {
  if (!windowMs) return points;
  const cutoff = Date.now() - windowMs;
  const out = points.filter(p => p.time >= cutoff);
  if (out.length === 0 && points.length > 0) return [points[points.length - 1]];
  return out;
}

export default function PriceChart({ curveId, refreshKey }) {
  const client = useSuiClient();
  const svgRef = useRef(null);

  const [rawTrades, setRawTrades] = useState([]);
  const [suiUsd, setSuiUsd] = useState(0);
  const [intervalIdx, setIntervalIdx] = useState(4);
  const [view, setView] = useState('PRICE');
  const [hover, setHover] = useState(null); // { idx, x, y }
  const [loading, setLoading] = useState(true);

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
        const eventMap = await paginateMultipleEvents(client, [buyType, sellType], {
          order: 'ascending', maxPages: 20,
        });
        const all = [
          ...eventMap[buyType].map(e => ({ ...e, kind: 'buy' })),
          ...eventMap[sellType].map(e => ({ ...e, kind: 'sell' })),
        ]
          .filter(e => e.parsedJson?.curve_id === curveId)
          .sort((a, b) => Number(a.timestampMs) - Number(b.timestampMs));

        const points = all.map(e => {
          const p = e.parsedJson;
          let price;
          if (e.kind === 'buy') {
            const suiIn  = Number(p.sui_in   ?? 0) / 1e9;
            const tokOut = Number(p.tokens_out ?? 1) / 1e6;
            price = tokOut > 0 ? suiIn / tokOut : 0;
          } else {
            const suiOut = Number(p.sui_out  ?? 0) / 1e9;
            const tokIn  = Number(p.tokens_in ?? 1) / 1e6;
            price = tokIn > 0 ? suiOut / tokIn : 0;
          }
          return { time: Number(e.timestampMs), price, kind: e.kind };
        }).filter(t => t.price > 0);

        if (!cancelled) { setRawTrades(points); setLoading(false); }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client, refreshKey]);

  const { ms: intervalMs, window: windowMs } = INTERVALS[intervalIdx];
  const candles   = useMemo(() => toCandles(rawTrades, intervalMs, windowMs), [rawTrades, intervalMs, windowMs]);

  const chartData = useMemo(() => {
    const mul = view === 'MCAP' ? TOTAL_SUPPLY_WHOLE : 1;
    return candles.map(c => ({
      ...c,
      o: c.o * mul, h: c.h * mul, l: c.l * mul, c: c.c * mul,
      value: c.c * mul,
    }));
  }, [candles, view]);

  // ── SVG dimensions ──────────────────────────────────────────────────────────
  const W = 600, H = 200, PL = 68, PR = 8, PT = 12, PB = 28;
  const cW = W - PL - PR;
  const cH = H - PT - PB;

  // Price range with padding
  const allH = chartData.map(d => d.h);
  const allL = chartData.map(d => d.l);
  const rawMin = allL.length ? Math.min(...allL) : 0;
  const rawMax = allH.length ? Math.max(...allH) : 1;
  const pad    = (rawMax - rawMin) * 0.08 || rawMax * 0.05 || 1e-10;
  const minV   = rawMin - pad;
  const maxV   = rawMax + pad;
  const rangeV = maxV - minV || 1;

  const toY = v  => PT + (1 - (v - minV) / rangeV) * cH;

  // Candle x positions and width
  const n = chartData.length;
  const candleSlot  = n > 1 ? cW / n : cW;
  const candleW     = Math.max(1.5, Math.min(12, candleSlot * 0.6));
  const candleCenterX = i => PL + (i + 0.5) * candleSlot;

  // ── Formatters ──────────────────────────────────────────────────────────────
  const fmtPrice = (v) => {
    if (v == null) return '-';
    if (view === 'MCAP') {
      if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
      if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
      return v.toFixed(1);
    }
    if (v < 1e-7) return v.toExponential(2);
    if (v < 0.001) return v.toFixed(7);
    return v.toFixed(5);
  };

  const fmtUsd = (suiVal) => {
    if (!suiUsd || suiVal == null) return null;
    const usd = suiVal * suiUsd;
    if (usd >= 1e6)  return `$${(usd / 1e6).toFixed(3)}M`;
    if (usd >= 1e3)  return `$${(usd / 1e3).toFixed(2)}k`;
    if (usd >= 1)    return `$${usd.toFixed(4)}`;
    if (usd >= 1e-4) return `$${usd.toFixed(6)}`;
    if (usd === 0)   return '$0.00';
    return `$${usd.toPrecision(4)}`;
  };

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y: PT + (1 - t) * cH,
    value: minV + t * rangeV,
  }));

  const xTicks = n >= 2
    ? [0, Math.floor(n / 2), n - 1].map(i => ({
        x: candleCenterX(i),
        label: chartData[i]
          ? new Date(chartData[i].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '',
      }))
    : [];

  // ── Mouse interaction ────────────────────────────────────────────────────────
  const handleMouseMove = useCallback((e) => {
    if (!svgRef.current || chartData.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX  = ((e.clientX - rect.left) / rect.width) * W;
    if (svgX < PL || svgX > W - PR) { setHover(null); return; }
    const idx = Math.max(0, Math.min(n - 1, Math.floor(((svgX - PL) / cW) * n)));
    const d   = chartData[idx];
    if (d) setHover({ idx, x: candleCenterX(idx), y: toY(d.c) });
  }, [chartData, n]);

  const cur  = hover ? chartData[hover.idx] : (n > 0 ? chartData[n - 1] : null);
  const isUp = n >= 2 && chartData[n - 1].c >= chartData[0].o;
  const accentColor = isUp ? '#84CC16' : '#EF4444';

  return (
    <div className="border border-lime-900/30 bg-black p-3 rounded-xl">
      {/* Controls */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1">
          {VIEWS.map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`text-[10px] font-mono px-2 py-0.5 border transition-colors ${
                view === v
                  ? 'bg-lime-400 text-black border-lime-400'
                  : 'text-lime-700 border-lime-900 hover:border-lime-600'
              }`}
            >{v}</button>
          ))}
        </div>
        <div className="flex gap-1">
          {INTERVALS.map((iv, i) => (
            <button key={iv.label} onClick={() => setIntervalIdx(i)}
              className={`text-[10px] font-mono px-2 py-0.5 border transition-colors ${
                intervalIdx === i
                  ? 'bg-lime-950 text-lime-400 border-lime-600'
                  : 'text-lime-900 border-lime-950 hover:border-lime-800'
              }`}
            >{iv.label}</button>
          ))}
        </div>
      </div>

      {/* Current price display */}
      {cur && (
        <div className="flex items-baseline gap-3 mb-2">
          {fmtUsd(cur.c) ? (
            <>
              <span className="text-lg font-bold font-mono" style={{ color: accentColor }}>
                {fmtUsd(cur.c)}
              </span>
              <span className="text-xs font-mono text-lime-700">{fmtPrice(cur.c)} SUI</span>
            </>
          ) : (
            <span className="text-lg font-bold font-mono" style={{ color: accentColor }}>
              {fmtPrice(cur.c)} SUI
            </span>
          )}
          {hover && (
            <span className="text-[10px] font-mono text-lime-800 ml-auto">
              {new Date(cur.time).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* OHLC summary on hover */}
      {hover && cur && (
        <div className="flex gap-3 mb-1.5 text-[9px] font-mono">
          <span className="text-white/40">O <span className="text-white/60">{fmtPrice(cur.o)}</span></span>
          <span className="text-white/40">H <span className="text-lime-500">{fmtPrice(cur.h)}</span></span>
          <span className="text-white/40">L <span className="text-red-500">{fmtPrice(cur.l)}</span></span>
          <span className="text-white/40">C <span className="text-white/60">{fmtPrice(cur.c)}</span></span>
        </div>
      )}

      {loading ? (
        <div className="h-48 flex items-center justify-center text-[10px] font-mono text-lime-900">
          LOADING TRADES…
        </div>
      ) : chartData.length < 1 ? (
        <div className="h-48 flex items-center justify-center text-[10px] font-mono text-lime-900">
          NOT ENOUGH TRADES — BUY OR SELL TO START THE CHART
        </div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full cursor-crosshair select-none"
          style={{ height: '200px' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHover(null)}
          preserveAspectRatio="none"
        >
          {/* Grid lines */}
          {yTicks.map((t, i) => (
            <line key={i} x1={PL} x2={W - PR} y1={t.y} y2={t.y}
              stroke="#141414" strokeWidth="1" />
          ))}

          {/* Y-axis labels */}
          {yTicks.map((t, i) => {
            const lbl = fmtUsd(t.value) ?? fmtPrice(t.value);
            return (
              <text key={i} x={PL - 4} y={t.y + 3}
                textAnchor="end" fontSize="7.5" fill="#4B5563" fontFamily="monospace">
                {lbl}
              </text>
            );
          })}

          {/* X-axis labels */}
          {xTicks.map((t, i) => (
            <text key={i} x={t.x} y={H - 4}
              textAnchor="middle" fontSize="7" fill="#374151" fontFamily="monospace">
              {t.label}
            </text>
          ))}

          {/* ── Candlesticks ─────────────────────────────────────────────────── */}
          {chartData.map((d, i) => {
            const isGreen    = d.c >= d.o;
            const isEmpty    = d.empty === true;
            const color      = isEmpty ? '#2a3a1a' : (isGreen ? '#84CC16' : '#EF4444');
            const cx         = candleCenterX(i);
            const bodyTop    = toY(Math.max(d.o, d.c));
            const bodyBottom = toY(Math.min(d.o, d.c));
            const bodyH      = Math.max(isEmpty ? 1 : 3, bodyBottom - bodyTop);
            const wickTop    = toY(d.h);
            const wickBottom = toY(d.l);
            const isHovered  = hover?.idx === i;

            return (
              <g key={i} opacity={isHovered ? 1 : 0.85}>
                {/* Upper wick */}
                <line
                  x1={cx} x2={cx}
                  y1={wickTop} y2={bodyTop}
                  stroke={color} strokeWidth="1"
                />
                {/* Candle body */}
                <rect
                  x={cx - candleW / 2}
                  y={bodyTop}
                  width={candleW}
                  height={bodyH}
                  fill={isGreen ? color : color}
                  fillOpacity={isGreen ? 0.9 : 0.85}
                  rx="0.5"
                />
                {/* Lower wick */}
                <line
                  x1={cx} x2={cx}
                  y1={bodyBottom} y2={wickBottom}
                  stroke={color} strokeWidth="1"
                />
              </g>
            );
          })}

          {/* Crosshair */}
          {hover && (
            <>
              <line
                x1={hover.x} x2={hover.x} y1={PT} y2={H - PB}
                stroke="#84CC16" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5"
              />
              <line
                x1={PL} x2={W - PR} y1={hover.y} y2={hover.y}
                stroke="#84CC16" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5"
              />
              {/* Crosshair dot at close price */}
              <circle
                cx={hover.x} cy={hover.y} r="3"
                fill={accentColor} stroke="#000" strokeWidth="1.5"
              />
            </>
          )}
        </svg>
      )}
    </div>
  );
}
