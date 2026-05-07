// PriceChart.jsx
// Interactive price/market cap chart for a SuiPump bonding curve token.
// Features:
//   - Time intervals: 1m, 5m, 30m, 1h, ALL  (properly filtered by real timestamp window)
//   - Toggle: PRICE | MCAP
//   - Hover crosshair — USD primary, SUI secondary
//   - SUI/USD price from Binance public API (CORS-friendly, no key needed)
//   - OHLC candle grouping per interval
//   - Smooth cubic-bezier path + fade-in animation on data change
//   - Fetches ALL TokensPurchased + TokensSold events via cursor pagination

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

function toCandles(points, intervalMs) {
  if (points.length === 0) return [];
  if (!intervalMs) {
    return points.map(p => ({ ...p, o: p.price, h: p.price, l: p.price, c: p.price, value: p.price }));
  }
  const buckets = {};
  for (const p of points) {
    const bucket = Math.floor(p.time / intervalMs) * intervalMs;
    if (!buckets[bucket]) buckets[bucket] = { time: bucket, prices: [], kinds: [] };
    buckets[bucket].prices.push(p.price);
    buckets[bucket].kinds.push(p.kind);
  }
  return Object.values(buckets).sort((a, b) => a.time - b.time).map(b => ({
    time: b.time,
    price: b.prices[b.prices.length - 1],
    o: b.prices[0],
    h: Math.max(...b.prices),
    l: Math.min(...b.prices),
    c: b.prices[b.prices.length - 1],
    value: b.prices[b.prices.length - 1],
    kind: b.kinds[b.kinds.length - 1],
  }));
}

// Filter raw points to the interval's time WINDOW (real time cutoff)
function filterByWindow(points, windowMs) {
  if (!windowMs) return points;
  const cutoff = Date.now() - windowMs;
  const out = points.filter(p => p.time >= cutoff);
  // Always include at least the last point so chart isn't blank
  if (out.length === 0 && points.length > 0) return [points[points.length - 1]];
  return out;
}

// Smooth cubic-bezier path
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

export default function PriceChart({ curveId, refreshKey }) {
  const client = useSuiClient();
  const svgRef = useRef(null);

  const [rawTrades, setRawTrades] = useState([]);
  const [suiUsd, setSuiUsd] = useState(0);
  const [intervalIdx, setIntervalIdx] = useState(4);
  const [view, setView] = useState('PRICE');
  const [hover, setHover] = useState(null);
  const [loading, setLoading] = useState(true);
  const [animKey, setAnimKey] = useState(0);

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
        const buyType = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
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
          let price;
          if (e.kind === 'buy') {
            const suiIn = Number(p.sui_in ?? 0) / 1e9;
            const tokOut = Number(p.tokens_out ?? 1) / 1e6;
            price = tokOut > 0 ? suiIn / tokOut : 0;
          } else {
            const suiOut = Number(p.sui_out ?? 0) / 1e9;
            const tokIn = Number(p.tokens_in ?? 1) / 1e6;
            price = tokIn > 0 ? suiOut / tokIn : 0;
          }
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
  const filtered = useMemo(() => filterByWindow(rawTrades, windowMs), [rawTrades, windowMs, intervalIdx]);
  const candles  = useMemo(() => toCandles(filtered, intervalMs), [filtered, intervalMs]);

  const chartData = useMemo(() => {
    const mul = view === 'MCAP' ? TOTAL_SUPPLY_WHOLE : 1;
    return candles.map(c => ({ ...c, value: c.price * mul, o: c.o*mul, h: c.h*mul, l: c.l*mul, c: c.c*mul }));
  }, [candles, view]);

  const W = 600, H = 160, PL = 62, PR = 8, PT = 12, PB = 28;
  const cW = W - PL - PR, cH = H - PT - PB;

  const vals = chartData.map(d => d.value);
  const minV = vals.length ? Math.min(...vals) * 0.992 : 0;
  const maxV = vals.length ? Math.max(...vals) * 1.008 : 1;
  const rangeV = maxV - minV || 1;

  const toX = i => PL + (i / Math.max(chartData.length - 1, 1)) * cW;
  const toY = v => PT + (1 - (v - minV) / rangeV) * cH;

  const pts   = chartData.map((d, i) => [toX(i), toY(d.value)]);
  const pathD = pts.length >= 2 ? smoothPath(pts) : null;
  const areaD = pathD ? `${pathD} L ${toX(chartData.length-1)},${H-PB} L ${PL},${H-PB} Z` : null;

  const isUp = chartData.length >= 2 && chartData[chartData.length-1].value >= chartData[0].value;
  const lineColor = isUp ? '#84CC16' : '#EF4444';

  // ─── Formatters ──────────────────────────────────────────────────────────────

  const fmtSui = (v) => {
    if (v == null) return '-';
    if (view === 'MCAP') {
      if (v >= 1e6) return `${(v/1e6).toFixed(2)}M`;
      if (v >= 1e3) return `${(v/1e3).toFixed(1)}k`;
      return v.toFixed(1);
    }
    if (v < 1e-7) return v.toExponential(2);
    if (v < 0.001) return v.toFixed(7);
    return v.toFixed(5);
  };

  const fmtUsd = (suiVal) => {
    if (!suiUsd || suiVal == null) return null;
    const usd = suiVal * suiUsd;
    if (usd >= 1e9) return `$${(usd/1e9).toFixed(3)}B`;
    if (usd >= 1e6) return `$${(usd/1e6).toFixed(3)}M`;
    if (usd >= 1e3) return `$${(usd/1e3).toFixed(2)}k`;
    if (usd >= 1)   return `$${usd.toFixed(4)}`;
    if (usd >= 1e-4) return `$${usd.toFixed(6)}`;
    if (usd === 0)   return '$0.00';
    return `$${usd.toPrecision(4)}`;
  };

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({ y: PT + (1-t)*cH, value: minV + t*rangeV }));
  const xTicks = chartData.length >= 2
    ? [0, Math.floor(chartData.length/2), chartData.length-1].map(i => ({
        x: toX(i),
        label: chartData[i] ? new Date(chartData[i].time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '',
      }))
    : [];

  const handleMouseMove = useCallback((e) => {
    if (!svgRef.current || chartData.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    if (svgX < PL || svgX > W - PR) { setHover(null); return; }
    const idx = Math.max(0, Math.min(chartData.length-1, Math.round(((svgX-PL)/cW)*(chartData.length-1))));
    const point = chartData[idx];
    if (point) setHover({ x: toX(idx), y: toY(point.value), point });
  }, [chartData]);

  const cur = hover?.point ?? (chartData.length > 0 ? chartData[chartData.length-1] : null);
  const gradId = `ag${animKey % 4}`;

  return (
    <div className="border border-lime-900/30 bg-black p-3">
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

      {/* Current price — USD primary */}
      {cur && (
        <div className="flex items-baseline gap-3 mb-2">
          {fmtUsd(cur.value) ? (
            <>
              <span className="text-lg font-bold font-mono" style={{ color: lineColor }}>{fmtUsd(cur.value)}</span>
              <span className="text-xs font-mono text-lime-700">{fmtSui(cur.value)} SUI</span>
            </>
          ) : (
            <span className="text-lg font-bold font-mono" style={{ color: lineColor }}>{fmtSui(cur.value)} SUI</span>
          )}
          {hover && <span className="text-[10px] font-mono text-lime-800 ml-auto">{new Date(cur.time).toLocaleString()}</span>}
        </div>
      )}

      {loading ? (
        <div className="h-40 flex items-center justify-center text-[10px] font-mono text-lime-900">LOADING TRADES…</div>
      ) : chartData.length < 2 ? (
        <div className="h-40 flex items-center justify-center text-[10px] font-mono text-lime-900">NOT ENOUGH TRADES — BUY OR SELL TO START THE CHART</div>
      ) : (
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full cursor-crosshair select-none"
          style={{ height: '160px' }} onMouseMove={handleMouseMove} onMouseLeave={() => setHover(null)}
          preserveAspectRatio="none">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity="0.18" />
              <stop offset="100%" stopColor={lineColor} stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {yTicks.map((t,i) => <line key={i} x1={PL} x2={W-PR} y1={t.y} y2={t.y} stroke="#141414" strokeWidth="1" />)}

          {/* Y-axis: USD labels if SUI price available, else SUI */}
          {yTicks.map((t,i) => {
            const lbl = fmtUsd(t.value) ?? fmtSui(t.value);
            return (
              <text key={i} x={PL-4} y={t.y+3} textAnchor="end" fontSize="7.5" fill="#4B5563" fontFamily="monospace">
                {lbl}
              </text>
            );
          })}

          {xTicks.map((t,i) => (
            <text key={i} x={t.x} y={H-4} textAnchor="middle" fontSize="7" fill="#374151" fontFamily="monospace">{t.label}</text>
          ))}

          {/* Area */}
          {areaD && <path key={`a${animKey}`} d={areaD} fill={`url(#${gradId})`} className="chart-area" />}

          {/* Line — animated draw-on */}
          {pathD && (
            <path key={`l${animKey}`} d={pathD} fill="none" stroke={lineColor} strokeWidth="1.5"
              strokeLinejoin="round" strokeLinecap="round" className="chart-line" />
          )}

          {/* Trade dots */}
          {chartData.map((d,i) => (
            <circle key={i} cx={toX(i)} cy={toY(d.value)} r="2.2"
              fill={d.kind === 'sell' ? '#EF4444' : '#84CC16'} opacity="0.55" />
          ))}

          {/* Crosshair + tooltip */}
          {hover && (() => {
            const usdLbl = fmtUsd(hover.point.value);
            const suiLbl = fmtSui(hover.point.value);
            const ttW = 148, ttH = usdLbl ? 54 : 40;
            const ttX = hover.x + 10 + ttW > W - PR ? hover.x - ttW - 10 : hover.x + 10;
            const ttY = Math.max(PT, Math.min(H - PB - ttH, hover.y - ttH/2));
            return (
              <>
                <line x1={hover.x} x2={hover.x} y1={PT} y2={H-PB} stroke="#84CC16" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.4" />
                <line x1={PL} x2={W-PR} y1={hover.y} y2={hover.y} stroke="#84CC16" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.4" />
                <circle cx={hover.x} cy={hover.y} r="4" fill={lineColor} stroke="#000" strokeWidth="1.5" />
                <rect x={ttX} y={ttY} width={ttW} height={ttH} fill="#070707" stroke="#1F2937" strokeWidth="0.5" rx="2" />
                {usdLbl ? (
                  <>
                    <text x={ttX+7} y={ttY+15} fontSize="10" fill="#84CC16" fontFamily="monospace" fontWeight="bold">{usdLbl}</text>
                    <text x={ttX+7} y={ttY+28} fontSize="8" fill="#6B7280" fontFamily="monospace">{suiLbl} SUI</text>
                  </>
                ) : (
                  <text x={ttX+7} y={ttY+15} fontSize="9" fill="#84CC16" fontFamily="monospace" fontWeight="bold">{suiLbl} SUI</text>
                )}
                <text x={ttX+7} y={ttY+ttH-7} fontSize="7" fill="#374151" fontFamily="monospace">
                  {new Date(hover.point.time).toLocaleTimeString()}
                </text>
              </>
            );
          })()}
        </svg>
      )}

      <style>{`
        .chart-line {
          stroke-dasharray: 3000;
          stroke-dashoffset: 3000;
          animation: chartDraw 0.55s ease-out forwards;
        }
        .chart-area {
          animation: chartFade 0.45s ease-out forwards;
          opacity: 0;
        }
        @keyframes chartDraw {
          to { stroke-dashoffset: 0; }
        }
        @keyframes chartFade {
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
