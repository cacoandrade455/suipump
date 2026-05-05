// PriceChart.jsx — pump.fun-style clean chart with line + bar toggle
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';

const TOTAL_SUPPLY_WHOLE = 1_000_000_000;
const INTERVALS = [
  { label: '1m',  ms: 60_000 },
  { label: '5m',  ms: 300_000 },
  { label: '15m', ms: 900_000 },
  { label: '1h',  ms: 3_600_000 },
  { label: '6h',  ms: 21_600_000 },
  { label: '24h', ms: 86_400_000 },
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

// Line chart SVG
function LineChart({ chartData, W, H, PL, PR, PT, PB, lineColor, fillColor, hover, onMouseMove, onMouseLeave, svgRef, fmtVal, fmtUsd, suiUsd }) {
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

  const yTicks = [0, 0.5, 1].map(t => ({ y: PT + (1 - t) * cH, value: minV + t * rangeV }));
  const xTicks = chartData.length >= 2
    ? [0, Math.floor((chartData.length - 1) / 2), chartData.length - 1].map(i => ({
        x: toX(i),
        label: chartData[i] ? new Date(chartData[i].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      }))
    : [];

  // Recalculate hover y from value when rendering
  const hoverY = hover ? toY(hover.point.value) : null;
  const hoverX = hover ? toX(hover.idx) : null;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full cursor-crosshair select-none"
      style={{ height: '140px' }} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}
      preserveAspectRatio="none">
      {yTicks.map((t, i) => (
        <line key={i} x1={PL} x2={W - PR} y1={t.y} y2={t.y} stroke="#ffffff08" strokeWidth="1" />
      ))}
      {yTicks.map((t, i) => (
        <text key={i} x={PL - 4} y={t.y + 3.5} textAnchor="end" fontSize="7.5" fill="#ffffff25" fontFamily="monospace">
          {fmtVal(t.value)}
        </text>
      ))}
      {xTicks.map((t, i) => (
        <text key={i} x={t.x} y={H - 5} textAnchor="middle" fontSize="7" fill="#ffffff20" fontFamily="monospace">
          {t.label}
        </text>
      ))}
      {areaD && <path d={areaD} fill={fillColor} />}
      {pathD && <path d={pathD} fill="none" stroke={lineColor} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />}
      {chartData.map((d, i) => (
        <circle key={i} cx={toX(i)} cy={toY(d.value)} r="1.5"
          fill={d.kind === 'sell' ? '#EF4444' : '#84CC16'} opacity="0.5" />
      ))}
      {hover && hoverX !== null && hoverY !== null && (
        <>
          <line x1={hoverX} x2={hoverX} y1={PT} y2={H - PB} stroke="#ffffff" strokeWidth="0.5" opacity="0.15" />
          <line x1={PL} x2={W - PR} y1={hoverY} y2={hoverY} stroke="#ffffff" strokeWidth="0.5" opacity="0.15" />
          <circle cx={hoverX} cy={hoverY} r="3.5" fill={lineColor} stroke="#080808" strokeWidth="1.5" />
          <Tooltip hover={hover} hoverX={hoverX} hoverY={hoverY} W={W} PR={PR} PT={PT} PB={PB} H={H} ttH={suiUsd > 0 ? 50 : 38} fmtVal={fmtVal} fmtUsd={fmtUsd} lineColor={lineColor} suiUsd={suiUsd} />
        </>
      )}
    </svg>
  );
}

// Bar chart SVG — OHLC candles
function BarChart({ chartData, W, H, PL, PR, PT, PB, hover, onMouseMove, onMouseLeave, svgRef, fmtVal, fmtUsd, suiUsd }) {
  const cW = W - PL - PR, cH = H - PT - PB;
  const values = chartData.flatMap(d => [d.h ?? d.value, d.l ?? d.value]);
  const minV = values.length ? Math.min(...values) * 0.99 : 0;
  const maxV = values.length ? Math.max(...values) * 1.01 : 1;
  const rangeV = maxV - minV || 1;

  const n = chartData.length;
  const barW = Math.max(2, Math.min(12, (cW / Math.max(n, 1)) * 0.7));
  const toX = i => PL + ((i + 0.5) / Math.max(n, 1)) * cW;
  const toY = v => PT + (1 - (v - minV) / rangeV) * cH;

  const yTicks = [0, 0.5, 1].map(t => ({ y: PT + (1 - t) * cH, value: minV + t * rangeV }));
  const xTicks = n >= 2
    ? [0, Math.floor((n - 1) / 2), n - 1].map(i => ({
        x: toX(i),
        label: chartData[i] ? new Date(chartData[i].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      }))
    : [];

  const hoverX = hover ? toX(hover.idx) : null;
  const hoverY = hover ? toY(hover.point.value) : null;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full cursor-crosshair select-none"
      style={{ height: '140px' }} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}
      preserveAspectRatio="none">
      {yTicks.map((t, i) => (
        <line key={i} x1={PL} x2={W - PR} y1={t.y} y2={t.y} stroke="#ffffff08" strokeWidth="1" />
      ))}
      {yTicks.map((t, i) => (
        <text key={i} x={PL - 4} y={t.y + 3.5} textAnchor="end" fontSize="7.5" fill="#ffffff25" fontFamily="monospace">
          {fmtVal(t.value)}
        </text>
      ))}
      {xTicks.map((t, i) => (
        <text key={i} x={t.x} y={H - 5} textAnchor="middle" fontSize="7" fill="#ffffff20" fontFamily="monospace">
          {t.label}
        </text>
      ))}

      {/* Candle bars */}
      {chartData.map((d, i) => {
        const x = toX(i);
        const isGreen = d.c >= d.o;
        const color = isGreen ? '#84CC16' : '#EF4444';
        const bodyTop = toY(Math.max(d.o, d.c));
        const bodyBot = toY(Math.min(d.o, d.c));
        const bodyH = Math.max(1.5, bodyBot - bodyTop);
        const wickTop = toY(d.h);
        const wickBot = toY(d.l);
        return (
          <g key={i}>
            {/* Wick */}
            <line x1={x} x2={x} y1={wickTop} y2={wickBot} stroke={color} strokeWidth="1" opacity="0.6" />
            {/* Body */}
            <rect x={x - barW / 2} y={bodyTop} width={barW} height={bodyH}
              fill={color} opacity={hover?.idx === i ? 1 : 0.8} rx="0.5" />
          </g>
        );
      })}

      {/* Hover crosshair */}
      {hover && hoverX !== null && (
        <>
          <line x1={hoverX} x2={hoverX} y1={PT} y2={H - PB} stroke="#ffffff" strokeWidth="0.5" opacity="0.15" />
          <Tooltip hover={hover} hoverX={hoverX} hoverY={hoverY ?? PT} W={W} PR={PR} PT={PT} PB={PB} H={H} ttH={suiUsd > 0 ? 50 : 38} fmtVal={fmtVal} fmtUsd={fmtUsd} lineColor={hover.point.c >= hover.point.o ? '#84CC16' : '#EF4444'} suiUsd={suiUsd} />
        </>
      )}
    </svg>
  );
}

function Tooltip({ hover, hoverX, hoverY, W, PR, PT, PB, H, ttH, fmtVal, fmtUsd, lineColor, suiUsd }) {
  const ttW = 140;
  const ttX = hoverX + 10 + ttW > W - PR ? hoverX - ttW - 10 : hoverX + 10;
  const ttY = Math.max(PT, Math.min(H - PB - ttH, hoverY - ttH / 2));
  return (
    <g>
      <rect x={ttX} y={ttY} width={ttW} height={ttH} fill="#111" stroke="#ffffff15" strokeWidth="1" rx="4" />
      <text x={ttX + 8} y={ttY + 15} fontSize="9.5" fill={lineColor} fontFamily="monospace" fontWeight="bold">
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
}

export default function PriceChart({ curveId, refreshKey }) {
  const client = useSuiClient();
  const svgRef = useRef(null);

  const [rawTrades, setRawTrades] = useState([]);
  const [suiUsd, setSuiUsd] = useState(0);
  const [intervalIdx, setIntervalIdx] = useState(6);
  const [view, setView] = useState('PRICE');
  const [chartType, setChartType] = useState('line'); // 'line' | 'bar'
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
    ? candles.map(c => ({ ...c, value: c.price * TOTAL_SUPPLY_WHOLE, o: c.o * TOTAL_SUPPLY_WHOLE, h: c.h * TOTAL_SUPPLY_WHOLE, l: c.l * TOTAL_SUPPLY_WHOLE, c: c.c * TOTAL_SUPPLY_WHOLE }))
    : candles,
  [candles, view]);

  const W = 600, H = 140, PL = 60, PR = 6, PT = 8, PB = 24;
  const cW = W - PL - PR;

  const isUp = chartData.length >= 2 && chartData[chartData.length - 1].value >= chartData[0].value;
  const lineColor = isUp ? '#84CC16' : '#EF4444';
  const fillColor = isUp ? '#84CC1612' : '#EF444412';

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
    const raw = suiVal * suiUsd;
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
    let idx;
    if (chartType === 'bar') {
      idx = Math.max(0, Math.min(chartData.length - 1, Math.floor(((svgX - PL) / cW) * chartData.length)));
    } else {
      idx = Math.max(0, Math.min(chartData.length - 1, Math.round(((svgX - PL) / cW) * (chartData.length - 1))));
    }
    const point = chartData[idx];
    if (point) setHover({ point, idx });
  }, [chartData, chartType]);

  const currentPoint = hover?.point ?? (chartData.length > 0 ? chartData[chartData.length - 1] : null);

  // Line chart SVG icon
  const LineIcon = () => (
    <svg width="16" height="10" viewBox="0 0 16 10" fill="none">
      <polyline points="1,9 5,5 9,7 15,1" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );

  // Bar chart SVG icon
  const BarIcon = () => (
    <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
      <rect x="1" y="4" width="2.5" height="6" fill="currentColor" opacity="0.9" />
      <rect x="5" y="1" width="2.5" height="9" fill="currentColor" opacity="0.9" />
      <rect x="9" y="3" width="2.5" height="7" fill="currentColor" opacity="0.9" />
    </svg>
  );

  return (
    <div className="bg-transparent">
      {/* Controls row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          {/* View toggle */}
          {VIEWS.map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`text-[10px] font-mono px-2.5 py-1 rounded-lg transition-all ${
                view === v ? 'bg-white/10 text-white font-bold' : 'text-white/30 hover:text-white/60'
              }`}
            >{v}</button>
          ))}

          {/* Divider */}
          <div className="w-px h-3 bg-white/10 mx-1" />

          {/* Chart type toggle */}
          <button
            onClick={() => setChartType('line')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg transition-all text-[10px] font-mono ${
              chartType === 'line' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'
            }`}
            title="Line chart"
          >
            <LineIcon />
          </button>
          <button
            onClick={() => setChartType('bar')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg transition-all text-[10px] font-mono ${
              chartType === 'bar' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'
            }`}
            title="Candlestick / bar chart"
          >
            <BarIcon />
          </button>
        </div>

        {/* Interval buttons */}
        <div className="flex gap-0.5">
          {INTERVALS.map((iv, i) => (
            <button key={iv.label} onClick={() => setIntervalIdx(i)}
              className={`text-[10px] font-mono px-2.5 py-1 rounded-lg transition-all ${
                intervalIdx === i ? 'bg-white/10 text-white font-bold' : 'text-white/20 hover:text-white/50'
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

      {/* Chart body */}
      {loading ? (
        <div className="h-36 flex items-center justify-center">
          <span className="text-[10px] font-mono text-white/20 animate-pulse">LOADING…</span>
        </div>
      ) : chartData.length < 2 ? (
        <div className="h-36 flex items-center justify-center rounded-xl border border-white/5">
          <span className="text-[10px] font-mono text-white/20">NOT ENOUGH TRADES FOR CHART</span>
        </div>
      ) : chartType === 'line' ? (
        <LineChart
          chartData={chartData} W={W} H={H} PL={PL} PR={PR} PT={PT} PB={PB}
          lineColor={lineColor} fillColor={fillColor}
          hover={hover} onMouseMove={handleMouseMove} onMouseLeave={() => setHover(null)}
          svgRef={svgRef} fmtVal={fmtVal} fmtUsd={fmtUsd} suiUsd={suiUsd}
        />
      ) : (
        <BarChart
          chartData={chartData} W={W} H={H} PL={PL} PR={PR} PT={PT} PB={PB}
          hover={hover} onMouseMove={handleMouseMove} onMouseLeave={() => setHover(null)}
          svgRef={svgRef} fmtVal={fmtVal} fmtUsd={fmtUsd} suiUsd={suiUsd}
        />
      )}
    </div>
  );
}
