// api/token-og.js
// Vercel Edge Function — injects page-specific OG meta tags for:
//   /token/:curveId  — token name, symbol, image, price, mcap, curve progress
//   /stats           — protocol volume & fee stats
//   /leaderboard     — top tokens & traders
//
// Crawlers get server-rendered meta. Real users get index.html as normal.
//
// NOTE: Edge runtime has no Node.js — cannot use @mysten/sui SDK.
// All Sui data is fetched via raw GraphQL queries to graphql.testnet.sui.io.

export const config = { runtime: 'edge' };

const GRAPHQL_URL    = 'https://graphql.testnet.sui.io/graphql';
const INDEXER_URL    = 'https://suipump-62s2.onrender.com';
const APP_URL        = 'https://suipump.vercel.app';
const FALLBACK_IMAGE = 'https://i.imgur.com/qS6SGc7.jpeg';
const MIST_PER_SUI   = 1_000_000_000n;

// All package IDs — used for event queries
const ALL_PACKAGE_IDS = [
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8', // V4
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236', // V5
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768', // V6
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0', // V7
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69', // V8_1
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546', // V8
];

// ── GraphQL helpers ───────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

async function getCurveFields(curveId) {
  const data = await gql(`
    query GetCurve($id: SuiAddress!) {
      object(address: $id) {
        asMoveObject {
          contents {
            type { repr }
            json
          }
        }
      }
    }
  `, { id: curveId });

  const obj = data?.object?.asMoveObject?.contents;
  if (!obj) return { fields: null, type: null };
  const fields = typeof obj.json === 'string' ? JSON.parse(obj.json) : obj.json;
  return { fields, type: obj.type?.repr ?? null };
}

async function getCoinMetadata(coinType) {
  try {
    const data = await gql(`
      query GetCoinMeta($type: String!) {
        coinMetadata(coinType: $type) {
          name
          symbol
          description
          iconUrl
        }
      }
    `, { type: coinType });
    return data?.coinMetadata ?? null;
  } catch { return null; }
}

async function queryRecentEvents(eventType, limit = 50) {
  try {
    const data = await gql(`
      query GetEvents($type: String!, $limit: Int!) {
        events(filter: { type: $type }, first: $limit) {
          nodes {
            contents { json }
          }
        }
      }
    `, { type: eventType, limit });
    return (data?.events?.nodes ?? []).map(n => {
      const j = n.contents?.json;
      return typeof j === 'string' ? JSON.parse(j) : (j ?? {});
    });
  } catch { return []; }
}

// ── Bonding curve math ────────────────────────────────────────────────────────

const TOKEN_DECIMALS = 6;
const TOTAL_SUPPLY   = 1_000_000_000;

// Per-package virtual reserves for accurate price
const VIRTUAL_PARAMS = {
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8': { vSui: 30_000n,  vTok: 1_073_000_000n, drain: 87_912n  }, // V4
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236': { vSui: 10_000n,  vTok: 1_073_000_000n, drain: 30_000n  }, // V5
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768': { vSui: 10_000n,  vTok: 1_073_000_000n, drain: 30_000n  }, // V6
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0': { vSui: 5_000n,   vTok: 1_073_000_000n, drain: 9_000n   }, // V7
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69': { vSui: 3_500n,   vTok: 1_073_000_000n, drain: 9_000n   }, // V8_1
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546': { vSui: 3_500n,   vTok: 1_073_000_000n, drain: 9_000n   }, // V8
};
const DEFAULT_PARAMS = { vSui: 3_500n, vTok: 1_073_000_000n, drain: 9_000n };

function getParams(typeRepr) {
  const pkgId = typeRepr?.split('::')?.[0];
  return VIRTUAL_PARAMS[pkgId] ?? DEFAULT_PARAMS;
}

function calcPriceAndProgress(fields, typeRepr) {
  if (!fields) return { priceStr: null, mcapStr: null, progress: null };
  const { vSui, vTok, drain } = getParams(typeRepr);
  const suiReserve  = BigInt(fields.sui_reserve  ?? 0);
  const tokReserve  = BigInt(fields.token_reserve ?? 0);
  const tokensSold  = BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokReserve;
  const vs          = vSui * MIST_PER_SUI + suiReserve;
  const vt          = vTok * 10n ** BigInt(TOKEN_DECIMALS) - tokensSold;
  if (vt <= 0n) return { priceStr: null, mcapStr: null, progress: null };
  const priceMist   = (vs * 10n ** BigInt(TOKEN_DECIMALS)) / vt;
  const priceSui    = Number(priceMist) / 1e9;
  const mcapSui     = priceSui * TOTAL_SUPPLY;
  const progressPct = Math.min(100, (Number(suiReserve) / 1e9 / Number(drain)) * 100);
  return {
    priceStr: priceSui.toFixed(8),
    mcapStr:  fmtSui(mcapSui),
    progress: progressPct.toFixed(1),
  };
}

function fmtSui(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

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

// ── Page meta builders ────────────────────────────────────────────────────────

async function tokenMeta(curveId) {
  // Try indexer first — faster and has name/symbol/icon already resolved
  try {
    const r = await fetch(`${INDEXER_URL}/token/${curveId}`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      const name   = d.name   ?? 'Unknown Token';
      const symbol = d.symbol ?? '???';
      const img    = d.iconUrl ?? FALLBACK_IMAGE;

      // Still need curve fields for price/progress
      const { fields, type } = await getCurveFields(curveId);
      const { priceStr, mcapStr, progress } = calcPriceAndProgress(fields, type);
      const graduated = fields?.graduated ?? false;

      const descParts = [];
      if (priceStr)  descParts.push(`Price: ${priceStr} SUI`);
      if (mcapStr)   descParts.push(`MCap: ${mcapStr} SUI`);
      if (progress)  descParts.push(`Curve: ${progress}%`);
      if (graduated) descParts.push('✅ Graduated');
      const desc = descParts.join(' · ') || `Trade $${symbol} on SuiPump.`;

      return { title: `$${symbol} — ${name} on SuiPump`, desc, img, pageUrl: `${APP_URL}/token/${curveId}` };
    }
  } catch {}

  // Fallback: GraphQL
  const { fields, type } = await getCurveFields(curveId);
  const tokenType = type?.match(/Curve<(.+)>$/)?.[1] ?? null;
  const coinMeta  = tokenType ? await getCoinMetadata(tokenType) : null;

  const name        = coinMeta?.name   ?? fields?.name   ?? 'Unknown Token';
  const symbol      = coinMeta?.symbol ?? fields?.symbol ?? '???';
  const img         = coinMeta?.iconUrl ?? FALLBACK_IMAGE;
  const graduated   = fields?.graduated ?? false;

  const { priceStr, mcapStr, progress } = calcPriceAndProgress(fields, type);

  const descParts = [];
  if (priceStr)  descParts.push(`Price: ${priceStr} SUI`);
  if (mcapStr)   descParts.push(`MCap: ${mcapStr} SUI`);
  if (progress)  descParts.push(`Curve: ${progress}%`);
  if (graduated) descParts.push('✅ Graduated');
  const desc = descParts.join(' · ') || `Trade $${symbol} on SuiPump.`;

  return { title: `$${symbol} — ${name} on SuiPump`, desc, img, pageUrl: `${APP_URL}/token/${curveId}` };
}

async function statsMeta() {
  // Try indexer first
  try {
    const r = await fetch(`${INDEXER_URL}/stats`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      const vol    = d.totalVolume ?? 0;
      const trades = d.totalTrades ?? 0;
      const desc   = vol > 0
        ? `${fmtSui(vol)} SUI traded across ${trades}+ trades on SuiPump. 1% fee — 40% to creators, 50% protocol, 10% LP.`
        : 'Live protocol metrics for SuiPump — permissionless token launchpad on Sui.';
      return { title: 'SuiPump Protocol Stats', desc, img: FALLBACK_IMAGE, pageUrl: `${APP_URL}/stats` };
    }
  } catch {}

  // Fallback: GraphQL events across all packages
  let volumeMist = 0n;
  let trades = 0;
  await Promise.all(ALL_PACKAGE_IDS.flatMap(pkg => [
    queryRecentEvents(`${pkg}::bonding_curve::TokensPurchased`, 20).then(evts => {
      for (const e of evts) { volumeMist += BigInt(e.sui_in ?? 0); trades++; }
    }),
    queryRecentEvents(`${pkg}::bonding_curve::TokensSold`, 20).then(evts => {
      for (const e of evts) { volumeMist += BigInt(e.sui_out ?? 0); trades++; }
    }),
  ]));

  const volumeSui = Number(volumeMist) / 1e9;
  const desc = volumeSui > 0
    ? `${fmtSui(volumeSui)} SUI traded across ${trades}+ trades on SuiPump. 1% fee — 40% to creators, 50% protocol, 10% LP.`
    : 'Live protocol metrics for SuiPump — permissionless token launchpad on Sui.';

  return { title: 'SuiPump Protocol Stats', desc, img: FALLBACK_IMAGE, pageUrl: `${APP_URL}/stats` };
}

async function leaderboardMeta() {
  // Try indexer first
  try {
    const r = await fetch(`${INDEXER_URL}/leaderboard/volume?limit=1`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const rows = await r.json();
      const topVolume  = rows[0]?.volume_sui ?? 0;
      const tokenCount = rows.length;
      const desc = tokenCount > 0
        ? `Top tokens and traders on SuiPump. #1 token: ${fmtSui(topVolume)} SUI volume.`
        : 'Top tokens and traders ranked by volume on SuiPump.';
      return { title: 'SuiPump Leaderboard — Top Tokens & Traders', desc, img: FALLBACK_IMAGE, pageUrl: `${APP_URL}/leaderboard` };
    }
  } catch {}

  // Fallback: GraphQL events
  const volByCurve = {};
  await Promise.all(ALL_PACKAGE_IDS.flatMap(pkg => [
    queryRecentEvents(`${pkg}::bonding_curve::TokensPurchased`, 20).then(evts => {
      for (const e of evts) {
        if (e.curve_id) volByCurve[e.curve_id] = (volByCurve[e.curve_id] ?? 0) + Number(e.sui_in ?? 0) / 1e9;
      }
    }),
    queryRecentEvents(`${pkg}::bonding_curve::TokensSold`, 20).then(evts => {
      for (const e of evts) {
        if (e.curve_id) volByCurve[e.curve_id] = (volByCurve[e.curve_id] ?? 0) + Number(e.sui_out ?? 0) / 1e9;
      }
    }),
  ]));

  const sorted     = Object.entries(volByCurve).sort((a, b) => b[1] - a[1]);
  const topVolume  = sorted[0]?.[1] ?? 0;
  const tokenCount = sorted.length;
  const desc = tokenCount > 0
    ? `Top tokens and traders on SuiPump. #1 token: ${fmtSui(topVolume)} SUI volume. ${tokenCount} tokens ranked.`
    : 'Top tokens and traders ranked by volume on SuiPump — permissionless token launchpad on Sui.';

  return { title: 'SuiPump Leaderboard — Top Tokens & Traders', desc, img: FALLBACK_IMAGE, pageUrl: `${APP_URL}/leaderboard` };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
  const url     = new URL(req.url);
  const ua      = req.headers.get('user-agent') || '';
  const page    = url.searchParams.get('page') || 'token';
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
