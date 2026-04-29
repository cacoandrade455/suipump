// LaunchModal.jsx
// Two-transaction token launch flow in the browser.
// Tx1: patch template bytecode + publish new coin module
// Tx2: create_and_return + optional dev-buy + share_curve
// Uses @mysten/move-bytecode-template for client-side bytecode patching.

import React, { useState, useCallback } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { X, Plus, Trash2, ExternalLink } from 'lucide-react';
import wasmInit, * as bytecodeTemplate from '@mysten/move-bytecode-template';

import { PACKAGE_ID, MIST_PER_SUI } from './constants.js';

const LAUNCH_FEE_MIST = 2_000_000_000n;
const TEMPLATE_URL = '/template.mv';

// Initialise the WASM module once — safe to call multiple times.
let wasmReady = false;
async function ensureWasm() {
  if (!wasmReady) {
    await wasmInit();
    wasmReady = true;
  }
}

// BCS helpers
function bcsBytes(str) {
  const buf = new TextEncoder().encode(str);
  if (buf.length > 127) throw new Error(`String too long for BCS: ${str}`);
  const out = new Uint8Array(buf.length + 1);
  out[0] = buf.length;
  out.set(buf, 1);
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

const STEPS = ['details', 'payouts', 'devbuy', 'launch'];
const STEP_LABELS = ['Token details', 'Payout splits', 'Dev buy', 'Launch'];

export default function LaunchModal({ onClose, onLaunched }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    name: '',
    symbol: '',
    description: '',
    iconUrl: '',
  });
  const [payouts, setPayouts] = useState([
    { address: account?.address ?? '', bps: 10000 },
  ]);
  const [devBuy, setDevBuy] = useState('');
  const [launching, setLaunching] = useState(false);
  const [txStep, setTxStep] = useState(null); // 'tx1' | 'tx2' | 'done'
  const [tx1Digest, setTx1Digest] = useState(null);
  const [tx2Digest, setTx2Digest] = useState(null);
  const [error, setError] = useState(null);
  const [newCurveId, setNewCurveId] = useState(null);

  // ── Validation ──────────────────────────────────────────────────────────
  const symbolValid = /^[A-Z][A-Z0-9]{0,4}$/.test(form.symbol);
  const nameValid = form.name.trim().length >= 2 && form.name.trim().length <= 64;
  const payoutSum = payouts.reduce((s, p) => s + (parseInt(p.bps) || 0), 0);
  const payoutsValid = payouts.length >= 1 && payouts.length <= 10 && payoutSum === 10000
    && payouts.every(p => p.address.startsWith('0x') && p.address.length === 66);

  const canNext = [
    nameValid && symbolValid,
    payoutsValid,
    true, // dev buy optional
    true,
  ][step];

  // ── Payout helpers ───────────────────────────────────────────────────────
  const addPayout = () => {
    if (payouts.length >= 10) return;
    const remaining = 10000 - payouts.slice(0, -1).reduce((s, p) => s + (parseInt(p.bps) || 0), 0);
    setPayouts([...payouts, { address: '', bps: remaining }]);
  };

  const removePayout = (i) => {
    if (payouts.length === 1) return;
    const next = payouts.filter((_, idx) => idx !== i);
    setPayouts(next);
  };

  const updatePayout = (i, field, value) => {
    const next = [...payouts];
    next[i] = { ...next[i], [field]: field === 'bps' ? parseInt(value) || 0 : value };
    setPayouts(next);
  };

  // ── Launch ───────────────────────────────────────────────────────────────
  const launch = useCallback(async () => {
    setError(null);
    setLaunching(true);

    try {
      const tokenSymbol = form.symbol.toUpperCase();
      const moduleName = tokenSymbol.toLowerCase();
      const tokenName = form.name.trim();
      const tokenDesc = form.description.trim() || `${tokenName} — launched on SuiPump`;
      const tokenIcon = form.iconUrl.trim() || 'https://suipump.test/icon-placeholder.png';

      // ── Tx1: patch + publish ───────────────────────────────────────────
      setTxStep('tx1');

      // Ensure WASM is initialised before calling bytecode template functions
      await ensureWasm();

      const templateRes = await fetch(TEMPLATE_URL);
      if (!templateRes.ok) throw new Error('Could not load template bytecode');
      const templateBuf = await templateRes.arrayBuffer();
      let patched = bytecodeTemplate.update_identifiers(
        new Uint8Array(templateBuf),
        { 'TEMPLATE': tokenSymbol, 'template': moduleName }
      );
      patched = bytecodeTemplate.update_constants(patched, bcsBytes(tokenSymbol), bcsBytes('TMPL'), 'Vector(U8)');
      patched = bytecodeTemplate.update_constants(patched, bcsBytes(tokenName), bcsBytes('Template Coin'), 'Vector(U8)');
      patched = bytecodeTemplate.update_constants(
        patched,
        bcsBytes(tokenDesc),
        bcsBytes('Template description placeholder that is intentionally long to accommodate real token descriptions.'),
        'Vector(U8)'
      );
      patched = bytecodeTemplate.update_constants(
        patched,
        bcsBytes(tokenIcon),
        bcsBytes('https://suipump.test/icon-placeholder.png'),
        'Vector(U8)'
      );

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

      // Fetch the full transaction result — dapp-kit hook only returns digest by default
      const res1 = await client.waitForTransaction({
        digest: res1raw.digest,
        options: { showEffects: true, showObjectChanges: true },
      });

      if (res1.effects.status.status !== 'success') {
        throw new Error('Tx1 failed: ' + res1.effects.status.error);
      }

      setTx1Digest(res1raw.digest);

      const published = res1.objectChanges.find(c => c.type === 'published');
      const newPackageId = published.packageId;
      const newTokenType = `${newPackageId}::${moduleName}::${tokenSymbol}`;

      const treasuryCapObj = res1.objectChanges.find(c =>
        c.type === 'created' && c.objectType?.includes('TreasuryCap')
      );
      if (!treasuryCapObj) throw new Error('TreasuryCap not found in Tx1 effects');
      const treasuryCapId = treasuryCapObj.objectId;

      // Wait for indexing
      await new Promise(r => setTimeout(r, 3000));

      // ── Tx2: configure + optional dev-buy ─────────────────────────────
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

      tx2.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::share_curve`,
        typeArguments: [newTokenType],
        arguments: [curve],
      });
      tx2.transferObjects([cap], account.address);

      const res2raw = await signAndExecute({ transaction: tx2 });

      const res2 = await client.waitForTransaction({
        digest: res2raw.digest,
        options: { showEffects: true, showObjectChanges: true, showEvents: true },
      });

      if (res2.effects.status.status !== 'success') {
        throw new Error('Tx2 failed: ' + res2.effects.status.error);
      }

      setTx2Digest(res2raw.digest);

      const curveEvent = res2.events?.find(e => e.type?.includes('CurveCreated'));
      const curveId = curveEvent?.parsedJson?.curve_id;
      setNewCurveId(curveId);
      setTxStep('done');

      // Notify parent so it can add the token to the list
      if (onLaunched) onLaunched({ curveId, tokenType: newTokenType, name: tokenName, symbol: tokenSymbol });

    } catch (err) {
      setError(err.message || String(err));
      setTxStep(null);
    } finally {
      setLaunching(false);
    }
  }, [form, payouts, devBuy, account, client, signAndExecute, onLaunched]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4">
      <div className="w-full max-w-lg border border-lime-900/60 bg-black font-mono">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-lime-900/40">
          <div>
            <div className="text-xs tracking-widest text-lime-600">SUIPUMP</div>
            <div className="text-lg font-bold text-lime-100">LAUNCH A TOKEN</div>
          </div>
          <button onClick={onClose} className="text-lime-700 hover:text-lime-400">
            <X size={18} />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex border-b border-lime-900/40">
          {STEP_LABELS.map((label, i) => (
            <div key={i} className={`flex-1 py-2 text-center text-[10px] tracking-widest border-r border-lime-900/40 last:border-r-0 ${
              i === step ? 'text-lime-400 bg-lime-950/30' : i < step ? 'text-lime-700' : 'text-lime-900'
            }`}>
              {i < step ? '✓ ' : ''}{label.toUpperCase()}
            </div>
          ))}
        </div>

        <div className="px-6 py-5 space-y-4 min-h-[260px]">

          {/* ── Step 0: Token details ── */}
          {step === 0 && (
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] tracking-widest text-lime-700 mb-1">TOKEN NAME *</label>
                <input
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="Moon Coin"
                  className="w-full bg-lime-950/20 border border-lime-900 px-3 py-2 text-lime-100 text-sm focus:outline-none focus:border-lime-400"
                />
              </div>
              <div>
                <label className="block text-[10px] tracking-widest text-lime-700 mb-1">SYMBOL * (1-5 uppercase letters)</label>
                <input
                  value={form.symbol}
                  onChange={e => setForm({ ...form, symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) })}
                  placeholder="MOON"
                  className={`w-full bg-lime-950/20 border px-3 py-2 text-lime-100 text-sm focus:outline-none ${
                    form.symbol && !symbolValid ? 'border-red-700 focus:border-red-400' : 'border-lime-900 focus:border-lime-400'
                  }`}
                />
                {form.symbol && !symbolValid && (
                  <div className="text-[10px] text-red-500 mt-1">Must start with a letter, max 5 chars, uppercase only</div>
                )}
              </div>
              <div>
                <label className="block text-[10px] tracking-widest text-lime-700 mb-1">DESCRIPTION</label>
                <textarea
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                  placeholder="What is this token about?"
                  rows={2}
                  className="w-full bg-lime-950/20 border border-lime-900 px-3 py-2 text-lime-100 text-sm focus:outline-none focus:border-lime-400 resize-none"
                />
              </div>
              <div>
                <label className="block text-[10px] tracking-widest text-lime-700 mb-1">TOKEN ICON</label>
                <div className="flex gap-2 items-start">
                  {/* Preview */}
                  <div className="w-14 h-14 shrink-0 border border-lime-900 flex items-center justify-center bg-lime-950/20 overflow-hidden">
                    {form.iconUrl
                      ? <img src={form.iconUrl} alt="icon" className="w-full h-full object-cover" onError={e => { e.target.style.display='none'; }} />
                      : <span className="text-2xl">🔥</span>
                    }
                  </div>
                  <div className="flex-1 space-y-2">
                    <label className={`flex items-center justify-center gap-2 w-full py-2 border text-[10px] font-mono cursor-pointer transition-colors ${
                      form.uploading ? 'border-lime-900 text-lime-900 cursor-not-allowed' : 'border-lime-900 text-lime-700 hover:border-lime-600 hover:text-lime-400'
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
                      {form.uploading ? 'UPLOADING…' : '📁 UPLOAD IMAGE (JPEG / PNG / GIF)'}
                    </label>
                    <input
                      value={form.iconUrl}
                      onChange={e => setForm({ ...form, iconUrl: e.target.value })}
                      placeholder="or paste a URL directly"
                      className="w-full bg-lime-950/20 border border-lime-900 px-3 py-1.5 text-lime-600 text-xs focus:outline-none focus:border-lime-400"
                    />
                    {form.uploadError && (
                      <div className="text-[10px] text-red-500">{form.uploadError}</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 1: Payout splits ── */}
          {step === 1 && (
            <div className="space-y-3">
              <div className="text-[10px] text-lime-600 leading-relaxed">
                Set who receives creator fees. Percentages must sum to 100%. Up to 10 recipients.
              </div>
              {payouts.map((p, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    value={p.address}
                    onChange={e => updatePayout(i, 'address', e.target.value)}
                    placeholder="0x..."
                    className="flex-1 bg-lime-950/20 border border-lime-900 px-2 py-2 text-lime-100 text-xs focus:outline-none focus:border-lime-400 min-w-0"
                  />
                  <div className="flex items-center gap-1 shrink-0">
                    <input
                      type="number"
                      value={Math.round(p.bps / 100)}
                      onChange={e => updatePayout(i, 'bps', Math.round(parseFloat(e.target.value || 0) * 100))}
                      min={1} max={100}
                      className="w-16 bg-lime-950/20 border border-lime-900 px-2 py-2 text-lime-100 text-xs focus:outline-none focus:border-lime-400 text-right"
                    />
                    <span className="text-lime-700 text-xs">%</span>
                    {payouts.length > 1 && (
                      <button onClick={() => removePayout(i)} className="text-lime-900 hover:text-red-400 ml-1">
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <button
                  onClick={addPayout}
                  disabled={payouts.length >= 10}
                  className="flex items-center gap-1 text-[10px] text-lime-700 hover:text-lime-400 disabled:opacity-30"
                >
                  <Plus size={10} /> ADD RECIPIENT
                </button>
                <div className={`text-[10px] ${payoutSum === 10000 ? 'text-lime-500' : 'text-red-500'}`}>
                  TOTAL: {payoutSum / 100}%{payoutSum !== 10000 ? ' (must be 100%)' : ' ✓'}
                </div>
              </div>
            </div>
          )}

          {/* ── Step 2: Dev buy ── */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="text-[10px] text-lime-600 leading-relaxed">
                Optional: buy tokens immediately at launch in the same transaction. Can be any amount — even enough to graduate the curve instantly.
              </div>
              <div className="border border-amber-900/40 bg-amber-950/10 p-3 text-[10px] text-amber-600 leading-relaxed">
                ⚠ Large dev buys signal insider advantage and may reduce community trust. This data is permanently visible on-chain.
              </div>
              <div>
                <label className="block text-[10px] tracking-widest text-lime-700 mb-1">DEV BUY AMOUNT (SUI)</label>
                <input
                  value={devBuy}
                  onChange={e => setDevBuy(e.target.value)}
                  placeholder="0 (leave blank to skip)"
                  className="w-full bg-lime-950/20 border border-lime-900 px-3 py-2 text-lime-100 text-sm focus:outline-none focus:border-lime-400"
                />
              </div>
              {devBuy && parseFloat(devBuy) > 0 && (
                <div className="text-[10px] text-lime-600">
                  Total cost: {(2 + parseFloat(devBuy)).toFixed(4)} SUI (2 SUI launch fee + {devBuy} SUI dev buy)
                </div>
              )}
              {!devBuy && (
                <div className="text-[10px] text-lime-600">
                  Total cost: 2 SUI launch fee
                </div>
              )}
            </div>
          )}

          {/* ── Step 3: Launch / progress ── */}
          {step === 3 && (
            <div className="space-y-4">
              {!txStep && !error && (
                <>
                  <div className="text-[10px] text-lime-600 leading-relaxed">
                    Review your launch details. Two wallet signatures required.
                  </div>
                  <div className="border border-lime-900/40 bg-lime-950/20 p-4 space-y-2 text-xs">
                    <div className="flex justify-between"><span className="text-lime-700">NAME</span><span className="text-lime-100">{form.name}</span></div>
                    <div className="flex justify-between"><span className="text-lime-700">SYMBOL</span><span className="text-lime-100">${form.symbol}</span></div>
                    <div className="flex justify-between"><span className="text-lime-700">PAYOUTS</span><span className="text-lime-100">{payouts.length} recipient{payouts.length > 1 ? 's' : ''}</span></div>
                    <div className="flex justify-between"><span className="text-lime-700">DEV BUY</span><span className="text-lime-100">{parseFloat(devBuy) > 0 ? `${devBuy} SUI` : 'None'}</span></div>
                    <div className="flex justify-between border-t border-lime-900 pt-2"><span className="text-lime-700">LAUNCH FEE</span><span className="text-lime-400">2 SUI</span></div>
                  </div>
                </>
              )}

              {txStep === 'tx1' && (
                <div className="space-y-3">
                  <div className="text-xs text-lime-400 animate-pulse">⬡ PUBLISHING COIN MODULE…</div>
                  <div className="text-[10px] text-lime-700">Patching bytecode and publishing to Sui. Approve in your wallet.</div>
                </div>
              )}

              {txStep === 'tx2' && (
                <div className="space-y-3">
                  <div className="text-xs text-lime-500">✓ Module published</div>
                  {tx1Digest && (
                    <a href={`https://testnet.suivision.xyz/txblock/${tx1Digest}`} target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 text-[10px] text-lime-700 hover:text-lime-400">
                      Tx 1 <ExternalLink size={9} />
                    </a>
                  )}
                  <div className="text-xs text-lime-400 animate-pulse">⬡ CONFIGURING CURVE…</div>
                  <div className="text-[10px] text-lime-700">Setting payouts and launch fee. Approve in your wallet.</div>
                </div>
              )}

              {txStep === 'done' && (
                <div className="space-y-3">
                  <div className="text-sm text-lime-400 font-bold">🎉 TOKEN LAUNCHED</div>
                  <div className="text-xs text-lime-100">${form.symbol} is live on Sui testnet.</div>
                  {newCurveId && (
                    <div className="text-[10px] text-lime-700 break-all">Curve: {newCurveId}</div>
                  )}
                  <div className="flex gap-2 flex-wrap">
                    {tx1Digest && (
                      <a href={`https://testnet.suivision.xyz/txblock/${tx1Digest}`} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 text-[10px] text-lime-700 hover:text-lime-400">
                        Publish tx <ExternalLink size={9} />
                      </a>
                    )}
                    {tx2Digest && (
                      <a href={`https://testnet.suivision.xyz/txblock/${tx2Digest}`} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 text-[10px] text-lime-700 hover:text-lime-400">
                        Configure tx <ExternalLink size={9} />
                      </a>
                    )}
                  </div>
                </div>
              )}

              {error && (
                <div className="border border-red-800 bg-red-950/20 p-3 text-xs text-red-400 break-all">
                  {error}
                  {error.includes('TreasuryCap') && (
                    <div className="mt-2 text-[10px] text-red-600">
                      Tip: The coin module published successfully (Tx 1). You can retry the configuration step manually.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer navigation */}
        <div className="flex gap-3 px-6 py-4 border-t border-lime-900/40">
          {txStep === 'done' ? (
            <button onClick={onClose} className="flex-1 py-2 bg-lime-400 text-black text-xs font-mono tracking-widest hover:bg-lime-300">
              VIEW TOKEN
            </button>
          ) : (
            <>
              <button
                onClick={() => step > 0 ? setStep(s => s - 1) : onClose()}
                disabled={launching}
                className="flex-1 py-2 border border-lime-900 text-lime-700 text-xs font-mono tracking-widest hover:border-lime-600 disabled:opacity-30"
              >
                {step === 0 ? 'CANCEL' : 'BACK'}
              </button>
              {step < 3 ? (
                <button
                  onClick={() => setStep(s => s + 1)}
                  disabled={!canNext}
                  className="flex-1 py-2 bg-lime-400 text-black text-xs font-mono tracking-widest hover:bg-lime-300 disabled:bg-lime-950 disabled:text-lime-800 disabled:cursor-not-allowed"
                >
                  NEXT
                </button>
              ) : !txStep && !error ? (
                <button
                  onClick={launch}
                  disabled={launching}
                  className="flex-1 py-2 bg-lime-400 text-black text-xs font-mono tracking-widest hover:bg-lime-300 disabled:opacity-50"
                >
                  {launching ? 'LAUNCHING…' : 'LAUNCH TOKEN'}
                </button>
              ) : error ? (
                <button
                  onClick={() => { setError(null); setTxStep(null); }}
                  className="flex-1 py-2 border border-lime-900 text-lime-700 text-xs font-mono tracking-widest hover:border-lime-600"
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
