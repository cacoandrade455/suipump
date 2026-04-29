// PriceChart.jsx
// Interactive price/market cap chart for a SuiPump bonding curve token.
// Features:
//   - Time intervals: 1m, 5m, 30m, 1h, ALL
//   - Toggle: PRICE | MCAP
//   - Hover crosshair with price tooltip (SUI + USD)
//   - SUI/USD price from Binance public API (CORS-friendly, no key needed)
//   - Candlestick-style OHLC grouping per interval
//   - Fetches TokensPurchased + TokensSold events and reconstructs price history

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';

const TOTAL_SUPPLY_WHOLE = 1_000_000_000; // 1B for market cap calc
const INTERVALS = [
  { label: '1M',  ms: 60_000 },
  { label: '5M',  ms: 300_000 },
  { label: '30M', ms: 1_800_000 },
  { label: '1H',  ms: 3_600_000 },
  { label: 'ALL', ms: 0 },
];
const VIEWS = ['PRICE', 'MCAP'];

// Fetch SUI/USD from Binance public ticker — CORS allowed, no API key
async function fetchSuiUsd() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    const j = await res.json();
    return parseFloat(j.price) || 0;
  } catch {
    try {
      // Fallback: CoinGecko simple price (sometimes works without key)
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd');
      const j = await res.json();
      return j?.sui?.usd || 0;
    } catch {
      return 0;
    }
  }
}

// Group raw trade points into OHLC candles per interval bucket
function toCandles(points, intervalMs) {
  if (!intervalMs || intervalMs === 0) return points.map(p => ({ ...p, o: p.price, h: p.price, l: p.price, c: p.price }));
  if (points.length === 0) return [];
  const buckets = {};
  for (const p of points) {
    const bucket = Math.floor(p.time / intervalMs) * intervalMs;
    if (!buckets[bucket]) buckets[bucket] = { time: bucket, prices: [] };
    buckets[bucket].prices.push(p.price);
  }
  return Object.values(buckets)
    .sort((a, b) => a.time - b.time)
    .map(b => ({
      time: b.time,
      price: b.prices[b.prices.length - 1], // close
      o: b.prices[0],
      h: Math.max(...b.prices),
      l: Math.min(...b.prices),
      c: b.prices[b.prices.length - 1],
    }));
}

// Filter points to only those within the last N buckets of the interval
// For ALL (intervalMs=0), return everything
// For time intervals, show last 100 data points regardless of time
// (testnet trades from days ago should still show on 1M chart)
function filterByInterval(points, intervalMs) {
  if (!intervalMs) return points;
  // Instead of filtering by wall-clock time (which breaks on testnet with old trades),
  // bucket the existing points and show the last 100 candles worth
  return points.slice(-100);
}

export default function PriceChart({ curveId, refreshKey }) {
  const client = useSuiClient();
  const svgRef = useRef(null);

  const [rawTrades, setRawTrades] = useState([]);
  const [suiUsd, setSuiUsd] = useState(0);
  const [intervalIdx, setIntervalIdx] = useState(4); // default ALL
  const [view, setView] = useState('PRICE');
  const [hover, setHover] = useState(null); // { x, y, point }
  const [loading, setLoading] = useState(true);

  // Fetch SUI price
  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const t = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(t);
  }, []);

  // Fetch trade events
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [buys, sells] = await Promise.all([
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensPurchased` },
            limit: 100, order: 'ascending',
          }),
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensSold` },
            limit: 100, order: 'ascending',
          }),
        ]);

        const all = [
          ...buys.data.map(e => ({ ...e, kind: 'buy' })),
          ...sells.data.map(e => ({ ...e, kind: 'sell' })),
        ]
          .filter(e => e.parsedJson?.curve_id === curveId)
          .sort((a, b) => Number(a.timestampMs) - Number(b.timestampMs));

        const points = all.map(e => {
          const p = e.parsedJson;
          let pricePerWhole;

          if (e.kind === 'buy') {
            // Marginal buy price: SUI paid (after fee) / tokens received
            // sui_in includes the fee, effective swap = sui_in * 0.99
            const suiIn = Number(p.sui_in ?? 0) / 1e9;       // SUI
            const tokOut = Number(p.tokens_out ?? 1) / 1e6;  // whole tokens
            pricePerWhole = tokOut > 0 ? suiIn / tokOut : 0;
          } else {
            // Marginal sell price: SUI received / tokens sold
            const suiOut = Number(p.sui_out ?? 0) / 1e9;
            const tokIn = Number(p.tokens_in ?? 1) / 1e6;
            pricePerWhole = tokIn > 0 ? suiOut / tokIn : 0;
          }

          return {
            time: Number(e.timestampMs),
            price: pricePerWhole,
            kind: e.kind,
          };
        }).filter(t => t.price > 0);

        if (!cancelled) { setRawTrades(points); setLoading(false); }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client, refreshKey]);

  // Derived chart data
  const intervalMs = INTERVALS[intervalIdx].ms;
  const filtered = useMemo(() => filterByInterval(rawTrades, intervalMs), [rawTrades, intervalMs]);
  const candles = useMemo(() => toCandles(filtered, intervalMs), [filtered, intervalMs]);

  const chartData = useMemo(() => {
    if (view === 'MCAP') {
      return candles.map(c => ({
        ...c,
        value: c.price * TOTAL_SUPPLY_WHOLE,
        o: c.o * TOTAL_SUPPLY_WHOLE,
        h: c.h * TOTAL_SUPPLY_WHOLE,
        l: c.l * TOTAL_SUPPLY_WHOLE,
        c: c.c * TOTAL_SUPPLY_WHOLE,
      }));
    }
    return candles.map(c => ({ ...c, value: c.price }));
  }, [candles, view]);

  // SVG dimensions
  const W = 600, H = 160, PL = 56, PR = 8, PT = 12, PB = 28;
  const cW = W - PL - PR, cH = H - PT - PB;

  const values = chartData.map(d => d.value);
  const minV = values.length ? Math.min(...values) * 0.995 : 0;
  const maxV = values.length ? Math.max(...values) * 1.005 : 1;
  const rangeV = maxV - minV || 1;

  const toX = (i) => PL + (i / Math.max(chartData.length - 1, 1)) * cW;
  const toY = (v) => PT + (1 - (v - minV) / rangeV) * cH;

  const pathD = chartData.length >= 2
    ? 'M ' + chartData.map((d, i) => `${toX(i)},${toY(d.value)}`).join(' L ')
    : null;
  const areaD = pathD
    ? `${pathD} L ${toX(chartData.length - 1)},${H - PB} L ${PL},${H - PB} Z`
    : null;

  const isUp = chartData.length >= 2 && chartData[chartData.length - 1].value >= chartData[0].value;
  const lineColor = isUp ? '#84CC16' : '#EF4444';
  const fillColor = isUp ? '#84CC1618' : '#EF444418';

  // Y-axis labels
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y: PT + (1 - t) * cH,
    value: minV + t * rangeV,
  }));

  // X-axis labels (time)
  const xTicks = chartData.length >= 2
    ? [0, Math.floor(chartData.length / 2), chartData.length - 1].map(i => ({
        x: toX(i),
        label: chartData[i] ? new Date(chartData[i].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      }))
    : [];

  // Format value for display
  const fmtVal = (v) => {
    if (view === 'MCAP') {
      if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
      if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
      return v.toFixed(2);
    }
    if (v < 0.000001) return v.toExponential(3);
    if (v < 0.001) return v.toFixed(7);
    return v.toFixed(6);
  };

  const fmtUsd = (suiVal) => {
    if (!suiUsd) return '';
    const usd = suiVal * suiUsd;
    if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
    if (usd >= 1e3) return `$${(usd / 1e3).toFixed(2)}k`;
    if (usd >= 0.01) return `$${usd.toFixed(4)}`;
    // For very small numbers, show enough significant digits without exponential
    if (usd === 0) return '$0';
    const sig = usd.toPrecision(4);
    // Format as $0.0000144 style — count leading zeros after decimal
    return `$${parseFloat(sig).toFixed(Math.max(4, -Math.floor(Math.log10(usd)) + 3))}`;
  };

  // Mouse hover handler
  const handleMouseMove = useCallback((e) => {
    if (!svgRef.current || chartData.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const svgY = ((e.clientY - rect.top) / rect.height) * H;
    if (svgX < PL || svgX > W - PR) { setHover(null); return; }
    const idx = Math.round(((svgX - PL) / cW) * (chartData.length - 1));
    const clampedIdx = Math.max(0, Math.min(chartData.length - 1, idx));
    const point = chartData[clampedIdx];
    if (point) setHover({ x: toX(clampedIdx), y: toY(point.value), point, idx: clampedIdx });
  }, [chartData, W, H, PL, PR, cW, cH]);

  const currentPoint = hover?.point ?? (chartData.length > 0 ? chartData[chartData.length - 1] : null);

  return (
    <div className="border border-lime-900/30 bg-black p-3">
      {/* Controls row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1">
          {VIEWS.map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`text-[10px] font-mono px-2 py-0.5 border ${
                view === v ? 'bg-lime-400 text-black border-lime-400' : 'text-lime-700 border-lime-900 hover:border-lime-600'
              }`}
            >{v}</button>
          ))}
        </div>
        <div className="flex gap-1">
          {INTERVALS.map((iv, i) => (
            <button key={iv.label} onClick={() => setIntervalIdx(i)}
              className={`text-[10px] font-mono px-2 py-0.5 border ${
                intervalIdx === i ? 'bg-lime-950 text-lime-400 border-lime-600' : 'text-lime-900 border-lime-950 hover:border-lime-800'
              }`}
            >{iv.label}</button>
          ))}
        </div>
      </div>

      {/* Current value display */}
      {currentPoint && (
        <div className="flex items-baseline gap-3 mb-2">
          {suiUsd > 0 ? (
            <>
              <span className="text-lg font-bold font-mono" style={{ color: lineColor }}>
                {fmtUsd(currentPoint.value)}
              </span>
              <span className="text-xs font-mono text-lime-700">
                {fmtVal(currentPoint.value)} SUI
              </span>
            </>
          ) : (
            <span className="text-lg font-bold font-mono" style={{ color: lineColor }}>
              {fmtVal(currentPoint.value)} SUI
            </span>
          )}
          {hover && (
            <span className="text-[10px] font-mono text-lime-800 ml-auto">
              {new Date(currentPoint.time).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* Chart */}
      {loading ? (
        <div className="h-40 flex items-center justify-center text-[10px] font-mono text-lime-900">
          LOADING TRADES…
        </div>
      ) : chartData.length < 2 ? (
        <div className="h-40 flex items-center justify-center text-[10px] font-mono text-lime-900">
          NOT ENOUGH TRADES — BUY OR SELL TO START THE CHART
        </div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full cursor-crosshair select-none"
          style={{ height: '160px' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHover(null)}
          preserveAspectRatio="none"
        >
          {/* Grid lines */}
          {yTicks.map((t, i) => (
            <line key={i} x1={PL} x2={W - PR} y1={t.y} y2={t.y}
              stroke="#1a1a1a" strokeWidth="1" />
          ))}

          {/* Y-axis labels */}
          {yTicks.map((t, i) => (
            <text key={i} x={PL - 4} y={t.y + 3} textAnchor="end"
              fontSize="7" fill="#4B5563" fontFamily="monospace">
              {fmtVal(t.value)}
            </text>
          ))}

          {/* X-axis labels */}
          {xTicks.map((t, i) => (
            <text key={i} x={t.x} y={H - 4} textAnchor="middle"
              fontSize="7" fill="#374151" fontFamily="monospace">
              {t.label}
            </text>
          ))}

          {/* Area fill */}
          {areaD && <path d={areaD} fill={fillColor} />}

          {/* Price line */}
          {pathD && (
            <path d={pathD} fill="none" stroke={lineColor} strokeWidth="1.5"
              strokeLinejoin="round" strokeLinecap="round" />
          )}

          {/* Data point dots */}
          {chartData.map((d, i) => (
            <circle key={i} cx={toX(i)} cy={toY(d.value)} r="2"
              fill={d.kind === 'sell' ? '#EF4444' : '#84CC16'}
              opacity="0.6" />
          ))}

          {/* Hover crosshair */}
          {hover && (
            <>
              <line x1={hover.x} x2={hover.x} y1={PT} y2={H - PB}
                stroke="#84CC16" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5" />
              <line x1={PL} x2={W - PR} y1={hover.y} y2={hover.y}
                stroke="#84CC16" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5" />
              <circle cx={hover.x} cy={hover.y} r="3.5"
                fill={lineColor} stroke="#000" strokeWidth="1" />
              {/* Tooltip */}
              {(() => {
                const ttW = 130, ttH = 46;
                const ttX = hover.x + 8 + ttW > W - PR ? hover.x - ttW - 8 : hover.x + 8;
                const ttY = Math.max(PT, Math.min(H - PB - ttH, hover.y - ttH / 2));
                return (
                  <g>
                    <rect x={ttX} y={ttY} width={ttW} height={ttH}
                      fill="#0A0A0A" stroke="#1F2937" strokeWidth="0.5" rx="2" />
                    <text x={ttX + 6} y={ttY + 14} fontSize="9" fill="#84CC16"
                      fontFamily="monospace" fontWeight="bold">
                      {fmtVal(hover.point.value)} SUI
                    </text>
                    {suiUsd > 0 && (
                      <text x={ttX + 6} y={ttY + 26} fontSize="8" fill="#6B7280" fontFamily="monospace">
                        {fmtUsd(hover.point.value)}
                      </text>
                    )}
                    <text x={ttX + 6} y={ttY + 38} fontSize="7" fill="#374151" fontFamily="monospace">
                      {new Date(hover.point.time).toLocaleTimeString()}
                    </text>
                  </g>
                );
              })()}
            </>
          )}
        </svg>
      )}
    </div>
  );
}
