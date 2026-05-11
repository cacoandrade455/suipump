// useTokenStats.js
// Per-token stats computed from on-chain events.
// Returns map: { [curveId]: { volume, trades, reserveSui, pctChange, recentTrades,
//   lastTradeTime, lastPrice, firstPrice, volume24h, commentCount, devBuyMist, sparkline24h } }

import { useState, useEffect, useRef } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const MIST_PER_SUI = 1e9;
const ONE_HOUR_MS  = 60 * 60 * 1000;
const ONE_DAY_MS   = 24 * 60 * 60 * 1000;

export function useTokenStats(tokens) {
  const client = useSuiClient();
  const [stats, setStats] = useState({});
  const prevTokenIds = useRef('');

  useEffect(() => {
    if (!tokens || tokens.length === 0) return;

    const ids = tokens.map(t => t.curveId).join(',');
    if (ids === prevTokenIds.current) return;
    prevTokenIds.current = ids;

    let cancelled = false;

    async function load() {
      try {
        const buyType     = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
        const sellType    = `${PACKAGE_ID}::bonding_curve::TokensSold`;
        const commentType = `${PACKAGE_ID}::bonding_curve::CommentPosted`;
        const createdType = `${PACKAGE_ID}::bonding_curve::CurveCreated`;

        const eventMap = await paginateMultipleEvents(
          client,
          [buyType, sellType, commentType, createdType],
          { order: 'descending', maxPages: 20 }
        );

        if (cancelled) return;

        const buysData     = eventMap[buyType]     || [];
        const sellsData    = eventMap[sellType]    || [];
        const commentsData = eventMap[commentType] || [];
        const createdData  = eventMap[createdType] || [];

        const now = Date.now();
        const map = {};

        const ensure = (curveId) => {
          if (!map[curveId]) {
            map[curveId] = {
              volume: 0, trades: 0, recentTrades: 0,
              firstPrice: null, lastPrice: null, reserveSui: 0,
              lastTradeTime: null,
              volume24h: 0,
              commentCount: 0,
              devBuyMist: 0,
              sparkline24h: [], // array of { t: timestamp, p: price }
            };
          }
          return map[curveId];
        };

        // ── Buys ──────────────────────────────────────────────────────────
        for (const evt of buysData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s = ensure(j.curve_id);
          const suiIn = Number(j.sui_in ?? 0) / MIST_PER_SUI;
          const ts = evt.timestampMs ? Number(evt.timestampMs) : 0;
          s.volume  += suiIn;
          s.trades  += 1;
          if (ts && now - ts < ONE_HOUR_MS) s.recentTrades += 1;
          if (ts && now - ts < ONE_DAY_MS)  s.volume24h    += suiIn;
          if (ts && s.lastTradeTime === null) s.lastTradeTime = ts;
          const tokensOut = Number(j.tokens_out ?? 0) / 1e6;
          if (tokensOut > 0) {
            const price = suiIn / tokensOut;
            if (s.lastPrice === null) s.lastPrice = price;
            s.firstPrice = price;
            if (ts && now - ts < ONE_DAY_MS) {
              s.sparkline24h.push({ t: ts, p: price });
            }
          }
        }

        // ── Sells ─────────────────────────────────────────────────────────
        for (const evt of sellsData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s = ensure(j.curve_id);
          const suiOut = Number(j.sui_out ?? 0) / MIST_PER_SUI;
          const ts = evt.timestampMs ? Number(evt.timestampMs) : 0;
          s.volume  += suiOut;
          s.trades  += 1;
          if (ts && now - ts < ONE_HOUR_MS) s.recentTrades += 1;
          if (ts && now - ts < ONE_DAY_MS)  s.volume24h    += suiOut;
          if (ts && s.lastTradeTime === null) s.lastTradeTime = ts;
          const tokensIn = Number(j.tokens_in ?? 0) / 1e6;
          if (tokensIn > 0) {
            const price = suiOut / tokensIn;
            if (s.lastPrice === null) s.lastPrice = price;
            s.firstPrice = price;
            if (ts && now - ts < ONE_DAY_MS) {
              s.sparkline24h.push({ t: ts, p: price });
            }
          }
        }

        // Fix lastTradeTime  -  take max across both streams per curve
        for (const curveId of Object.keys(map)) {
          const s = map[curveId];
          let latestTs = s.lastTradeTime ?? 0;
          for (const evt of [...buysData, ...sellsData]) {
            if (evt.parsedJson?.curve_id !== curveId) continue;
            const ts = evt.timestampMs ? Number(evt.timestampMs) : 0;
            if (ts > latestTs) latestTs = ts;
          }
          s.lastTradeTime = latestTs || null;
          // Sort sparkline oldest→newest
          s.sparkline24h.sort((a, b) => a.t - b.t);
        }

        // ── Comments ──────────────────────────────────────────────────────
        for (const evt of commentsData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s = ensure(j.curve_id);
          s.commentCount += 1;
        }

        // ── Dev buy  -  from CurveCreated event ─────────────────────────────
        for (const evt of createdData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s = ensure(j.curve_id);
          // dev_buy_sui_in field emitted by contract on launch with dev buy
          if (j.dev_buy_sui_in) {
            s.devBuyMist = Number(j.dev_buy_sui_in);
          }
        }

        // ── % change ──────────────────────────────────────────────────────
        for (const s of Object.values(map)) {
          if (s.firstPrice && s.lastPrice && s.firstPrice > 0) {
            s.pctChange = ((s.lastPrice - s.firstPrice) / s.firstPrice) * 100;
          } else {
            s.pctChange = null;
          }
        }

        if (!cancelled) setStats(map);
      } catch (err) {
        console.error('useTokenStats error:', err);
      }
    }

    load();
    const interval = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [tokens, client]);

  return stats;
}
