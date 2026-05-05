// Comments.jsx
// On-chain comment feed for a SuiPump token.
// post_comment takes (curve_id: ID, text: String) — no generic, no sharedObjectRef.

import React, { useState, useEffect } from 'react';
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { MessageSquare, Send } from 'lucide-react';
import { PACKAGE_ID } from './constants.js';

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
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();

  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [status, setStatus] = useState(null);

  async function loadComments(cancelled) {
    try {
      const result = await client.queryEvents({
        query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::Comment` },
        limit: 100,
        order: 'descending',
      });
      if (cancelled?.value) return;
      const filtered = result.data
        .filter(e => e.parsedJson?.curve_id === curveId)
        .map(e => ({
          author: e.parsedJson.author,
          text: e.parsedJson.text,
          ts: e.timestampMs ? Number(e.timestampMs) : null,
          digest: e.id?.txDigest,
        }));
      setComments(filtered);
    } catch { }
    finally { setLoading(false); }
  }

  useEffect(() => {
    const cancelled = { value: false };
    loadComments(cancelled);
    const interval = setInterval(() => loadComments(cancelled), 15_000);
    return () => { cancelled.value = true; clearInterval(interval); };
  }, [curveId, client]);

  const post = async () => {
    if (!account || !text.trim() || isPending) return;
    setStatus(null);
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
      setStatus({ kind: 'success', msg: 'Comment posted!' });
      setTimeout(() => { const c = { value: false }; loadComments(c); }, 2000);
    } catch (err) {
      setStatus({ kind: 'error', msg: err.message?.slice(0, 80) || 'Failed to post' });
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center gap-2 text-[10px] font-mono text-white/30 tracking-widest mb-4">
        <MessageSquare size={12} />
        COMMENTS {comments.length > 0 && `· ${comments.length}`}
      </div>

      {account ? (
        <div className="mb-4">
          <div className="flex gap-2">
            <input
              value={text}
              onChange={e => setText(e.target.value.slice(0, 280))}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post(); } }}
              placeholder="Say something…"
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-lime-400/40 transition-colors placeholder-white/20"
            />
            <button
              onClick={post}
              disabled={!text.trim() || isPending}
              className="px-3 py-2 bg-lime-400 text-black rounded-xl hover:bg-lime-300 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              {isPending ? '…' : <Send size={13} />}
            </button>
          </div>
          <div className="flex justify-between mt-1 px-1">
            <div className={`text-[9px] font-mono ${
              status?.kind === 'success' ? 'text-lime-400'
              : status?.kind === 'error' ? 'text-red-400'
              : 'text-transparent'
            }`}>
              {status?.msg || '.'}
            </div>
            <div className="text-[9px] font-mono text-white/20">{text.length}/280</div>
          </div>
        </div>
      ) : (
        <div className="mb-4 text-[10px] font-mono text-white/20 text-center py-3 border border-white/5 rounded-xl">
          CONNECT WALLET TO COMMENT
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-10 bg-white/5 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : comments.length === 0 ? (
        <div className="text-center py-6 text-[10px] font-mono text-white/20">
          NO COMMENTS YET · BE THE FIRST
        </div>
      ) : (
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {comments.map((c, i) => (
            <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-mono text-lime-400/60">
                  {c.author ? `${c.author.slice(0, 6)}…${c.author.slice(-4)}` : '?'}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-mono text-white/20">{timeAgo(c.ts)}</span>
                  {c.digest && (
                    <a href={`https://testnet.suivision.xyz/txblock/${c.digest}`}
                      target="_blank" rel="noreferrer"
                      className="text-[9px] font-mono text-white/20 hover:text-lime-400 transition-colors"
                    >↗</a>
                  )}
                </div>
              </div>
              <p className="text-xs font-mono text-white/70 break-words leading-relaxed">{c.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
