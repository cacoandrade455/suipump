// CommunityTakeoverPanel.jsx
// V13 ESCROW-WEIGHTED Community Takeover (CTO).
//
// The V13 bonding_curve redesign replaced the old for/against, live-balance
// weighted vote with an ESCROW-weighted model. Holders lock (escrow) tokens to
// nominate a new creator and to vote; weight is the escrowed amount; escrow is
// returned on resolve (auto-sweeper, with a manual reclaim fallback). This panel
// drives that lifecycle against the V13 package ONLY.
//
// V13 Move signatures targeted here (exact):
//   propose_takeover<T>(curve: &mut Curve<T>, stake: Coin<T>, clock, ctx)      // shares proposal on-chain
//   vote_takeover<T>(proposal: &mut TakeoverProposal<T>, coins: Coin<T>, clock, ctx)
//   unvote_takeover<T>(proposal: &mut TakeoverProposal<T>, clock, ctx)
//   resolve_takeover<T>(proposal: &mut TakeoverProposal<T>, curve: &mut Curve<T>, clock, ctx)   // permissionless
//   reclaim_vote<T>(proposal: &mut TakeoverProposal<T>, voter: address, ctx)                    // permissionless
//
// HARD GATE: the whole panel is hidden unless PACKAGE_ID_V13 is set. These
// functions exist ONLY in V13; never attempt them on legacy curves. All writes
// go through executeTx (build-then-execute; NEVER dAppKit.signAndExecuteTransaction).

import React, { useState, useEffect } from 'react';
import { useDAppKit, useCurrentClient } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { PACKAGE_ID_V13, ALL_PACKAGE_IDS } from './constants.js';
import { executeTx } from './lib/executeTx.js';

const CLOCK_ID     = '0x6';
// 800M supply on the curve, atomic (6 decimals). circ = CURVE_SUPPLY - token_reserve.
const CURVE_SUPPLY = 800000000n * 1000000n;
const INACTIVITY_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
const CAP_GQL_URL   = 'https://graphql.testnet.sui.io/graphql';

// Canonical 0x + 64-hex-lowercase form, for id equality (never truncates).
function normAddr(a) {
  if (a == null) return '';
  let s = String(a).trim().toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  s = s.replace(/^0+/, '');
  if (s === '') s = '0';
  return '0x' + s.padStart(64, '0');
}

async function gql(query, ms = 8000) {
  const r = await fetch(CAP_GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(ms),
  });
  return r.json();
}

// Resolve the CreatorCap object id for `curveId` owned by `ownerAddr`, or null.
// Mirrors the old panel's strategy: (1) indexer fast path, (2) type-filtered +
// paginated per known package, (3) package-agnostic bounded scan by type repr.
async function findCreatorCapId(ownerAddr, curveId, indexerUrl) {
  const want = normAddr(curveId);
  if (indexerUrl) {
    try {
      const res = await fetch(`${indexerUrl}/token/${curveId}/creator-cap?owner=${ownerAddr}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) { const d = await res.json(); if (d && d.objectId) return d.objectId; }
    } catch { /* fall through to on-chain scan */ }
  }
  for (const pid of ALL_PACKAGE_IDS) {
    if (!pid) continue;
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const after = cursor ? `, after: "${cursor}"` : '';
      const q = `{ address(address: "${ownerAddr}") { objects(first: 50${after}, filter: { type: "${pid}::bonding_curve::CreatorCap" }) { pageInfo { hasNextPage endCursor } nodes { address contents { json } } } } }`;
      let result;
      try { result = await gql(q); } catch { break; }
      const conn = result?.data?.address?.objects;
      const nodes = conn?.nodes ?? [];
      for (const n of nodes) { if (normAddr(n.contents?.json?.curve_id) === want) return n.address; }
      if (!conn?.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }
  {
    let cursor = null;
    for (let page = 0; page < 8; page++) {
      const after = cursor ? `, after: "${cursor}"` : '';
      const q = `{ address(address: "${ownerAddr}") { objects(first: 50${after}) { pageInfo { hasNextPage endCursor } nodes { address contents { type { repr } json } } } } }`;
      let result;
      try { result = await gql(q); } catch { break; }
      const conn = result?.data?.address?.objects;
      const nodes = conn?.nodes ?? [];
      for (const n of nodes) {
        const repr = n.contents?.type?.repr || '';
        if (!repr.includes('::bonding_curve::CreatorCap')) continue;
        if (normAddr(n.contents?.json?.curve_id) === want) return n.address;
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }
  return null;
}

function fmtTok(atomic) {
  // atomic (BigInt) -> whole tokens, safe: CURVE_SUPPLY (8e14) < 2^53.
  const n = atomic == null ? 0 : Number(atomic) / 1e6;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtDur(ms) {
  if (ms <= 0) return '0m';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec}s`;
}

export default function CommunityTakeoverPanel({ curveId, tokenType, creator, account, initialSharedVersion, tokenReserveAtomic }) {
  const client  = useCurrentClient();
  const dAppKit = useDAppKit();

  const [data, setData]           = useState(null); // raw /takeover route response
  const [stakeInput, setStakeInput] = useState('');
  const [voteInput, setVoteInput]   = useState('');
  const [voted, setVoted]         = useState(false); // in-memory: user voted this session
  const [busy, setBusy]           = useState(false);
  const [msg, setMsg]             = useState('');
  const [now, setNow]             = useState(Date.now());
  const [capId, setCapId]         = useState(null);  // connected creator's CreatorCap id
  const [capChecked, setCapChecked] = useState(false);

  const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

  // Only the curve's own creator can heartbeat; compare full ids canonically.
  const isCreator = Boolean(PACKAGE_ID_V13) && Boolean(account) && Boolean(creator) &&
    normAddr(account.address) === normAddr(creator);

  // Locate the creator's CreatorCap once (drives the heartbeat button's enabled
  // state); disable-with-hint if none is found rather than crashing on click.
  useEffect(() => {
    if (!isCreator) { setCapId(null); setCapChecked(false); return; }
    let cancelled = false;
    setCapChecked(false);
    (async () => {
      try {
        const id = await findCreatorCapId(account.address, curveId, INDEXER_URL);
        if (!cancelled) setCapId(id);
      } catch { if (!cancelled) setCapId(null); }
      finally { if (!cancelled) setCapChecked(true); }
    })();
    return () => { cancelled = true; };
  }, [isCreator, account?.address, curveId, INDEXER_URL]);

  const load = React.useCallback(async () => {
    if (!curveId || !INDEXER_URL) return;
    try {
      const r = await fetch(`${INDEXER_URL}/token/${curveId}/takeover`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) setData(await r.json());
    } catch { /* keep last snapshot */ }
  }, [curveId, INDEXER_URL]);

  useEffect(() => {
    load();
    const poll = setInterval(load, 8000);
    const clk  = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(clk); };
  }, [load]);

  // -- derived on-chain state -------------------------------------------------
  const proposal = data && data.proposal_id ? {
    proposalId:           data.proposal_id,
    proposer:             data.proposer,
    deadlineMs:           Number(data.deadline_ms ?? 0),
    totalWeight:          BigInt(data.total_weight ?? 0),
    resolved:             data.resolved === true,
    succeeded:            data.succeeded === true,
    initialSharedVersion: data.initial_shared_version ?? null,
  } : null;

  const activityMs = data && data.last_creator_activity_ms != null ? Number(data.last_creator_activity_ms) : null;
  const inactiveMs = activityMs != null ? (now - activityMs) : 0;
  const creatorInactive = activityMs != null && inactiveMs >= INACTIVITY_MS;

  // -- supply-derived thresholds (all BigInt u64 math) ------------------------
  const reserve   = tokenReserveAtomic != null ? BigInt(tokenReserveAtomic) : 0n;
  const circ      = CURVE_SUPPLY > reserve ? (CURVE_SUPPLY - reserve) : 0n;
  // Quorum: prefer the on-chain snapshot surfaced by the indexer route
  // (TakeoverProposal.quorum_target, frozen at propose time so trading can't
  // move the goalposts). Fall back to the live 25%-of-circulating estimate only
  // when the field is absent (older indexer, resolved proposal, lookup failure).
  let quorumSnapshot = null;
  if (data && data.quorum_target != null) {
    try { quorumSnapshot = BigInt(data.quorum_target); } catch { quorumSnapshot = null; }
  }
  const quorum    = quorumSnapshot != null ? quorumSnapshot : (circ * 2500n) / 10000n; // 25% of circulating supply
  const threshold = (circ * 100n) / 10000n;    // 1% of circulating supply to nominate
  const minVote   = CURVE_SUPPLY / 10000n;     // 0.01% of full curve supply

  // Takeover body visibility: V13 published AND (a proposal exists OR creator is
  // inactive). The creator's heartbeat control renders regardless (a creator must
  // be able to signal liveness BEFORE the curve becomes takeover-qualified).
  const show = Boolean(PACKAGE_ID_V13) && (proposal || creatorInactive);

  // Prefill the nominate stake with the minimum (1% of circulating supply).
  useEffect(() => {
    if (!proposal && creatorInactive && stakeInput === '' && threshold > 0n) {
      setStakeInput(String(Number(threshold) / 1e6));
    }
  }, [proposal, creatorInactive, threshold]); // eslint-disable-line react-hooks/exhaustive-deps

  // IDLE: takeover is possible on this curve (V13 live; the mount site already
  // gates on V10-lineage + not graduated) but nothing is happening - no proposal
  // and the creator is not inactive. Render the design's subtle footnote row
  // instead of nothing (design HTML: font 400 9px/1.5 monospace,
  // rgba(255,255,255,.28), margin-top 10px, no border/background of its own).
  if (!show && !isCreator) {
    if (!PACKAGE_ID_V13) return null;
    return (
      <div className="mt-2.5 text-[9px] leading-[1.5] font-normal font-mono text-white/[0.28]">
        CTO vote: none active
      </div>
    );
  }

  const live            = proposal && !proposal.resolved && now < proposal.deadlineMs;
  const awaitingResolve = proposal && !proposal.resolved && now >= proposal.deadlineMs;
  const resolved        = proposal && proposal.resolved;
  const proposeState    = !proposal && creatorInactive;

  const supportPct = quorum > 0n
    ? Math.min(100, Number((proposal ? proposal.totalWeight : 0n) * 10000n / quorum) / 100)
    : 0;
  const quorumReached = proposal && proposal.totalWeight >= quorum;

  const curveRef = (tx, mutable) => (initialSharedVersion
    ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: String(initialSharedVersion), mutable })
    : tx.object(curveId));

  const proposalRef = (tx, mutable) => (proposal && proposal.initialSharedVersion
    ? tx.sharedObjectRef({ objectId: proposal.proposalId, initialSharedVersion: String(proposal.initialSharedVersion), mutable })
    : tx.object(proposal.proposalId));

  // Select + merge + split the user's Coin<T> exactly like the sell path.
  async function pickCoin(tx, atomic) {
    const coins = await client.listCoins({ owner: account.address, coinType: tokenType });
    if (!coins.objects.length) throw new Error('No token balance');
    const coinObjs = coins.objects.map(c => tx.object(c.objectId));
    let coin;
    if (coinObjs.length === 1) { [coin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(atomic)]); }
    else { tx.mergeCoins(coinObjs[0], coinObjs.slice(1)); [coin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(atomic)]); }
    return coin;
  }

  function isFailed(res) { return res?.$kind === 'FailedTransaction' || Boolean(res?.FailedTransaction); }
  function failMsg(res, fallback) { return res?.FailedTransaction?.status?.error ?? fallback; }

  // creator_heartbeat<T>(cap: &CreatorCap, curve: &mut Curve<T>, clock, ctx) is
  // UNCHANGED in V13. It resets the 5-day inactivity clock (emits CreatorHeartbeat
  // -> last_creator_activity_ms), the only liveness signal this panel's gate reads.
  async function doHeartbeat() {
    if (busy || !account || !isCreator) return;
    setBusy(true); setMsg('');
    try {
      let id = capId;
      if (!id) { id = await findCreatorCapId(account.address, curveId, INDEXER_URL); if (id) setCapId(id); }
      if (!id) throw new Error('CreatorCap not found for this wallet on this curve');
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID_V13}::bonding_curve::creator_heartbeat`,
        typeArguments: [tokenType],
        arguments: [tx.object(id), curveRef(tx, true), tx.object(CLOCK_ID)],
      });
      const res = await executeTx(dAppKit, null, tx, account.address);
      if (isFailed(res)) throw new Error(failMsg(res, 'Heartbeat failed'));
      setMsg('Heartbeat sent - inactivity clock reset.');
      setTimeout(load, 1500);
    } catch (e) { setMsg(e.message || 'Heartbeat failed'); }
    finally { setBusy(false); }
  }

  async function doPropose() {
    if (busy || !account) return;
    const amt = parseFloat(stakeInput);
    if (!(amt > 0)) { setMsg('Enter a stake amount'); return; }
    const stakeAtomic = BigInt(Math.floor(amt * 1e6));
    if (stakeAtomic < threshold) { setMsg(`Minimum stake is ${fmtTok(threshold)} tokens (1% of circulating supply)`); return; }
    setBusy(true); setMsg('');
    try {
      const tx = new Transaction();
      const stake = await pickCoin(tx, stakeAtomic);
      tx.moveCall({
        target: `${PACKAGE_ID_V13}::bonding_curve::propose_takeover`,
        typeArguments: [tokenType],
        arguments: [curveRef(tx, true), stake, tx.object(CLOCK_ID)],
      });
      const res = await executeTx(dAppKit, null, tx, account.address);
      if (isFailed(res)) throw new Error(failMsg(res, 'Propose failed'));
      setMsg('Takeover proposed. Your stake is escrowed and voting is open.');
      setStakeInput('');
      setTimeout(load, 1500);
    } catch (e) { setMsg(e.message || 'Propose failed'); }
    finally { setBusy(false); }
  }

  async function doVote() {
    if (busy || !account || !proposal) return;
    const amt = parseFloat(voteInput);
    if (!(amt > 0)) { setMsg('Enter an amount to stake toward the takeover'); return; }
    const voteAtomic = BigInt(Math.floor(amt * 1e6));
    if (voteAtomic < minVote) { setMsg(`Minimum vote is ${fmtTok(minVote)} tokens`); return; }
    setBusy(true); setMsg('');
    try {
      const tx = new Transaction();
      const coin = await pickCoin(tx, voteAtomic);
      tx.moveCall({
        target: `${PACKAGE_ID_V13}::bonding_curve::vote_takeover`,
        typeArguments: [tokenType],
        arguments: [proposalRef(tx, true), coin, tx.object(CLOCK_ID)],
      });
      const res = await executeTx(dAppKit, null, tx, account.address);
      if (isFailed(res)) throw new Error(failMsg(res, 'Vote failed'));
      setVoted(true);
      setMsg('Vote cast. Your tokens are escrowed toward the takeover.');
      setVoteInput('');
      setTimeout(load, 1500);
    } catch (e) { setMsg(e.message || 'Vote failed'); }
    finally { setBusy(false); }
  }

  async function doUnvote() {
    if (busy || !account || !proposal) return;
    setBusy(true); setMsg('');
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID_V13}::bonding_curve::unvote_takeover`,
        typeArguments: [tokenType],
        arguments: [proposalRef(tx, true), tx.object(CLOCK_ID)],
      });
      const res = await executeTx(dAppKit, null, tx, account.address);
      if (isFailed(res)) throw new Error(failMsg(res, 'Withdraw failed'));
      setVoted(false);
      setMsg('Vote withdrawn. Escrowed tokens returned to your wallet.');
      setTimeout(load, 1500);
    } catch (e) { setMsg(e.message || 'Withdraw failed'); }
    finally { setBusy(false); }
  }

  async function doResolve() {
    if (busy || !proposal || !account) return;
    setBusy(true); setMsg('');
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID_V13}::bonding_curve::resolve_takeover`,
        typeArguments: [tokenType],
        arguments: [proposalRef(tx, true), curveRef(tx, true), tx.object(CLOCK_ID)],
      });
      const res = await executeTx(dAppKit, null, tx, account.address);
      if (isFailed(res)) throw new Error(failMsg(res, 'Resolve failed'));
      setMsg('Proposal resolved.');
      setTimeout(load, 1500);
    } catch (e) { setMsg(e.message || 'Resolve failed'); }
    finally { setBusy(false); }
  }

  async function doReclaim() {
    if (busy || !proposal || !account) return;
    setBusy(true); setMsg('');
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID_V13}::bonding_curve::reclaim_vote`,
        typeArguments: [tokenType],
        arguments: [proposalRef(tx, true), tx.pure.address(account.address)],
      });
      const res = await executeTx(dAppKit, null, tx, account.address);
      if (isFailed(res)) throw new Error(failMsg(res, 'Reclaim failed'));
      setMsg('Escrow reclaimed to your wallet.');
      setTimeout(load, 1500);
    } catch (e) { setMsg(e.message || 'Reclaim failed'); }
    finally { setBusy(false); }
  }

  const btnPrimary  = (dis) => `px-3 py-1.5 rounded-lg text-[10px] font-mono transition-colors ${dis ? 'bg-white/5 text-white/25 cursor-not-allowed' : 'bg-lime-400 hover:bg-lime-300 text-black'}`;
  const btnLime     = (dis) => `w-full py-1.5 rounded-lg text-[10px] font-mono transition-colors ${dis ? 'bg-white/5 text-white/25' : 'bg-lime-400/10 text-lime-400 border border-lime-400/30 hover:bg-lime-400/20'}`;
  const btnNeutral  = (dis) => `w-full py-1.5 rounded-lg text-[10px] font-mono transition-colors ${dis ? 'bg-white/5 text-white/25' : 'bg-white/10 text-white/70 border border-white/20 hover:bg-white/20'}`;
  const inputCls    = 'flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/20 focus:outline-none focus:border-lime-400/40 font-mono';

  return (
    <div className="bg-white/[0.015] border border-white/[0.08] rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-mono font-bold tracking-[0.16em] text-white/55">COMMUNITY TAKEOVER</div>
        {isCreator && (
          <button onClick={doHeartbeat} disabled={busy || (capChecked && !capId)}
            title={capChecked && !capId ? 'CreatorCap not found for this wallet' : 'Reset the 5-day takeover inactivity clock'}
            className={`shrink-0 px-2.5 py-1 rounded-lg text-[9px] font-mono transition-colors ${busy || (capChecked && !capId) ? 'bg-white/5 text-white/25 cursor-not-allowed' : 'bg-lime-400/10 text-lime-400 border border-lime-400/30 hover:bg-lime-400/20'}`}>
            {busy ? 'WORKING...' : 'HEARTBEAT (RESET TAKEOVER CLOCK)'}
          </button>
        )}
      </div>
      {isCreator && capChecked && !capId && (
        <div className="text-[9px] font-mono text-white/30">CreatorCap not found for this wallet on this curve - heartbeat unavailable.</div>
      )}

      {/* PROPOSE: creator inactive, no live proposal */}
      {proposeState && (
        <div className="space-y-2">
          <p className="text-[11px] font-mono text-white/40 leading-relaxed">
            Creator inactive for 5+ days. Escrow at least {fmtTok(threshold)} tokens (1% of circulating supply) to
            nominate yourself as the new creator. If the takeover passes you become the creator; your stake is
            escrowed and reclaimable after the vote resolves.
          </p>
          {account ? (
            <div className="flex gap-2">
              <input value={stakeInput} onChange={e => setStakeInput(e.target.value)} inputMode="decimal"
                placeholder={`min ${fmtTok(threshold)}`} className={inputCls} />
              <button onClick={doPropose} disabled={busy || !stakeInput.trim()} className={btnPrimary(busy || !stakeInput.trim())}>
                {busy ? 'WORKING...' : 'PROPOSE TAKEOVER'}
              </button>
            </div>
          ) : (
            <div className="text-[10px] font-mono text-white/30">Connect a wallet to propose a takeover.</div>
          )}
        </div>
      )}

      {/* LIVE / AWAITING RESOLVE */}
      {proposal && !resolved && (
        <div className="space-y-2.5">
          <div className="text-[11px] font-mono text-white/50 break-all">
            Proposer: <span className="text-lime-400">{proposal.proposer}</span>
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] font-mono">
              <span className={quorumReached ? 'text-lime-400' : 'text-white/50'}>
                SUPPORT {fmtTok(proposal.totalWeight)}
              </span>
              <span className="text-white/30">QUORUM {fmtTok(quorum)} (25%)</span>
            </div>
            <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-lime-400" style={{ width: `${supportPct}%` }} />
            </div>
            <div className="text-[9px] font-mono text-white/30">
              {quorumReached ? 'Quorum reached.' : `${supportPct.toFixed(1)}% of quorum`}
            </div>
          </div>
          <div className="text-[10px] font-mono text-white/30">
            {live ? `Voting closes in ${fmtDur(proposal.deadlineMs - now)}` : 'Voting closed - awaiting resolution'}
          </div>

          {live && account && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input value={voteInput} onChange={e => setVoteInput(e.target.value)} inputMode="decimal"
                  placeholder={`min ${fmtTok(minVote)}`} className={inputCls} />
                <button onClick={doVote} disabled={busy || !voteInput.trim()} className={btnPrimary(busy || !voteInput.trim())}>
                  {busy ? 'WORKING...' : 'VOTE'}
                </button>
              </div>
              {voted && (
                <button onClick={doUnvote} disabled={busy} className={btnLime(busy)}>
                  {busy ? 'WORKING...' : 'WITHDRAW MY VOTE'}
                </button>
              )}
            </div>
          )}

          {awaitingResolve && account && (
            <button onClick={doResolve} disabled={busy} className={btnNeutral(busy)}>
              {busy ? 'WORKING...' : 'RESOLVE'}
            </button>
          )}
        </div>
      )}

      {/* RESOLVED */}
      {resolved && (
        <div className="space-y-2.5">
          {proposal.succeeded ? (
            <p className="text-[11px] font-mono text-lime-400 leading-relaxed break-all">
              Takeover passed - {proposal.proposer} is now the creator.
            </p>
          ) : (
            <p className="text-[11px] font-mono text-white/50 leading-relaxed">
              Takeover failed - quorum not reached.
            </p>
          )}
          {account && (
            <>
              <button onClick={doReclaim} disabled={busy} className={btnLime(busy)}>
                {busy ? 'WORKING...' : 'RECLAIM MY ESCROW'}
              </button>
              <div className="text-[9px] font-mono text-white/30 leading-relaxed">
                The auto-sweeper normally returns escrowed tokens within a minute, so this is rarely needed.
                Reclaiming twice aborts harmlessly on-chain.
              </div>
            </>
          )}
        </div>
      )}

      {msg && <div className="text-[10px] font-mono text-white/40 break-all">{msg}</div>}
    </div>
  );
}
