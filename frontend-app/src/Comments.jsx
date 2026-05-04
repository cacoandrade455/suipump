// Comments.jsx
// On-chain comment feed for a SuiPump token.
// Comments are stored as on-chain events (suipump::bonding_curve::Comment).
// Any wallet can post. No backend required. Costs ~0.001 SUI per comment.
// Future: replace with real-time indexer + streaming when funded.

import React, { useState, useEffect, useRef } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { MessageSquare, Send, ExternalLink } from 'lucide-react';
import { PACKAGE_ID } from './constants.js';

const MAX_CHARS = 280;

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function shortAddr(addr) {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// Deterministic color from address for avatar
function addrColor(addr) {
  if (!addr) return '#84cc16';
  const colors = ['#84cc16', '#22d3ee', '#f59e0b', '#ec4899', '#8b5cf6', '#10b981', '#f97316', '#06b6d4'];
  let hash = 0;
  for (let i = 0; i < addr.length; i++) hash = addr.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export default function Comments({ curveId, tokenType }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();

  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);

  // Load comments from on-chain events
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const events = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::Comment` },
          limit: 100,
          order: 'ascending',
        });

        if (cancelled) return;

        const filtered = events.data
          .filter(e => e.parsedJson?.curve_id === curveId)
          .map(e => ({
            author: e.parsedJson.author,
            text: e.parsedJson.text,
            ts: Number(e.timestampMs),
            digest: e.id.txDigest,
          }));

        setComments(filtered);
        setLoading(false);
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client]);

  // Scroll to bottom when new comments load
  useEffect(() => {
    if (!loading && comments.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [comments.length, loading]);

  const post = async () => {
    if (!account || !text.trim() || posting) return;
    setPosting(true);
    setError(null);
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::post_comment`,
        arguments: [
          tx.pure.address(curveId),
          tx.pure.string(text.trim()),
        ],
      });
      await signAndExecute({ transaction: tx });
      setText('');
      // Reload after a short delay for indexing
      setTimeout(async () => {
        const events = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::Comment` },
          limit: 100,
          order: 'ascending',
        });
        const filtered = events.data
          .filter(e => e.parsedJson?.curve_id === curveId)
          .map(e => ({
            author: e.parsedJson.author,
            text: e.parsedJson.text,
            ts: Number(e.timestampMs),
            digest: e.id.txDigest,
          }));
        setComments(filtered);
      }, 3000);
    } catch (err) {
      setError(err.message?.slice(0, 100) || 'Failed to post');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
        <div className="flex items-center gap-2">
          <MessageSquare size={13} className="text-white/30" />
          <span className="text-[10px] font-mono tracking-widest text-white/30">COMMENTS</span>
          {!loading && comments.length > 0 && (
            <span className="text-[9px] font-mono text-white/20">· {comments.length}</span>
          )}
        </div>
        <div className="text-[9px] font-mono text-white/15">ON-CHAIN · ~0.001 SUI PER COMMENT</div>
      </div>

      {/* Comment feed */}
      <div className="max-h-80 overflow-y-auto px-4 py-3 space-y-3 scrollbar-thin">
        {loading && (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex gap-3 animate-pulse">
                <div className="w-7 h-7 rounded-full bg-white/5 shrink-0" />
                <div className="flex-1">
                  <div className="h-2.5 bg-white/5 rounded w-20 mb-1.5" />
                  <div className="h-3 bg-white/5 rounded w-full" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && comments.length === 0 && (
          <div className="text-center py-8">
            <div className="text-2xl mb-2">💬</div>
            <div className="text-xs font-mono text-white/20">No comments yet. Be the first.</div>
          </div>
        )}

        {!loading && comments.map((c, i) => (
          <div key={`${c.digest}-${i}`} className="flex gap-3 group">
            {/* Avatar */}
            <div
              className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-black"
              style={{ backgroundColor: addrColor(c.author) }}
            >
              {c.author?.slice(2, 4).toUpperCase()}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <a
                  href={`https://testnet.suivision.xyz/account/${c.author}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] font-mono text-white/40 hover:text-lime-400 transition-colors"
                >
                  {shortAddr(c.author)}
                </a>
                <span className="text-[9px] font-mono text-white/20">{c.ts ? timeAgo(c.ts) : '—'}</span>
                <a
                  href={`https://testnet.suivision.xyz/txblock/${c.digest}`}
                  target="_blank"
                  rel="noreferrer"
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <ExternalLink size={8} className="text-white/20 hover:text-white/40" />
                </a>
              </div>
              <p className="text-xs font-mono text-white/70 leading-relaxed break-words">{c.text}</p>
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-white/5 p-4">
        {!account ? (
          <div className="text-[10px] font-mono text-white/20 text-center py-2">
            Connect wallet to comment
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              {/* Avatar */}
              <div
                className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-black mt-0.5"
                style={{ backgroundColor: addrColor(account.address) }}
              >
                {account.address?.slice(2, 4).toUpperCase()}
              </div>
              <textarea
                value={text}
                onChange={e => setText(e.target.value.slice(0, MAX_CHARS))}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post(); }}
                placeholder="Say something… (⌘↩ to post)"
                rows={2}
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-lime-400/40 resize-none transition-colors placeholder-white/20"
              />
            </div>
            <div className="flex items-center justify-between pl-9">
              <span className={`text-[9px] font-mono ${text.length > MAX_CHARS * 0.9 ? 'text-amber-400' : 'text-white/20'}`}>
                {text.length}/{MAX_CHARS}
              </span>
              <div className="flex items-center gap-3">
                {error && <span className="text-[9px] font-mono text-red-400">{error}</span>}
                <button
                  onClick={post}
                  disabled={!text.trim() || posting || isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-lime-400 text-black text-[10px] font-mono font-bold rounded-lg hover:bg-lime-300 disabled:bg-white/5 disabled:text-white/20 disabled:cursor-not-allowed transition-all"
                >
                  <Send size={10} />
                  {posting || isPending ? 'POSTING…' : 'POST'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
