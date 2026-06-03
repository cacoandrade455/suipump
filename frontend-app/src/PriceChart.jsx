// PriceChart.jsx
// KLineChart v9 wrapper — built-in indicators (MA / MACD / RSI / VOL).
// Data: ohlc + connected received as props from TokenPage (shared useTokenPageFeed SSE).
// The full ohlc array (historical backlog + live SSE) is rebuilt into candles and
// re-applied on every change, so the chart always reflects the complete history.
//
// Requires: npm install klinecharts@^9.8.0

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { init, dispose } from 'klinecharts';

const TOTAL_SUPPLY_WHOLE = 1_000_000_000;

const INTERVALS = [
  { label: '1M',  seconds: 60 },
  { label: '5M',  seconds: 300 },
  { label: '30M', seconds: 1_800 },
  { label: '1H',  seconds: 3_600 },
  { label: 'ALL', seconds: 0 },
];
const VIEWS = ['PRICE', 'MCAP'];

// Indicators: MA overlays on the candle pane (stack); the rest get their own pane.
const INDICATORS = [
  { key: 'MA',   stack: true  },
  { key: 'VOL',  stack: false },
  { key: 'MACD', stack: false },
  { key: 'RSI',  stack: false },
];

const LIME  = '#84CC16';
const RED    = '#EF4444';
const MONO   = 'JetBrains Mono, ui-monospace, monospace';

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
    if (!buckets.has(t)) buckets.set(t, { prices: [], vol: 0 });
    const b = buckets.get(t);
    b.prices.push(p.price);
    b.vol += Number(p.sui ?? 0);
  }

  const firstBucket = Math.floor(points[0].time / s) * s;
  const lastBucket  = Math.floor(Date.now() / 1000 / s) * s;

  const candles  = [];
  let prevClose  = points[0].price;
  for (let t = firstBucket; t <= lastBucket; t += s) {
    const b = buckets.get(t);
    if (b?.prices.length > 0) {
      const open  = prevClose;
      const close = b.prices[b.prices.length - 1];
      candles.push({ time: t, open, high: Math.max(open, ...b.prices), low: Math.min(open, ...b.prices), close, volume: b.vol });
      prevClose = close;
    } else {
      candles.push({ time: t, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0 });
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

function foldBig(n) {
  const v = Math.abs(Number(n));
  if (v >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
}

const chartStyles = {
  grid: {
    show: true,
    horizontal: { show: true, size: 1, color: '#141414', style: 'solid' },
    vertical:   { show: true, size: 1, color: '#141414', style: 'solid' },
  },
  candle: {
    type: 'candle_solid',
    bar: {
      upColor: LIME, downColor: RED, noChangeColor: '#888888',
      upBorderColor: LIME, downBorderColor: RED, noChangeBorderColor: '#888888',
      upWickColor: LIME, downWickColor: RED, noChangeWickColor: '#888888',
    },
    priceMark: {
      show: true,
      high: { show: true, color: LIME, textSize: 10, textFamily: MONO },
      low:  { show: true, color: LIME, textSize: 10, textFamily: MONO },
      last: {
        show: true,
        upColor: LIME, downColor: RED, noChangeColor: '#888888',
        line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1 },
        text: {
          show: true, size: 10, family: MONO, weight: 'normal', color: '#000000',
          borderRadius: 2, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2,
        },
      },
    },
    tooltip: {
      showRule: 'follow_cross',
      showType: 'standard',
      text: { size: 10, family: MONO, color: LIME, marginLeft: 8, marginTop: 6, marginRight: 8, marginBottom: 0 },
    },
  },
  indicator: {
    tooltip: { showRule: 'follow_cross', text: { size: 10, family: MONO, color: LIME } },
    lines: [
      { color: LIME }, { color: '#FFFFFF' }, { color: '#6B7280' }, { color: '#3B82F6' }, { color: '#F59E0B' },
    ],
    bars: [{ upColor: LIME, downColor: RED, noChangeColor: '#888888' }],
  },
  xAxis: {
    axisLine: { show: true, color: '#1a3a0a', size: 1 },
    tickText: { show: true, color: '#4B5563', size: 10, family: MONO },
    tickLine: { show: true, size: 1, length: 3, color: '#1a3a0a' },
  },
  yAxis: {
    axisLine: { show: true, color: '#1a3a0a', size: 1 },
    tickText: { show: true, color: '#4B5563', size: 10, family: MONO },
    tickLine: { show: true, size: 1, length: 3, color: '#1a3a0a' },
  },
  crosshair: {
    show: true,
    horizontal: {
      line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1, color: LIME },
      text: { show: true, color: '#000000', size: 10, family: MONO, backgroundColor: LIME,
        paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 2, borderSize: 0 },
    },
    vertical: {
      line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1, color: LIME },
      text: { show: true, color: '#000000', size: 10, family: MONO, backgroundColor: LIME,
        paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 2, borderSize: 0 },
    },
  },
};

// ohlc: [{ time, price, kind, sui? }] — provided by TokenPage via useTokenPageFeed
// connected: bool — SSE connection status from TokenPage
// suiUsd: number — live SUI/USD price from TokenPage
// loading: bool — initial fetch in progress
export default function PriceChart({ ohlc = [], connected = false, suiUsd = 0, loading = false }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);
  const paneIds      = useRef({}); // { indicatorKey: paneId }

  const [intervalIdx,      setIntervalIdx]      = useState(4);
  const [view,             setView]             = useState('PRICE');
  const [activeIndicators, setActiveIndicators] = useState(['MA']);

  // Sub-panes (everything except the MA overlay) drive the container height.
  const subPaneCount = activeIndicators.filter(k => k !== 'MA').length;
  const chartHeight  = 300 + subPaneCount * 88;

  // ── Initialize chart once ─────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = init(containerRef.current, {
      styles: chartStyles,
      customApi: { formatBigNumber: foldBig },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    chartRef.current = chart;

    // Seed default indicator (MA overlay on the candle pane).
    paneIds.current.MA = 'candle_pane';
    chart.createIndicator('MA', true, { id: 'candle_pane' });

    const ro = new ResizeObserver(() => { chartRef.current?.resize(); });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      dispose(containerRef.current);
      chartRef.current = null;
      paneIds.current = {};
    };
  }, []);

  // ── Build candles from the full backlog + live feed ───────────────────────
  const candles = useMemo(() => {
    const mul = view === 'MCAP'
      ? TOTAL_SUPPLY_WHOLE * (suiUsd > 0 ? suiUsd : 1)
      : (suiUsd > 0 ? suiUsd : 1);

    const seen = new Set();
    const deduped = ohlc
      .filter(p => { const k = `${p.time}_${p.price}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.time - b.time);

    return buildCandles(deduped, INTERVALS[intervalIdx].seconds).map(c => ({
      timestamp: c.time * 1000,
      open:  c.open  * mul,
      high:  c.high  * mul,
      low:   c.low   * mul,
      close: c.close * mul,
      volume: c.volume,
    }));
  }, [ohlc, intervalIdx, view, suiUsd]);

  // ── Apply data + precision ────────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const pricePrecision = view === 'MCAP' ? 2 : (suiUsd > 0 ? 8 : 9);
    if (typeof chart.setPriceVolumePrecision === 'function') {
      chart.setPriceVolumePrecision(pricePrecision, 0);
    }
    chart.applyNewData(candles);
  }, [candles, view, suiUsd]);

  // ── Resize when indicator panes change the container height ───────────────
  useEffect(() => { chartRef.current?.resize(); }, [chartHeight]);

  // ── Indicator toggles ─────────────────────────────────────────────────────
  function toggleIndicator(key) {
    const chart = chartRef.current;
    if (!chart) return;

    if (activeIndicators.includes(key)) {
      if (key === 'MA') {
        chart.removeIndicator('candle_pane', 'MA');
      } else if (paneIds.current[key]) {
        chart.removeIndicator(paneIds.current[key], key);
      }
      delete paneIds.current[key];
      setActiveIndicators(a => a.filter(k => k !== key));
    } else {
      if (key === 'MA') {
        chart.createIndicator('MA', true, { id: 'candle_pane' });
        paneIds.current.MA = 'candle_pane';
      } else {
        const paneId = chart.createIndicator(key, false);
        if (paneId) paneIds.current[key] = paneId;
      }
      setActiveIndicators(a => [...a, key]);
    }
  }

  const latestPrice = candles.length > 0 ? candles[candles.length - 1].close : null;

  return (
    <div className="bg-black border border-lime-950 rounded-2xl p-4">
      {/* Header: views + live dot + intervals */}
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
              <span className="text-lg font-bold font-mono text-lime-400">{view === 'MCAP' ? `$${foldBig(latestPrice)}` : fmtUsd(latestPrice)}</span>
              <span className="text-xs font-mono text-lime-700">{view === 'MCAP' ? 'market cap' : fmtSui(latestPrice / suiUsd)}</span>
            </>
          ) : (
            <span className="text-lg font-bold font-mono text-lime-400">{view === 'MCAP' ? foldBig(latestPrice) : fmtSui(latestPrice)}</span>
          )}
        </div>
      )}

      {/* Indicator toggles */}
      <div className="flex gap-1 mb-2">
        {INDICATORS.map(({ key }) => (
          <button key={key} onClick={() => toggleIndicator(key)}
            className={`px-2 py-0.5 text-[9px] font-mono rounded transition-colors ${
              activeIndicators.includes(key)
                ? 'bg-lime-950 text-lime-400 border border-lime-700'
                : 'text-lime-900 border border-lime-950 hover:border-lime-800'
            }`}>{key}</button>
        ))}
      </div>

      {/* Chart */}
      <div className="relative">
        <div ref={containerRef} style={{ width: '100%', height: `${chartHeight}px` }} />
        {(loading || ohlc.length === 0) && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-lime-900 bg-black pointer-events-none">
            {loading ? 'LOADING TRADES…' : 'NO TRADES YET — BE THE FIRST TO BUY'}
          </div>
        )}
      </div>
    </div>
  );
}
