// Comments.jsx — on-chain comments + off-chain replies (localStorage)
import React, { useState, useEffect, useRef } from 'react';
import { useCurrentAccount, useSuiClient, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { Send, Reply, ChevronDown, ChevronUp } from 'lucide-react';
import { PACKAGE_ID } from './constants.js';
import { paginateEvents } from './paginateEvents.js';

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

// ── localStorage reply store ─────────────────────────────────────────────────

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

// ── CommentItem ──────────────────────────────────────────────────────────────

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
      parentId: comment.id,
      author: account.address,
      text: trimmed,
      timestamp: Date.now(),
    };

    saveReply(curveId, reply);
    onReplyPosted(reply);
    setReplyText('');
    setReplyOpen(false);
    setReplyErr('');
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePostReply(); }
    if (e.key === 'Escape') { setReplyOpen(false); setReplyText(''); }
  };

  return (
    <div className="px-4 py-3 hover:bg-white/[0.02] transition-colors">
      <div className="flex items-start gap-2.5">
        {/* Avatar */}
        <div
          className="w-6 h-6 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center text-[9px] font-bold text-black"
          style={{ backgroundColor: walletColor(comment.author) }}
        >
          {comment.author?.slice(2, 4).toUpperCase()}
        </div>

        <div className="flex-1 min-w-0">
          {/* Author + time */}
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono text-white/50">{shortAddr(comment.author)}</span>
            <span className="text-[10px] font-mono text-white/25">{timeAgo(comment.timestamp)}</span>
          </div>

          {/* Text */}
          <p className="text-sm text-white/70 leading-relaxed break-words">{comment.text}</p>

          {/* Action row */}
          <div className="flex items-center gap-3 mt-2">
            {account && (
              <button
                onClick={handleOpenReply}
                className={`flex items-center gap-1 text-[10px] font-mono transition-colors ${
                  replyOpen ? 'text-lime-400' : 'text-white/25 hover:text-white/50'
                }`}
              >
                <Reply size={10} />
                REPLY
              </button>
            )}
            {replyCount > 0 && (
              <button
                onClick={() => setShowReplies(o => !o)}
                className="flex items-center gap-1 text-[10px] font-mono text-white/25 hover:text-white/50 transition-colors"
              >
                {showReplies ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </div>

          {/* Reply input */}
          {replyOpen && (
            <div className="mt-3 space-y-1.5">
              <div className="flex gap-2">
                <div
                  className="w-5 h-5 rounded-full flex-shrink-0 mt-1 flex items-center justify-center text-[8px] font-bold text-black"
                  style={{ backgroundColor: walletColor(account?.address) }}
                >
                  {account?.address?.slice(2, 4).toUpperCase()}
                </div>
                <textarea
                  ref={inputRef}
                  value={replyText}
                  onChange={e => { setReplyText(e.target.value); setReplyErr(''); }}
                  onKeyDown={handleKey}
                  placeholder={`Reply to ${shortAddr(comment.author)}… (Enter to post)`}
                  maxLength={200}
                  rows={2}
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder-white/20 resize-none focus:outline-none focus:border-lime-400/50 focus:bg-lime-400/5 transition-colors"
                />
                <button
                  onClick={handlePostReply}
                  disabled={!replyText.trim()}
                  className={`self-end px-2.5 py-2 rounded-lg transition-colors ${
                    !replyText.trim()
                      ? 'bg-white/5 text-white/25 cursor-not-allowed'
                      : 'bg-lime-400 hover:bg-lime-300 text-black'
                  }`}
                >
                  <Send size={12} />
                </button>
              </div>
              <div className="flex items-center justify-between pl-7">
                {replyErr
                  ? <span className="text-[10px] font-mono text-red-400">{replyErr}</span>
                  : <span />}
                <span className="text-[10px] font-mono text-white/25">{replyText.length}/200</span>
              </div>
            </div>
          )}

          {/* Replies list */}
          {showReplies && replyCount > 0 && (
            <div className="mt-3 space-y-3 border-l-2 border-white/5 pl-3">
              {replies.map(r => (
                <div key={r.id} className="flex items-start gap-2">
                  <div
                    className="w-5 h-5 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center text-[8px] font-bold text-black"
                    style={{ backgroundColor: walletColor(r.author) }}
                  >
                    {r.author?.slice(2, 4).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] font-mono text-white/50">{shortAddr(r.author)}</span>
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

// ── Main component ───────────────────────────────────────────────────────────

export default function Comments({ curveId }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const [comments, setComments] = useState([]);
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState('');
  const bottomRef = useRef(null);

  // Load on-chain comments
  useEffect(() => {
    if (!curveId || !client) return;
    let cancelled = false;

    async function load() {
      try {
        const eventType = `${PACKAGE_ID}::bonding_curve::CommentPosted`;
        const events = await paginateEvents(client, { MoveEventType: eventType }, { order: 'ascending' });
        const filtered = events
          .filter(e => e.parsedJson?.curve_id === curveId)
          .map(e => ({
            id: e.id?.txDigest + '_' + e.id?.eventSeq,
            author: e.parsedJson?.author,
            text: e.parsedJson?.text,
            timestamp: e.timestampMs ? Number(e.timestampMs) : null,
          }));
        if (!cancelled) {
          setComments(filtered);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client]);

  // Load off-chain replies from localStorage
  useEffect(() => {
    if (!curveId) return;
    setReplies(loadReplies(curveId));
  }, [curveId]);

  const handleReplyPosted = (reply) => {
    setReplies(prev => [...prev, reply]);
  };

  const handlePost = async () => {
    const trimmed = text.trim();
    if (!trimmed || !account || posting) return;
    if (trimmed.length > 200) { setPostErr('Max 200 characters'); return; }

    setPosting(true);
    setPostErr('');

    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::post_comment`,
        arguments: [
          tx.pure.address(curveId),
          tx.pure.string(trimmed),
        ],
      });

      signAndExecute(
        { transaction: tx },
        {
          onSuccess: () => {
            setText('');
            setPosting(false);
            setComments(prev => [...prev, {
              id: 'pending_' + Date.now(),
              author: account.address,
              text: trimmed,
              timestamp: Date.now(),
            }]);
          },
          onError: (err) => {
            setPostErr(err.message || 'Failed to post');
            setPosting(false);
          },
        }
      );
    } catch (err) {
      setPostErr(err.message || 'Failed to post');
      setPosting(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePost(); }
  };

  const totalCount = comments.length + replies.length;

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <span className="text-[10px] font-mono text-white/35 tracking-widest">COMMENTS</span>
        <span className="text-[10px] font-mono text-white/25">{totalCount}</span>
      </div>

      {/* Comment list */}
      <div className="max-h-[500px] overflow-y-auto">
        {loading ? (
          <div className="py-8 text-center text-white/35 text-xs font-mono">Loading…</div>
        ) : comments.length === 0 ? (
          <div className="py-8 text-center text-white/35 text-xs font-mono">
            No comments yet. Be the first!
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {comments.map(c => (
              <CommentItem
                key={c.id}
                comment={c}
                replies={replies.filter(r => r.parentId === c.id)}
                account={account}
                curveId={curveId}
                onReplyPosted={handleReplyPosted}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Post input */}
      <div className="border-t border-white/10 p-3">
        {!account ? (
          <div className="text-center text-white/35 text-xs font-mono py-2">
            Connect wallet to comment
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <div
                className="w-6 h-6 rounded-full flex-shrink-0 mt-1.5 flex items-center justify-center text-[9px] font-bold text-black"
                style={{ backgroundColor: walletColor(account.address) }}
              >
                {account.address.slice(2, 4).toUpperCase()}
              </div>
              <textarea
                value={text}
                onChange={e => { setText(e.target.value); setPostErr(''); }}
                onKeyDown={handleKey}
                placeholder="Write a comment… (Enter to post)"
                maxLength={200}
                rows={2}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-white placeholder-white/20 resize-none focus:outline-none focus:border-lime-400/50 focus:bg-lime-400/5 transition-colors"
              />
              <button
                onClick={handlePost}
                disabled={!text.trim() || posting}
                className={`self-end px-3 py-2 rounded-lg transition-colors ${
                  !text.trim() || posting
                    ? 'bg-white/5 text-white/25 cursor-not-allowed'
                    : 'bg-lime-400 hover:bg-lime-300 text-black'
                }`}
              >
                <Send size={14} />
              </button>
            </div>
            <div className="flex items-center justify-between px-8">
              {postErr
                ? <span className="text-[10px] font-mono text-red-400">{postErr}</span>
                : <span />}
              <span className="text-[10px] font-mono text-white/25">{text.length}/200</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
