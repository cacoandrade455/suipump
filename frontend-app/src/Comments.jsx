// Comments.jsx — on-chain comments + replies
//   V4-V9: top-level comments on-chain; replies off-chain (localStorage).
//   V10:   holder-gated comments AND replies on-chain via post_comment's
//          holder_coin + parent_id args. parent_id = parent comment's tx digest.
import React, { useState, useEffect, useRef } from 'react';
import { useCurrentAccount, useDAppKit, useCurrentClient } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { Send, Reply, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router-dom';

function getPfp(addr) { try { return localStorage.getItem(`suipump_pfp_${addr}`) || ''; } catch { return ''; } }
import {
  ALL_PACKAGE_IDS,
  PACKAGE_ID_V4, PACKAGE_ID_V5, PACKAGE_ID_V6,
  PACKAGE_ID_V7, PACKAGE_ID_V8_1, PACKAGE_ID_V8,
  COMMENT_FEE_MIST, isV7OrLater, isV9OrLater, isV10OrLater,
} from './constants.js';

// The zero address — V10 parent_id sentinel for a top-level comment.
const ZERO_ADDR = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Fetch the caller's largest coin object of `coinType` (for V10 holder_coin proof).
// Returns the coinObjectId string, or null if the caller holds none.
async function firstCoinObjectId(client, owner, coinType) {
  if (!client || !owner || !coinType) return null;
  try {
    const res = await client.getCoins({ owner, coinType });
    const coins = res?.data ?? res?.coins ?? [];
    if (!coins.length) return null;
    // Pick the highest-balance coin so the borrow always sees balance > 0.
    let best = coins[0];
    for (const c of coins) {
      if (BigInt(c.balance ?? 0) > BigInt(best.balance ?? 0)) best = c;
    }
    return best.coinObjectId ?? best.objectId ?? null;
  } catch {
    return null;
  }
}

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

function walletColor(addr) {
  if (!addr) return '#84cc16';
  const hue = parseInt(addr.slice(2, 6), 16) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

function shortAddr(addr) {
  if (!addr) return '—';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// Build a V10 post_comment moveCall onto `tx`. parentId = ZERO_ADDR for a
// top-level comment, else the parent comment's tx digest (as an address).
// Caller must have already resolved `holderCoinId` (their token coin object).
// V10 sig: post_comment<T>(curve, text, payment, author, &holder_coin, parent_id, ctx)
function buildV10PostComment({ tx, curveRef, packageId, tokenType, text, author, holderCoinId, parentId }) {
  const [feeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(COMMENT_FEE_MIST))]);
  tx.moveCall({
    target: `${packageId}::bonding_curve::post_comment`,
    typeArguments: [tokenType],
    arguments: [
      curveRef,
      tx.pure.string(text),
      feeCoin,
      tx.pure.address(author),
      tx.object(holderCoinId),
      tx.pure.address(parentId ?? ZERO_ADDR),
    ],
  });
}

function loadReplies(curveId) {
  try {
    const raw = localStorage.getItem(`suipump_replies_${curveId}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveReply(curveId, reply) {
  const existing = loadReplies(curveId);
  existing.push(reply);
  localStorage.setItem(`suipump_replies_${curveId}`, JSON.stringify(existing));
}

function CommentItem({ comment, replies, account, curveId, onReplyPosted,
                      isV10, packageId, tokenType, initialSharedVersion,
                      client, dAppKit, holderCoinId, onNeedHolder }) {
  const [showReplies, setShowReplies] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replyErr, setReplyErr] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const inputRef = useRef(null);
  const replyCount = replies.length;

  const handleOpenReply = () => {
    setReplyOpen(o => !o);
    setShowReplies(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handlePostReply = async () => {
    const trimmed = replyText.trim();
    if (!trimmed || !account || replyBusy) return;
    if (trimmed.length > 200) { setReplyErr('Max 200 characters'); return; }

    // ── Legacy (V4-V9): replies stay off-chain in localStorage ──
    if (!isV10) {
      const reply = {
        id: `reply_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        parentId: comment.id, author: account.address, text: trimmed, timestamp: Date.now(),
      };
      saveReply(curveId, reply);
      onReplyPosted(reply);
      setReplyText(''); setReplyOpen(false); setReplyErr('');
      return;
    }

    // ── V10: reply is an on-chain post_comment with parent_id = parent tx digest ──
    setReplyBusy(true); setReplyErr('');
    try {
      // Resolve the holder coin (proves balance > 0). Parent passes its cached
      // id when it has one; otherwise fetch on demand.
      let coinId = holderCoinId;
      if (!coinId) coinId = await firstCoinObjectId(client, account.address, tokenType);
      if (!coinId) { setReplyErr('Hold the token to reply'); onNeedHolder?.(); setReplyBusy(false); return; }

      const parentDigest = comment.digestKey ?? null;
      if (!parentDigest) { setReplyErr('Parent not yet on-chain — try again in a moment'); setReplyBusy(false); return; }

      const isv = initialSharedVersion;
      const tx = new Transaction();
      const curveRef = isv
        ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: String(isv), mutable: true })
        : tx.object(curveId);

      buildV10PostComment({
        tx, curveRef, packageId, tokenType,
        text: trimmed, author: account.address,
        holderCoinId: coinId, parentId: parentDigest,
      });

      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (result.FailedTransaction) throw new Error(result.FailedTransaction.status.error ?? 'Reply failed');
      const txDigest = result.digest ?? result.Transaction?.digest ?? null;

      // Optimistic: surface the reply immediately, keyed on parent digest.
      onReplyPosted({
        id: txDigest ? `${txDigest}_0` : `reply_${Date.now()}`,
        digestKey: txDigest,
        parentId: parentDigest,
        author: account.address, text: trimmed, timestamp: Date.now(),
      });
      setReplyText(''); setReplyOpen(false); setReplyErr('');
    } catch (err) {
      setReplyErr(err.message || 'Failed to reply');
    } finally {
      setReplyBusy(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePostReply(); }
    if (e.key === 'Escape') { setReplyOpen(false); setReplyText(''); }
  };

  return (
    <div className="px-4 py-3 hover:bg-white/[0.02] transition-colors">
      <div className="flex items-start gap-2.5">
        <Link to={`/portfolio/${comment.author}`} className="w-6 h-6 rounded-full flex-shrink-0 mt-0.5 overflow-hidden block hover:ring-1 hover:ring-lime-400/40 transition-all">
          {getPfp(comment.author)
            ? <img src={getPfp(comment.author)} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center text-[9px] font-bold text-black"
                style={{ backgroundColor: walletColor(comment.author) }}>
                {comment.author?.slice(2, 4).toUpperCase()}
              </div>
          }
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Link to={`/portfolio/${comment.author}`} className="text-[10px] font-mono text-white/50 hover:text-lime-400 transition-colors">{shortAddr(comment.author)}</Link>
            <span className="text-[10px] font-mono text-white/25">{timeAgo(comment.timestamp)}</span>
          </div>
          <p className="text-sm text-white/70 leading-relaxed break-words">{comment.text}</p>
          <div className="flex items-center gap-3 mt-2">
            {account && (
              <button onClick={handleOpenReply}
                className={`flex items-center gap-1 text-[10px] font-mono transition-colors ${replyOpen ? 'text-lime-400' : 'text-white/25 hover:text-white/50'}`}>
                <Reply size={9} /> Reply
              </button>
            )}
            {replyCount > 0 && (
              <button onClick={() => setShowReplies(o => !o)}
                className="flex items-center gap-1 text-[10px] font-mono text-white/25 hover:text-white/50 transition-colors">
                {showReplies ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </div>
          {replyOpen && (
            <div className="mt-2 space-y-1.5">
              <div className="flex gap-2">
                <input ref={inputRef} value={replyText} onChange={e => setReplyText(e.target.value)} onKeyDown={handleKey}
                  placeholder="Write a reply…" maxLength={200}
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/20 focus:outline-none focus:border-lime-400/40 font-mono" />
                <button onClick={handlePostReply} disabled={!replyText.trim() || replyBusy}
                  className={`px-2.5 py-1.5 rounded-lg text-[10px] font-mono transition-colors ${!replyText.trim() || replyBusy ? 'bg-white/5 text-white/25 cursor-not-allowed' : 'bg-lime-400 hover:bg-lime-300 text-black'}`}>
                  <Send size={12} />
                </button>
              </div>
              <div className="flex items-center justify-between pl-7">
                {replyErr ? <span className="text-[10px] font-mono text-red-400">{replyErr}</span> : <span />}
                <span className="text-[10px] font-mono text-white/25">{replyText.length}/200</span>
              </div>
            </div>
          )}
          {showReplies && replyCount > 0 && (
            <div className="mt-3 space-y-3 border-l-2 border-white/5 pl-3">
              {replies.map(r => (
                <div key={r.id} className="flex items-start gap-2">
                  <div className="w-5 h-5 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center text-[8px] font-bold text-black"
                    style={{ backgroundColor: walletColor(r.author) }}>
                    {r.author?.slice(2, 4).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Link to={`/portfolio/${r.author}`} className="text-[10px] font-mono text-white/50 hover:text-lime-400 transition-colors">{shortAddr(r.author)}</Link>
                      <span className="text-[10px] font-mono text-white/25">{timeAgo(r.timestamp)}</span>
                    </div>
                    <p className="text-xs text-white/60 leading-relaxed break-words">{r.text}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Comments({ curveId, packageId, initialSharedVersion = null, tokenType = null }) {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const client  = useCurrentClient();

  const isV10 = packageId ? isV10OrLater(packageId) : false;

  const [comments, setComments] = useState([]);
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState('');
  // V10 holder gate: the caller's token coin object id (null = holds none).
  const [holderCoinId, setHolderCoinId] = useState(null);
  const bottomRef = useRef(null);
  const esRef = useRef(null);
  const timerRef = useRef(null);

  // V10 only: resolve whether the connected wallet holds this token, so the
  // post/reply UI can gate on it and we have the coin object for holder_coin.
  useEffect(() => {
    if (!isV10 || !account || !tokenType || !client) { setHolderCoinId(null); return; }
    let cancelled = false;
    (async () => {
      const id = await firstCoinObjectId(client, account.address, tokenType);
      if (!cancelled) setHolderCoinId(id);
    })();
    return () => { cancelled = true; };
  }, [isV10, account?.address, tokenType, client, comments.length]);

  useEffect(() => {
    if (!curveId) return;
    let cancelled = false;

    async function load() {
      try {
        let loadedComments = [];
        let loadedReplies  = [];
        if (INDEXER_URL) {
          try {
            const res = await fetch(`${INDEXER_URL}/token/${curveId}/comments`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const rows = await res.json();
              const mapped = rows.map(r => ({
                id:        r.tx_digest + '_' + (r.event_seq ?? 0),
                digestKey: r.tx_digest ?? null,
                author:    r.author ?? r.data?.author ?? '',
                text:      r.text  ?? r.data?.text  ?? '',
                parentId:  r.parent_id ?? r.data?.parent_id ?? null,
                timestamp: r.timestamp_ms ? Number(r.timestamp_ms) : null,
                curveId,
              }));
              // V10: a row with a non-zero parent_id is a reply; split it out so
              // the tree is reconstructed from chain. Legacy rows have no
              // parent_id and are all top-level.
              if (isV10) {
                loadedComments = mapped.filter(c => !c.parentId || c.parentId === ZERO_ADDR);
                loadedReplies  = mapped
                  .filter(c => c.parentId && c.parentId !== ZERO_ADDR)
                  .map(c => ({ id: c.id, digestKey: c.digestKey, parentId: c.parentId,
                               author: c.author, text: c.text, timestamp: c.timestamp }));
              } else {
                loadedComments = mapped;
              }
            }
          } catch {}
        }
        if (!cancelled) {
          setComments(loadedComments);
          // V10 replies are reconstructed from chain; legacy from localStorage.
          setReplies(isV10 ? loadedReplies : loadReplies(curveId));
        }
      } catch {} finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    // SSE for real-time comments — stable ref pattern:
    // cancelled flag guards both connect() and the reconnect timeout so no
    // phantom EventSources survive after unmount or curveId change.
    function connect() {
      if (cancelled || !INDEXER_URL) return;
      const es = new EventSource(`${INDEXER_URL}/stream?curveId=${curveId}`);
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'Comment') {
            const d = event.data ?? {};
            // ID format matches indexer: txDigest + '_0'
            // event.digest is populated by the indexer's pg_notify payload
            const txDigest = event.digest ?? d.tx_digest ?? null;
            const author = d.author ?? '';
            const cText = d.text ?? '';
            const parentId = d.parent_id ?? null;
            const id = txDigest ? `${txDigest}_0` : `sse_${author}_${cText}`;

            // V10: a Comment carrying a non-zero parent_id is a reply → replies state.
            if (isV10 && parentId && parentId !== ZERO_ADDR) {
              setReplies(prev => {
                if (txDigest && prev.find(r => r.digestKey === txDigest)) return prev;
                if (prev.find(r => r.id === id)) return prev;
                return [...prev, { id, digestKey: txDigest, parentId, author, text: cText, timestamp: event.ts ?? Date.now() }];
              });
              return;
            }

            setComments(prev => {
              // Dedup on the bare tx_digest, NOT the seq-suffixed id. The initial
              // load keys comments as `${digest}_${event_seq}` (seq may be nonzero),
              // while SSE/optimistic use `${digest}_0` — so matching on full id
              // missed same-digest comments and rendered duplicates until refresh.
              if (txDigest && prev.find(c => c.digestKey === txDigest)) return prev;
              if (prev.find(c => c.id === id)) return prev;
              // Last-resort guard when no digest: don't append an identical
              // author+text that's already present from the optimistic add.
              if (!txDigest && prev.find(c => c.author === author && c.text === cText)) return prev;
              return [...prev, { id, digestKey: txDigest, author, text: cText, parentId: parentId ?? null, timestamp: event.ts ?? Date.now(), curveId }];
            });
          }
        } catch {}
      };
      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (!cancelled) timerRef.current = setTimeout(connect, 3000);
      };
    }
    connect();

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
      clearTimeout(timerRef.current);
    };
  }, [curveId]);

  const handlePost = async () => {
    const trimmed = text.trim();
    if (!trimmed || !account || posting) return;
    if (trimmed.length > 500) { setPostErr('Max 500 characters'); return; }
    if (!packageId) { setPostErr('Package ID not available'); return; }

    setPosting(true); setPostErr('');
    try {
      // Resolve initialSharedVersion — try prop first, then indexer, then fail gracefully
      let isv = initialSharedVersion;
      if (!isv && INDEXER_URL) {
        try {
          const r = await fetch(`${INDEXER_URL}/token/${curveId}`, { signal: AbortSignal.timeout(4000) });
          if (r.ok) { const d = await r.json(); isv = d.initialSharedVersion ?? d.initial_shared_version ?? null; }
        } catch {}
      }

      const tx = new Transaction();
      const isV7 = isV7OrLater(packageId);

      // post_comment takes &mut Curve<T> — MUST use sharedObjectRef
      const curveRef = isv
        ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: String(isv), mutable: true })
        : tx.object(curveId);

      if (isV10) {
        // V10: holder-gated. Resolve the caller's token coin object first.
        let coinId = holderCoinId;
        if (!coinId) coinId = await firstCoinObjectId(client, account.address, tokenType);
        if (!coinId) { setPostErr('Hold the token to comment'); setPosting(false); return; }
        buildV10PostComment({
          tx, curveRef, packageId, tokenType,
          text: trimmed, author: account.address,
          holderCoinId: coinId, parentId: ZERO_ADDR,
        });
      } else if (isV7 && COMMENT_FEE_MIST && BigInt(COMMENT_FEE_MIST) > 0n) {
        const [feeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(COMMENT_FEE_MIST))]);
        if (isV9OrLater(packageId)) {
          // V9: post_comment<T>(curve, text, payment, author, ctx)
          tx.moveCall({
            target: `${packageId}::bonding_curve::post_comment`,
            typeArguments: [tokenType],
            arguments: [curveRef, tx.pure.string(trimmed), feeCoin, tx.pure.address(account.address)],
          });
        } else {
          // V7/V8: post_comment<T>(curve, payment, text, ctx)
          tx.moveCall({
            target: `${packageId}::bonding_curve::post_comment`,
            typeArguments: [tokenType],
            arguments: [curveRef, feeCoin, tx.pure.string(trimmed)],
          });
        }
      } else {
        // V4/V5/V6: post_comment(curve_id, text, ctx) — no fee, no type arg
        tx.moveCall({
          target: `${packageId}::bonding_curve::post_comment`,
          arguments: [tx.pure.address(curveId), tx.pure.string(trimmed)],
        });
      }

      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (result.FailedTransaction) throw new Error(result.FailedTransaction.status.error ?? 'Post failed');

      const txDigest = result.digest ?? result.Transaction?.digest ?? null;
      setText('');
      // Optimistic update — keyed on the bare tx_digest so the SSE event for the
      // same comment dedups against it (both use digestKey) instead of appending.
      setComments(prev => {
        const id = txDigest ? `${txDigest}_0` : `opt_${Date.now()}`;
        if (txDigest && prev.find(c => c.digestKey === txDigest)) return prev;
        if (prev.find(c => c.id === id)) return prev;
        return [...prev, { id, digestKey: txDigest, author: account.address, text: trimmed, timestamp: Date.now(), curveId }];
      });
    } catch (err) {
      setPostErr(err.message || 'Failed to post comment');
    } finally {
      setPosting(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePost(); }
  };

  // Final render-time dedup: collapse any same-digest duplicates that could slip
  // through a state race, so the list can never DISPLAY one comment twice.
  // Keyed on digestKey when present, else id.
  const seenKeys = new Set();
  const visibleComments = comments.filter(c => {
    const k = c.digestKey ?? c.id;
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });

  const repliesByParent = {};
  for (const r of replies) {
    // V10 replies reference the parent's tx digest; legacy reference parent id.
    const k = r.parentId;
    if (!k) continue;
    if (!repliesByParent[k]) repliesByParent[k] = [];
    repliesByParent[k].push(r);
  }
  // Resolve a comment's reply bucket: V10 by digestKey, legacy by id.
  const repliesFor = (c) => repliesByParent[isV10 ? (c.digestKey ?? c.id) : c.id] || [];

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden">
      {loading ? (
        <div className="py-8 text-center text-white/20 text-xs font-mono">Loading…</div>
      ) : visibleComments.length === 0 ? (
        <div className="py-8 text-center text-white/20 text-xs font-mono">No comments yet. Be the first!</div>
      ) : (
        <div className="divide-y divide-white/5 max-h-[500px] overflow-y-auto">
          {visibleComments.map(c => (
            <CommentItem
              key={c.id}
              comment={c}
              replies={repliesFor(c)}
              account={account}
              curveId={curveId}
              onReplyPosted={(r) => setReplies(prev => [...prev, r])}
              isV10={isV10}
              packageId={packageId}
              tokenType={tokenType}
              initialSharedVersion={initialSharedVersion}
              client={client}
              dAppKit={dAppKit}
              holderCoinId={holderCoinId}
              onNeedHolder={() => {}}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
      {account && (
        <div className="border-t border-white/10 p-3 space-y-2">
          {isV10 && !holderCoinId ? (
            <div className="py-2 text-center text-[11px] font-mono text-white/30">
              Hold the token to comment.
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value.slice(0, 500))}
                  onKeyDown={handleKey}
                  placeholder="Write a comment… (Enter to post)"
                  rows={2}
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-lime-400/40 font-mono resize-none transition-colors"
                />
                <button onClick={handlePost} disabled={!text.trim() || posting}
                  className={`px-3 py-2 rounded-xl text-sm font-mono transition-colors self-end ${!text.trim() || posting ? 'bg-white/5 text-white/20 cursor-not-allowed' : 'bg-lime-400 hover:bg-lime-300 text-black'}`}>
                  <Send size={14} />
                </button>
              </div>
              <div className="flex items-center justify-between px-1">
                {postErr ? <span className="text-[10px] font-mono text-red-400">{postErr}</span> : <span />}
                <span className="text-[10px] font-mono text-white/25">{text.length}/500</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
