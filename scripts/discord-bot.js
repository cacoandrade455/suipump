// discord-bot.js
// SuiPump trade alert bot — polls Sui events every 15s, posts to Discord webhook.
// Alerts on: new token launches, buys ≥25 SUI, sells ≥25 SUI, graduations.
//
// Usage:
//   node discord-bot.js

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

const PACKAGE_ID = '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1502064445155840140/e0UpUyi4_6L-ZnHTrDt9Eh7rwg1yf_o74xYb3dzXy8p1CNTJgRX1LGx9mWTPY78ziQxp';
const POLL_INTERVAL_MS = 15_000;
const MIST_PER_SUI = 1_000_000_000;
const MIN_TRADE_SUI = 25;

const client = new SuiClient({ url: getFullnodeUrl('testnet') });

// Track last seen event cursor per type so we don't re-alert on old events
const cursors = {
  buy: null,
  sell: null,
  launch: null,
  grad: null,
};

// Track seen tx digests to deduplicate across polls
const seen = new Set();

function fmtSui(mist) {
  return (Number(mist) / MIST_PER_SUI).toFixed(2);
}

function shortAddr(addr) {
  if (!addr) return '???';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function explorerUrl(digest) {
  return `https://testnet.suivision.xyz/txblock/${digest}`;
}

function tokenUrl(curveId) {
  return `https://suipump.vercel.app/token/${curveId}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Webhook sender with automatic rate limit retry
async function sendWebhook(payload, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        const json = await res.json();
        const wait = Math.ceil((json.retry_after ?? 1) * 1000) + 100;
        console.log(`  Rate limited — waiting ${wait}ms…`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        console.error(`Webhook error ${res.status}:`, text);
      }
      return;
    } catch (err) {
      console.error('Webhook send failed:', err.message);
      await sleep(1000);
    }
  }
}

async function pollEvents(eventType, cursorKey, handler) {
  try {
    const query = {
      query: { MoveEventType: eventType },
      limit: 20,
      order: 'descending',
    };
    if (cursors[cursorKey]) query.cursor = cursors[cursorKey];

    const result = await client.queryEvents(query);

    if (!result.data || result.data.length === 0) return;

    // Update cursor to the newest event
    if (result.data[0]) {
      cursors[cursorKey] = result.nextCursor ?? null;
    }

    // Process in chronological order (reverse of descending)
    const events = [...result.data].reverse();

    for (const evt of events) {
      const digest = evt.id?.txDigest;
      if (!digest || seen.has(digest + cursorKey)) continue;
      seen.add(digest + cursorKey);

      // Skip events older than 2 minutes on first poll (avoid spam on startup)
      if (cursors[cursorKey] === null && evt.timestampMs) {
        const age = Date.now() - Number(evt.timestampMs);
        if (age > 2 * 60 * 1000) continue;
      }

      await handler(evt, digest);
      // Small delay between each webhook call to avoid bursting
      await sleep(500);
    }
  } catch (err) {
    console.error(`Poll error [${cursorKey}]:`, err.message);
  }
}

async function handleBuy(evt, digest) {
  const p = evt.parsedJson;
  const suiIn = Number(p.sui_in ?? 0) / MIST_PER_SUI;
  if (suiIn < MIN_TRADE_SUI) return;

  const tokensOut = (Number(p.tokens_out ?? 0) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const curveId = p.curve_id;

  await sendWebhook({
    embeds: [{
      color: 0x84CC16, // lime
      title: '💰 BUY',
      description: `**${fmtSui(p.sui_in)} SUI** → **${tokensOut} tokens**`,
      fields: [
        { name: 'Buyer', value: shortAddr(p.buyer), inline: true },
        { name: 'Reserve after', value: `${fmtSui(p.new_sui_reserve)} SUI`, inline: true },
        { name: 'Token page', value: `[View on SuiPump](${tokenUrl(curveId)})`, inline: true },
      ],
      footer: { text: `tx: ${digest.slice(0, 16)}…` },
      timestamp: evt.timestampMs ? new Date(Number(evt.timestampMs)).toISOString() : undefined,
    }],
  });

  console.log(`[BUY] ${fmtSui(p.sui_in)} SUI — ${shortAddr(p.buyer)}`);
}

async function handleSell(evt, digest) {
  const p = evt.parsedJson;
  const suiOut = Number(p.sui_out ?? 0) / MIST_PER_SUI;
  if (suiOut < MIN_TRADE_SUI) return;

  const tokensIn = (Number(p.tokens_in ?? 0) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const curveId = p.curve_id;

  await sendWebhook({
    embeds: [{
      color: 0xEF4444, // red
      title: '📉 SELL',
      description: `**${tokensIn} tokens** → **${fmtSui(p.sui_out)} SUI**`,
      fields: [
        { name: 'Seller', value: shortAddr(p.seller), inline: true },
        { name: 'Reserve after', value: `${fmtSui(p.new_sui_reserve)} SUI`, inline: true },
        { name: 'Token page', value: `[View on SuiPump](${tokenUrl(curveId)})`, inline: true },
      ],
      footer: { text: `tx: ${digest.slice(0, 16)}…` },
      timestamp: evt.timestampMs ? new Date(Number(evt.timestampMs)).toISOString() : undefined,
    }],
  });

  console.log(`[SELL] ${fmtSui(p.sui_out)} SUI — ${shortAddr(p.seller)}`);
}

async function handleLaunch(evt, digest) {
  const p = evt.parsedJson;

  await sendWebhook({
    embeds: [{
      color: 0x60A5FA, // blue
      title: '🚀 NEW TOKEN LAUNCHED',
      description: `**${p.name}** ($${p.symbol}) is live on SuiPump!`,
      fields: [
        { name: 'Creator', value: shortAddr(p.creator), inline: true },
        { name: 'Trade now', value: `[Open on SuiPump](${tokenUrl(p.curve_id)})`, inline: true },
      ],
      footer: { text: `tx: ${digest.slice(0, 16)}…` },
      timestamp: evt.timestampMs ? new Date(Number(evt.timestampMs)).toISOString() : undefined,
    }],
  });

  console.log(`[LAUNCH] ${p.name} ($${p.symbol}) — ${shortAddr(p.creator)}`);
}

async function handleGraduation(evt, digest) {
  const p = evt.parsedJson;

  await sendWebhook({
    embeds: [{
      color: 0x34D399, // emerald
      title: '🎓 TOKEN GRADUATED TO CETUS!',
      description: `A SuiPump token has graduated to the DEX with **${fmtSui(p.final_sui_reserve)} SUI** in liquidity.`,
      fields: [
        { name: 'Creator bonus', value: `${fmtSui(p.creator_bonus)} SUI`, inline: true },
        { name: 'Final reserve', value: `${fmtSui(p.final_sui_reserve)} SUI`, inline: true },
        { name: 'Explorer', value: `[View tx](${explorerUrl(digest)})`, inline: true },
      ],
      footer: { text: `tx: ${digest.slice(0, 16)}…` },
      timestamp: evt.timestampMs ? new Date(Number(evt.timestampMs)).toISOString() : undefined,
    }],
  });

  console.log(`[GRAD] ${fmtSui(p.final_sui_reserve)} SUI final reserve`);
}

async function poll() {
  await Promise.all([
    pollEvents(`${PACKAGE_ID}::bonding_curve::TokensPurchased`, 'buy', handleBuy),
    pollEvents(`${PACKAGE_ID}::bonding_curve::TokensSold`, 'sell', handleSell),
    pollEvents(`${PACKAGE_ID}::bonding_curve::CurveCreated`, 'launch', handleLaunch),
    pollEvents(`${PACKAGE_ID}::bonding_curve::Graduated`, 'grad', handleGraduation),
  ]);
}

// Startup
console.log('━'.repeat(50));
console.log('  SuiPump Discord Bot — starting');
console.log(`  Package: ${PACKAGE_ID.slice(0, 20)}…`);
console.log(`  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
console.log(`  Min trade alert: ${MIN_TRADE_SUI} SUI`);
console.log('━'.repeat(50));

// First poll — marks cursors so we only alert on new events going forward
await poll();
console.log('  Ready — listening for new events…\n');

// Poll loop
setInterval(poll, POLL_INTERVAL_MS);
