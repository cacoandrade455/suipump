// BubbleMap.jsx - holder bubble-map modal. Hand-rolled SVG force layout, zero deps.
// Nodes come from the holders HolderList already fetched (balance/locked, atomic BigInt)
// merged with cluster membership from GET {INDEXER_URL}/token/{curveId}/bundles:
// { circulating_whole, holders (a NUMBER: holder count, not an array),
//   clusters: [{ id, wallets, pct_of_circulating, funder, kind }],
//   edges: [{ from, to, kind: 'funding' }], meta: { resolved, pending } }.
// Edge `from` is the external funder (faucet/exchange/funding wallet), usually
// NOT a holder - such funders render as small grey satellite nodes.
// 404/error on the bundles fetch = honest "Bundle data unavailable" empty state.
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';
const TOKEN_SCALE = 1e6;

const WORLD_W = 1000;
const WORLD_H = 700;
const MAX_NODES = 60;         // cap at the ~60 largest wallets
const MAX_FUNDER_NODES = 20;  // cap on synthesized funder satellites (bounded by cluster count anyway)
const FUNDER_R = 6;           // fixed small radius for funder satellites
const TICKS = 300;            // total simulation ticks
const TICKS_PER_FRAME = 3;    // ticks advanced per rAF frame

// ~8-color cluster palette; singletons grey; creator ring is lime (reserved, not a cluster color)
const CLUSTER_COLORS = ['#38bdf8', '#f472b6', '#f59e0b', '#a78bfa', '#34d399', '#fb7185', '#22d3ee', '#facc15'];
const SINGLETON_COLOR = '#6b7280';

function shortAddr(a) {
  if (!a) return '???';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmtNum(n, d = 2) {
  if (n == null) return '-';
  return n.toLocaleString(undefined, { maximumFractionDigits: d });
}

// Build the node/edge/cluster model from the bundles payload + HolderList's holder rows.
// propHolders rows are { addr, raw: BigInt atomic, lockedRaw: BigInt atomic } - Number() before arithmetic.
function buildGraph(bundle, propHolders, creator) {
  const clusters = Array.isArray(bundle?.clusters) ? bundle.clusters : [];
  const rawEdges = Array.isArray(bundle?.edges) ? bundle.edges : [];

  // address -> { balance, locked } in WHOLE tokens (bundle.holders is only a count)
  const info = new Map();
  for (const h of propHolders) {
    if (!h?.addr) continue;
    info.set(h.addr, {
      balance: Number(h.raw) / TOKEN_SCALE,
      locked: Number(h.lockedRaw ?? 0n) / TOKEN_SCALE,
    });
  }

  // cluster membership; single-wallet clusters render grey
  const clusterOf = new Map();
  const clusterList = clusters.map((c, i) => {
    const wallets = Array.isArray(c.wallets) ? c.wallets : [];
    const color = wallets.length > 1 ? CLUSTER_COLORS[i % CLUSTER_COLORS.length] : SINGLETON_COLOR;
    const entry = {
      id: c.id ?? i,
      color,
      wallets,
      pct: Number(c.pct_of_circulating) || 0,
      funder: c.funder ?? null,
      kind: c.kind === 'temporal' ? 'temporal' : 'funding',
    };
    for (const w of wallets) {
      clusterOf.set(w, entry);
      if (!info.has(w)) info.set(w, { balance: 0, locked: 0 });
    }
    return entry;
  });

  const summed = [...info.values()].reduce((a, v) => a + v.balance, 0);
  const circulating = Math.max(1e-9, Number(bundle?.circulating_whole) || summed || 1);

  const all = [...info.entries()]
    .map(([addr, v]) => ({ addr, balance: v.balance, locked: Math.min(v.locked, v.balance) }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, MAX_NODES);

  const maxShare = Math.max(1e-9, ...all.map(n => n.balance / circulating));
  const nodes = all.map((n, i) => {
    const share = n.balance / circulating;
    const cl = clusterOf.get(n.addr) ?? null;
    const ang = i * 2.399963; // golden-angle spiral seed keeps the start un-clumped
    const rad = 30 + 9 * Math.sqrt(i);
    return {
      ...n,
      share,
      r: 6 + 34 * (Math.sqrt(share) / Math.sqrt(maxShare)), // radius ~ sqrt(share of circulating)
      x: WORLD_W / 2 + rad * Math.cos(ang),
      y: WORLD_H / 2 + rad * Math.sin(ang),
      vx: 0, vy: 0, pinned: false,
      clusterId: cl?.id ?? null,
      color: cl?.color ?? SINGLETON_COLOR,
      funder: cl?.funder ?? null,
      isCreator: creator != null && n.addr === creator,
    };
  });

  const inSet = new Set(nodes.map(n => n.addr));

  // Funder satellites: edge `from` is an external funder that is usually NOT a
  // holder, so the funder -> wallet edge would have no anchor. Synthesize one
  // small grey satellite node per missing funder (fixed radius, zero balance,
  // excluded from share-of-circulating math, dashed-ring treatment). They join
  // the nodes array so the force sim gives them repulsion/collision like any
  // other bubble; clusterId ties them into their cluster's highlight.
  const satelliteByAddr = new Map();
  for (const e of rawEdges) {
    if (!e || !inSet.has(e.to) || inSet.has(e.from) || !e.from) continue;
    if (satelliteByAddr.has(e.from)) continue;
    if (satelliteByAddr.size >= MAX_FUNDER_NODES) continue;
    const cl = clusterOf.get(e.to) ?? null;
    const seed = nodes.length + satelliteByAddr.size;
    const ang = seed * 2.399963;
    const rad = 30 + 9 * Math.sqrt(seed);
    satelliteByAddr.set(e.from, {
      addr: e.from,
      balance: 0,
      locked: 0,
      share: 0,
      r: FUNDER_R,
      x: WORLD_W / 2 + rad * Math.cos(ang),
      y: WORLD_H / 2 + rad * Math.sin(ang),
      vx: 0, vy: 0, pinned: false,
      clusterId: cl?.id ?? null,
      color: SINGLETON_COLOR,
      funder: null,
      isCreator: false,
      isFunderSatellite: true,
    });
  }
  nodes.push(...satelliteByAddr.values());

  const drawable = new Set(nodes.map(n => n.addr));
  const edges = rawEdges.filter(e => e && drawable.has(e.from) && drawable.has(e.to));

  // per-wallet funder from funding edges wins over the cluster-level funder
  const funderByWallet = new Map();
  for (const e of edges) if (e.kind === 'funding') funderByWallet.set(e.to, e.from);
  for (const n of nodes) n.funder = funderByWallet.get(n.addr) ?? n.funder;

  return { nodes, edges, clusterList, circulating };
}

// One simulation tick: center gravity + pairwise repulsion + same-cluster cohesion + hard collision.
function simTick(nodes) {
  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  const GRAVITY = 0.0045, REPULSE = 1200, COHESION = 0.0035, DAMP = 0.8, PAD = 5;
  for (const n of nodes) {
    if (n.pinned) continue;
    n.vx += (cx - n.x) * GRAVITY;
    n.vy += (cy - n.y) * GRAVITY;
  }
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist = Math.sqrt(dx * dx + dy * dy); }
      const ux = dx / dist, uy = dy / dist;
      const rep = REPULSE / (dist * dist);
      if (!a.pinned) { a.vx -= ux * rep; a.vy -= uy * rep; }
      if (!b.pinned) { b.vx += ux * rep; b.vy += uy * rep; }
      if (a.clusterId != null && a.clusterId === b.clusterId) {
        const pull = dist * COHESION;
        if (!a.pinned) { a.vx += ux * pull; a.vy += uy * pull; }
        if (!b.pinned) { b.vx -= ux * pull; b.vy -= uy * pull; }
      }
      const minDist = a.r + b.r + PAD;
      if (dist < minDist) {
        const push = (minDist - dist) / 2;
        if (!a.pinned) { a.x -= ux * push; a.y -= uy * push; }
        if (!b.pinned) { b.x += ux * push; b.y += uy * push; }
      }
    }
  }
  for (const n of nodes) {
    if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
    n.vx *= DAMP; n.vy *= DAMP;
    n.x += n.vx; n.y += n.vy;
  }
}

export default function BubbleMap({ curveId, holders = [], creator = null, onClose }) {
  const navigate = useNavigate();
  const svgRef = useRef(null);
  const nodesRef = useRef([]);
  const edgesRef = useRef([]);
  const rafRef = useRef(null);
  const tickCountRef = useRef(0);
  const dragRef = useRef(null);
  const mountedRef = useRef(true);

  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'empty' | 'error'
  const [clusterList, setClusterList] = useState([]);
  const [meta, setMeta] = useState(null);
  const [selectedCluster, setSelectedCluster] = useState(null);
  const [hover, setHover] = useState(null); // { addr, balance, share, funder, x, y }
  const [view, setView] = useState({ x: 0, y: 0, w: WORLD_W, h: WORLD_H });
  const [, setFrame] = useState(0); // bump to re-render mutable node positions

  // ESC closes
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Fetch bundles on open, build the graph, run the force layout via rAF.
  // holders/creator are captured at open - the modal is short-lived by design.
  useEffect(() => {
    mountedRef.current = true;
    const ctrl = new AbortController();
    (async () => {
      let bundle = null;
      try {
        if (!INDEXER_URL) throw new Error('no indexer');
        const res = await fetch(`${INDEXER_URL}/token/${curveId}/bundles`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`http ${res.status}`);
        bundle = await res.json();
      } catch {
        if (mountedRef.current && !ctrl.signal.aborted) setStatus('error');
        return;
      }
      if (!mountedRef.current) return;
      const graph = buildGraph(bundle, holders, creator);
      nodesRef.current = graph.nodes;
      edgesRef.current = graph.edges;
      setClusterList(graph.clusterList);
      setMeta(bundle?.meta ?? null);
      setStatus(graph.nodes.length ? 'ready' : 'empty');
      tickCountRef.current = 0;
      const step = () => {
        if (!mountedRef.current) return;
        for (let i = 0; i < TICKS_PER_FRAME && tickCountRef.current < TICKS; i++) {
          simTick(nodesRef.current);
          tickCountRef.current++;
        }
        setFrame(f => f + 1);
        if (tickCountRef.current < TICKS) rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    })();
    return () => {
      mountedRef.current = false;
      ctrl.abort();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [curveId]);

  // Wheel zoom needs a non-passive native listener (React's synthetic wheel is passive at the root)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      setView(v => {
        const scale = Math.max(v.w / rect.width, v.h / rect.height);
        const wx = v.x + v.w / 2 + (e.clientX - rect.left - rect.width / 2) * scale;
        const wy = v.y + v.h / 2 + (e.clientY - rect.top - rect.height / 2) * scale;
        const f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
        const w = Math.min(WORLD_W * 4, Math.max(WORLD_W / 12, v.w * f));
        const h = w * (WORLD_H / WORLD_W);
        return { x: wx - (wx - v.x) * (w / v.w), y: wy - (wy - v.y) * (h / v.h), w, h };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [status]);

  // screen -> world for the current view (viewBox uses xMidYMid meet)
  const worldFromClient = (clientX, clientY, v) => {
    const rect = svgRef.current.getBoundingClientRect();
    const scale = Math.max(v.w / rect.width, v.h / rect.height);
    return {
      x: v.x + v.w / 2 + (clientX - rect.left - rect.width / 2) * scale,
      y: v.y + v.h / 2 + (clientY - rect.top - rect.height / 2) * scale,
      scale,
    };
  };

  const onSvgPointerDown = (e) => {
    if (e.button !== 0) return;
    svgRef.current?.setPointerCapture?.(e.pointerId);
    setHover(null);
    dragRef.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, view0: view, moved: 0 };
  };

  const onNodePointerDown = (n) => (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture?.(e.pointerId);
    n.pinned = true;
    setHover(null);
    dragRef.current = { mode: 'node', node: n, sx: e.clientX, sy: e.clientY, moved: 0 };
  };

  const onSvgPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.sx, e.clientY - d.sy));
    if (d.mode === 'pan') {
      const rect = svgRef.current.getBoundingClientRect();
      const scale = Math.max(d.view0.w / rect.width, d.view0.h / rect.height);
      setView({ ...d.view0, x: d.view0.x - (e.clientX - d.sx) * scale, y: d.view0.y - (e.clientY - d.sy) * scale });
    } else if (d.mode === 'node') {
      const w = worldFromClient(e.clientX, e.clientY, view);
      d.node.x = w.x; d.node.y = w.y;
      d.node.vx = 0; d.node.vy = 0;
      setFrame(f => f + 1);
    }
  };

  const endDrag = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.mode === 'node') {
      d.node.pinned = false;
      if (d.moved < 5) {
        // click (not drag) -> profile
        onClose();
        navigate(`/profile/${d.node.addr}`);
      }
    } else if (d.mode === 'pan' && d.moved < 5) {
      setSelectedCluster(null); // background click clears cluster highlight
    }
  };

  const onNodeHover = (n) => (e) => {
    if (dragRef.current) return;
    setHover({ addr: n.addr, balance: n.balance, share: n.share, funder: n.funder, isFunderSatellite: !!n.isFunderSatellite, x: e.clientX, y: e.clientY });
  };

  const nodes = nodesRef.current;
  const nodeByAddr = new Map(nodes.map(n => [n.addr, n]));

  return (
    <>
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40" onClick={onClose} />
      <div
        className="fixed inset-2 sm:inset-6 z-50 rounded-2xl border border-white/10 bg-[#0d0d0d] overflow-hidden flex flex-col"
        style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono font-bold text-white tracking-widest">BUBBLE MAP</span>
            <span className="text-[8.5px] font-mono font-semibold text-black bg-lime-400 px-1.5 py-[3px] rounded">BETA</span>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white"><X size={16} /></button>
        </div>

        <div className="flex-1 flex min-h-0">
          {status === 'loading' && (
            <div className="flex-1 flex items-center justify-center text-[11px] font-mono text-white/25">Loading bundle data…</div>
          )}
          {status === 'error' && (
            <div className="flex-1 flex items-center justify-center text-[11px] font-mono text-white/25">Bundle data unavailable</div>
          )}
          {status === 'empty' && (
            <div className="flex-1 flex items-center justify-center text-[11px] font-mono text-white/25">No holder data</div>
          )}

          {status === 'ready' && (
            <>
              {/* Map canvas */}
              <div className="flex-1 relative min-w-0">
                <svg
                  ref={svgRef}
                  className="w-full h-full block cursor-grab touch-none select-none"
                  viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
                  onPointerDown={onSvgPointerDown}
                  onPointerMove={onSvgPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                >
                  {/* funding edges: thin funder -> wallet lines */}
                  {edgesRef.current.map((e, i) => {
                    const a = nodeByAddr.get(e.from);
                    const b = nodeByAddr.get(e.to);
                    if (!a || !b) return null;
                    const lit = selectedCluster == null || a.clusterId === selectedCluster || b.clusterId === selectedCluster;
                    return (
                      <line
                        key={i}
                        x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                        stroke="#ffffff"
                        strokeOpacity={lit ? 0.18 : 0.05}
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  })}

                  {/* bubbles */}
                  {nodes.map((n) => {
                    const dim = selectedCluster != null && n.clusterId !== selectedCluster;
                    const lockedR = n.balance > 0 && n.locked > 0
                      ? n.r * Math.sqrt(Math.min(1, n.locked / n.balance))
                      : 0;
                    return (
                      <g
                        key={n.addr}
                        opacity={dim ? 0.15 : 1}
                        className="cursor-pointer"
                        onPointerDown={onNodePointerDown(n)}
                        onPointerMove={onNodeHover(n)}
                        onPointerLeave={() => setHover(null)}
                      >
                        {n.isCreator && (
                          <circle cx={n.x} cy={n.y} r={n.r + 3} fill="none" stroke="#a3e635" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                        )}
                        <circle
                          cx={n.x} cy={n.y} r={n.r}
                          fill={n.color}
                          fillOpacity={n.isFunderSatellite ? 0.07 : 0.18}
                          stroke={n.color}
                          strokeOpacity={n.isFunderSatellite ? 0.5 : 0.85}
                          strokeWidth={1.2}
                          strokeDasharray={n.isFunderSatellite ? '3 3' : undefined}
                          vectorEffect="non-scaling-stroke"
                        />
                        {lockedR > 0 && (
                          <circle cx={n.x} cy={n.y} r={lockedR} fill={n.color} fillOpacity={0.45} stroke="none" pointerEvents="none" />
                        )}
                      </g>
                    );
                  })}
                </svg>

                {/* legend */}
                <div className="absolute bottom-2 left-3 text-[8.5px] font-mono text-white/22 leading-[1.5] pointer-events-none">
                  {'ring = creator'} {'·'} {'inner disc = locked'} {'·'} {'grey = unclustered'} {'·'} {'dashed = funding source'} {'·'} {'scroll = zoom'} {'·'} {'drag = pan'} {'·'} {'click = profile'}
                </div>

                {/* hover tooltip */}
                {hover && (
                  <div
                    className="fixed z-[70] pointer-events-none bg-[#0d0d0d] border border-white/15 rounded-lg px-3 py-2 max-w-[300px]"
                    style={{ left: Math.min(hover.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 316), top: hover.y + 14 }}
                  >
                    <div className="text-[10px] font-mono font-bold text-white/80">{shortAddr(hover.addr)}</div>
                    {hover.isFunderSatellite ? (
                      <div className="text-[9.5px] font-mono text-white/50 mt-0.5">funding source {'·'} not a holder</div>
                    ) : (
                      <div className="text-[9.5px] font-mono text-white/50 mt-0.5">{fmtNum(hover.balance, 0)} tokens {'·'} {(hover.share * 100).toFixed(2)}% of circulating</div>
                    )}
                    {hover.funder && (
                      <div className="text-[9.5px] font-mono text-white/40 mt-0.5">funded by {shortAddr(hover.funder)}</div>
                    )}
                    <div className="text-[8px] font-mono text-white/25 break-all mt-1">{hover.addr}</div>
                  </div>
                )}
              </div>

              {/* Cluster panel */}
              <div className="hidden sm:flex flex-col w-[280px] shrink-0 border-l border-white/[0.07] min-h-0">
                <div className="px-4 py-3 border-b border-white/[0.07] text-[10px] font-mono font-bold tracking-[0.16em] text-white/55 shrink-0">
                  BUNDLES
                </div>
                <div className="flex-1 overflow-y-auto divide-y divide-white/5">
                  {clusterList.length === 0 ? (
                    <div className="py-8 text-center text-white/20 text-xs font-mono">No bundles detected</div>
                  ) : (
                    clusterList.map((c) => {
                      const selected = selectedCluster === c.id;
                      return (
                        <button
                          key={c.id}
                          onClick={() => setSelectedCluster(prev => (prev === c.id ? null : c.id))}
                          className={`w-full text-left px-4 py-3 transition-colors ${selected ? 'bg-lime-400/[0.05]' : 'hover:bg-white/[0.03]'}`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full flex-none" style={{ background: c.color }} />
                            <span className="text-[10px] font-mono text-white/70">{c.wallets.length} wallet{c.wallets.length === 1 ? '' : 's'}</span>
                            <span className="text-[10px] font-mono text-white/40">{fmtNum(c.pct, 2)}%</span>
                            <span className="ml-auto text-[8px] font-mono text-white/40 border border-white/15 px-1 rounded uppercase">{c.kind}</span>
                          </div>
                          {c.funder && (
                            <div className="text-[8px] font-mono text-white/30 break-all mt-1.5 leading-[1.5]">
                              funder: {c.funder}
                            </div>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
                {meta && (
                  <div className="px-4 py-2.5 border-t border-white/[0.07] text-[8.5px] font-mono text-white/22 shrink-0">
                    {fmtNum(Number(meta.resolved) || 0, 0)} resolved {'·'} {fmtNum(Number(meta.pending) || 0, 0)} pending
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
