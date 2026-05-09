// api/token-og.js
// Vercel Edge Function — injects page-specific OG meta tags for:
//   /token/:curveId  — token name, symbol, image, price, mcap, curve progress
//   /stats           — protocol volume & fee stats
//   /leaderboard     — top tokens & traders
//
// Crawlers get server-rendered meta. Real users get index.html as normal.

export const config = { runtime: 'edge' };

const PACKAGE_ID     = '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';
const SUI_RPC        = 'https://fullnode.testnet.sui.io';
const APP_URL        = 'https://suipump.vercel.app';
const FALLBACK_IMAGE = 'https://i.imgur.com/qS6SGc7.jpeg';
const MIST_PER_SUI   = 1_000_000_000n;

// ── RPC helpers ──────────────────────────────────────────────────────────────

async function rpc(method, params) {
  const res = await fetch(SUI_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function getCurveFields(curveId) {
  const result = await rpc('sui_getObject', [
    curveId,
    { showContent: true, showType: true },
  ]);
  return {
    fields: result?.data?.content?.fields ?? null,
    type:   result?.data?.type ?? null,
  };
}

async function getCoinMetadata(coinType) {
  try { return await rpc('suix_getCoinMetadata', [coinType]); }
  catch { return null; }
}

async function queryEvents(eventType, limit = 50) {
  try {
    const result = await rpc('suix_queryEvents', [
      { MoveEventType: eventType },
      null,
      limit,
      false,
    ]);
    return result?.data ?? [];
  } catch { return []; }
}

// ── Bonding curve math ───────────────────────────────────────────────────────

const TOKEN_DECIMALS = 6;
const VIRTUAL_SUI    = 30_000n * MIST_PER_SUI;
const VIRTUAL_TOKENS = 1_073_000_000n * 1_000_000n;
const TOTAL_SUPPLY   = 1_000_000_000;

function priceMistPerToken(suiReserveMist, tokensSoldMicro) {
  const vs = VIRTUAL_SUI + BigInt(suiReserveMist);
  const vt = VIRTUAL_TOKENS - BigInt(tokensSoldMicro);
  if (vt <= 0n) return 0n;
  return (vs * 1_000_000n) / vt;
}

function calcProgress(suiReserveMist) {
  const DRAIN = 87_912n * MIST_PER_SUI;
  const pct = (BigInt(suiReserveMist) * 10_000n) / DRAIN;
  return Math.min(100, Number(pct) / 100);
}

function fmtSui(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isCrawler(ua = '') {
  const bots = [
    'twitterbot', 'discordbot', 'telegrambot', 'slackbot',
    'facebot', 'linkedinbot', 'whatsapp', 'applebot',
    'googlebot', 'bingbot', 'ia_archiver', 'embedly',
    'outbrain', 'pinterest', 'rogerbot', 'showyoubot',
    'vkshare', 'w3c_validator', 'facebookexternalhit',
  ];
  const lower = ua.toLowerCase();
  return bots.some(b => lower.includes(b));
}

function injectMeta(html, { title, desc, img, pageUrl }) {
  // Strip existing static title + OG/Twitter/description meta
  let out = html
    .replace(/<title>[^<]*<\/title>/i, '')
    .replace(/<meta\s+(?:property|name)="(?:og:|twitter:)[^"]*"[^>]*\/?>/gi, '')
    .replace(/<meta\s+name="description"[^>]*\/?>/gi, '');

  const tags = `
    <title>${escHtml(title)}</title>
    <meta name="description"         content="${escHtml(desc)}" />
    <meta property="og:type"         content="website" />
    <meta property="og:url"          content="${escHtml(pageUrl)}" />
    <meta property="og:title"        content="${escHtml(title)}" />
    <meta property="og:description"  content="${escHtml(desc)}" />
    <meta property="og:image"        content="${escHtml(img)}" />
    <meta property="og:image:width"  content="400" />
    <meta property="og:image:height" content="400" />
    <meta property="og:site_name"    content="SuiPump" />
    <meta name="twitter:card"        content="summary" />
    <meta name="twitter:site"        content="@SuiPump_SUMP" />
    <meta name="twitter:title"       content="${escHtml(title)}" />
    <meta name="twitter:description" content="${escHtml(desc)}" />
    <meta name="twitter:image"       content="${escHtml(img)}" />
  `.trim();

  return out.replace('<head>', `<head>\n    ${tags}`);
}

async function fetchIndexHtml() {
  try {
    const res = await fetch(`${APP_URL}/index.html`);
    return await res.text();
  } catch {
    return `<!doctype html><html><head></head><body></body></html>`;
  }
}

// ── Page meta builders ───────────────────────────────────────────────────────

async function tokenMeta(curveId) {
  const { fields, type } = await getCurveFields(curveId);
  const tokenType = type?.match(/Curve<(.+)>$/)?.[1] ?? null;
  const coinMeta  = tokenType ? await getCoinMetadata(tokenType) : null;

  const name        = coinMeta?.name        ?? fields?.name   ?? 'Unknown Token';
  const symbol      = coinMeta?.symbol      ?? fields?.symbol ?? '???';
  const description = coinMeta?.description ?? '';
  const img         = coinMeta?.iconUrl      ?? FALLBACK_IMAGE;
  const graduated   = fields?.graduated      ?? false;

  let priceStr = null;
  let mcapStr  = null;
  if (fields) {
    const suiReserve = BigInt(fields.sui_reserve  ?? 0);
    const tokensSold = BigInt(800_000_000) * BigInt(10 ** TOKEN_DECIMALS)
                     - BigInt(fields.token_reserve ?? 0);
    const priceMist  = priceMistPerToken(suiReserve, tokensSold);
    const priceSui   = Number(priceMist) / 1e9;
    const mcapSui    = priceSui * TOTAL_SUPPLY;
    priceStr = priceSui.toFixed(8);
    mcapStr  = fmtSui(mcapSui);
  }

  const progress = fields ? calcProgress(fields.sui_reserve).toFixed(1) : null;

  const descParts = [];
  if (priceStr)  descParts.push(`Price: ${priceStr} SUI`);
  if (mcapStr)   descParts.push(`MCap: ${mcapStr} SUI`);
  if (progress)  descParts.push(`Curve: ${progress}%`);
  if (graduated) descParts.push('✅ Graduated');
  if (description) descParts.push(description.slice(0, 100));
  const desc = descParts.join(' · ') || `Trade $${symbol} on SuiPump.`;

  return {
    title:   `$${symbol} — ${name} on SuiPump`,
    desc,
    img,
    pageUrl: `${APP_URL}/token/${curveId}`,
  };
}

async function statsMeta() {
  // Fetch a sample of recent events to compute live volume for the description
  const buyType  = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
  const sellType = `${PACKAGE_ID}::bonding_curve::TokensSold`;

  const [buys, sells] = await Promise.all([
    queryEvents(buyType,  50),
    queryEvents(sellType, 50),
  ]);

  let volumeMist = 0n;
  let trades = 0;
  for (const e of buys) {
    volumeMist += BigInt(e.parsedJson?.sui_in ?? 0);
    trades++;
  }
  for (const e of sells) {
    volumeMist += BigInt(e.parsedJson?.sui_out ?? 0);
    trades++;
  }

  const volumeSui = Number(volumeMist) / 1e9;
  const desc = volumeSui > 0
    ? `${fmtSui(volumeSui)} SUI traded across ${trades}+ trades on SuiPump testnet. 1% fee — 40% to creators, 50% protocol, 10% LP.`
    : 'Live protocol metrics for SuiPump — permissionless token launchpad on Sui. Volume, fees, graduations.';

  return {
    title:   'SuiPump Protocol Stats',
    desc,
    img:     FALLBACK_IMAGE,
    pageUrl: `${APP_URL}/stats`,
  };
}

async function leaderboardMeta() {
  const buyType  = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
  const sellType = `${PACKAGE_ID}::bonding_curve::TokensSold`;

  const [buys, sells] = await Promise.all([
    queryEvents(buyType,  50),
    queryEvents(sellType, 50),
  ]);

  // Tally volume by curve to find #1 token
  const volByCurve = {};
  for (const e of buys) {
    const id = e.parsedJson?.curve_id;
    if (id) volByCurve[id] = (volByCurve[id] ?? 0) + Number(e.parsedJson.sui_in ?? 0) / 1e9;
  }
  for (const e of sells) {
    const id = e.parsedJson?.curve_id;
    if (id) volByCurve[id] = (volByCurve[id] ?? 0) + Number(e.parsedJson.sui_out ?? 0) / 1e9;
  }

  const sorted = Object.entries(volByCurve).sort((a, b) => b[1] - a[1]);
  const topVolume = sorted[0]?.[1] ?? 0;
  const tokenCount = sorted.length;

  const desc = tokenCount > 0
    ? `Top tokens and traders on SuiPump. #1 token: ${fmtSui(topVolume)} SUI volume. ${tokenCount} tokens ranked.`
    : 'Top tokens and traders ranked by volume on SuiPump — permissionless token launchpad on Sui.';

  return {
    title:   'SuiPump Leaderboard — Top Tokens & Traders',
    desc,
    img:     FALLBACK_IMAGE,
    pageUrl: `${APP_URL}/leaderboard`,
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req) {
  const url  = new URL(req.url);
  const ua   = req.headers.get('user-agent') || '';
  const page = url.searchParams.get('page') || 'token';
  const curveId = url.searchParams.get('curveId') || '';

  // Real users: serve index.html directly
  if (!isCrawler(ua)) {
    const html = await fetchIndexHtml();
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Crawlers: build page-specific meta
  let meta = {
    title:   'SuiPump — Permissionless Token Launchpad on Sui',
    desc:    'Launch a token on Sui in 2 wallet signatures. Fair launch, no pre-mine, 40% creator fees.',
    img:     FALLBACK_IMAGE,
    pageUrl: APP_URL,
  };

  try {
    if (page === 'token' && curveId) {
      meta = await tokenMeta(curveId);
    } else if (page === 'stats') {
      meta = await statsMeta();
    } else if (page === 'leaderboard') {
      meta = await leaderboardMeta();
    }
  } catch {
    // fallback meta already set
  }

  const html = injectMeta(await fetchIndexHtml(), meta);

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=30, stale-while-revalidate=60',
    },
  });
}
