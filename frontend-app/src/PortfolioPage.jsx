// PortfolioPage.jsx
// Shows all SuiPump tokens held by any wallet address.
// Defaults to connected wallet, but accepts any typed address.

import React, { useState, useEffect } from 'react';
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Wallet, Search, X } from 'lucide-react';
import { useTokenList } from './useTokenList.js';
import { priceMistPerToken, mistToSui } from './curve.js';
import { TOKEN_DECIMALS, DRAIN_SUI_APPROX } from './constants.js';

const MIST_PER_SUI = 1e9;

function fmt(n, d = 2) {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

function isValidSuiAddress(addr) {
  return /^0x[0-9a-fA-F]{1,64}$/.test(addr.trim());
}

export default function PortfolioPage({ onBack }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const navigate = useNavigate();
  const { tokens } = useTokenList();

  const [inputAddr, setInputAddr] = useState('');
  const [activeAddr, setActiveAddr] = useState(null);
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [iconUrls, setIconUrls] = useState({});

  // When wallet connects, prefill but don't override a manually typed address
  useEffect(() => {
    if (account?.address && !inputAddr) {
      setInputAddr(account.address);
      setActiveAddr(account.address);
    }
  }, [account?.address]);

  // Load portfolio whenever activeAddr or tokens change
  useEffect(() => {
    if (!activeAddr || !tokens.length) {
      setHoldings([]);
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const results = await Promise.all(
          tokens.filter(t => t.tokenType).map(async (token) => {
            try {
              const [balance, curveObj] = await Promise.all([
                client.getBalance({ owner: activeAddr, coinType: token.tokenType }),
                client.getObject({ id: token.curveId, options: { showContent: true } }),
              ]);
              const rawBalance = BigInt(balance.totalBalance ?? '0');
              if (rawBalance === 0n) return null;

              const fields = curveObj.data?.content?.fields;
              const reserveMist = fields ? BigInt(fields.sui_reserve) : 0n;
              const tokensRemaining = fields ? BigInt(fields.token_reserve) : 0n;
              const tokensSold = BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokensRemaining;
              const priceMist = priceMistPerToken(reserveMist, tokensSold);
              const valueInMist = (rawBalance * priceMist) / (10n ** BigInt(TOKEN_DECIMALS));
              const valueSui = Number(valueInMist) / MIST_PER_SUI;
              const balanceWhole = Number(rawBalance) / 10 ** TOKEN_DECIMALS;
              const graduated = fields?.graduated ?? false;
              const progress = Math.min(100, (mistToSui(reserveMist) / DRAIN_SUI_APPROX) * 100);

              return { ...token, balance: balanceWhole, valueSui, progress, graduated };
            } catch { return null; }
          })
        );
        if (cancelled) return;

        const filtered = results.filter(Boolean).sort((a, b) => b.valueSui - a.valueSui);
        setHoldings(filtered);

        const icons = {};
        await Promise.all(filtered.map(async (h) => {
          try {
            const m = await client.getCoinMetadata({ coinType: h.tokenType });
            if (m?.iconUrl) icons[h.curveId] = m.iconUrl;
          } catch { }
        }));
        if (!cancelled) setIconUrls(icons);
      } catch { }
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [activeAddr, tokens.length, client]);

  const totalValueSui = holdings.reduce((s, h) => s + h.valueSui, 0);
  const isOwnWallet = account?.address && activeAddr === account.address;
  const addrValid = isValidSuiAddress(inputAddr);

  const handleLookup = () => {
    if (addrValid) setActiveAddr(inputAddr.trim());
  };

  const handleClear = () => {
    setInputAddr(account?.address ?? '');
    setActiveAddr(account?.address ?? null);
  };

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors"
      >
        <ArrowLeft size={12} /> BACK TO HOME
      </button>

      <div className="max-w-2xl mx-auto space-y-4">

        {/* Header card */}
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-lime-950/20 via-black to-black p-6 relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-16 bg-lime-400/10 blur-3xl rounded-full pointer-events-none" />
          <div className="relative">
            <div className="flex items-center gap-3 mb-4">
              <Wallet className="text-lime-400" size={20} />
              <h1 className="text-xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                PORTFOLIO
              </h1>
            </div>

            {/* Address input */}
            <div className="flex gap-2 mb-4">
              <div className="relative flex-1">
                <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20 pointer-events-none" />
                <input
                  value={inputAddr}
                  onChange={e => setInputAddr(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleLookup(); }}
                  placeholder="Enter any Sui wallet address…"
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-8 pr-4 py-2 text-white text-xs font-mono focus:outline-none focus:border-lime-400/40 transition-colors placeholder-white/20"
                />
              </div>
              <button
                onClick={handleLookup}
                disabled={!addrValid}
                className="px-4 py-2 bg-lime-400 text-black text-xs font-mono font-bold rounded-xl hover:bg-lime-300 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                LOOK UP
              </button>
              {activeAddr && activeAddr !== account?.address && (
                <button
                  onClick={handleClear}
                  className="px-3 py-2 rounded-xl border border-white/10 text-white/40 hover:text-white transition-colors"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {activeAddr && (
              <>
                <div className="text-[10px] font-mono text-white/30 mb-1">
                  {isOwnWallet ? 'YOUR WALLET' : 'VIEWING WALLET'}
                </div>
                <div className="text-[10px] font-mono text-white/40 mb-4 break-all">{activeAddr}</div>
                <div className="flex items-end gap-6">
                  <div>
                    <div className="text-[10px] font-mono text-white/30 mb-1">ESTIMATED VALUE</div>
                    <div className="text-3xl font-bold text-white font-mono">
                      {fmt(totalValueSui, 4)} <span className="text-white/40 text-lg">SUI</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-mono text-white/30 mb-1">TOKENS HELD</div>
                    <div className="text-3xl font-bold text-lime-400 font-mono">{holdings.length}</div>
                  </div>
                </div>
              </>
            )}

            {!activeAddr && (
              <div className="text-sm font-mono text-white/30">
                {account ? 'Loading…' : 'Connect wallet or enter an address above.'}
              </div>
            )}
          </div>
        </div>

        {/* Holdings list */}
        {activeAddr && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
            <div className="grid grid-cols-12 text-[9px] font-mono text-white/20 tracking-widest px-5 py-3 border-b border-white/5">
              <span className="col-span-5">TOKEN</span>
              <span className="col-span-3 text-right">BALANCE</span>
              <span className="col-span-4 text-right">EST. VALUE</span>
            </div>

            {loading && (
              <div className="space-y-px">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-4 animate-pulse">
                    <div className="w-9 h-9 rounded-full bg-white/5 shrink-0" />
                    <div className="flex-1">
                      <div className="h-3 bg-white/5 rounded w-20 mb-1.5" />
                      <div className="h-2 bg-white/5 rounded w-14" />
                    </div>
                    <div className="h-3 bg-white/5 rounded w-16 ml-auto" />
                  </div>
                ))}
              </div>
            )}

            {!loading && holdings.length === 0 && (
              <div className="text-xs font-mono text-white/20 text-center py-12">
                No SuiPump tokens in this wallet.
              </div>
            )}

            {!loading && holdings.map((h) => (
              <button
                key={h.curveId}
                onClick={() => navigate(`/token/${h.curveId}`)}
                className="w-full grid grid-cols-12 items-center px-5 py-4 border-b border-white/[0.03] last:border-0 hover:bg-white/5 transition-colors group text-left"
              >
                <div className="col-span-5 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full border border-white/10 overflow-hidden flex items-center justify-center bg-lime-950/30 shrink-0 group-hover:border-lime-400/30 transition-colors">
                    {iconUrls[h.curveId]
                      ? <img src={iconUrls[h.curveId]} alt={h.symbol} className="w-full h-full object-cover"
                          onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='block'; }} />
                      : null}
                    <span className="text-base" style={{ display: iconUrls[h.curveId] ? 'none' : 'block' }}>🔥</span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-mono font-bold text-white truncate group-hover:text-lime-400 transition-colors">{h.name}</div>
                    <div className="text-[10px] font-mono text-white/30">${h.symbol}</div>
                    <div className="mt-1 h-1 bg-white/5 rounded-full overflow-hidden w-16">
                      <div className="h-full bg-gradient-to-r from-lime-700 to-lime-400 rounded-full"
                        style={{ width: `${Math.max(h.progress, 1)}%` }} />
                    </div>
                  </div>
                </div>
                <div className="col-span-3 text-right">
                  <div className="text-xs font-mono font-bold text-white">{fmt(h.balance, 0)}</div>
                  <div className="text-[10px] font-mono text-white/30">{h.symbol}</div>
                </div>
                <div className="col-span-4 text-right">
                  <div className="text-xs font-mono font-bold text-lime-400">{fmt(h.valueSui, 4)} SUI</div>
                  {h.graduated && <div className="text-[10px] font-mono text-emerald-400">GRADUATED</div>}
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="text-[9px] font-mono text-white/15 text-center">
          VALUES ARE ESTIMATES BASED ON CURRENT BONDING CURVE PRICE · NOT FINANCIAL ADVICE
        </div>
      </div>
    </div>
  );
}
