// PriceChart.jsx — pump.fun-style clean chart
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';

const TOTAL_SUPPLY_WHOLE = 1_000_000_000;
const INTERVALS = [
  { label: '1M',  ms: 60_000 },
  { label: '5M',  ms: 300_000 },
  { label: '30M', ms: 1_800_000 },
  { label: '1H',  ms: 3_600_000 },
  { label: 'ALL', ms: 0 },
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
  if (!intervalMs) return points.map(p => ({ ...p, o: p.price, h: p.price, l: p.price, c: p.price }));
  if (!points.length) return [];
  const buckets = {};
  for (const p of points) {
    const bucket = Math.floor(p.time / intervalMs) * intervalMs;
    if (!buckets[bucket]) buckets[bucket] = { time: bucket, prices: [], kind: p.kind };
    buckets[bucket].prices.push(p.price);
  }
  return Object.values(buckets).sort((a, b) => a.time - b.time).map(b => ({
    time: b.time, kind: b.kind,
    price: b.prices[b.prices.length - 1],
    o: b.prices[0],
    h: Math.max(...b.prices),
    l: Math.min(...b.prices),
    c: b.prices[b.prices.length - 1],
  }));
}

export default function PriceChart({ curveId, refreshKey }) {
  const client = useSuiClient();
  const svgRef = useRef(null);

  const [rawTrades, setRawTrades] = useState([]);
  const [suiUsd, setSuiUsd] = useState(0);
  const [intervalIdx, setIntervalIdx] = useState(4); // ALL
  const [view, setView] = useState('PRICE');
  const [hover, setHover] = useState(null);
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
        const [buys, sells] = await Promise.all([
          client.queryEvents({ query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensPurchased` }, limit: 100, order: 'ascending' }),
          client.queryEvents({ query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensSold` }, limit: 100, order: 'ascending' }),
        ]);
        const all = [
          ...buys.data.map(e => ({ ...e, kind: 'buy' })),
          ...sells.data.map(e => ({ ...e, kind: 'sell' })),
        ]
          .filter(e => e.parsedJson?.curve_id === curveId)
          .sort((a, b) => Number(a.timestampMs) - Number(b.timestampMs));

        const points = all.map(e => {
          const p = e.parsedJson;
          const suiVal = e.kind === 'buy' ? Number(p.sui_in ?? 0) / 1e9 : Number(p.sui_out ?? 0) / 1e9;
          const tokVal = e.kind === 'buy' ? Number(p.tokens_out ?? 1) / 1e6 : Number(p.tokens_in ?? 1) / 1e6;
          const price = tokVal > 0 ? suiVal / tokVal : 0;
          return { time: Number(e.timestampMs), price, kind: e.kind };
        }).filter(t => t.price > 0);

        if (!cancelled) { setRawTrades(points); setLoading(false); }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client, refreshKey]);

  const intervalMs = INTERVALS[intervalIdx].ms;
  const candles = useMemo(() => toCandles(rawTrades.slice(-100), intervalMs), [rawTrades, intervalMs]);

  const chartData = useMemo(() => view === 'MCAP'
    ? candles.map(c => ({ ...c, value: c.price * TOTAL_SUPPLY_WHOLE }))
    : candles.map(c => ({ ...c, value: c.price })),
  [candles, view]);

  // SVG layout — tighter, no padding waste
  const W = 600, H = 140, PL = 60, PR = 6, PT = 8, PB = 24;
  const cW = W - PL - PR, cH = H - PT - PB;

  const values = chartData.map(d => d.value);
  const minV = values.length ? Math.min(...values) * 0.992 : 0;
  const maxV = values.length ? Math.max(...values) * 1.008 : 1;
  const rangeV = maxV - minV || 1;

  const toX = i => PL + (i / Math.max(chartData.length - 1, 1)) * cW;
  const toY = v => PT + (1 - (v - minV) / rangeV) * cH;

  const pathD = chartData.length >= 2
    ? 'M ' + chartData.map((d, i) => `${toX(i).toFixed(1)},${toY(d.value).toFixed(1)}`).join(' L ')
    : null;
  const areaD = pathD
    ? `${pathD} L ${toX(chartData.length - 1).toFixed(1)},${H - PB} L ${PL},${H - PB} Z`
    : null;

  const isUp = chartData.length >= 2 && chartData[chartData.length - 1].value >= chartData[0].value;
  const lineColor = isUp ? '#84CC16' : '#EF4444';
  const fillColor = isUp ? '#84CC1612' : '#EF444412';

  const yTicks = [0, 0.5, 1].map(t => ({ y: PT + (1 - t) * cH, value: minV + t * rangeV }));
  const xTicks = chartData.length >= 2
    ? [0, Math.floor((chartData.length - 1) / 2), chartData.length - 1].map(i => ({
        x: toX(i),
        label: chartData[i] ? new Date(chartData[i].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      }))
    : [];

  const fmtVal = v => {
    if (view === 'MCAP') {
      if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
      if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
      return v.toFixed(2);
    }
    if (v < 0.000001) return v.toExponential(3);
    if (v < 0.001) return v.toFixed(7);
    return v.toFixed(6);
  };

  const fmtUsd = suiVal => {
    if (!suiUsd) return '';
    const usd = suiVal * (view === 'MCAP' ? suiUsd : suiUsd);
    const raw = view === 'MCAP' ? usd : usd;
    if (raw >= 1e6) return `$${(raw / 1e6).toFixed(2)}M`;
    if (raw >= 1e3) return `$${(raw / 1e3).toFixed(2)}k`;
    if (raw >= 0.01) return `$${raw.toFixed(4)}`;
    if (raw === 0) return '$0';
    return `$${parseFloat(raw.toPrecision(4)).toFixed(Math.max(4, -Math.floor(Math.log10(raw)) + 3))}`;
  };

  const handleMouseMove = useCallback(e => {
    if (!svgRef.current || !chartData.length) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    if (svgX < PL || svgX > W - PR) { setHover(null); return; }
    const idx = Math.max(0, Math.min(chartData.length - 1, Math.round(((svgX - PL) / cW) * (chartData.length - 1))));
    const point = chartData[idx];
    if (point) setHover({ x: toX(idx), y: toY(point.value), point });
  }, [chartData]);

  const currentPoint = hover?.point ?? (chartData.length > 0 ? chartData[chartData.length - 1] : null);

  return (
    <div className="bg-transparent">
      {/* Controls */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex gap-1">
          {VIEWS.map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`text-[10px] font-mono px-2.5 py-1 rounded-lg transition-all ${
                view === v
                  ? 'bg-white/10 text-white font-bold'
                  : 'text-white/30 hover:text-white/60'
              }`}
            >{v}</button>
          ))}
        </div>
        <div className="flex gap-0.5">
          {INTERVALS.map((iv, i) => (
            <button key={iv.label} onClick={() => setIntervalIdx(i)}
              className={`text-[10px] font-mono px-2.5 py-1 rounded-lg transition-all ${
                intervalIdx === i
                  ? 'bg-white/10 text-white font-bold'
                  : 'text-white/20 hover:text-white/50'
              }`}
            >{iv.label}</button>
          ))}
        </div>
      </div>

      {/* Price display */}
      {currentPoint && (
        <div className="flex items-baseline gap-2 mb-1.5 min-h-[28px]">
          <span className="text-xl font-bold font-mono" style={{ color: lineColor }}>
            {suiUsd > 0 ? fmtUsd(currentPoint.value) : `${fmtVal(currentPoint.value)} SUI`}
          </span>
          {suiUsd > 0 && (
            <span className="text-xs font-mono text-white/30">{fmtVal(currentPoint.value)} SUI</span>
          )}
          {hover && (
            <span className="text-[10px] font-mono text-white/20 ml-auto">
              {new Date(currentPoint.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      )}

      {/* Chart */}
      {loading ? (
        <div className="h-36 flex items-center justify-center">
          <span className="text-[10px] font-mono text-white/20 animate-pulse">LOADING…</span>
        </div>
      ) : chartData.length < 2 ? (
        <div className="h-36 flex items-center justify-center rounded-xl border border-white/5">
          <span className="text-[10px] font-mono text-white/20">NOT ENOUGH TRADES FOR CHART</span>
        </div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full cursor-crosshair select-none"
          style={{ height: '140px' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHover(null)}
          preserveAspectRatio="none"
        >
          {/* Minimal grid */}
          {yTicks.map((t, i) => (
            <line key={i} x1={PL} x2={W - PR} y1={t.y} y2={t.y}
              stroke="#ffffff08" strokeWidth="1" />
          ))}

          {/* Y labels */}
          {yTicks.map((t, i) => (
            <text key={i} x={PL - 4} y={t.y + 3.5} textAnchor="end"
              fontSize="7.5" fill="#ffffff25" fontFamily="monospace">
              {fmtVal(t.value)}
            </text>
          ))}

          {/* X labels */}
          {xTicks.map((t, i) => (
            <text key={i} x={t.x} y={H - 5} textAnchor="middle"
              fontSize="7" fill="#ffffff20" fontFamily="monospace">
              {t.label}
            </text>
          ))}

          {/* Area */}
          {areaD && <path d={areaD} fill={fillColor} />}

          {/* Line */}
          {pathD && (
            <path d={pathD} fill="none" stroke={lineColor} strokeWidth="1.5"
              strokeLinejoin="round" strokeLinecap="round" />
          )}

          {/* Dots — only buy/sell indicators, small */}
          {chartData.map((d, i) => (
            <circle key={i} cx={toX(i)} cy={toY(d.value)} r="1.5"
              fill={d.kind === 'sell' ? '#EF4444' : '#84CC16'} opacity="0.5" />
          ))}

          {/* Hover */}
          {hover && (
            <>
              <line x1={hover.x} x2={hover.x} y1={PT} y2={H - PB}
                stroke="#ffffff" strokeWidth="0.5" opacity="0.15" />
              <line x1={PL} x2={W - PR} y1={hover.y} y2={hover.y}
                stroke="#ffffff" strokeWidth="0.5" opacity="0.15" />
              <circle cx={hover.x} cy={hover.y} r="3.5"
                fill={lineColor} stroke="#080808" strokeWidth="1.5" />
              {(() => {
                const ttW = 140, ttH = suiUsd > 0 ? 50 : 38;
                const ttX = hover.x + 10 + ttW > W - PR ? hover.x - ttW - 10 : hover.x + 10;
                const ttY = Math.max(PT, Math.min(H - PB - ttH, hover.y - ttH / 2));
                return (
                  <g>
                    <rect x={ttX} y={ttY} width={ttW} height={ttH}
                      fill="#111" stroke="#ffffff15" strokeWidth="1" rx="4" />
                    <text x={ttX + 8} y={ttY + 15} fontSize="9.5" fill={lineColor}
                      fontFamily="monospace" fontWeight="bold">
                      {fmtVal(hover.point.value)} SUI
                    </text>
                    {suiUsd > 0 && (
                      <text x={ttX + 8} y={ttY + 29} fontSize="8.5" fill="#9CA3AF" fontFamily="monospace">
                        {fmtUsd(hover.point.value)}
                      </text>
                    )}
                    <text x={ttX + 8} y={ttY + ttH - 7} fontSize="7" fill="#ffffff30" fontFamily="monospace">
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
