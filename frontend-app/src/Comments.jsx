// Comments.jsx — on-chain comments + off-chain replies (localStorage)
import React, { useState, useEffect, useRef } from 'react';
import { useCurrentAccount, useDAppKit } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { Send, Reply, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router-dom';

function getPfp(addr) { try { return localStorage.getItem(`suipump_pfp_${addr}`) || ''; } catch { return ''; } }
import {
  ALL_PACKAGE_IDS,
  PACKAGE_ID_V4, PACKAGE_ID_V5, PACKAGE_ID_V6,
  PACKAGE_ID_V7, PACKAGE_ID_V8_1, PACKAGE_ID_V8,
  COMMENT_FEE_MIST, isV7OrLater,
} from './constants.js';

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

function CommentItem({ comment, replies, account, curveId, onReplyPosted }) {
  const [showReplies, setShowReplies] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replyErr, setReplyErr] = useState('');
  const inputRef = useRef(null);
  const replyCount = replies.length;

  const handleOpenReply = () => {
    setReplyOpen(o => !o);
    setShowReplies(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handlePostReply = () => {
    const trimmed = replyText.trim();
    if (!trimmed || !account) return;
    if (trimmed.length > 200) { setReplyErr('Max 200 characters'); return; }
    const reply = {
      id: `reply_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      parentId: comment.id, author: account.address, text: trimmed, timestamp: Date.now(),
    };
    saveReply(curveId, reply);
    onReplyPosted(reply);
    setReplyText(''); setReplyOpen(false); setReplyErr('');
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
                <button onClick={handlePostReply} disabled={!replyText.trim()}
                  className={`px-2.5 py-1.5 rounded-lg text-[10px] font-mono transition-colors ${!replyText.trim() ? 'bg-white/5 text-white/25 cursor-not-allowed' : 'bg-lime-400 hover:bg-lime-300 text-black'}`}>
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

export default function Comments({ curveId, packageId, initialSharedVersion = null }) {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();

  const [comments, setComments] = useState([]);
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState('');
  const bottomRef = useRef(null);
  const esRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!curveId) return;
    let cancelled = false;

    async function load() {
      try {
        let loadedComments = [];
        if (INDEXER_URL) {
          try {
            const res = await fetch(`${INDEXER_URL}/token/${curveId}/comments`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const rows = await res.json();
              loadedComments = rows.map(r => ({
                id:        r.tx_digest + '_' + (r.event_seq ?? 0),
                author:    r.author ?? r.data?.author ?? '',
                text:      r.text  ?? r.data?.text  ?? '',
                timestamp: r.timestamp_ms ? Number(r.timestamp_ms) : null,
                curveId,
              }));
            }
          } catch {}
        }
        if (!cancelled) {
          setComments(loadedComments);
          setReplies(loadReplies(curveId));
        }
      } catch {} finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    // SSE for real-time comments
    function connect() {
      if (!INDEXER_URL) return;
      const es = new EventSource(`${INDEXER_URL}/stream?curveId=${curveId}`);
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'Comment') {
            const d = event.data ?? {};
            setComments(prev => {
              const id = (d.tx_digest || event.txDigest || `${Date.now()}`) + '_sse';
              if (prev.find(c => c.id === id)) return prev;
              return [...prev, { id, author: d.author ?? '', text: d.text ?? '', timestamp: event.ts ?? Date.now(), curveId }];
            });
          }
        } catch {}
      };
      es.onerror = () => { es.close(); timerRef.current = setTimeout(connect, 3000); };
    }
    connect();

    return () => {
      cancelled = true;
      esRef.current?.close();
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

      if (isV7 && COMMENT_FEE_MIST && BigInt(COMMENT_FEE_MIST) > 0n) {
        const [feeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(COMMENT_FEE_MIST))]);
        tx.moveCall({
          target: `${packageId}::bonding_curve::post_comment`,
          arguments: [curveRef, feeCoin, tx.pure.string(trimmed)],
        });
      } else {
        tx.moveCall({
          target: `${packageId}::bonding_curve::post_comment`,
          arguments: [curveRef, tx.pure.string(trimmed)],
        });
      }

      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (result.$kind === 'FailedTransaction') throw new Error(result.FailedTransaction.status.error ?? 'Post failed');

      setText('');
      // Optimistic update
      setComments(prev => [...prev, {
        id: result.Transaction.digest,
        author: account.address, text: trimmed,
        timestamp: Date.now(), curveId,
      }]);
    } catch (err) {
      setPostErr(err.message || 'Failed to post comment');
    } finally {
      setPosting(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePost(); }
  };

  const repliesByParent = {};
  for (const r of replies) {
    if (!repliesByParent[r.parentId]) repliesByParent[r.parentId] = [];
    repliesByParent[r.parentId].push(r);
  }

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden">
      {loading ? (
        <div className="py-8 text-center text-white/20 text-xs font-mono">Loading…</div>
      ) : comments.length === 0 ? (
        <div className="py-8 text-center text-white/20 text-xs font-mono">No comments yet. Be the first!</div>
      ) : (
        <div className="divide-y divide-white/5 max-h-[500px] overflow-y-auto">
          {comments.map(c => (
            <CommentItem
              key={c.id}
              comment={c}
              replies={repliesByParent[c.id] || []}
              account={account}
              curveId={curveId}
              onReplyPosted={(r) => setReplies(prev => [...prev, r])}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
      {account && (
        <div className="border-t border-white/10 p-3 space-y-2">
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
        </div>
      )}
    </div>
  );
}
