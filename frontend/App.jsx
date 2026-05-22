import React, { useState, useEffect, useMemo, useRef } from "react";
import { TrendingUp, TrendingDown, Zap, Rocket, Crown, Copy, ExternalLink, Flame, Wallet, Plus } from "lucide-react";

// --- Curve math (mirrors Move contract) -----------------------------------
const VIRTUAL_SUI = 30_000;
const VIRTUAL_TOKENS = 1_073_000_000;
const CURVE_SUPPLY = 800_000_000;
// Real SUI reserve when curve fully drains, from the constant-product math:
// Vs * Vt / (Vt - CURVE_SUPPLY) - Vs ≈ 87,912 SUI
const DRAIN_SUI_APPROX = 87_912;
const TRADE_FEE_BPS = 100;
const CREATOR_SHARE_BPS = 4_000; // 40% of fee -> 0.40% of volume
const PROTOCOL_SHARE_BPS = 5_000; // 50% of fee -> 0.50% of volume
const LP_SHARE_BPS = 1_000; // 10% of fee -> 0.10% of volume (stays in reserve)

function splitFee(fee) {
  const creator = (fee * CREATOR_SHARE_BPS) / 10_000;
  const protocol = (fee * PROTOCOL_SHARE_BPS) / 10_000;
  const lp = fee - creator - protocol;
  return { creator, protocol, lp };
}

function quoteBuy(suiIn, realSuiReserve, tokensSold) {
  const fee = (suiIn * TRADE_FEE_BPS) / 10_000;
  const swap = suiIn - fee;
  const x = realSuiReserve + VIRTUAL_SUI;
  const y = VIRTUAL_TOKENS - tokensSold;
  const tokensOut = (y * swap) / (x + swap);
  return { tokensOut, fee };
}

function quoteSell(tokensIn, realSuiReserve, tokensSold) {
  const x = VIRTUAL_TOKENS - tokensSold;
  const y = realSuiReserve + VIRTUAL_SUI;
  const grossOut = (y * tokensIn) / (x + tokensIn);
  const fee = (grossOut * TRADE_FEE_BPS) / 10_000;
  return { suiOut: grossOut - fee, fee };
}

function priceAt(realSuiReserve, tokensSold) {
  const x = realSuiReserve + VIRTUAL_SUI;
  const y = VIRTUAL_TOKENS - tokensSold;
  return x / y;
}

// --- Seed demo data --------------------------------------------------------
const seedTokens = [
  { id: "1", name: "Sui Pepe", symbol: "SPEPE", creator: "0x7a3f...c21b", emoji: "🐸", reserve: 4210, sold: 312_000_000, holders: 847, age: "2h", creatorEarned: 21.05 },
  { id: "2", name: "Moon Walrus", symbol: "MWAL", creator: "0xff12...88ad", emoji: "🦭", reserve: 71_200, sold: 698_000_000, holders: 2104, age: "11h", creatorEarned: 356.0 },
  { id: "3", name: "Gigabrain", symbol: "BRAIN", creator: "0x4401...0e7e", emoji: "🧠", reserve: 12_450, sold: 521_000_000, holders: 1203, age: "5h", creatorEarned: 62.25 },
  { id: "4", name: "Ramen", symbol: "RAMEN", creator: "0xaabb...3311", emoji: "🍜", reserve: 340, sold: 74_000_000, holders: 182, age: "34m", creatorEarned: 1.7 },
  { id: "5", name: "Cetus Slayer", symbol: "SLAY", creator: "0x9901...ccdd", emoji: "⚔️", reserve: 28_900, sold: 612_000_000, holders: 1876, age: "8h", creatorEarned: 144.5 },
  { id: "6", name: "Blobby", symbol: "BLOB", creator: "0x2233...ff00", emoji: "🫧", reserve: 1890, sold: 201_000_000, holders: 423, age: "1h", creatorEarned: 9.45 },
];

function fmt(n, d = 2) {
  if (n >= 1e9) return (n / 1e9).toFixed(d) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(d) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(d) + "k";
  if (n < 0.0001 && n > 0) return n.toExponential(2);
  return n.toFixed(d);
}

// --- Mini sparkline --------------------------------------------------------
function Spark({ reserve, sold }) {
  const pts = useMemo(() => {
    const out = [];
    for (let i = 0; i <= 20; i++) {
      const f = i / 20;
      const r = reserve * f;
      const s = sold * f;
      out.push(priceAt(r, s));
    }
    return out;
  }, [reserve, sold]);
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const d = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * 100;
      const y = 30 - ((p - min) / (max - min || 1)) * 28;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" className="w-full h-8" preserveAspectRatio="none">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

// --- Token card ------------------------------------------------------------
function TokenCard({ tok, onOpen }) {
  const progress = Math.min(100, (tok.reserve / DRAIN_SUI_APPROX) * 100);
  const graduating = progress >= 95;
  const price = priceAt(tok.reserve, tok.sold);
  const mcap = price * 1_000_000_000;

  return (
    <button
      onClick={() => onOpen(tok)}
      className="group relative text-left border border-lime-900/50 bg-black hover:bg-lime-950/20 hover:border-lime-500/60 transition-all duration-150 p-4 overflow-hidden"
    >
      {graduating && (
        <div className="absolute top-0 right-0 bg-lime-400 text-black text-[10px] font-bold px-2 py-0.5 tracking-widest">
          GRADUATING
        </div>
      )}
      <div className="flex items-start gap-3 mb-3">
        <div className="text-3xl leading-none">{tok.emoji}</div>
        <div className="min-w-0 flex-1">
          <div className="font-bold text-lime-200 truncate">{tok.name}</div>
          <div className="text-xs text-lime-600 font-mono">${tok.symbol} · {tok.age}</div>
        </div>
      </div>

      <div className="text-lime-500 mb-2">
        <Spark reserve={tok.reserve} sold={tok.sold} />
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] font-mono mb-3">
        <div className="text-lime-700">MCAP</div>
        <div className="text-right text-lime-200">${fmt(mcap * 4.2)}</div>
        <div className="text-lime-700">PRICE</div>
        <div className="text-right text-lime-200">{fmt(price, 6)} SUI</div>
        <div className="text-lime-700">HOLDERS</div>
        <div className="text-right text-lime-200">{tok.holders.toLocaleString()}</div>
        <div className="text-lime-700 flex items-center gap-1"><Crown size={10}/>EARNED</div>
        <div className="text-right text-amber-300">{fmt(tok.creatorEarned)} SUI</div>
      </div>

      <div>
        <div className="flex justify-between text-[10px] font-mono text-lime-700 mb-1">
          <span>BONDING</span>
          <span>{progress.toFixed(1)}%</span>
        </div>
        <div className="h-1.5 bg-lime-950 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-lime-500 to-lime-300 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </button>
  );
}

// --- Trading panel ---------------------------------------------------------
function TradingPanel({ tok, onBack }) {
  const [side, setSide] = useState("buy");
  const [amount, setAmount] = useState("");
  const [reserve, setReserve] = useState(tok.reserve);
  const [sold, setSold] = useState(tok.sold);
  const [creatorEarned, setCreatorEarned] = useState(tok.creatorEarned);
  const [trades, setTrades] = useState([
    { side: "buy", sui: 45, tokens: 1_240_000, who: "0xabcd...1234", t: "12s" },
    { side: "sell", sui: 12, tokens: 334_000, who: "0x8812...aabb", t: "1m" },
    { side: "buy", sui: 210, tokens: 5_812_000, who: "0x4411...99ff", t: "3m" },
    { side: "buy", sui: 88, tokens: 2_440_000, who: "0x2233...7788", t: "4m" },
  ]);

  const price = priceAt(reserve, sold);
  const progress = Math.min(100, (reserve / DRAIN_SUI_APPROX) * 100);

  const quote = useMemo(() => {
    const a = parseFloat(amount);
    if (!a || a <= 0) return null;
    if (side === "buy") return quoteBuy(a, reserve, sold);
    return quoteSell(a * 1_000_000, reserve, sold);
  }, [amount, side, reserve, sold]);

  const execute = () => {
    const a = parseFloat(amount);
    if (!a || !quote) return;
    const split = splitFee(quote.fee);
    if (side === "buy") {
      // LP fee stays in reserve; creator & protocol fees are earmarked off.
      setReserve((r) => r + a - split.creator - split.protocol);
      setSold((s) => s + quote.tokensOut);
      setCreatorEarned((c) => c + split.creator);
      setTrades((t) => [
        { side: "buy", sui: a, tokens: quote.tokensOut, who: "0xyou...0001", t: "now" },
        ...t.slice(0, 9),
      ]);
    } else {
      // On sell, we pay out (gross - creator - protocol - lp_withheld_in_reserve)
      setReserve((r) => Math.max(0, r - quote.suiOut - split.creator - split.protocol));
      setSold((s) => Math.max(0, s - a * 1_000_000));
      setCreatorEarned((c) => c + split.creator);
      setTrades((t) => [
        { side: "sell", sui: quote.suiOut, tokens: a * 1_000_000, who: "0xyou...0001", t: "now" },
        ...t.slice(0, 9),
      ]);
    }
    setAmount("");
  };

  return (
    <div className="max-w-6xl mx-auto">
      <button onClick={onBack} className="text-lime-600 hover:text-lime-400 text-xs font-mono mb-4 tracking-widest">
        ← BACK TO BOARD
      </button>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Left: token info */}
        <div className="lg:col-span-2 space-y-4">
          <div className="border border-lime-900/50 bg-black p-5">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-4">
                <div className="text-5xl">{tok.emoji}</div>
                <div>
                  <h2 className="text-2xl font-bold text-lime-100">{tok.name}</h2>
                  <div className="text-sm text-lime-600 font-mono">${tok.symbol}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-lime-700 font-mono tracking-widest">PRICE</div>
                <div className="text-2xl font-bold text-lime-200 font-mono">{fmt(price, 7)}</div>
                <div className="text-xs text-lime-600 font-mono">SUI per token</div>
              </div>
            </div>

            <div className="border-t border-lime-950 pt-4">
              <div className="flex justify-between items-center mb-2">
                <div className="flex items-center gap-2 text-xs font-mono tracking-widest text-lime-400">
                  <Rocket size={12}/> BONDING CURVE → DEX GRADUATION
                </div>
                <div className="text-xs font-mono text-lime-300">
                  {fmt(reserve)} / {fmt(DRAIN_SUI_APPROX)} SUI
                </div>
              </div>
              <div className="h-3 bg-lime-950 relative overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-lime-600 via-lime-400 to-lime-200 relative"
                  style={{ width: `${progress}%` }}
                >
                  <div className="absolute inset-0 bg-white/20 animate-pulse"/>
                </div>
              </div>
              <div className="text-[10px] text-lime-700 font-mono mt-2">
                AT 100%, REMAINING 20% SUPPLY + {fmt(DRAIN_SUI_APPROX)} SUI RESERVE DEPLOY TO CETUS LP · CREATOR RECEIVES 0.5% BONUS
              </div>
            </div>
          </div>

          {/* Creator revenue panel */}
          <div className="border border-amber-900/50 bg-gradient-to-br from-amber-950/20 to-black p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 text-xs font-mono tracking-widest text-amber-400 mb-2">
                  <Crown size={12}/> CREATOR REVENUE · 40% OF 1% FEES
                </div>
                <div className="text-xs font-mono text-amber-700 mb-1">CREATOR</div>
                <div className="text-sm font-mono text-amber-200 flex items-center gap-2">
                  {tok.creator} <Copy size={10} className="cursor-pointer hover:text-amber-100"/>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-mono text-amber-700">EARNED</div>
                <div className="text-3xl font-bold text-amber-200 font-mono tabular-nums">{fmt(creatorEarned, 3)}</div>
                <div className="text-xs text-amber-600 font-mono">SUI</div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-4 pt-4 border-t border-amber-950">
              <div>
                <div className="text-[10px] text-amber-700 font-mono">PER TRADE</div>
                <div className="text-sm text-amber-200 font-mono">0.40%</div>
              </div>
              <div>
                <div className="text-[10px] text-amber-700 font-mono">ON GRADUATION</div>
                <div className="text-sm text-amber-200 font-mono">+440 SUI</div>
              </div>
              <div>
                <div className="text-[10px] text-amber-700 font-mono">UNCLAIMED</div>
                <div className="text-sm text-amber-200 font-mono">{fmt(creatorEarned * 0.3, 3)} SUI</div>
              </div>
            </div>
          </div>

          {/* Recent trades */}
          <div className="border border-lime-900/50 bg-black">
            <div className="border-b border-lime-950 px-4 py-2 text-xs font-mono tracking-widest text-lime-500">
              TRADE LOG
            </div>
            <div className="divide-y divide-lime-950/50">
              {trades.map((t, i) => (
                <div key={i} className="px-4 py-2 flex items-center justify-between text-xs font-mono">
                  <div className="flex items-center gap-3">
                    {t.side === "buy" ? (
                      <TrendingUp size={12} className="text-lime-400"/>
                    ) : (
                      <TrendingDown size={12} className="text-red-400"/>
                    )}
                    <span className={t.side === "buy" ? "text-lime-400" : "text-red-400"}>
                      {t.side.toUpperCase()}
                    </span>
                    <span className="text-lime-700">{t.who}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-lime-300">{fmt(t.sui, 3)} SUI</span>
                    <span className="text-lime-600">{fmt(t.tokens / 1_000_000)} {tok.symbol}</span>
                    <span className="text-lime-800 w-8 text-right">{t.t}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: trade form */}
        <div className="border border-lime-500/60 bg-black p-5 h-fit sticky top-4">
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setSide("buy")}
              className={`flex-1 py-2 text-xs font-mono tracking-widest border ${
                side === "buy"
                  ? "bg-lime-400 text-black border-lime-400"
                  : "bg-black text-lime-600 border-lime-900 hover:border-lime-600"
              }`}
            >
              BUY
            </button>
            <button
              onClick={() => setSide("sell")}
              className={`flex-1 py-2 text-xs font-mono tracking-widest border ${
                side === "sell"
                  ? "bg-red-400 text-black border-red-400"
                  : "bg-black text-lime-600 border-lime-900 hover:border-red-600"
              }`}
            >
              SELL
            </button>
          </div>

          <div className="mb-1 text-[10px] font-mono text-lime-700 tracking-widest">
            {side === "buy" ? "YOU PAY (SUI)" : `YOU SELL (${tok.symbol})`}
          </div>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            className="w-full bg-lime-950/30 border border-lime-900 px-3 py-3 text-lime-100 font-mono text-xl focus:outline-none focus:border-lime-400"
          />

          <div className="flex gap-1 mt-2">
            {[0.1, 0.5, 1, 5].map((v) => (
              <button
                key={v}
                onClick={() => setAmount(String(v))}
                className="flex-1 text-[10px] font-mono py-1 border border-lime-900 text-lime-600 hover:border-lime-400 hover:text-lime-300"
              >
                {v}
              </button>
            ))}
          </div>

          {quote && (
            <div className="mt-4 p-3 border border-lime-900 bg-lime-950/20 space-y-1 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-lime-700">YOU RECEIVE</span>
                <span className="text-lime-100">
                  {side === "buy"
                    ? `${fmt(quote.tokensOut / 1_000_000)} ${tok.symbol}`
                    : `${fmt(quote.suiOut, 4)} SUI`}
                </span>
              </div>
              <div className="flex justify-between pt-1 border-t border-lime-950">
                <span className="text-lime-700">TOTAL FEE (1%)</span>
                <span className="text-lime-500">{fmt(quote.fee, 5)} SUI</span>
              </div>
              <div className="flex justify-between pl-3">
                <span className="text-amber-700">├ CREATOR (0.40%)</span>
                <span className="text-amber-400">{fmt(splitFee(quote.fee).creator, 5)}</span>
              </div>
              <div className="flex justify-between pl-3">
                <span className="text-lime-700">├ PROTOCOL (0.50%)</span>
                <span className="text-lime-500">{fmt(splitFee(quote.fee).protocol, 5)}</span>
              </div>
              <div className="flex justify-between pl-3">
                <span className="text-cyan-700">└ LIQUIDITY (0.10%)</span>
                <span className="text-cyan-400">{fmt(splitFee(quote.fee).lp, 5)}</span>
              </div>
            </div>
          )}

          <button
            onClick={execute}
            disabled={!quote}
            className={`w-full mt-4 py-3 font-mono tracking-widest text-sm ${
              quote
                ? side === "buy"
                  ? "bg-lime-400 text-black hover:bg-lime-300"
                  : "bg-red-400 text-black hover:bg-red-300"
                : "bg-lime-950 text-lime-800 cursor-not-allowed"
            }`}
          >
            {!quote ? "ENTER AMOUNT" : `EXECUTE ${side.toUpperCase()}`}
          </button>

          <div className="mt-4 text-[10px] font-mono text-lime-800 leading-relaxed">
            TXN ROUTED VIA PTB · SLIPPAGE 0.5% · NO PRESALE · NO TEAM ALLOCATION · FAIR LAUNCH
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Create modal ----------------------------------------------------------
function CreateModal({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [emoji, setEmoji] = useState("🚀");

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="border border-lime-500 bg-black max-w-md w-full p-6"
      >
        <div className="flex items-center gap-2 text-xs font-mono tracking-widest text-lime-400 mb-6">
          <Zap size={12}/> DEPLOY NEW TOKEN
        </div>
        <div className="space-y-3">
          <div>
            <div className="text-[10px] font-mono text-lime-700 mb-1 tracking-widest">NAME</div>
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Gigachad Coin"
              className="w-full bg-lime-950/30 border border-lime-900 px-3 py-2 text-lime-100 font-mono focus:outline-none focus:border-lime-400"
            />
          </div>
          <div>
            <div className="text-[10px] font-mono text-lime-700 mb-1 tracking-widest">SYMBOL</div>
            <input
              value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="GIGA" maxLength={6}
              className="w-full bg-lime-950/30 border border-lime-900 px-3 py-2 text-lime-100 font-mono focus:outline-none focus:border-lime-400"
            />
          </div>
          <div>
            <div className="text-[10px] font-mono text-lime-700 mb-1 tracking-widest">ICON</div>
            <div className="flex gap-2">
              {["🚀","🔥","💎","🐸","🦭","🧠","⚔️","🍜","👑","⚡","🌙","🫧"].map((e) => (
                <button
                  key={e} onClick={() => setEmoji(e)}
                  className={`text-2xl p-2 border ${emoji === e ? "border-lime-400 bg-lime-950" : "border-lime-900"}`}
                >{e}</button>
              ))}
            </div>
          </div>
          <div className="text-[10px] font-mono text-lime-700 bg-lime-950/30 border border-lime-900 p-3 leading-relaxed">
            PUBLISHING COSTS ~0.1 SUI · YOU EARN 40% OF ALL TRADE FEES (0.40% PER TRADE) ·
            +0.5% BONUS ON GRADUATION (~440 SUI) · 0.10% OF EACH TRADE DEEPENS YOUR POOL LIQUIDITY ·
            NO VESTING · IMMUTABLE
          </div>
          <button
            disabled={!name || !symbol}
            onClick={() => onCreate({ name, symbol, emoji })}
            className={`w-full py-3 font-mono tracking-widest text-sm ${
              name && symbol
                ? "bg-lime-400 text-black hover:bg-lime-300"
                : "bg-lime-950 text-lime-800 cursor-not-allowed"
            }`}
          >
            PUBLISH & LAUNCH CURVE
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Root ------------------------------------------------------------------
export default function App() {
  const [tokens, setTokens] = useState(seedTokens);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [sort, setSort] = useState("hot");

  const sorted = useMemo(() => {
    const arr = [...tokens];
    if (sort === "hot") arr.sort((a, b) => b.reserve / DRAIN_SUI_APPROX - a.reserve / DRAIN_SUI_APPROX);
    if (sort === "new") arr.sort((a, b) => parseFloat(a.age) - parseFloat(b.age));
    if (sort === "earn") arr.sort((a, b) => b.creatorEarned - a.creatorEarned);
    return arr;
  }, [tokens, sort]);

  const handleCreate = ({ name, symbol, emoji }) => {
    const newTok = {
      id: String(Date.now()),
      name, symbol, emoji,
      creator: "0xyou...0001",
      reserve: 0, sold: 0, holders: 1, age: "0m", creatorEarned: 0,
    };
    setTokens((t) => [newTok, ...t]);
    setCreating(false);
    setSelected(newTok);
  };

  return (
    <div className="min-h-screen bg-black text-lime-100" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@700&display=swap');
        body { background: #000; }
      `}</style>

      {/* Scanline + grid backdrop */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.04]" style={{
        backgroundImage: "linear-gradient(rgba(132,204,22,0.8) 1px, transparent 1px), linear-gradient(90deg, rgba(132,204,22,0.8) 1px, transparent 1px)",
        backgroundSize: "40px 40px"
      }}/>

      <header className="border-b border-lime-900/60 bg-black/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Flame className="text-lime-400" size={24}/>
              <div className="absolute inset-0 blur-md bg-lime-400/50 -z-10"/>
            </div>
            <div>
              <div className="text-lg font-bold tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                SUIPUMP<span className="text-lime-400">.</span>
              </div>
              <div className="text-[9px] font-mono text-lime-700 tracking-[0.2em] -mt-1">FAIR LAUNCH · SUI MAINNET</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setCreating(true)} className="hidden sm:flex items-center gap-2 bg-lime-400 text-black px-3 py-1.5 text-xs font-mono tracking-widest hover:bg-lime-300">
              <Plus size={12}/> LAUNCH
            </button>
            <button className="flex items-center gap-2 border border-lime-900 px-3 py-1.5 text-xs font-mono tracking-widest text-lime-400 hover:border-lime-500">
              <Wallet size={12}/> CONNECT
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 relative">
        {selected ? (
          <TradingPanel tok={{ ...selected, ...tokens.find((t) => t.id === selected.id) }} onBack={() => setSelected(null)}/>
        ) : (
          <>
            {/* Hero */}
            <div className="mb-4 border border-lime-900/50 bg-gradient-to-br from-lime-950/20 via-black to-black p-6 relative overflow-hidden">
              <div className="absolute -right-20 -top-20 text-[200px] opacity-5">🔥</div>
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-2" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                LAUNCH A TOKEN.<br/>
                <span className="text-lime-400">EARN FROM EVERY TRADE.</span>
              </h1>
              <p className="text-sm text-lime-600 font-mono max-w-xl">
                Permissionless bonding curves on Sui. Creators earn 40% of trade fees forever + a graduation bonus when liquidity migrates to Cetus. No presales. No vesting. No team allocations.
              </p>
              <div className="grid grid-cols-3 gap-4 mt-6 max-w-xl">
                <div>
                  <div className="text-2xl font-bold text-lime-200">{tokens.length}</div>
                  <div className="text-[10px] font-mono text-lime-700 tracking-widest">ACTIVE CURVES</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-lime-200">{fmt(tokens.reduce((s, t) => s + t.reserve, 0))}</div>
                  <div className="text-[10px] font-mono text-lime-700 tracking-widest">SUI LOCKED</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-amber-300">{fmt(tokens.reduce((s, t) => s + t.creatorEarned, 0))}</div>
                  <div className="text-[10px] font-mono text-amber-700 tracking-widest">PAID TO CREATORS</div>
                </div>
              </div>
            </div>

            {/* Fee comparison */}
            <div className="mb-8 border border-lime-900/50 bg-black">
              <div className="border-b border-lime-950 px-4 py-2 text-xs font-mono tracking-widest text-lime-500 flex items-center justify-between">
                <span>FEE BREAKDOWN · SUIPUMP vs LEADING SOL LAUNCHPAD</span>
                <span className="text-lime-800">PER TRADE</span>
              </div>
              <div className="grid grid-cols-5 text-xs font-mono">
                <div className="col-span-1 px-4 py-3 border-r border-lime-950"></div>
                <div className="px-2 py-3 text-center text-amber-600 border-r border-lime-950">CREATOR</div>
                <div className="px-2 py-3 text-center text-lime-600 border-r border-lime-950">PROTOCOL</div>
                <div className="px-2 py-3 text-center text-cyan-600 border-r border-lime-950">LIQUIDITY</div>
                <div className="px-2 py-3 text-center text-lime-400">TOTAL</div>

                <div className="col-span-1 px-4 py-3 border-r border-t border-lime-950 text-lime-300 font-bold">SUIPUMP</div>
                <div className="px-2 py-3 text-center text-amber-300 border-r border-t border-lime-950">0.40%</div>
                <div className="px-2 py-3 text-center text-lime-300 border-r border-t border-lime-950">0.50%</div>
                <div className="px-2 py-3 text-center text-cyan-300 border-r border-t border-lime-950">0.10%</div>
                <div className="px-2 py-3 text-center text-lime-200 border-t border-lime-950 font-bold">1.00%</div>

                <div className="col-span-1 px-4 py-3 border-r border-t border-lime-950 text-lime-700">LEADING SOL LAUNCHPAD</div>
                <div className="px-2 py-3 text-center text-amber-700 border-r border-t border-lime-950">0.30%</div>
                <div className="px-2 py-3 text-center text-lime-700 border-r border-t border-lime-950">0.95%</div>
                <div className="px-2 py-3 text-center text-cyan-900 border-r border-t border-lime-950">0.00%</div>
                <div className="px-2 py-3 text-center text-lime-600 border-t border-lime-950">1.25%</div>
              </div>
              <div className="border-t border-lime-950 px-4 py-2 text-[10px] font-mono text-lime-700 leading-relaxed">
                LOWER TOTAL FEE · MORE TO CREATORS (40% OF FEE vs 24%) · LIQUIDITY GROWS WITH VOLUME · PROTOCOL FEE STILL FUNDS DEV
              </div>
            </div>

            {/* Sort */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex gap-1">
                {[
                  { k: "hot", l: "🔥 HOT" },
                  { k: "new", l: "⚡ NEW" },
                  { k: "earn", l: "👑 TOP EARNING" },
                ].map((s) => (
                  <button
                    key={s.k} onClick={() => setSort(s.k)}
                    className={`px-3 py-1.5 text-xs font-mono tracking-widest border ${
                      sort === s.k ? "border-lime-400 text-lime-300 bg-lime-950/40" : "border-lime-900 text-lime-600"
                    }`}
                  >{s.l}</button>
                ))}
              </div>
              <div className="text-[10px] font-mono text-lime-700">UPDATED LIVE · BLOCK #128442031</div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {sorted.map((t) => (
                <TokenCard key={t.id} tok={t} onOpen={setSelected}/>
              ))}
            </div>
          </>
        )}
      </main>

      {creating && <CreateModal onClose={() => setCreating(false)} onCreate={handleCreate}/>}

      <footer className="max-w-6xl mx-auto px-4 py-8 text-[10px] font-mono text-lime-800 text-center tracking-widest">
        DEMO UI · CONTRACTS UNAUDITED · DYOR · SUIPUMP IS A CONCEPT PROJECT
      </footer>
    </div>
  );
}
