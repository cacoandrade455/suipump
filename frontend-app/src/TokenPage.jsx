// v17-creator-tools
// TokenPage.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { ArrowLeft, Copy, Check, Share2, ExternalLink, Settings, Edit3, Clock } from 'lucide-react';
import PriceChart from './PriceChart.jsx';
import TradeHistory from './TradeHistory.jsx';
import HolderList from './HolderList.jsx';
import Comments from './Comments.jsx';
import AIAnalysis from './AIAnalysis.jsx';
import { PACKAGE_ID, PACKAGE_ID_V4, PACKAGE_ID_V5, PACKAGE_ID_V6, MIST_PER_SUI, DRAIN_SUI_APPROX, VIRTUAL_SUI_V4, VIRTUAL_SUI_V5, VIRTUAL_SUI_V6, VIRTUAL_TOKENS_V4, VIRTUAL_TOKENS_V5, VIRTUAL_TOKENS_V6, DRAIN_SUI_V4, DRAIN_SUI_V5, DRAIN_SUI_V6, isNewCurve, isV5OrLater, supportsMetadataUpdate } from './constants.js';
import { buyQuote, sellQuote } from './curve.js';
import { t } from './i18n.js';

// BCS helpers
// Option<address> none = single 0x00 byte (BCS enum variant 0)
function bcsOptionNone() {
  return new Uint8Array([0]);
}
function bcsOptionSomeAddress(addr) {
  const hex = addr.replace('0x', '').padStart(64, '0');
  const bytes = new Uint8Array(33);
  bytes[0] = 1; // some variant
  for (let i = 0; i < 32; i++) bytes[i + 1] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// ── constants ─────────────────────────────────────────────────────────────────
const TOKEN_DECIMALS    = 6;
const TOTAL_SUPPLY_WHOLE = 1_000_000_000;
const SUI_CLOCK_ID      = '0x6';

function mistToSui(mist) {
  if (mist == null) return 0;
  return Number(mist) / 1e9;
}

function priceMistPerToken(suiReserveMist, tokensSold, vSuiSui, vTokTokens) {
  const vSui = BigInt(vSuiSui) * BigInt(MIST_PER_SUI);
  const vTok = BigInt(vTokTokens) * 10n ** BigInt(TOKEN_DECIMALS);
  const realSui = BigInt(suiReserveMist);
  const realTok = BigInt(tokensSold);
  const numSui = vSui + realSui;
  const numTok = vTok - realTok;
  if (numTok === 0n) return 0n;
  return (numSui * 10n ** BigInt(TOKEN_DECIMALS)) / numTok;
}

function fmt(n, decimals = 4) {
  if (n == null) return '-';
  if (typeof n === 'bigint') n = Number(n);
  if (isNaN(n)) return '-';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(2) + 'k';
  return n.toFixed(decimals);
}

function fmtUsd(suiAmt, suiUsd, decimals = 2) {
  if (suiAmt == null) return '-';
  const usd = Number(suiAmt) * suiUsd;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}k`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(decimals + 2)}`;
}

async function fetchSuiUsd() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    const j = await r.json();
    return parseFloat(j.price) || 0;
  } catch {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd');
      const j = await r.json();
      return j?.sui?.usd || 0;
    } catch { return 0; }
  }
}

function parseDescription(raw) {
  if (!raw) return { desc: '', twitter: '', telegram: '', website: '', dex: 'cetus' };
  const idx = raw.indexOf('||');
  if (idx === -1) return { desc: raw, twitter: '', telegram: '', website: '', dex: 'cetus' };
  const descPart = raw.slice(0, idx);
  try {
    const links = JSON.parse(raw.slice(idx + 2));
    return {
      desc:     descPart,
      twitter:  links.twitter  || '',
      telegram: links.telegram || '',
      website:  links.website  || '',
      dex:      links.dex      || 'cetus',
    };
  } catch {
    const parts = raw.split('||');
    return {
      desc:     parts[0]?.trim() || '',
      twitter:  parts[1]?.trim() || '',
      telegram: parts[2]?.trim() || '',
      website:  parts[3]?.trim() || '',
      dex:      'cetus',
    };
  }
}

function encodeDescription(desc, links) {
  const hasLinks = links.telegram || links.twitter || links.website || links.dex;
  if (!hasLinks) return desc;
  const obj = {};
  if (links.telegram) obj.telegram = links.telegram.trim();
  if (links.twitter)  obj.twitter  = links.twitter.trim();
  if (links.website)  obj.website  = links.website.trim();
  if (links.dex)      obj.dex      = links.dex;
  return `${desc}||${JSON.stringify(obj)}`;
}

function isPlaceholderIcon(url) {
  if (!url) return true;
  return url.includes('suipump.test');
}

function isPlaceholderDesc(desc) {
  if (!desc) return false;
  return desc.startsWith('Template description placeholder') || desc.startsWith('Template Coin');
}

// Determine which package a token belongs to by checking its type string
function getTokenPackageId(tokenType) {
  if (!tokenType) return null;
  if (PACKAGE_ID_V6 && tokenType.startsWith(PACKAGE_ID_V6)) return PACKAGE_ID_V6;
  if (PACKAGE_ID_V5 && tokenType.startsWith(PACKAGE_ID_V5)) return PACKAGE_ID_V5;
  if (tokenType.startsWith(PACKAGE_ID_V4)) return PACKAGE_ID_V4;
  return null;
}

// Derive package ID — tokenType wins if recognized, else use packageIdHint from App
function resolvePackageId(tokenType, packageIdHint) {
  const fromType = getTokenPackageId(tokenType);
  if (fromType) return fromType;
  if (packageIdHint) {
    if (PACKAGE_ID_V6 && packageIdHint === PACKAGE_ID_V6) return PACKAGE_ID_V6;
    if (PACKAGE_ID_V5 && packageIdHint === PACKAGE_ID_V5) return PACKAGE_ID_V5;
    if (packageIdHint === PACKAGE_ID_V4) return PACKAGE_ID_V4;
    return packageIdHint;
  }
  return PACKAGE_ID_V4;
}

const SLIPPAGE_PRESETS = ['0.5', '1', '2', '5'];

// ── Creator Tools Panel (v5 only) ─────────────────────────────────────────────

function CreatorToolsPanel({ curveId, tokenType, packageIdHint, account, curveState, currentDesc, currentTwitter, currentTelegram, currentWebsite, currentDex, lang }) {
  const client = useSuiClient();
  const { mutate: signAndExecutePanel } = useSignAndExecuteTransaction();
  const pkgId = resolvePackageId(tokenType, packageIdHint);
  const isV5Token = isV5OrLater(pkgId);
  const isV6Token = !!(PACKAGE_ID_V6 && pkgId === PACKAGE_ID_V6);

  const [tab, setTab] = useState('links'); // 'links' | 'metadata'
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // Social links editor state
  const [links, setLinks] = useState({
    desc:     currentDesc     || '',
    twitter:  currentTwitter  || '',
    telegram: currentTelegram || '',
    website:  currentWebsite  || '',
    dex:      currentDex      || 'cetus',
  });

  // Metadata update state (v5 only)
  const [meta, setMeta] = useState({
    name:        '',
    symbol:      '',
    description: '',
    iconUrl:     '',
  });

  // Pending metadata unlock time from on-chain curve state
  // v6 has no pending_metadata — timelock removed
  const pendingUnlocksAt = null;
  const timelockExpired = false;
  const timelockRemaining = 0;

  const showMsg = (m, isError = false) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 4000);
  };

  // Get CreatorCap for this curve
  const getCapId = async () => {
    const ownedObjs = await client.getOwnedObjects({
      owner: account.address,
      filter: { StructType: `${pkgId}::bonding_curve::CreatorCap` },
      options: { showContent: true },
    });
    const capObj = ownedObjs.data?.find(o => o.data?.content?.fields?.curve_id === curveId)
      ?? ownedObjs.data?.[0];
    if (!capObj) throw new Error('CreatorCap not found in wallet');
    return capObj.data?.objectId;
  };

  const getCurveRef = async (tx) => {
    const objForRef = await client.getObject({ id: curveId, options: { showOwner: true } });
    const initialSharedVersion = objForRef.data?.owner?.Shared?.initial_shared_version;
    return initialSharedVersion
      ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion, mutable: true })
      : tx.object(curveId);
  };

  // Queue social links / description update
  // V6 (testnet): localStorage override — no on-chain call needed
  // V4/V5: would call queue_metadata_update (not implemented for testnet, use localStorage)
  const handleQueueLinks = () => {
    if (!links.desc && !links.twitter && !links.telegram && !links.website) {
      showMsg('Fill in at least one field', true); return;
    }
    const key = `suipump_links_${curveId}`;
    const override = {
      updatedAt: Date.now(),
      desc:      links.desc.trim()     || null,
      twitter:   links.twitter.trim()  || null,
      telegram:  links.telegram.trim() || null,
      website:   links.website.trim()  || null,
      dex:       links.dex             || 'cetus',
    };
    localStorage.setItem(key, JSON.stringify(override));
    showMsg('Links updated! ✅');
    setTimeout(() => window.location.reload(), 1200);
  };

  // Queue full metadata update (name/symbol/desc/icon)
  // V6 TESTNET: metadata overrides stored in localStorage only.
  // On mainnet (v7) this will be replaced with a proper on-chain call.
  const METADATA_STORE_KEY = `suipump_meta_${curveId}`;

  const handleUpdateMetadata = () => {
    if (!meta.name && !meta.symbol && !meta.description && !meta.iconUrl) {
      showMsg('Fill in at least one field', true); return;
    }
    // Check 24h window
    const windowClosesAt = curveState?.created_at_ms
      ? Number(curveState.created_at_ms) + 24 * 60 * 60 * 1000 : 0;
    if (windowClosesAt > 0 && Date.now() >= windowClosesAt) {
      showMsg('24h window has closed', true); return;
    }
    // Read existing override
    const existing = JSON.parse(localStorage.getItem(METADATA_STORE_KEY) || '{}');
    if (existing.used) { showMsg('Already updated — one time only', true); return; }
    // Save override
    const override = {
      used: true,
      updatedAt: Date.now(),
      name:        meta.name.trim()        || null,
      symbol:      meta.symbol.trim()      || null,
      description: meta.description.trim() || null,
      iconUrl:     meta.iconUrl.trim()     || null,
    };
    localStorage.setItem(METADATA_STORE_KEY, JSON.stringify(override));
    showMsg('Updated! ✅ (testnet local — v7 will be on-chain)');
    // Force page reload so overrides take effect immediately
    setTimeout(() => window.location.reload(), 1200);
  };


  return (
    <div className="bg-white/[0.03] border border-lime-400/20 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Edit3 size={11} className="text-lime-400/70" />
          <span className="text-[9px] font-mono tracking-widest text-lime-400/70">CREATOR TOOLS</span>
        </div>
        <div className="flex gap-1">
          {['links', ...(isV6Token ? ['metadata'] : [])].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2.5 py-1 rounded-lg text-[9px] font-mono transition-colors ${
                tab === t
                  ? 'bg-lime-400/10 text-lime-400 border border-lime-400/30'
                  : 'text-white/30 hover:text-white/60'
              }`}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Social Links Tab */}
      {tab === 'links' && (
        <div className="space-y-2.5">
          <div className="text-[9px] font-mono text-white/25">
            {'Update your social links — saved instantly'}
          </div>
          <textarea
            value={links.desc}
            onChange={e => setLinks(l => ({ ...l, desc: e.target.value }))}
            placeholder="Token description…"
            rows={2}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-lime-400/50 transition-colors resize-none"
          />
          {[
            { key: 'twitter',  placeholder: 'https://x.com/yourtoken' },
            { key: 'telegram', placeholder: 'https://t.me/yourtoken' },
            { key: 'website',  placeholder: 'https://yourtoken.xyz' },
          ].map(({ key, placeholder }) => (
            <input
              key={key}
              value={links[key]}
              onChange={e => setLinks(l => ({ ...l, [key]: e.target.value }))}
              placeholder={placeholder}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-lime-400/50 transition-colors"
            />
          ))}
          {/* Pending timelock indicator */}
          {pendingUnlocksAt && !timelockExpired && (
            <div className="flex items-center gap-1.5 rounded-lg bg-white/5 border border-white/10 px-3 py-2">
              <Clock size={10} className="text-white/40" />
              <span className="text-[9px] font-mono text-white/40">Update pending — unlocks in ~{timelockRemaining}h</span>
              <button
                onClick={handleApplyMetadata}
                disabled={!timelockExpired || busy}
                className="ml-auto text-[9px] font-mono text-white/20 cursor-not-allowed"
              >
                APPLY
              </button>
            </div>
          )}
          {pendingUnlocksAt && timelockExpired && (
            <button
              onClick={handleApplyMetadata}
              disabled={busy}
              className="w-full py-2 rounded-lg bg-lime-400/10 border border-lime-400/30 text-lime-400 text-[10px] font-mono hover:bg-lime-400/20 transition-colors"
            >
              {busy ? 'APPLYING…' : '✅ APPLY PENDING UPDATE'}
            </button>
          )}
          <button
            onClick={isV5Token ? handleQueueLinks : handleQueueLinks}
            disabled={busy}
            className={`w-full py-2 rounded-lg text-[10px] font-mono font-bold transition-colors ${
              busy
                ? 'bg-white/5 text-white/20 cursor-not-allowed'
                : 'bg-lime-400/10 border border-lime-400/30 text-lime-400 hover:bg-lime-400/20'
            }`}
          >
            {busy ? 'SAVING…' : 'UPDATE LINKS'}
          </button>
        </div>
      )}

      {/* Metadata Tab (v5 only) */}
      {tab === 'metadata' && isV6Token && (() => {
        const windowClosesAt = curveState?.created_at_ms
          ? Number(curveState.created_at_ms) + 24 * 60 * 60 * 1000 : 0;
        const nowMs = Date.now();
        const windowOpen = windowClosesAt > 0 && nowMs < windowClosesAt;
        const hoursLeft = windowOpen ? Math.ceil((windowClosesAt - nowMs) / (1000 * 60 * 60)) : 0;
        // Testnet: check localStorage for one-time usage flag
        const metaOverride = JSON.parse(localStorage.getItem(`suipump_meta_${curveId}`) || '{}');
        const alreadyUpdated = metaOverride.used === true;

        return (
          <div className="space-y-2.5">
            {alreadyUpdated ? (
              <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-3 text-[9px] font-mono text-white/40 text-center">
                ✅ Metadata already updated — one-time change used
              </div>
            ) : !windowOpen ? (
              <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-3 text-[9px] font-mono text-white/40 text-center">
                🔒 24h update window has closed
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div className="text-[9px] font-mono text-white/25">
                    Instant · one-time only · {hoursLeft}h remaining
                  </div>
                  <div className="flex items-center gap-1 text-[9px] font-mono text-lime-400/60">
                    <Clock size={9} />
                    {hoursLeft}h left
                  </div>
                </div>
                {[
                  { key: 'name',        placeholder: 'New token name (optional)' },
                  { key: 'symbol',      placeholder: 'NEW SYMBOL (optional)' },
                  { key: 'description', placeholder: 'New description (optional)' },
                  { key: 'iconUrl',     placeholder: 'https://i.imgur.com/... (optional)' },
                ].map(({ key, placeholder }) => (
                  <input
                    key={key}
                    value={meta[key]}
                    onChange={e => setMeta(m => ({ ...m, [key]: e.target.value }))}
                    placeholder={placeholder}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-lime-400/50 transition-colors"
                  />
                ))}
                <button
                  onClick={handleUpdateMetadata}
                  disabled={busy}
                  className={`w-full py-2 rounded-lg text-[10px] font-mono font-bold transition-colors ${
                    busy
                      ? 'bg-white/5 text-white/20 cursor-not-allowed'
                      : 'bg-lime-400 text-black hover:bg-lime-300'
                  }`}
                >
                  {busy ? 'UPDATING…' : 'UPDATE NOW (INSTANT)'}
                </button>
              </>
            )}
          </div>
        );
      })()}

      {msg && (
        <div className={`text-[10px] font-mono text-center ${msg.includes('✅') || msg.includes('⏳') || msg.includes('🎉') ? 'text-lime-400' : 'text-red-400'}`}>
          {msg}
        </div>
      )}
    </div>
  );
}

// ── Trade Panel ───────────────────────────────────────────────────────────────

function TradePanelContent({
  lang,
  side, setSide, amount, setAmount,
  slippage, setSlippage,
  quote, txStatus, txMsg,
  account, onExecute, priceSui, priceUsd, suiUsd, symbol, graduated,
  suiBalance, tokenBalance,
  isCreator, creatorFeesMist, curveId: panelCurveId, tokenType: panelTokenType,
  packageIdHint: panelPkgHint,
  curveState,
}) {
  const { mutate: signAndExecutePanel } = useSignAndExecuteTransaction();
  const client2 = useSuiClient();
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState('');
  const [showSlippage, setShowSlippage] = useState(false);
  const [customSlippage, setCustomSlippage] = useState('');
  const isPending = txStatus === 'pending';
  const pkgId = resolvePackageId(panelTokenType, panelPkgHint);

  const slippageNum = parseFloat(slippage) || 0;
  const isCustom = !SLIPPAGE_PRESETS.includes(slippage);

  const handleSlippagePreset = (v) => { setSlippage(v); setCustomSlippage(''); };
  const handleCustomSlippage = (v) => {
    const clean = v.replace(/[^0-9.]/g, '');
    setCustomSlippage(clean);
    const n = parseFloat(clean);
    if (!isNaN(n) && n >= 0 && n <= 50) setSlippage(clean);
  };

  const handleClaim = async () => {
    if (!account || !panelCurveId || !panelTokenType || claiming) return;
    setClaiming(true);
    setClaimMsg('');
    try {
      const ownedObjs = await client2.getOwnedObjects({
        owner: account.address,
        filter: { StructType: `${pkgId}::bonding_curve::CreatorCap` },
        options: { showContent: true },
      });
      const capObj = ownedObjs.data?.find(o => {
        const fields = o.data?.content?.fields;
        return fields?.curve_id === panelCurveId;
      }) ?? ownedObjs.data?.[0];
      if (!capObj) throw new Error('CreatorCap not found in wallet');
      const capId = capObj.data?.objectId;

      const objForRef = await client2.getObject({ id: panelCurveId, options: { showOwner: true } });
      const initialSharedVersion = objForRef.data?.owner?.Shared?.initial_shared_version;
      const tx = new Transaction();
      const curveRef = initialSharedVersion
        ? tx.sharedObjectRef({ objectId: panelCurveId, initialSharedVersion, mutable: true })
        : tx.object(panelCurveId);
      tx.moveCall({
        target: `${pkgId}::bonding_curve::claim_creator_fees`,
        typeArguments: [panelTokenType],
        arguments: [tx.object(capId), curveRef],
      });
      signAndExecutePanel(
        { transaction: tx },
        {
          onSuccess: () => { setClaimMsg('Fees claimed! 🎉'); setClaiming(false); setTimeout(() => setClaimMsg(''), 3000); },
          onError: (err) => { setClaimMsg(err.message || 'Claim failed'); setClaiming(false); setTimeout(() => setClaimMsg(''), 4000); },
        }
      );
    } catch (err) {
      setClaimMsg(err.message || 'Claim failed');
      setClaiming(false);
    }
  };

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 space-y-4">
      {/* Header row with slippage toggle */}
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-mono text-white/35 tracking-widest">{t(lang, 'trade')}</div>
        <button
          onClick={() => setShowSlippage(s => !s)}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-mono transition-colors ${
            showSlippage
              ? 'bg-lime-400/10 border border-lime-400/30 text-lime-400'
              : 'text-white/35 hover:text-white/60'
          }`}
        >
          <Settings size={10} />
          {slippageNum === 0 ? 'NO SLIPPAGE' : `${slippage}% ${t(lang, 'slippage')}`}
        </button>
      </div>

      {/* Slippage panel */}
      {showSlippage && (
        <div className="bg-white/[0.02] border border-white/10 rounded-lg p-3 space-y-2">
          <div className="text-[9px] font-mono text-white/35 tracking-widest">SLIPPAGE TOLERANCE</div>
          <div className="flex gap-1.5">
            {SLIPPAGE_PRESETS.map(v => (
              <button
                key={v}
                onClick={() => handleSlippagePreset(v)}
                className={`flex-1 py-1.5 text-[10px] font-mono rounded-lg border transition-colors ${
                  slippage === v && !isCustom
                    ? 'bg-lime-400/10 border-lime-400/30 text-lime-400'
                    : 'border-white/10 text-white/40 hover:border-white/25 hover:text-white/60'
                }`}
              >
                {v}%
              </button>
            ))}
            <input
              type="number" min="0" max="50" step="0.1"
              value={customSlippage}
              onChange={e => handleCustomSlippage(e.target.value)}
              placeholder="—"
              className={`w-14 py-1.5 text-[10px] font-mono rounded-lg border text-center bg-transparent transition-colors ${
                isCustom ? 'border-lime-400/30 text-lime-400' : 'border-white/10 text-white/40'
              } focus:outline-none focus:border-lime-400/50`}
            />
          </div>
        </div>
      )}

      {/* Creator fee claim */}
      {isCreator && Number(creatorFeesMist) > 0 && (
        <div className="space-y-2 pb-2 border-b border-white/5">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-mono text-white/35">{t(lang, 'creatorFees')}</div>
            <div className="text-xs font-mono text-lime-400">
              {fmt(Number(creatorFeesMist) / 1e9, 4)} SUI
            </div>
          </div>
          <button
            onClick={handleClaim}
            disabled={claiming}
            className={`w-full py-2 rounded-lg text-[10px] font-mono font-bold transition-colors ${
              claiming
                ? 'bg-white/5 text-white/20 cursor-not-allowed'
                : 'bg-lime-400/10 border border-lime-400/30 text-lime-400 hover:bg-lime-400/20'
            }`}
          >
            {claiming ? 'CLAIMING…' : t(lang, 'claimFees')}
          </button>
          {claimMsg && (
            <div className={`text-[10px] font-mono text-center ${claimMsg.includes('🎉') ? 'text-lime-400' : 'text-red-400'}`}>
              {claimMsg}
            </div>
          )}
        </div>
      )}

      {/* Price display */}
      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-white/5">
        <div>
          <div className="text-[10px] font-mono text-white/35 mb-0.5">{t(lang, 'price')}</div>
          <div className="text-white/70 text-xs font-mono">
            {suiUsd > 0 ? `$${priceUsd.toFixed(6)}` : `${fmt(priceSui, 6)} SUI`}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-mono text-white/35 mb-0.5">{t(lang, 'inSui')}</div>
          <div className="text-white/50 text-xs font-mono">{fmt(priceSui, 6)} SUI</div>
        </div>
      </div>

      {/* Graduated state */}
      {graduated ? (
        <div className="text-center py-4 text-xs font-mono text-lime-400/70">
          🎓 {t(lang, 'graduationComplete')}
          <a href="https://app.cetus.zone" target="_blank" rel="noreferrer"
            className="block mt-2 text-lime-400 hover:text-lime-300 underline">
            {t(lang, 'viewOnCetus')} ↗
          </a>
        </div>
      ) : (
        <>
          {/* Buy / Sell toggle */}
          <div className="flex rounded-lg overflow-hidden border border-white/10">
            <button onClick={() => setSide('buy')}
              className={`flex-1 py-2.5 text-xs font-mono font-bold transition-colors ${side === 'buy' ? 'bg-lime-400 text-black' : 'text-white/50 hover:text-white/80'}`}>
              {t(lang, 'buy')}
            </button>
            <button onClick={() => setSide('sell')}
              className={`flex-1 py-2.5 text-xs font-mono font-bold transition-colors ${side === 'sell' ? 'bg-red-500 text-white' : 'text-white/50 hover:text-white/80'}`}>
              {t(lang, 'sell')}
            </button>
          </div>

          {/* Amount input */}
          <div className="space-y-1.5">
            <div className="text-[10px] font-mono text-white/35">
              {side === 'buy' ? t(lang, 'amount') : `${t(lang, 'amount')} ($${symbol})`}
            </div>
            <div className="flex gap-2">
              <input
                type="number" min="0" step="any" value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder={side === 'buy' ? '0.00' : '0'}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-white/20 focus:outline-none focus:border-lime-400/50 focus:bg-lime-400/5 transition-colors"
              />
              <button
                onClick={() => {
                  if (side === 'buy') {
                    const max = Math.max(0, suiBalance - 0.1);
                    setAmount(max > 0 ? max.toFixed(4) : '0');
                  } else {
                    setAmount(tokenBalance > 1 ? (tokenBalance - 1).toFixed(0) : tokenBalance > 0 ? tokenBalance.toFixed(0) : '0');
                  }
                }}
                className="px-3 py-2.5 text-[10px] font-mono text-white/40 hover:text-lime-400 border border-white/10 rounded-lg hover:border-lime-400/30 transition-colors"
              >
                {t(lang, 'max')}
              </button>
            </div>
            {side === 'buy' ? (
              <div className="flex gap-1.5">
                {['1', '10', '50', '100'].map(v => (
                  <button key={v} onClick={() => setAmount(v)}
                    className="flex-1 py-1 text-[9px] font-mono text-white/30 hover:text-lime-400 border border-white/10 rounded-md hover:border-lime-400/30 transition-colors">
                    {v}
                  </button>
                ))}
              </div>
            ) : tokenBalance > 0 ? (
              <div className="flex gap-1.5">
                {[25, 50, 75, 100].map(pct => (
                  <button key={pct} onClick={() => setAmount(pct === 100 && tokenBalance > 1 ? (tokenBalance - 1).toFixed(0) : ((tokenBalance * pct) / 100).toFixed(0))}
                    className="flex-1 py-1 text-[9px] font-mono text-white/30 hover:text-lime-400 border border-white/10 rounded-md hover:border-lime-400/30 transition-colors">
                    {pct}%
                  </button>
                ))}
              </div>
            ) : null}
            <div className="text-[9px] font-mono text-white/20">
              {side === 'buy' ? `Balance: ${fmt(suiBalance, 3)} SUI` : `Balance: ${fmt(tokenBalance, 0)} $${symbol}`}
            </div>
          </div>

          {/* Quote */}
          {quote && (
            <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-1.5">
              {side === 'buy' ? (
                <>
                  <div className="flex justify-between text-[10px] font-mono">
                    <span className="text-white/35">{t(lang, 'youReceive')}</span>
                    <span className="text-white">{fmt(Number(quote.tokensOut) / 1e6, 0)} ${symbol}</span>
                  </div>
                  <div className="flex justify-between text-[10px] font-mono">
                    <span className="text-white/35">{t(lang, 'priceImpact')}</span>
                    <span className={Number(quote.priceImpact) > 5 ? 'text-red-400' : 'text-white/50'}>
                      {Number(quote.priceImpact).toFixed(2)}%
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex justify-between text-[10px] font-mono">
                    <span className="text-white/35">{t(lang, 'youReceive')}</span>
                    <span className="text-white">{fmt(Number(quote.suiOut) / 1e9, 4)} SUI</span>
                  </div>
                  <div className="flex justify-between text-[10px] font-mono">
                    <span className="text-white/35">{t(lang, 'priceImpact')}</span>
                    <span className={Number(quote.priceImpact) > 5 ? 'text-red-400' : 'text-white/50'}>
                      {Number(quote.priceImpact).toFixed(2)}%
                    </span>
                  </div>
                </>
              )}
              <div className="flex justify-between text-[10px] font-mono">
                <span className="text-white/35">{t(lang, 'fee')}</span>
                <span className="text-white/50">1%</span>
              </div>
            </div>
          )}

          {/* Execute button */}
          <button
            onClick={onExecute}
            disabled={!account || isPending || !amount || parseFloat(amount) <= 0}
            className={`w-full py-3 rounded-xl text-sm font-mono font-bold transition-colors ${
              !account || isPending || !amount || parseFloat(amount) <= 0
                ? 'bg-white/5 text-white/20 cursor-not-allowed'
                : side === 'buy'
                  ? 'bg-lime-400 text-black hover:bg-lime-300'
                  : 'bg-red-500 text-white hover:bg-red-400'
            }`}
          >
            {isPending ? '⏳ …' : !account ? 'Connect wallet' : side === 'buy' ? t(lang, 'buy') : t(lang, 'sell')}
          </button>

          {/* TX status */}
          {txStatus && txMsg && (
            <div className={`text-[10px] font-mono text-center py-1 ${
              txStatus === 'success' ? 'text-lime-400' : txStatus === 'error' ? 'text-red-400' : 'text-white/40'
            }`}>
              {txMsg}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Trades / Holders toggle block ─────────────────────────────────────────────

function TradesHoldersBlock({ curveId, tokenType, suiUsd, lang, creator }) {
  const [tab, setTab] = useState('trades');
  return (
    <div className="space-y-0">
      <div className="flex bg-white/[0.03] border border-white/10 rounded-t-xl overflow-hidden">
        <button onClick={() => setTab('trades')}
          className={`flex-1 py-3 text-xs font-mono font-bold tracking-wider transition-colors ${tab === 'trades' ? 'text-lime-400 bg-lime-400/5 border-b-2 border-lime-400' : 'text-white/40 hover:text-white/70'}`}>
          TRADES
        </button>
        <button onClick={() => setTab('holders')}
          className={`flex-1 py-3 text-xs font-mono font-bold tracking-wider transition-colors ${tab === 'holders' ? 'text-lime-400 bg-lime-400/5 border-b-2 border-lime-400' : 'text-white/40 hover:text-white/70'}`}>
          {t(lang, 'holders')}
        </button>
      </div>
      <div className="[&>div]:rounded-t-none [&>div]:border-t-0">
        {tab === 'trades'
          ? <TradeHistory curveId={curveId} suiUsd={suiUsd} />
          : <HolderList curveId={curveId} tokenType={tokenType} suiUsd={suiUsd} creator={creator} />
        }
      </div>
    </div>
  );
}

// ── Comments wrapper ──────────────────────────────────────────────────────────

function CommentsBlock({ curveId, lang }) {
  return (
    <div>
      <div className="text-[10px] font-mono text-white/35 tracking-widest mb-2">{t(lang, 'comments')}</div>
      <Comments curveId={curveId} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TokenPage({ curveId, tokenType, packageId: packageIdHint, onBack, lang = 'en' }) {
  const navigate = useNavigate();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const [suiUsd, setSuiUsd]               = useState(0);
  const [curveState, setCurveState]       = useState(null);
  const [metadata, setMetadata]           = useState(null);
  const [iconUrl, setIconUrl]             = useState(null);
  const [curveCreatedData, setCurveCreatedData] = useState(null);

  const [suiBalance, setSuiBalance]       = useState(0);
  const [tokenBalance, setTokenBalance]   = useState(0);
  const [side, setSide]                   = useState('buy');
  const [amount, setAmount]               = useState('');
  const [slippage, setSlippage]           = useState('1');
  const [txStatus, setTxStatus]           = useState(null);
  const [txMsg, setTxMsg]                 = useState('');
  const [copied, setCopied]               = useState(false);
  const [shared, setShared]               = useState(false);
  const [linkCopied, setLinkCopied]       = useState(false);

  // ── data loading ──────────────────────────────────────────────────────────

  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const timer = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!curveId || !client) return;
    let cancelled = false;
    async function load() {
      try {
        const obj = await client.getObject({ id: curveId, options: { showContent: true } });
        if (!cancelled) setCurveState(obj.data?.content?.fields ?? null);
      } catch {}
    }
    load();
    const timer = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [curveId, client]);

  useEffect(() => {
    if (!tokenType) return;
    let cancelled = false;
    const pkgId = getTokenPackageId(tokenType);

    client.getCoinMetadata({ coinType: tokenType })
      .then(m => {
        if (!cancelled) {
          setMetadata(m);
          const icon = m?.iconUrl;
          if (icon && !isPlaceholderIcon(icon)) setIconUrl(icon);
        }
      }).catch(() => {});

    // Fetch CurveCreated event — try all package IDs
    (async () => {
      try {
        const packageIds = [pkgId, PACKAGE_ID_V5, PACKAGE_ID_V4].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
        let found = null;
        for (const pid of packageIds) {
          if (found) break;
          let cursor = null;
          for (let page = 0; page < 10 && !found; page++) {
            const res = await client.queryEvents({
              query: { MoveEventType: `${pid}::bonding_curve::CurveCreated` },
              limit: 50,
              cursor: cursor || undefined,
            });
            found = res.data?.find(e => e.parsedJson?.curve_id === curveId);
            if (!res.hasNextPage) break;
            cursor = res.nextCursor;
          }
        }
        if (found?.parsedJson && !cancelled) setCurveCreatedData(found.parsedJson);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [tokenType, client, curveId]);

  useEffect(() => {
    if (!account || !client) return;
    let cancelled = false;
    async function loadBalances() {
      try {
        const sui = await client.getBalance({ owner: account.address, coinType: '0x2::sui::SUI' });
        if (!cancelled) setSuiBalance(Number(sui.totalBalance) / 1e9);
        if (tokenType) {
          const tok = await client.getBalance({ owner: account.address, coinType: tokenType });
          if (!cancelled) setTokenBalance(Number(tok.totalBalance) / 10 ** TOKEN_DECIMALS);
        }
      } catch {}
    }
    loadBalances();
    const timer = setInterval(loadBalances, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [account, client, tokenType]);

  // ── derived state ─────────────────────────────────────────────────────────

  const pkgId          = resolvePackageId(tokenType, packageIdHint);
  const isV5Token      = isV5OrLater(pkgId);
  const vSui           = isV5Token ? VIRTUAL_SUI_V5    : VIRTUAL_SUI_V4;
  const vTok           = isV5Token ? VIRTUAL_TOKENS_V5 : VIRTUAL_TOKENS_V4;
  const drainSui       = isV5Token ? DRAIN_SUI_V5      : DRAIN_SUI_V4;
  const reserveMist    = curveState ? BigInt(curveState.sui_reserve) : 0n;
  const tokensRemaining = curveState ? BigInt(curveState.token_reserve) : 0n;
  const tokensSold     = BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokensRemaining;
  const progress       = Math.min(100, (mistToSui(reserveMist) / drainSui) * 100);
  const priceMist      = curveState ? priceMistPerToken(reserveMist, tokensSold, vSui, vTok) : 0n;
  const priceSui       = Number(priceMist) / 1e9;
  const priceUsd       = priceSui * suiUsd;
  const marketCapSui   = priceSui * TOTAL_SUPPLY_WHOLE;
  const graduated      = curveState?.graduated ?? false;
  const creatorFeesMist = curveState ? BigInt(curveState.creator_fees ?? 0) : 0n;
  const creatorAddr     = curveState?.creator ?? null;

  // Apply localStorage overrides (testnet only — v7 will be on-chain)
  const _metaOverride = (() => {
    try { return JSON.parse(localStorage.getItem(`suipump_meta_${curveId}`) || '{}'); }
    catch { return {}; }
  })();
  const _linksOverride = (() => {
    try { return JSON.parse(localStorage.getItem(`suipump_links_${curveId}`) || '{}'); }
    catch { return {}; }
  })();

  const name   = _metaOverride.name   || curveCreatedData?.name   || metadata?.name   || '';
  const symbol = _metaOverride.symbol || curveCreatedData?.symbol || metadata?.symbol || '';

  const _rawDesc = (_metaOverride.description || _linksOverride.desc || metadata?.description || '').trim();
  const rawDesc  = isPlaceholderDesc(_rawDesc) ? '' : _rawDesc;
  const _parsed  = parseDescription(rawDesc);
  const desc     = _parsed.desc;
  const twitter  = _linksOverride.twitter  || _parsed.twitter;
  const telegram = _linksOverride.telegram || _parsed.telegram;
  const website  = _linksOverride.website  || _parsed.website;
  const dex      = _linksOverride.dex      || _parsed.dex;

  // Override iconUrl from localStorage if set
  const _overrideIcon = _metaOverride.iconUrl || null;

  // Creator check — query CreatorCap from both packages
  const [isCreator, setIsCreator] = React.useState(false);
  React.useEffect(() => {
    if (!account?.address || !curveId || !client) { setIsCreator(false); return; }
    let cancelled = false;
    const checkPkg = async (pid) => {
      const res = await client.getOwnedObjects({
        owner: account.address,
        filter: { StructType: `${pid}::bonding_curve::CreatorCap` },
        options: { showContent: true },
      });
      return res.data?.some(o => o.data?.content?.fields?.curve_id === curveId);
    };
    Promise.all([
      checkPkg(PACKAGE_ID_V4),
      ...(PACKAGE_ID_V5 ? [checkPkg(PACKAGE_ID_V5)] : []),
      ...(PACKAGE_ID_V6 ? [checkPkg(PACKAGE_ID_V6)] : []),
    ]).then(results => {
      if (!cancelled) setIsCreator(results.some(Boolean));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [account?.address, curveId, client]);

  // ── actions ───────────────────────────────────────────────────────────────

  const handleCopy = () => {
    if (curveId) { navigator.clipboard.writeText(curveId); setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };

  const handleShare = () => {
    const url = `${window.location.origin}/token/${curveId}`;
    if (navigator.share) {
      navigator.share({ title: `${name} ($${symbol}) on SuiPump`, url });
    } else {
      navigator.clipboard.writeText(url);
    }
    setShared(true);
    setTimeout(() => setShared(false), 1500);
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/token/${curveId}`);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
  };

  const quoteTrade = useCallback(() => {
    if (!amount || parseFloat(amount) <= 0 || !curveState) return null;
    try {
      if (side === 'buy') {
        const suiIn = BigInt(Math.floor(parseFloat(amount) * Number(MIST_PER_SUI)));
        return buyQuote(reserveMist, tokensRemaining, suiIn, vSui, vTok);
      } else {
        const tokIn = BigInt(Math.floor(parseFloat(amount) * 10 ** TOKEN_DECIMALS));
        return sellQuote(reserveMist, tokensRemaining, tokIn, vSui, vTok);
      }
    } catch { return null; }
  }, [amount, side, curveState, reserveMist, tokensRemaining, vSui, vTok]);

  const executeTrade = useCallback(async () => {
    if (!account || !curveState || !curveId || !tokenType) return;
    const amtFloat = parseFloat(amount);
    if (!amtFloat || amtFloat <= 0) return;
    // Must know which package this token belongs to before firing tx
    if (!pkgId) return;

    setTxStatus('pending');
    setTxMsg('');

    try {
      const objForRef = await client.getObject({ id: curveId, options: { showOwner: true } });
      const initialSharedVersion = objForRef.data?.owner?.Shared?.initial_shared_version;
      const tx = new Transaction();
      const curveRef = initialSharedVersion
        ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion, mutable: true })
        : tx.object(curveId);

      const slippageNum = parseFloat(slippage) || 0;
      const isV5 = isV5OrLater(pkgId);

      if (side === 'buy') {
        const suiInMist = BigInt(Math.floor(amtFloat * Number(MIST_PER_SUI)));
        const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiInMist)]);
        const quote = buyQuote(reserveMist, tokensRemaining, suiInMist, vSui, vTok);
        const minOut = quote?.tokensOut != null
          ? BigInt(Math.floor(Number(quote.tokensOut) * (1 - slippageNum / 100)))
          : 0n;

        const buyArgs = isV5
          ? [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', null), tx.object(SUI_CLOCK_ID)]
          : [curveRef, payment, tx.pure.u64(minOut)];

        const [tokens, refund] = tx.moveCall({
          target: `${pkgId}::bonding_curve::buy`,
          typeArguments: [tokenType],
          arguments: buyArgs,
        });
        tx.transferObjects([tokens, refund], account.address);
      } else {
        const tokInAtomic = BigInt(Math.floor(amtFloat * 10 ** TOKEN_DECIMALS));
        const coins = await client.getCoins({ owner: account.address, coinType: tokenType });
        const coinObjs = coins.data.map(c => tx.object(c.coinObjectId));
        let tokenCoin;
        if (coinObjs.length === 0) throw new Error('No token balance');
        if (coinObjs.length === 1) {
          [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(tokInAtomic)]);
        } else {
          tx.mergeCoins(coinObjs[0], coinObjs.slice(1));
          [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(tokInAtomic)]);
        }
        const quote = sellQuote(reserveMist, tokensRemaining, tokInAtomic, vSui, vTok);
        const minOut = quote?.suiOut != null
          ? BigInt(Math.floor(Number(quote.suiOut) * (1 - slippageNum / 100)))
          : 0n;
        const [suiOut] = tx.moveCall({
          target: `${pkgId}::bonding_curve::sell`,
          typeArguments: [tokenType],
          arguments: [curveRef, tokenCoin, tx.pure.u64(minOut)],
        });
        tx.transferObjects([suiOut], account.address);
      }

      signAndExecute(
        { transaction: tx },
        {
          onSuccess: () => {
            setTxStatus('success');
            setTxMsg(side === 'buy' ? 'Buy successful! 🎉' : 'Sell successful!');
            setAmount('');
            setTimeout(() => { setTxStatus(null); setTxMsg(''); }, 3000);
          },
          onError: (err) => {
            setTxStatus('error');
            setTxMsg(err.message || 'Transaction failed');
            setTimeout(() => { setTxStatus(null); setTxMsg(''); }, 4000);
          },
        }
      );
    } catch (err) {
      setTxStatus('error');
      setTxMsg(err.message || 'Transaction failed');
      setTimeout(() => { setTxStatus(null); setTxMsg(''); }, 4000);
    }
  }, [account, curveState, curveId, tokenType, side, amount, slippage, client, signAndExecute, reserveMist, tokensRemaining, pkgId, vSui, vTok]);

  const quote = quoteTrade();

  // ── render ────────────────────────────────────────────────────────────────
  const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  return (
    <div className="min-h-screen" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      {/* Back */}
      <button
        onClick={onBack || (() => navigate('/'))}
        className="flex items-center gap-2 text-white/50 hover:text-lime-400 transition-colors text-xs font-mono mb-4 group"
      >
        <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
        {t(lang, 'backToHome')}
      </button>

      {/* Graduation banner */}
      {graduated && (
        <div className="mb-4 px-4 py-3 bg-lime-400/10 border border-lime-400/30 rounded-xl text-xs font-mono text-lime-400 flex items-center justify-between">
          <span>🎓 {t(lang, 'graduationComplete')}</span>
          <a href="https://app.cetus.zone" target="_blank" rel="noreferrer"
            className="flex items-center gap-1 text-lime-400 hover:text-lime-300 underline">
            {t(lang, 'viewOnCetus')} <ExternalLink size={10} />
          </a>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* Left column */}
        <div className="space-y-4">
          {/* Token header */}
          <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4">
            <div className="flex items-start gap-3">
              {/* Icon */}
              <div className="w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 bg-white/5 flex items-center justify-center text-xl">
                {(_overrideIcon || iconUrl) ? (
                  <img src={_overrideIcon || iconUrl} alt={symbol} className="w-full h-full object-cover"
                    onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='flex'; }} />
                ) : null}
                <span style={{ display: (_overrideIcon || iconUrl) ? 'none' : 'flex' }} className="text-2xl items-center justify-center w-full h-full">🔥</span>
              </div>

              {/* Name + CA + social */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-white font-bold text-lg">{name}</h1>
                  <span className="text-lime-400 text-sm font-mono">${symbol}</span>
                </div>

                {/* Contract address row */}
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span className="text-white/35 text-[10px] font-mono truncate max-w-[180px]">
                    {curveId ? `${curveId.slice(0, 6)}...${curveId.slice(-4)}` : ''}
                  </span>
                  <button onClick={handleCopy}
                    className="text-white/35 hover:text-lime-400 transition-colors flex items-center gap-1 text-[10px] font-mono">
                    {copied ? <Check size={10} /> : <Copy size={10} />}
                    {copied ? t(lang, 'copied') : t(lang, 'copyCA')}
                  </button>
                  <button onClick={handleShare}
                    className="text-white/35 hover:text-lime-400 transition-colors flex items-center gap-1 text-[10px] font-mono">
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                    {shared ? t(lang, 'share') + '!' : t(lang, 'share')}
                  </button>
                  <button onClick={handleCopyLink}
                    className="text-white/35 hover:text-lime-400 transition-colors flex items-center gap-1 text-[10px] font-mono">
                    {linkCopied ? <Check size={10} /> : <Share2 size={10} />}
                    {linkCopied ? 'COPIED!' : 'SHARE LINK'}
                  </button>
                </div>

                {/* Social links */}
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  {twitter && (
                    <a href={twitter.startsWith('http') ? twitter : `https://${twitter}`}
                      target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 text-[10px] font-mono text-white/35 hover:text-lime-400 transition-colors">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                      Twitter
                    </a>
                  )}
                  {telegram && (
                    <a href={telegram.startsWith('http') ? telegram : `https://${telegram}`}
                      target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 text-[10px] font-mono text-white/35 hover:text-lime-400 transition-colors">
                      <ExternalLink size={9} /> Telegram
                    </a>
                  )}
                  {website && (
                    <a href={website.startsWith('http') ? website : `https://${website}`}
                      target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 text-[10px] font-mono text-white/35 hover:text-lime-400 transition-colors">
                      <ExternalLink size={9} /> Website
                    </a>
                  )}
                </div>
              </div>

              {/* Price + mcap */}
              <div className="text-right shrink-0">
                <div className="text-white text-sm font-mono font-bold">
                  {suiUsd > 0 ? `$${priceUsd.toFixed(6)}` : `${fmt(priceSui, 6)} SUI`}
                </div>
                <div className="text-white/35 text-[10px] font-mono">{t(lang, 'price')}</div>
                <div className="text-white/70 text-xs font-mono mt-1">
                  {suiUsd > 0 ? fmtUsd(marketCapSui, suiUsd) : `${fmt(marketCapSui)} SUI`}
                </div>
                <div className="text-white/35 text-[10px] font-mono">{t(lang, 'mcap')}</div>
              </div>
            </div>

            {/* Description */}
            {desc && (
              <p className="mt-3 text-xs font-mono text-white/40 leading-relaxed">{desc}</p>
            )}

            {/* Progress bar */}
            <div className="mt-4">
              <div className="flex justify-between text-[10px] font-mono text-white/35 mb-1.5">
                <span>{t(lang, 'bondingCurveProgress')}</span>
                <span className="text-lime-400">{progress.toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-lime-600 to-lime-400 rounded-full transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono text-white/25 mt-1">
                <span>{fmt(mistToSui(reserveMist))} {t(lang, 'suiRaised')}</span>
                <span>{fmt(drainSui)} {t(lang, 'suiTarget')}</span>
              </div>
            </div>

            {/* Graduation target badge */}
            {!graduated && (
              <div className="mt-3 flex items-center gap-1.5">
                <span className="text-[8px] font-mono text-white/20 tracking-widest">GRADUATES TO</span>
                <span className={`text-[9px] font-mono px-2 py-0.5 rounded-full border ${
                  dex === 'deepbook'
                    ? 'border-blue-400/30 text-blue-400/70 bg-blue-400/5'
                    : 'border-lime-400/30 text-lime-400/70 bg-lime-400/5'
                }`}>
                  {dex === 'deepbook' ? '⚡ DeepBook' : '🌊 Cetus'}
                </span>
              </div>
            )}
          </div>

          {/* Chart */}
          <PriceChart curveId={curveId} tokenType={tokenType} suiUsd={suiUsd} />

          {/* Trades / Holders */}
          <TradesHoldersBlock curveId={curveId} tokenType={tokenType} suiUsd={suiUsd} lang={lang} creator={creatorAddr} />

          {/* AI Analysis */}
          <AIAnalysis
            curveId={curveId}
            name={name}
            symbol={symbol}
            progress={progress}
            reserveSui={mistToSui(reserveMist)}
            creatorFeesSui={Number(creatorFeesMist) / 1e9}
            graduated={graduated}
            tokensSoldWhole={Number(tokensSold) / 10 ** TOKEN_DECIMALS}
          />

          {/* Comments */}
          <CommentsBlock curveId={curveId} lang={lang} />
        </div>

        {/* Right column */}
        <div className="space-y-4">
          <TradePanelContent
            lang={lang}
            side={side} setSide={setSide}
            amount={amount} setAmount={setAmount}
            slippage={slippage} setSlippage={setSlippage}
            quote={quote}
            txStatus={txStatus} txMsg={txMsg}
            account={account}
            onExecute={executeTrade}
            priceSui={priceSui} priceUsd={priceUsd} suiUsd={suiUsd}
            symbol={symbol}
            graduated={graduated}
            suiBalance={suiBalance} tokenBalance={tokenBalance}
            isCreator={isCreator} creatorFeesMist={creatorFeesMist}
            curveId={curveId} tokenType={tokenType}
            packageIdHint={pkgId}
            curveState={curveState}
          />

          {/* Creator Tools — visible to creator only */}
          {isCreator && (
            <CreatorToolsPanel
              curveId={curveId}
              tokenType={tokenType}
              packageIdHint={pkgId}
              account={account}
              curveState={curveState}
              currentDesc={desc}
              currentTwitter={twitter}
              currentTelegram={telegram}
              currentWebsite={website}
              currentDex={dex}
              lang={lang}
            />
          )}
        </div>
      </div>

      {/* Back to top — mobile only */}
      <div className="sm:hidden fixed bottom-6 right-4 z-50">
        <button
          onClick={scrollToTop}
          className="bg-white/10 hover:bg-white/20 border border-white/20 rounded-full p-3 text-white/60 hover:text-white transition-colors backdrop-blur-sm"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="18 15 12 9 6 15"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
