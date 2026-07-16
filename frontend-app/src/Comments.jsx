// Comments.jsx - on-chain comments + replies
//   V4-V9: top-level comments on-chain; replies off-chain (localStorage).
//   V10:   holder-gated comments AND replies on-chain via post_comment's
//          holder_coin + parent_id args. parent_id = parent comment's tx digest.
import React, { useState, useEffect, useRef } from 'react';
import { useCurrentAccount, useDAppKit, useCurrentClient } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { Send, Reply, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { t } from './i18n.js';

function getPfp(addr) { try { return localStorage.getItem(`suipump_pfp_${addr}`) || ''; } catch { return ''; } }
import {
  ALL_PACKAGE_IDS,
  PACKAGE_ID_V4, PACKAGE_ID_V5, PACKAGE_ID_V6,
  PACKAGE_ID_V7, PACKAGE_ID_V8_1, PACKAGE_ID_V8,
  COMMENT_FEE_MIST, isV7OrLater, isV9OrLater, isV10OrLater,
  PACKAGE_ID, PACKAGE_ID_V12,
} from './constants.js';

// Sui GraphQL endpoint - same one CommentGatePanel (TokenPage.jsx) reads
// CommentGateSet events from.
const SUI_GQL_URL = 'https://graphql.testnet.sui.io/graphql';

// The zero address - V10 parent_id sentinel for a top-level comment.
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
  if (!addr) return '-';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// Build a lineage post_comment moveCall onto `tx`. parentId = ZERO_ADDR for a
// top-level comment, else the parent comment's tx digest (as an address).
// Sig (V13+): post_comment<T>(curve, text, payment, &holder_coin, parent_id, ctx)
// V13 derives the comment author from the tx sender on-chain (audit F-7) -- no author arg.
//
// TARGET: the ACTIVE package (V12+), NOT the curve-derived packageId. The curve
// type defines at V10 forever, but V10 bytecode holder-gates UNCONDITIONALLY --
// targeting it would silently ignore the creator's V12 COMMENTS ACCESS toggle.
//
// holderCoinId may be null (caller holds none of the token): we mint a zero
// coin, borrow it into post_comment, and destroy it afterwards. If the curve
// is holder-gated the contract aborts EHolderOnly(37) -- callers map that to
// the friendly "hold the token" message; if the creator opened comments, the
// zero coin passes and anyone can post.
function buildV10PostComment({ tx, curveRef, packageId: _packageId, tokenType, text, holderCoinId, parentId }) {
  const [feeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(COMMENT_FEE_MIST))]);
  let holderArg;
  let zeroCoin = null;
  if (holderCoinId) {
    holderArg = tx.object(holderCoinId);
  } else {
    [zeroCoin] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [tokenType], arguments: [] });
    holderArg = zeroCoin;
  }
  tx.moveCall({
    target: `${PACKAGE_ID}::bonding_curve::post_comment`,
    typeArguments: [tokenType],
    arguments: [
      curveRef,
      tx.pure.string(text),
      feeCoin,
      holderArg,
      tx.pure.address(parentId ?? ZERO_ADDR),
    ],
  });
  if (zeroCoin) {
    tx.moveCall({ target: '0x2::coin::destroy_zero', typeArguments: [tokenType], arguments: [zeroCoin] });
  }
}

// Map the on-chain holder-gate abort to the friendly message. EHolderOnly = 37
// in bonding_curve; abort strings look like "...bonding_curve...} 37) ...".
function isHolderGateAbort(err) {
  const t = String(err?.message ?? err ?? '');
  return /bonding_curve/.test(t) && /\b37\b/.test(t);
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
                      client, dAppKit, holderCoinId, holderGated, onNeedHolder }) {
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

    // -- Legacy (V4-V9): replies stay off-chain in localStorage --
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

    // -- V10: reply is an on-chain post_comment with parent_id = parent tx digest --
    setReplyBusy(true); setReplyErr('');
    try {
      // Resolve the holder coin (proves balance > 0). Parent passes its cached
      // id when it has one; otherwise fetch on demand.
      let coinId = holderCoinId;
      if (!coinId) coinId = await firstCoinObjectId(client, account.address, tokenType);
      // Non-holders proceed via the zero-coin path (posts when the creator
      // opened comments; clean abort mapping when holder-gated).

      const parentDigest = comment.digestKey ?? null;
      if (!parentDigest) { setReplyErr('Parent not yet on-chain - try again in a moment'); setReplyBusy(false); return; }

      const isv = initialSharedVersion;
      const tx = new Transaction();
      const curveRef = isv
        ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: String(isv), mutable: true })
        : tx.object(curveId);

      buildV10PostComment({
        tx, curveRef, packageId, tokenType,
        text: trimmed,
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
      setReplyErr(isHolderGateAbort(err) ? 'Hold the token to reply' : (err.message || 'Failed to reply'));
    } finally {
      setReplyBusy(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePostReply(); }
    if (e.key === 'Escape') { setReplyOpen(false); setReplyText(''); }
  };

  return (
    <div className="-mx-2 px-2 py-2 rounded-lg hover:bg-white/[0.02] transition-colors">
      <div className="flex items-start gap-[11px]">
        <Link to={`/portfolio/${comment.author}`} className="w-7 h-7 rounded-[9px] flex-shrink-0 overflow-hidden block border border-white/[0.12] hover:ring-1 hover:ring-lime-400/40 transition-all">
          {getPfp(comment.author)
            ? <img src={getPfp(comment.author)} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center text-[9px] font-bold text-black"
                style={{ backgroundColor: walletColor(comment.author) }}>
                {comment.author?.slice(2, 4).toUpperCase()}
              </div>
          }
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Link to={`/portfolio/${comment.author}`} className="text-[11px] font-mono font-semibold text-white/75 hover:text-lime-400 transition-colors">{shortAddr(comment.author)}</Link>
            <span className="text-[9.5px] font-mono text-white/28">{timeAgo(comment.timestamp)}</span>
          </div>
          <p className="text-xs text-white/60 leading-[1.55] break-words mt-1.5">{comment.text}</p>
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
              {isV10 && holderGated && !holderCoinId ? (
                <p className="text-[10px] font-mono text-white/30 pl-1">Hold the token to reply.</p>
              ) : (
                <>
                  <div className="flex gap-2">
                    <input ref={inputRef} value={replyText} onChange={e => setReplyText(e.target.value)} onKeyDown={handleKey}
                      placeholder="Write a reply..." maxLength={200}
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
                </>
              )}
            </div>
          )}
          {showReplies && replyCount > 0 && (
            <div className="mt-3 space-y-3 border-l-2 border-lime-400/20 pl-3">
              {replies.map(r => (
                <div key={r.id} className="flex items-start gap-[11px]">
                  <div className="w-[22px] h-[22px] rounded-[7px] flex-shrink-0 flex items-center justify-center text-[8px] font-bold text-black border border-white/[0.12]"
                    style={{ backgroundColor: walletColor(r.author) }}>
                    {r.author?.slice(2, 4).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Link to={`/portfolio/${r.author}`} className="text-[11px] font-mono font-semibold text-white/75 hover:text-lime-400 transition-colors">{shortAddr(r.author)}</Link>
                      <span className="text-[9.5px] font-mono text-white/28">{timeAgo(r.timestamp)}</span>
                    </div>
                    <p className="text-xs text-white/60 leading-[1.55] break-words mt-1.5">{r.text}</p>
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

export default function Comments({ curveId, packageId, initialSharedVersion = null, tokenType = null, lang = 'en' }) {
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
  // V12 creator toggle: whether comments are holder-gated on this curve.
  // Contract default = TRUE (holder-gated); CommentGateSet events (defined
  // under V12) override it, latest wins. Mirrors CommentGatePanel's read in
  // TokenPage.jsx. On read failure we keep the safe default - the composer
  // then behaves exactly like pre-toggle V10, and the on-chain abort mapping
  // remains the backstop either way.
  const [holderGated, setHolderGated] = useState(true);
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

  // V10-lineage only: read the creator's COMMENTS ACCESS toggle so the composer
  // gates only when the curve is actually holder-gated. Same event read as
  // CommentGatePanel: CommentGateSet types under V12, filter to this curve,
  // latest event wins; no events = holder-gated (the contract default).
  useEffect(() => {
    if (!isV10 || !curveId) { setHolderGated(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const evType = `${PACKAGE_ID_V12}::bonding_curve::CommentGateSet`;
        const q = `{ events(filter: { type: "${evType}" }, last: 50) { nodes { contents { json } } } }`;
        const r = await fetch(SUI_GQL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q }),
          signal: AbortSignal.timeout(8000),
        });
        const d = await r.json();
        const mine = (d?.data?.events?.nodes ?? [])
          .map(n => n.contents?.json)
          .filter(j => j && (j.curve_id ?? '').toLowerCase() === curveId.toLowerCase());
        const latest = mine.length ? mine[mine.length - 1] : null;
        if (!cancelled) {
          setHolderGated(latest ? (latest.holder_gated === true || latest.holder_gated === 'true') : true);
        }
      } catch { /* keep the safe contract default */ }
    })();
    return () => { cancelled = true; };
  }, [isV10, curveId]);

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

    // SSE for real-time comments - stable ref pattern:
    // cancelled flag guards both connect() and the reconnect timeout so no
    // phantom EventSources survive after unmount or curveId change.
    function connect() {
      if (cancelled || !INDEXER_URL) return;
      const es = new EventSource(`${INDEXER_URL}/stream?curveId=${curveId}`);
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          // Live COMMENTS ACCESS toggle: the indexer streams CommentGateSet, so
          // the composer opens/locks the moment the creator flips the gate.
          if (event.type === 'CommentGateSet') {
            const g = event.data ?? {};
            setHolderGated(g.holder_gated === true || g.holder_gated === 'true');
            return;
          }
          if (event.type === 'Comment') {
            const d = event.data ?? {};
            // ID format matches indexer: txDigest + '_0'
            // event.digest is populated by the indexer's pg_notify payload
            const txDigest = event.digest ?? d.tx_digest ?? null;
            const author = d.author ?? '';
            const cText = d.text ?? '';
            const parentId = d.parent_id ?? null;
            const id = txDigest ? `${txDigest}_0` : `sse_${author}_${cText}`;

            // V10: a Comment carrying a non-zero parent_id is a reply -> replies state.
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
              // while SSE/optimistic use `${digest}_0` - so matching on full id
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
      // Resolve initialSharedVersion - try prop first, then indexer, then fail gracefully
      let isv = initialSharedVersion;
      if (!isv && INDEXER_URL) {
        try {
          const r = await fetch(`${INDEXER_URL}/token/${curveId}`, { signal: AbortSignal.timeout(4000) });
          if (r.ok) { const d = await r.json(); isv = d.initialSharedVersion ?? d.initial_shared_version ?? null; }
        } catch {}
      }

      const tx = new Transaction();
      const isV7 = isV7OrLater(packageId);

      // post_comment takes &mut Curve<T> - MUST use sharedObjectRef
      const curveRef = isv
        ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: String(isv), mutable: true })
        : tx.object(curveId);

      if (isV10) {
        // V10: holder-gated. Resolve the caller's token coin object first.
        let coinId = holderCoinId;
        if (!coinId) coinId = await firstCoinObjectId(client, account.address, tokenType);
        // No coin held is no longer a hard stop: if the creator opened comments
        // (V12 toggle) the zero-coin path posts fine; if still holder-gated the
        // contract aborts and we surface the friendly message below.
        buildV10PostComment({
          tx, curveRef, packageId, tokenType,
          text: trimmed,
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
        // V4/V5/V6: post_comment(curve_id, text, ctx) - no fee, no type arg
        tx.moveCall({
          target: `${packageId}::bonding_curve::post_comment`,
          arguments: [tx.pure.address(curveId), tx.pure.string(trimmed)],
        });
      }

      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (result.FailedTransaction) throw new Error(result.FailedTransaction.status.error ?? 'Post failed');

      const txDigest = result.digest ?? result.Transaction?.digest ?? null;
      setText('');
      // Optimistic update - keyed on the bare tx_digest so the SSE event for the
      // same comment dedups against it (both use digestKey) instead of appending.
      setComments(prev => {
        const id = txDigest ? `${txDigest}_0` : `opt_${Date.now()}`;
        if (txDigest && prev.find(c => c.digestKey === txDigest)) return prev;
        if (prev.find(c => c.id === id)) return prev;
        return [...prev, { id, digestKey: txDigest, author: account.address, text: trimmed, timestamp: Date.now(), curveId }];
      });
    } catch (err) {
      setPostErr(isHolderGateAbort(err) ? 'Hold the token to comment' : (err.message || 'Failed to post comment'));
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
    <div className="border border-white/[0.08] rounded-2xl bg-white/[0.015] p-4">
      {/* Header (design: COMMENTS + live gate subtitle) */}
      <div className="flex items-center gap-2 mb-3.5 flex-wrap">
        <span className="text-[10px] font-mono font-bold tracking-[0.16em] text-white/55">{t(lang, 'comments')}</span>
        {isV10 && (
          <span className="text-[9.5px] font-mono text-white/30">
            {holderGated ? t(lang, 'commentsGateHolders') : t(lang, 'commentsGateOpen')} {'·'} {t(lang, 'commentsPostInfo')}
          </span>
        )}
      </div>

      {/* Composer (design: bordered box directly under header) */}
      {account && (
        <div className="mb-3.5">
          {isV10 && holderGated && !holderCoinId ? (
            <div className="py-2 text-center text-[11px] font-mono text-white/30">
              Hold the token to comment.
            </div>
          ) : (
            <>
              <div className="flex items-start gap-2.5 border border-white/[0.09] rounded-[11px] px-3.5 py-[11px] bg-white/[0.02] focus-within:border-lime-400/40 transition-colors">
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value.slice(0, 500))}
                  onKeyDown={handleKey}
                  placeholder="Write a comment... (Enter to post)"
                  rows={1}
                  className="flex-1 bg-transparent border-0 p-0 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-0 font-mono resize-none leading-snug"
                />
                <button onClick={handlePost} disabled={!text.trim() || posting}
                  className={`h-7 px-3 rounded-lg text-[10px] font-mono font-bold transition-colors flex items-center gap-1 self-start ${!text.trim() || posting ? 'bg-white/5 text-white/20 cursor-not-allowed' : 'bg-lime-400 hover:bg-lime-300 text-black'}`}>
                  <Send size={12} />
                </button>
              </div>
              <div className="flex items-center justify-between px-1 mt-1.5">
                {postErr ? <span className="text-[10px] font-mono text-red-400">{postErr}</span> : <span />}
                <span className="text-[10px] font-mono text-white/25">{text.length}/500</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Comment list */}
      {loading ? (
        <div className="py-8 text-center text-white/20 text-xs font-mono">Loading...</div>
      ) : visibleComments.length === 0 ? (
        <div className="py-8 text-center text-white/20 text-xs font-mono">No comments yet. Be the first!</div>
      ) : (
        <div className="flex flex-col gap-3 max-h-[500px] overflow-y-auto">
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
              holderGated={holderGated}
              onNeedHolder={() => {}}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
