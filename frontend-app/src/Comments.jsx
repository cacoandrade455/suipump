// Comments.jsx — on-chain comments via post_comment
import React, { useState, useEffect, useRef } from 'react';
import { useCurrentAccount, useSuiClient, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { Send } from 'lucide-react';
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

export default function Comments({ curveId }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState('');
  const bottomRef = useRef(null);

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
      } catch (err) {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client]);

  const handlePost = async () => {
    const trimmed = text.trim();
    if (!trimmed || !account || posting) return;
    if (trimmed.length > 200) {
      setPostErr('Max 200 characters');
      return;
    }

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
            // Optimistically add
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handlePost();
    }
  };

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <span className="text-[10px] font-mono text-white/35 tracking-widest">COMMENTS</span>
        <span className="text-[10px] font-mono text-white/25">{comments.length}</span>
      </div>

      {/* Comment list */}
      <div className="max-h-[400px] overflow-y-auto">
        {loading ? (
          <div className="py-8 text-center text-white/35 text-xs font-mono">Loading…</div>
        ) : comments.length === 0 ? (
          <div className="py-8 text-center text-white/35 text-xs font-mono">
            No comments yet. Be the first!
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {comments.map(c => (
              <div key={c.id} className="px-4 py-3 hover:bg-white/[0.02] transition-colors">
                <div className="flex items-start gap-2.5">
                  {/* Avatar */}
                  <div
                    className="w-6 h-6 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center text-[9px] font-bold text-black"
                    style={{ backgroundColor: walletColor(c.author) }}
                  >
                    {c.author?.slice(2, 4).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-mono text-white/50">
                        {shortAddr(c.author)}
                      </span>
                      <span className="text-[10px] font-mono text-white/25">
                        {timeAgo(c.timestamp)}
                      </span>
                    </div>
                    <p className="text-sm text-white/70 leading-relaxed break-words">{c.text}</p>
                  </div>
                </div>
              </div>
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
              {postErr ? (
                <span className="text-[10px] font-mono text-red-400">{postErr}</span>
              ) : <span />}
              <span className="text-[10px] font-mono text-white/25">{text.length}/200</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
