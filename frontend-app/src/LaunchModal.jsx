// LaunchModal.jsx
import React, { useState, useCallback } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { X, Plus, Trash2, ExternalLink, Rocket, CheckCircle } from 'lucide-react';
import wasmInit, * as bytecodeTemplate from '@mysten/move-bytecode-template';
import { PACKAGE_ID, MIST_PER_SUI } from './constants.js';
import { t } from './i18n.js';

const LAUNCH_FEE_MIST = 2_000_000_000n;
const TEMPLATE_URL = '/template.mv';
const MAX_DESCRIPTION_CHARS = 500;

let wasmReady = false;
async function ensureWasm() {
  if (!wasmReady) { await wasmInit(); wasmReady = true; }
}

function uleb128(n) {
  const bytes = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return bytes;
}

function bcsBytes(str) {
  const buf = new TextEncoder().encode(str);
  const lenBytes = uleb128(buf.length);
  const out = new Uint8Array(lenBytes.length + buf.length);
  out.set(lenBytes, 0);
  out.set(buf, lenBytes.length);
  return out;
}

function bcsVectorAddress(addrs) {
  const out = [addrs.length];
  for (const a of addrs) {
    const hex = a.replace('0x', '').padStart(64, '0');
    for (let i = 0; i < 64; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return new Uint8Array(out);
}

function bcsVectorU64(nums) {
  const buf = new DataView(new ArrayBuffer(1 + nums.length * 8));
  buf.setUint8(0, nums.length);
  nums.forEach((n, i) => buf.setBigUint64(1 + i * 8, BigInt(n), true));
  return new Uint8Array(buf.buffer);
}

function encodeDescription(desc, links) {
  const hasLinks = links.telegram || links.twitter || links.website;
  if (!hasLinks) return desc;
  const linksObj = {};
  if (links.telegram) linksObj.telegram = links.telegram.trim();
  if (links.twitter) linksObj.twitter = links.twitter.trim();
  if (links.website) linksObj.website = links.website.trim();
  return `${desc}||${JSON.stringify(linksObj)}`;
}

const STEPS = [
  { id: 'details', labelKey: 'details' },
  { id: 'payouts', labelKey: 'payouts' },
  { id: 'devbuy',  labelKey: 'devBuy' },
  { id: 'launch',  labelKey: 'review' },
];

function TokenPreview({ name, symbol, iconUrl }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-[9px] font-mono text-white/20 tracking-widest mb-3">PREVIEW</div>
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-full border-2 border-white/10 flex items-center justify-center bg-lime-950/30 overflow-hidden shrink-0">
          {iconUrl
            ? <img src={iconUrl} alt="icon" className="w-full h-full object-cover" onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='block'; }} />
            : null}
          <span className="text-2xl" style={{ display: iconUrl ? 'none' : 'block' }}>🔥</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-white font-mono truncate">{name || 'Token Name'}</div>
          <div className="text-xs text-lime-400/70 font-mono">${symbol || 'SYMBOL'}</div>
        </div>
        <div className="text-right">
          <div className="text-[9px] text-white/20 font-mono">BONDING CURVE</div>
          <div className="text-xs text-white/40 font-mono">0.0%</div>
        </div>
      </div>
      <div className="mt-3 h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div className="h-full w-0 bg-gradient-to-r from-lime-600 to-lime-400 rounded-full" />
      </div>
    </div>
  );
}

export default function LaunchModal({ onClose, onLaunched, lang = 'en' }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    name: '', symbol: '', description: '', iconUrl: '',
    uploading: false, uploadError: null,
    telegram: '', twitter: '', website: '',
  });
  const [payouts, setPayouts] = useState([{ address: account?.address ?? '', bps: 10000 }]);
  const [devBuy, setDevBuy] = useState('');
  const [launching, setLaunching] = useState(false);
  const [txStep, setTxStep] = useState(null);
  const [tx1Digest, setTx1Digest] = useState(null);
  const [tx2Digest, setTx2Digest] = useState(null);
  const [error, setError] = useState(null);
  const [newCurveId, setNewCurveId] = useState(null);

  const symbolValid = /^[A-Z][A-Z0-9]{0,4}$/.test(form.symbol);
  const nameValid = form.name.trim().length >= 2 && form.name.trim().length <= 64;
  const descBytes = new TextEncoder().encode(form.description).length;
  const payoutSum = payouts.reduce((s, p) => s + (parseInt(p.bps) || 0), 0);
  const payoutsValid = payouts.length >= 1 && payouts.length <= 10 && payoutSum === 10000
    && payouts.every(p => p.address.startsWith('0x') && p.address.length === 66);

  const canNext = [nameValid && symbolValid, payoutsValid, true, true][step];

  const addPayout = () => {
    if (payouts.length >= 10) return;
    const remaining = 10000 - payouts.slice(0, -1).reduce((s, p) => s + (parseInt(p.bps) || 0), 0);
    setPayouts([...payouts, { address: '', bps: remaining }]);
  };
  const removePayout = (i) => { if (payouts.length > 1) setPayouts(payouts.filter((_, idx) => idx !== i)); };
  const updatePayout = (i, field, value) => {
    const next = [...payouts];
    next[i] = { ...next[i], [field]: field === 'bps' ? (parseInt(value) || 0) : value };
    setPayouts(next);
  };

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setForm(f => ({ ...f, uploading: true, uploadError: null }));
    try {
      const fd = new FormData();
      fd.append('image', file);
      const res = await fetch('https://api.imgur.com/3/image', {
        method: 'POST',
        headers: { Authorization: 'Client-ID 546c25a59c58ad7' },
        body: fd,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.data?.error || 'Upload failed');
      setForm(f => ({ ...f, iconUrl: json.data.link, uploading: false }));
    } catch (err) {
      setForm(f => ({ ...f, uploadError: err.message, uploading: false }));
    }
  };

  const handleLaunch = useCallback(async () => {
    if (!account || launching) return;
    setLaunching(true);
    setError(null);
    setTxStep('tx1');

    try {
      await ensureWasm();

      const templateBytes = await fetch(TEMPLATE_URL).then(r => r.arrayBuffer()).then(b => new Uint8Array(b));

      const tokenName = form.name.trim();
      const tokenSymbol = form.symbol.trim().toUpperCase();
      const descWithLinks = encodeDescription(form.description.trim(), {
        telegram: form.telegram, twitter: form.twitter, website: form.website,
      });

      const sym = String(tokenSymbol);
      const patched = bytecodeTemplate.update_identifiers(
        bytecodeTemplate.update_constants(
          templateBytes,
          [bcsBytes(tokenName), bcsBytes(sym), bcsBytes(descWithLinks)],
          [bcsBytes('TEMPLATE_NAME'), bcsBytes('TMPL'), bcsBytes('template description')],
          ['String', 'String', 'String'],
        ),
        { TEMPLATE: sym, template: sym.toLowerCase() },
      );

      const tx1 = new Transaction();
      const [upgradeCap] = tx1.publish({ modules: [[...patched]], dependencies: ['0x1', '0x2'] });
      tx1.transferObjects([upgradeCap], account.address);

      const res1raw = await signAndExecute({ transaction: tx1 });
      setTx1Digest(res1raw.digest);

      const res1 = await client.waitForTransaction({
        digest: res1raw.digest,
        options: { showEffects: true, showObjectChanges: true },
      });
      if (res1.effects.status.status !== 'success') throw new Error('Tx1 failed: ' + res1.effects.status.error);

      const createdObjs = res1.objectChanges?.filter(c => c.type === 'created') ?? [];
      const treasuryCapObj = createdObjs.find(o => o.objectType?.includes('TreasuryCap'));
      if (!treasuryCapObj) throw new Error('TreasuryCap not found in Tx1 output');

      const treasuryCapId = treasuryCapObj.objectId;
      const newTokenType = treasuryCapObj.objectType.match(/<(.+)>/)?.[1];
      if (!newTokenType) throw new Error('Could not parse token type');

      setTxStep('tx2');

      const tx2 = new Transaction();
      const [launchFeeCoin] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(LAUNCH_FEE_MIST)]);

      const payoutAddrs = payouts.map(p => p.address);
      const payoutBps = payouts.map(p => parseInt(p.bps));
      const [curve, cap] = tx2.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::create_and_return`,
        typeArguments: [newTokenType],
        arguments: [
          tx2.object(treasuryCapId),
          launchFeeCoin,
          tx2.pure.string(tokenName),
          tx2.pure.string(tokenSymbol),
          tx2.pure(bcsVectorAddress(payoutAddrs)),
          tx2.pure(bcsVectorU64(payoutBps)),
        ],
      });

      const devBuyAmount = parseFloat(devBuy);
      if (devBuyAmount > 0) {
        const devBuyMist = BigInt(Math.floor(devBuyAmount * Number(MIST_PER_SUI)));
        const [devPayment] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(devBuyMist)]);
        const [tokens, refund] = tx2.moveCall({
          target: `${PACKAGE_ID}::bonding_curve::buy`,
          typeArguments: [newTokenType],
          arguments: [curve, devPayment, tx2.pure.u64(0)],
        });
        tx2.transferObjects([tokens, refund], account.address);
      }

      tx2.moveCall({ target: `${PACKAGE_ID}::bonding_curve::share_curve`, typeArguments: [newTokenType], arguments: [curve] });
      tx2.transferObjects([cap], account.address);

      const res2raw = await signAndExecute({ transaction: tx2 });
      const res2 = await client.waitForTransaction({
        digest: res2raw.digest,
        options: { showEffects: true, showObjectChanges: true, showEvents: true },
      });
      if (res2.effects.status.status !== 'success') throw new Error('Tx2 failed: ' + res2.effects.status.error);
      setTx2Digest(res2raw.digest);

      const curveEvent = res2.events?.find(e => e.type?.includes('CurveCreated'));
      const curveId = curveEvent?.parsedJson?.curve_id;
      setNewCurveId(curveId);
      setTxStep('done');
      if (onLaunched) onLaunched({ curveId, tokenType: newTokenType, name: tokenName, symbol: tokenSymbol });
    } catch (err) {
      setError(err.message || String(err));
      setTxStep(null);
    } finally {
      setLaunching(false);
    }
  }, [form, payouts, devBuy, account, client, signAndExecute, onLaunched]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4">
      <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#0a0a0a] font-mono shadow-2xl shadow-black/50 overflow-hidden max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <div>
            <div className="text-[9px] tracking-widest text-white/20">SUIPUMP</div>
            <div className="text-lg font-bold text-white">{t(lang, 'launchATokenTitle')}</div>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white transition-colors rounded-xl p-1.5 hover:bg-white/5">
            <X size={18} />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex px-6 pt-5 gap-2">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex-1 flex flex-col items-center gap-1.5">
              <div className={`w-full h-1 rounded-full transition-all duration-300 ${
                i < step ? 'bg-lime-400' : i === step ? 'bg-lime-400/60' : 'bg-white/10'
              }`} />
              <div className={`text-[9px] font-mono tracking-widest transition-colors ${
                i === step ? 'text-lime-400' : i < step ? 'text-lime-400/50' : 'text-white/20'
              }`}>
                {i < step ? '✓' : t(lang, s.labelKey).toUpperCase()}
              </div>
            </div>
          ))}
        </div>

        <div className="px-6 py-5 space-y-4 min-h-[320px]">

          {/* Step 0: Token details + social links */}
          {step === 0 && (
            <div className="space-y-4">
              <TokenPreview name={form.name} symbol={form.symbol} iconUrl={form.iconUrl} />

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">{t(lang, 'tokenName')} *</label>
                  <input
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    placeholder="Moon Coin"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">{t(lang, 'symbol')} *</label>
                  <input
                    value={form.symbol}
                    onChange={e => setForm({ ...form, symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) })}
                    placeholder="MOON"
                    className={`w-full bg-white/5 border rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none transition-colors ${
                      form.symbol && !symbolValid ? 'border-red-500/50 focus:border-red-400' : 'border-white/10 focus:border-lime-400/50'
                    }`}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-[9px] tracking-widest text-white/30">{t(lang, 'description')}</label>
                  <span className={`text-[9px] font-mono ${
                    form.description.length > MAX_DESCRIPTION_CHARS * 0.9
                      ? form.description.length >= MAX_DESCRIPTION_CHARS ? 'text-red-400' : 'text-lime-400'
                      : 'text-white/20'
                  }`}>
                    {form.description.length}/{MAX_DESCRIPTION_CHARS}
                  </span>
                </div>
                <textarea
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value.slice(0, MAX_DESCRIPTION_CHARS) })}
                  placeholder={'Describe your token…'}
                  rows={3}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors resize-none"
                />
              </div>

              {/* Icon URL */}
              <div>
                <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">{t(lang, 'iconUrl')}</label>
                <div className="flex gap-2">
                  <input
                    value={form.iconUrl}
                    onChange={e => setForm({ ...form, iconUrl: e.target.value })}
                    placeholder="https://i.imgur.com/..."
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors"
                  />
                  <label className="shrink-0 px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-[10px] font-mono text-white/50 hover:text-white hover:border-lime-400/30 transition-colors cursor-pointer">
                    {form.uploading ? '…' : '↑'}
                    <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                  </label>
                </div>
                {form.uploadError && <div className="text-[10px] text-red-400 mt-1">{form.uploadError}</div>}
              </div>

              {/* Social links */}
              <div>
                <label className="block text-[9px] tracking-widest text-white/30 mb-2">{t(lang, 'socialLinks')}</label>
                <div className="space-y-2">
                  <input
                    value={form.telegram}
                    onChange={e => setForm({ ...form, telegram: e.target.value })}
                    placeholder={`${'Telegram'} — @handle or https://t.me/...`}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-lime-400/50 transition-colors"
                  />
                  <input
                    value={form.twitter}
                    onChange={e => setForm({ ...form, twitter: e.target.value })}
                    placeholder={`${'Twitter / X'} — @handle or https://x.com/...`}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-lime-400/50 transition-colors"
                  />
                  <input
                    value={form.website}
                    onChange={e => setForm({ ...form, website: e.target.value })}
                    placeholder={`${'Website'} — https://...`}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-lime-400/50 transition-colors"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Payouts */}
          {step === 1 && (
            <div className="space-y-3">
              <div className="text-[10px] text-white/30 leading-relaxed">
                Percentages must sum to 100%. Up to 10 recipients.
              </div>
              {payouts.map((p, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    value={p.address}
                    onChange={e => updatePayout(i, 'address', e.target.value)}
                    placeholder="0x..."
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-xs focus:outline-none focus:border-lime-400/50 min-w-0 transition-colors"
                  />
                  <div className="flex items-center gap-1.5 shrink-0">
                    <input
                      type="number"
                      value={Math.round(p.bps / 100)}
                      onChange={e => updatePayout(i, 'bps', Math.round(parseFloat(e.target.value || 0) * 100))}
                      min={1} max={100}
                      className="w-16 bg-white/5 border border-white/10 rounded-xl px-2 py-2.5 text-white text-xs focus:outline-none focus:border-lime-400/50 text-right transition-colors"
                    />
                    <span className="text-white/30 text-xs">%</span>
                    {payouts.length > 1 && (
                      <button onClick={() => removePayout(i)} className="text-white/20 hover:text-red-400 transition-colors">
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between pt-1">
                <button onClick={addPayout} disabled={payouts.length >= 10}
                  className="flex items-center gap-1 text-[10px] text-white/30 hover:text-lime-400 disabled:opacity-20 transition-colors"
                >
                  <Plus size={10} /> {t(lang, 'addPayout')}
                </button>
                <div className={`text-[10px] font-bold ${payoutSum === 10000 ? 'text-lime-400' : 'text-red-400'}`}>
                  {payoutSum / 100}% {payoutSum !== 10000 ? '≠ 100%' : '✓'}
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Dev buy */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="text-[10px] text-white/30 leading-relaxed">
                {t(lang, 'devBuyHint')}
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-[10px] text-white/30 leading-relaxed">
                {t(lang, 'devBuyWarning')}
              </div>
              <div>
                <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">{t(lang, 'devBuyAmount')}</label>
                <input
                  value={devBuy}
                  onChange={e => setDevBuy(e.target.value)}
                  placeholder="0 — leave blank to skip"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors"
                />
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-2 text-xs font-mono">
                <div className="flex justify-between text-white/30">
                  <span>{t(lang, 'launchFee')}</span><span className="text-white">2 SUI</span>
                </div>
                {devBuy && parseFloat(devBuy) > 0 && (
                  <div className="flex justify-between text-white/30">
                    <span>{t(lang, 'devBuy').toUpperCase()}</span><span className="text-white">{devBuy} SUI</span>
                  </div>
                )}
                <div className="flex justify-between border-t border-white/5 pt-2 text-white/50">
                  <span>{t(lang, 'total')}</span>
                  <span className="text-lime-400 font-bold">
                    {(2 + (parseFloat(devBuy) || 0)).toFixed(4)} SUI
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Review + Launch */}
          {step === 3 && (
            <div className="space-y-4">
              {!txStep && !error && (
                <>
                  <TokenPreview name={form.name} symbol={form.symbol} iconUrl={form.iconUrl} />

                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-2.5 text-xs font-mono">
                    {[
                      { label: 'NAME', value: form.name },
                      { label: 'SYMBOL', value: `$${form.symbol}` },
                      { label: 'DESCRIPTION', value: form.description ? `${form.description.slice(0, 60)}${form.description.length > 60 ? '…' : ''}` : 'None' },
                      { label: 'PAYOUTS', value: `${payouts.length} recipient${payouts.length > 1 ? 's' : ''}` },
                      { label: 'DEV BUY', value: parseFloat(devBuy) > 0 ? `${devBuy} SUI` : 'None' },
                      ...(form.telegram ? [{ label: 'TELEGRAM', value: form.telegram }] : []),
                      ...(form.twitter ? [{ label: 'X / TWITTER', value: form.twitter }] : []),
                      ...(form.website ? [{ label: 'WEBSITE', value: form.website }] : []),
                    ].map(({ label, value }) => (
                      <div key={label} className="flex justify-between">
                        <span className="text-white/30">{label}</span>
                        <span className="text-white truncate ml-4 max-w-[200px]">{value}</span>
                      </div>
                    ))}
                    <div className="flex justify-between border-t border-white/5 pt-2.5">
                      <span className="text-white/30">{t(lang, 'launchFee').toUpperCase()}</span>
                      <span className="text-lime-400 font-bold">2 SUI</span>
                    </div>
                  </div>
                  <div className="text-[10px] text-white/20 text-center">{t(lang, 'twoSignaturesRequired')}</div>
                </>
              )}

              {txStep === 'tx1' && (
                <div className="space-y-4 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full border-2 border-lime-400 border-t-transparent animate-spin" />
                    <div>
                      <div className="text-sm text-white font-bold">{t(lang, 'publishing')}</div>
                      <div className="text-[10px] text-white/30">{t(lang, 'approveInWallet')} — Tx 1 {t(lang, 'of')} 2</div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 h-1.5 bg-lime-400/60 rounded-full animate-pulse" />
                    <div className="flex-1 h-1.5 bg-white/10 rounded-full" />
                  </div>
                </div>
              )}

              {txStep === 'tx2' && (
                <div className="space-y-4 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full border-2 border-lime-400 border-t-transparent animate-spin" />
                    <div>
                      <div className="text-sm text-white font-bold">{t(lang, 'creating')}</div>
                      <div className="text-[10px] text-white/30">{t(lang, 'approveInWallet')} — Tx 2 {t(lang, 'of')} 2</div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 h-1.5 bg-lime-400 rounded-full" />
                    <div className="flex-1 h-1.5 bg-lime-400/60 rounded-full animate-pulse" />
                  </div>
                </div>
              )}

              {txStep === 'done' && (
                <div className="space-y-4 py-4 text-center">
                  <CheckCircle size={40} className="text-lime-400 mx-auto" />
                  <div className="text-lg font-bold text-white">{t(lang, 'success')}</div>
                  {newCurveId && (
                    <>
                      <div className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 flex items-center gap-2">
                        <span className="text-[10px] font-mono text-white/40 flex-1 truncate text-left">
                          suipump.vercel.app/token/{newCurveId.slice(0,8)}…
                        </span>
                        <button
                          onClick={() => navigator.clipboard.writeText(`${window.location.origin}/token/${newCurveId}`)}
                          className="text-[9px] font-mono text-lime-400 hover:text-lime-300 whitespace-nowrap border border-lime-400/30 px-2 py-1 rounded-lg transition-colors"
                        >
                          COPY LINK
                        </button>
                      </div>
                      <button
                        onClick={() => { onClose(); window.location.href = `/token/${newCurveId}`; }}
                        className="w-full py-3 bg-lime-400 text-black font-bold rounded-xl text-sm font-mono hover:bg-lime-300 transition-colors"
                      >
                        {t(lang, 'viewToken')}
                      </button>
                    </>
                  )}
                </div>
              )}

              {error && (
                <div className="rounded-xl border border-red-500/20 bg-red-950/20 p-4 text-xs font-mono text-red-400">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer nav */}
        {!txStep && !error && (
          <div className="px-6 pb-6 flex gap-3">
            {step > 0 && step < 3 && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="flex-1 py-3 rounded-xl border border-white/10 text-sm font-mono text-white/50 hover:text-white hover:border-white/25 transition-colors"
              >
                {t(lang, 'back')}
              </button>
            )}
            {step === 3 && !txStep && (
              <button
                onClick={() => setStep(2)}
                className="flex-1 py-3 rounded-xl border border-white/10 text-sm font-mono text-white/50 hover:text-white hover:border-white/25 transition-colors"
              >
                {t(lang, 'back')}
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={() => canNext && setStep(s => s + 1)}
                disabled={!canNext}
                className={`flex-1 py-3 rounded-xl text-sm font-mono font-bold transition-colors ${
                  canNext
                    ? 'bg-lime-400 text-black hover:bg-lime-300'
                    : 'bg-white/5 text-white/20 cursor-not-allowed'
                }`}
              >
                {t(lang, 'next')}
              </button>
            ) : (
              !txStep && (
                <button
                  onClick={handleLaunch}
                  disabled={!account || launching}
                  className={`flex-1 py-3 rounded-xl text-sm font-mono font-bold transition-colors flex items-center justify-center gap-2 ${
                    !account || launching
                      ? 'bg-white/5 text-white/20 cursor-not-allowed'
                      : 'bg-lime-400 text-black hover:bg-lime-300'
                  }`}
                >
                  <Rocket size={14} />
                  {t(lang, 'launchATokenTitle')}
                </button>
              )
            )}
          </div>
        )}

        {/* Error retry */}
        {error && (
          <div className="px-6 pb-6 flex gap-3">
            <button
              onClick={() => { setError(null); setStep(3); }}
              className="flex-1 py-3 rounded-xl border border-white/10 text-sm font-mono text-white/50 hover:text-white transition-colors"
            >
              {t(lang, 'back')}
            </button>
            <button
              onClick={handleLaunch}
              className="flex-1 py-3 rounded-xl bg-lime-400 text-black font-bold text-sm font-mono hover:bg-lime-300 transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
