// LaunchModal.jsx
import React, { useState, useCallback } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { X, Plus, Trash2, ExternalLink, Rocket, CheckCircle } from 'lucide-react';
import wasmInit, * as bytecodeTemplate from '@mysten/move-bytecode-template';
import { PACKAGE_ID, MIST_PER_SUI } from './constants.js';

const LAUNCH_FEE_MIST = 2_000_000_000n;
const TEMPLATE_URL = '/template.mv';

let wasmReady = false;
async function ensureWasm() {
  if (!wasmReady) { await wasmInit(); wasmReady = true; }
}

function bcsBytes(str) {
  const buf = new TextEncoder().encode(str);
  if (buf.length > 127) throw new Error(`String too long for BCS: ${str}`);
  const out = new Uint8Array(buf.length + 1);
  out[0] = buf.length; out.set(buf, 1); return out;
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

/**
 * Encode social links into the description string.
 * Format: "Human description||{json}"
 * If no links provided, returns plain description.
 */
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
  { id: 'details', label: 'Details' },
  { id: 'payouts', label: 'Payouts' },
  { id: 'devbuy',  label: 'Dev Buy' },
  { id: 'launch',  label: 'Launch' },
];

// Token card preview
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

export default function LaunchModal({ onClose, onLaunched }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    name: '', symbol: '', description: '', iconUrl: '',
    uploading: false, uploadError: null,
    // Social links
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
    next[i] = { ...next[i], [field]: field === 'bps' ? parseInt(value) || 0 : value };
    setPayouts(next);
  };

  const launch = useCallback(async () => {
    setError(null); setLaunching(true);
    try {
      const tokenSymbol = form.symbol.toUpperCase();
      const moduleName = tokenSymbol.toLowerCase();
      const tokenName = form.name.trim();
      const rawDesc = form.description.trim() || `${tokenName} — launched on SuiPump`;
      const tokenDesc = encodeDescription(rawDesc, {
        telegram: form.telegram,
        twitter: form.twitter,
        website: form.website,
      });
      const tokenIcon = form.iconUrl.trim() || 'https://suipump.test/icon-placeholder.png';

      setTxStep('tx1');
      await ensureWasm();
      const templateRes = await fetch(TEMPLATE_URL);
      if (!templateRes.ok) throw new Error('Could not load template bytecode');
      const templateBuf = await templateRes.arrayBuffer();
      let patched = bytecodeTemplate.update_identifiers(new Uint8Array(templateBuf), { 'TEMPLATE': tokenSymbol, 'template': moduleName });
      patched = bytecodeTemplate.update_constants(patched, bcsBytes(tokenSymbol), bcsBytes('TMPL'), 'Vector(U8)');
      patched = bytecodeTemplate.update_constants(patched, bcsBytes(tokenName), bcsBytes('Template Coin'), 'Vector(U8)');
      patched = bytecodeTemplate.update_constants(patched, bcsBytes(tokenDesc), bcsBytes('Template description placeholder that is intentionally long to accommodate real token descriptions.'), 'Vector(U8)');
      patched = bytecodeTemplate.update_constants(patched, bcsBytes(tokenIcon), bcsBytes('https://suipump.test/icon-placeholder.png'), 'Vector(U8)');

      const tx1 = new Transaction();
      const [upgradeCap] = tx1.publish({
        modules: [Array.from(patched)],
        dependencies: [
          '0x0000000000000000000000000000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000000000000000000000000000002',
        ],
      });
      tx1.transferObjects([upgradeCap], account.address);
      const res1raw = await signAndExecute({ transaction: tx1 });
      const res1 = await client.waitForTransaction({ digest: res1raw.digest, options: { showEffects: true, showObjectChanges: true } });
      if (res1.effects.status.status !== 'success') throw new Error('Tx1 failed: ' + res1.effects.status.error);
      setTx1Digest(res1raw.digest);

      const published = res1.objectChanges.find(c => c.type === 'published');
      const newPackageId = published.packageId;
      const newTokenType = `${newPackageId}::${moduleName}::${tokenSymbol}`;
      const treasuryCapObj = res1.objectChanges.find(c => c.type === 'created' && c.objectType?.includes('TreasuryCap'));
      if (!treasuryCapObj) throw new Error('TreasuryCap not found in Tx1 effects');
      const treasuryCapId = treasuryCapObj.objectId;

      await new Promise(r => setTimeout(r, 3000));
      setTxStep('tx2');

      const tx2 = new Transaction();
      const [launchFeeCoin] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(LAUNCH_FEE_MIST)]);
      const payoutAddrs = payouts.map(p => p.address);
      const payoutBps = payouts.map(p => parseInt(p.bps));
      const [curve, cap] = tx2.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::create_and_return`,
        typeArguments: [newTokenType],
        arguments: [tx2.object(treasuryCapId), launchFeeCoin, tx2.pure.string(tokenName), tx2.pure.string(tokenSymbol), tx2.pure(bcsVectorAddress(payoutAddrs)), tx2.pure(bcsVectorU64(payoutBps))],
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
      const res2 = await client.waitForTransaction({ digest: res2raw.digest, options: { showEffects: true, showObjectChanges: true, showEvents: true } });
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
            <div className="text-lg font-bold text-white">LAUNCH A TOKEN</div>
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
                {i < step ? '✓' : s.label.toUpperCase()}
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
                  <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">TOKEN NAME *</label>
                  <input
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    placeholder="Moon Coin"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">SYMBOL *</label>
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
                <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">DESCRIPTION</label>
                <textarea
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                  placeholder="What is this token about?"
                  rows={2}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 resize-none transition-colors"
                />
              </div>

              <div>
                <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">TOKEN ICON</label>
                <div className="flex gap-3 items-center">
                  <label className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border text-[10px] font-mono cursor-pointer transition-all ${
                    form.uploading ? 'border-white/5 text-white/20 cursor-not-allowed' : 'border-white/10 text-white/40 hover:border-lime-400/40 hover:text-lime-400'
                  }`}>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      className="hidden"
                      disabled={form.uploading}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        if (file.size > 5 * 1024 * 1024) { alert('Image must be under 5MB'); return; }
                        setForm(f => ({ ...f, uploading: true, uploadError: null }));
                        try {
                          const data = new FormData();
                          data.append('image', file);
                          const res = await fetch('https://api.imgur.com/3/image', {
                            method: 'POST',
                            headers: { Authorization: 'Client-ID 546c25a59c58ad7' },
                            body: data,
                          });
                          const json = await res.json();
                          if (json.success) {
                            setForm(f => ({ ...f, iconUrl: json.data.link, uploading: false }));
                          } else {
                            throw new Error(json.data?.error || 'Upload failed');
                          }
                        } catch (err) {
                          setForm(f => ({ ...f, uploading: false, uploadError: err.message }));
                        }
                      }}
                    />
                    {form.uploading ? 'UPLOADING…' : '📁 UPLOAD IMAGE'}
                  </label>
                  <input
                    value={form.iconUrl}
                    onChange={e => setForm({ ...form, iconUrl: e.target.value })}
                    placeholder="or paste URL"
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white/60 text-xs focus:outline-none focus:border-lime-400/50 transition-colors"
                  />
                </div>
                {form.uploadError && <div className="text-[10px] text-red-400 mt-1">{form.uploadError}</div>}
              </div>

              {/* Social links */}
              <div>
                <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">SOCIAL LINKS <span className="text-white/15">(OPTIONAL)</span></label>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-white/20 w-20 shrink-0">TELEGRAM</span>
                    <input
                      value={form.telegram}
                      onChange={e => setForm({ ...form, telegram: e.target.value })}
                      placeholder="https://t.me/yourgroup"
                      className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white/60 text-xs focus:outline-none focus:border-lime-400/50 transition-colors"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-white/20 w-20 shrink-0">X / TWITTER</span>
                    <input
                      value={form.twitter}
                      onChange={e => setForm({ ...form, twitter: e.target.value })}
                      placeholder="https://x.com/yourtoken"
                      className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white/60 text-xs focus:outline-none focus:border-lime-400/50 transition-colors"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-white/20 w-20 shrink-0">WEBSITE</span>
                    <input
                      value={form.website}
                      onChange={e => setForm({ ...form, website: e.target.value })}
                      placeholder="https://yourtoken.com"
                      className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white/60 text-xs focus:outline-none focus:border-lime-400/50 transition-colors"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Payouts */}
          {step === 1 && (
            <div className="space-y-3">
              <div className="text-[10px] text-white/30 leading-relaxed">
                Set who receives creator fees. Percentages must sum to 100%. Up to 10 recipients.
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
                  <Plus size={10} /> ADD RECIPIENT
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
                Optional: buy tokens at launch in the same transaction. Leave blank to skip.
              </div>
              <div className="rounded-2xl border border-amber-500/20 bg-amber-950/10 p-3 text-[10px] text-amber-400/70 leading-relaxed">
                ⚠ Large dev buys are permanently visible on-chain and may reduce community trust.
              </div>
              <div>
                <label className="block text-[9px] tracking-widest text-white/30 mb-1.5">DEV BUY AMOUNT (SUI)</label>
                <input
                  value={devBuy}
                  onChange={e => setDevBuy(e.target.value)}
                  placeholder="0 — leave blank to skip"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-lime-400/50 transition-colors"
                />
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-2 text-xs font-mono">
                <div className="flex justify-between text-white/30">
                  <span>LAUNCH FEE</span><span className="text-white">2 SUI</span>
                </div>
                {devBuy && parseFloat(devBuy) > 0 && (
                  <div className="flex justify-between text-white/30">
                    <span>DEV BUY</span><span className="text-white">{devBuy} SUI</span>
                  </div>
                )}
                <div className="flex justify-between border-t border-white/5 pt-2 text-white/50">
                  <span>TOTAL</span>
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
                      <span className="text-white/30">LAUNCH FEE</span>
                      <span className="text-lime-400 font-bold">2 SUI</span>
                    </div>
                  </div>
                  <div className="text-[10px] text-white/20 text-center">Two wallet signatures required</div>
                </>
              )}

              {txStep === 'tx1' && (
                <div className="space-y-4 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full border-2 border-lime-400 border-t-transparent animate-spin" />
                    <div>
                      <div className="text-sm text-white font-bold">Publishing coin module…</div>
                      <div className="text-[10px] text-white/30">Approve in your wallet — Tx 1 of 2</div>
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
                  <div className="flex items-center gap-3 text-lime-400/60">
                    <CheckCircle size={20} />
                    <div className="text-sm text-white/50">Module published</div>
                    {tx1Digest && (
                      <a href={`https://testnet.suivision.xyz/txblock/${tx1Digest}`} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 text-[10px] text-white/20 hover:text-lime-400 ml-auto transition-colors">
                        Tx 1 <ExternalLink size={9} />
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full border-2 border-lime-400 border-t-transparent animate-spin" />
                    <div>
                      <div className="text-sm text-white font-bold">Configuring curve…</div>
                      <div className="text-[10px] text-white/30">Approve in your wallet — Tx 2 of 2</div>
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
                  <div className="text-4xl">🎉</div>
                  <div className="text-xl font-bold text-white">${form.symbol} IS LIVE</div>
                  <div className="text-sm text-white/40">{form.name} launched on Sui testnet</div>
                  <div className="flex gap-3 justify-center pt-2">
                    {tx1Digest && (
                      <a href={`https://testnet.suivision.xyz/txblock/${tx1Digest}`} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 text-[10px] text-white/30 hover:text-lime-400 transition-colors">
                        Publish tx <ExternalLink size={9} />
                      </a>
                    )}
                    {tx2Digest && (
                      <a href={`https://testnet.suivision.xyz/txblock/${tx2Digest}`} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 text-[10px] text-white/30 hover:text-lime-400 transition-colors">
                        Configure tx <ExternalLink size={9} />
                      </a>
                    )}
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-2xl border border-red-500/20 bg-red-950/10 p-4 text-xs text-red-400 break-all space-y-2">
                  <div>{error}</div>
                  {error.includes('TreasuryCap') && (
                    <div className="text-[10px] text-red-600">
                      Tip: The coin module published (Tx 1 succeeded). You can retry the configuration step.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-white/5">
          {txStep === 'done' ? (
            <button onClick={onClose}
              className="flex-1 py-3 bg-lime-400 text-black text-xs font-mono tracking-widest hover:bg-lime-300 rounded-xl font-bold transition-colors">
              VIEW TOKEN →
            </button>
          ) : (
            <>
              <button
                onClick={() => step > 0 ? setStep(s => s - 1) : onClose()}
                disabled={launching}
                className="flex-1 py-3 rounded-xl border border-white/10 text-white/40 text-xs font-mono tracking-widest hover:border-white/20 hover:text-white/60 disabled:opacity-20 transition-all"
              >
                {step === 0 ? 'CANCEL' : 'BACK'}
              </button>
              {step < 3 ? (
                <button
                  onClick={() => setStep(s => s + 1)}
                  disabled={!canNext}
                  className="flex-1 py-3 bg-lime-400 text-black text-xs font-mono tracking-widest hover:bg-lime-300 disabled:bg-white/5 disabled:text-white/20 disabled:cursor-not-allowed rounded-xl font-bold transition-all"
                >
                  NEXT →
                </button>
              ) : !txStep && !error ? (
                <button
                  onClick={launch}
                  disabled={launching}
                  className="flex-1 py-3 bg-lime-400 text-black text-xs font-mono tracking-widest hover:bg-lime-300 disabled:opacity-50 rounded-xl font-bold transition-all flex items-center justify-center gap-2"
                >
                  <Rocket size={13} /> LAUNCH TOKEN
                </button>
              ) : error ? (
                <button
                  onClick={() => { setError(null); setTxStep(null); }}
                  className="flex-1 py-3 rounded-xl border border-white/10 text-white/40 text-xs font-mono tracking-widest hover:border-lime-400/40 hover:text-lime-400 transition-all"
                >
                  TRY AGAIN
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
