// api/token-og.js
// Vercel Edge Function -- server-rendered OG/Twitter meta for social crawlers:
//   /token/:curveId  -- token name, symbol, image, price, mcap, curve progress
//   /stats           -- protocol volume & trade stats
//   /leaderboard     -- top tokens by volume
//
// WIRING: vercel.json routes ONLY crawler user-agents here (ordered rewrites
// with a `has` UA match, ahead of the SPA catch-all). Humans never hit this
// function via site links; a direct hit gets a 302 back to the SPA route.
//
// DATA STRATEGY (post 2026-07-04 price fixes): the indexer's /token/:id
// last_price is reserve-derived and version-correct, so it is the PRIMARY
// source for everything (name/symbol/icon/price/reserve/graduated). The raw
// GraphQL curve read is the FALLBACK for indexer outages only.
//
// NOTE: Edge runtime has no Node.js -- no @mysten/sui SDK. Fallback Sui data
// comes from raw GraphQL queries to graphql.testnet.sui.io. GraphQL page
// sizes are CAPPED AT 50 by the RPC validator (larger pages null the whole
// read -- the PortfolioPage holdings incident).

export const config = { runtime: 'edge' };

const GRAPHQL_URL    = 'https://graphql.testnet.sui.io/graphql';
const INDEXER_URL    = 'https://suipump-62s2.onrender.com';
const APP_URL        = 'https://suipump.org';
const FALLBACK_IMAGE = 'https://suipump.org/og-banner.png'; // torch brand card (brand v2, 2026-07-13)
const MIST_PER_SUI   = 1_000_000_000n;

// Defining package ids -- event TYPES define here forever (V11/V12 are
// upgrades of V10, so lineage events keep typing under V10; they never get
// their own event-type namespace for the legacy events used below).
// V13 -- SEPARATE PUBLISHED LINEAGE (fresh publish 2026-07-17, NOT a V10 upgrade),
// so V13 curves/events have their OWN type identity (they do NOT type as V10).
// Env-driven (Vercel edge env exposes process.env), so the id is never hardcoded.
// Full V13 id: 0xdf66376f006557b9f81b3455ee786ffd7f2a633488cc3bd31a37ddbdc69bd56b
const V13_PACKAGE = (process.env.SUIPUMP_V13_PACKAGE ?? '').trim().toLowerCase() || null;
// V14 (GRAD-1): ADDITIVE upgrade of V13; V14 curves keep the V13 type, so this id
// appears only via the new GraduationCapIssued/Rotated events. Env-gated; null when
// SUIPUMP_V14_PACKAGE is unset (then this module behaves exactly as pre-V14).
const V14_PACKAGE = (process.env.SUIPUMP_V14_PACKAGE ?? '').trim().toLowerCase() || null;

const ALL_PACKAGE_IDS = [
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8', // V4
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236', // V5
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768', // V6
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0', // V7
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69', // V8_1
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546', // V8
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2', // V9
  '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598', // V10 (whole V10/V11/V12 lineage)
  // V13 -- separate lineage; its bonding_curve events (TokensPurchased etc.) type
  // under the V13 id. Env-gated; conditional spread so a null id never enters.
  ...(V13_PACKAGE ? [V13_PACKAGE] : []),
  // V14 -- ADDITIVE upgrade of V13; only the new GraduationCap events type under it.
  ...(V14_PACKAGE ? [V14_PACKAGE] : []),
];

// -- GraphQL helpers ----------------------------------------------------------

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

async function queryRecentEvents(eventType, limit = 20) {
  try {
    // RPC hard-caps GraphQL pages at 50 -- never request more.
    const capped = Math.min(limit, 50);
    const data = await gql(`
      query GetEvents($type: String!, $limit: Int!) {
        events(filter: { type: $type }, first: $limit) {
          nodes {
            contents { json }
          }
        }
      }
    `, { type: eventType, limit: capped });
    return (data?.events?.nodes ?? []).map(n => {
      const j = n.contents?.json;
      return typeof j === 'string' ? JSON.parse(j) : (j ?? {});
    });
  } catch { return []; }
}

// -- Bonding curve math (GraphQL FALLBACK path only) ---------------------------

const TOKEN_DECIMALS = 6;
const TOTAL_SUPPLY   = 1_000_000_000; // 800M curve + 200M reserve

// Per-package virtual reserves + graduation drain -- MUST match the contracts
// and frontend constants.js. Every new package version needs a row here or
// prices silently fall through to a wrong shape (the -20% badge incident).
const VIRTUAL_PARAMS = {
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8': { vSui: 30_000n, vTok: 1_073_000_000n, drain: 35_000n }, // V4
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236': { vSui: 9_000n,  vTok: 1_073_000_000n, drain: 17_000n }, // V5
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768': { vSui: 9_000n,  vTok: 1_073_000_000n, drain: 17_000n }, // V6
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0': { vSui: 3_500n,  vTok: 1_073_000_000n, drain: 9_000n  }, // V7
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69': { vSui: 3_500n,  vTok: 1_073_000_000n, drain: 9_000n  }, // V8_1
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546': { vSui: 3_500n,  vTok: 1_073_000_000n, drain: 9_000n  }, // V8
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2': { vSui: 4_369n,  vTok: 1_073_000_000n, drain: 12_305n }, // V9
  '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598': { vSui: 4_369n,  vTok: 1_073_000_000n, drain: 12_305n }, // V10 lineage (curves type as V10)
  '0xc03817bce45ff492e5d0f40f9e46f5a075a952b50c5c6146b8fb38138bd699eb': { vSui: 4_369n,  vTok: 1_073_000_000n, drain: 12_305n }, // V11 (defensive)
  '0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd': { vSui: 4_369n,  vTok: 1_073_000_000n, drain: 12_305n }, // V12 (defensive)
  // V13 -- SEPARATE lineage. Curve shape is UNCHANGED from V9+ (vSui 4_369, vTok
  // 1_073_000_000, confirmed vs contracts-v10/sources/bonding_curve.move:177-178),
  // so PRICE is correct here. `drain` is the price-unset FLOOR (9_000 = BASE_GRAD),
  // NOT a live target: V13's real graduation threshold is oracle-dampened (dynamic),
  // resolved from the indexer's per-curve grad_threshold_sui (the contract's
  // current_grad_threshold). This floor is used only when that value is absent - a
  // static 12_305 here would render a wrong target. Env-gated so the id is never hardcoded.
  ...(V13_PACKAGE ? { [V13_PACKAGE]: { vSui: 4_369n, vTok: 1_073_000_000n, drain: 9_000n } } : {}),
  // V14 (GRAD-1) -- ADDITIVE upgrade of V13: a V14 curve IS a V13 curve, so this id
  // should never appear as a curve-type package. Defensive row: if it ever does, it
  // MUST resolve to the SAME V13/V9+ shape (drain 9_000 = price-unset FLOOR, live
  // per-curve grad_threshold_sui preferred), never fall through to DEFAULT_PARAMS.
  // Env-gated; see also the '0xb6e7cef4' prefix fallback in paramsForPackage.
  // Full V14 id: 0xb6e7cef4d36b3cf0fd84888dd9930ce9abfcc0ed56f01384f1e02b55eeac1b03
  ...(V14_PACKAGE ? { [V14_PACKAGE]: { vSui: 4_369n, vTok: 1_073_000_000n, drain: 9_000n } } : {}),
};
const DEFAULT_PARAMS = { vSui: 3_500n, vTok: 1_073_000_000n, drain: 9_000n };

function paramsForPackage(pkgId) {
  const key = String(pkgId ?? '').toLowerCase();
  const hit = VIRTUAL_PARAMS[key];
  if (hit) return hit;
  // V14 (GRAD-1) prefix fallback for when SUIPUMP_V14_PACKAGE is unset: a V14 curve
  // IS a V13 curve (same V9+ shape; drain 9_000 = price-unset FLOOR).
  // Full V14 id: 0xb6e7cef4d36b3cf0fd84888dd9930ce9abfcc0ed56f01384f1e02b55eeac1b03
  if (key.startsWith('0xb6e7cef4')) return { vSui: 4_369n, vTok: 1_073_000_000n, drain: 9_000n };
  // Genuinely unknown package -- LOUD, do not silently return stale reserves (the
  // guard the -20.2% price-badge incident lacked). This is a fallback-only path
  // (the indexer is the primary price source); still surface the misconfiguration.
  if (key) console.warn(`[token-og] UNKNOWN package id ${key} - no VIRTUAL_PARAMS branch; using DEFAULT (vSui 3500). If this is a new lineage, add a branch.`);
  return DEFAULT_PARAMS;
}

function calcPriceAndProgress(fields, typeRepr) {
  if (!fields) return { priceSui: null, progress: null };
  const { vSui, vTok, drain } = paramsForPackage(typeRepr?.split('::')?.[0]);
  const suiReserve = BigInt(fields.sui_reserve   ?? 0);
  const tokReserve = BigInt(fields.token_reserve ?? 0);
  const tokensSold = BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokReserve;
  const vs = vSui * MIST_PER_SUI + suiReserve;                 // MIST
  const vt = vTok * 10n ** BigInt(TOKEN_DECIMALS) - tokensSold; // atomic tokens
  if (vt <= 0n) return { priceSui: null, progress: null };
  // Spot price of the x*y=k curve: virtual SUI over virtual tokens.
  const priceMist = (vs * 10n ** BigInt(TOKEN_DECIMALS)) / vt;
  const priceSui  = Number(priceMist) / 1e9;
  const progress  = Math.min(100, (Number(suiReserve) / 1e9 / Number(drain)) * 100);
  return { priceSui, progress };
}

// -- Formatting ----------------------------------------------------------------

function fmtSui(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(n >= 10 ? 0 : 2);
}

function fmtPrice(p) {
  if (!(p > 0)) return null;
  return p < 0.001 ? p.toFixed(8) : p.toFixed(4);
}

function buildTokenDesc({ priceSui, reserveSui, drain, graduated, description, symbol }) {
  const parts = [];
  const price = fmtPrice(priceSui);
  if (price) {
    parts.push(`Price ${price} SUI`);
    parts.push(`MCap ${fmtSui(priceSui * TOTAL_SUPPLY)} SUI`);
  }
  if (graduated) {
    parts.push('Graduated to DEX');
  } else if (reserveSui != null && drain) {
    parts.push(`Curve ${Math.min(100, (reserveSui / drain) * 100).toFixed(1)}%`);
  }
  // Creator description: text before the '||' metadata separator, trimmed.
  const blurb = String(description ?? '').split('||')[0].trim();
  if (blurb) parts.push(blurb.length > 90 ? `${blurb.slice(0, 87)}...` : blurb);
  return parts.join(' | ') || `Trade $${symbol} on SuiPump.`;
}

// -- HTML helpers ---------------------------------------------------------------

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function injectMeta(html, { title, desc, img, pageUrl }) {
  const out = html
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
    return '<!doctype html><html><head></head><body></body></html>';
  }
}

function cleanIcon(raw) {
  const s = String(raw ?? '').trim();
  return /^https?:\/\//.test(s) ? s : null;
}

// -- Page meta builders ----------------------------------------------------------

async function tokenMeta(curveId) {
  const pageUrl = `${APP_URL}/token/${curveId}`;

  // PRIMARY: the indexer -- one round trip, and last_price is reserve-derived
  // and version-correct since the 2026-07-04 getVirtuals fixes.
  try {
    const r = await fetch(`${INDEXER_URL}/token/${curveId}`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      const symbol = d.symbol ?? '???';
      const name   = d.name   ?? 'Unknown Token';
      const img    = cleanIcon(d.icon_url ?? d.iconUrl) ?? FALLBACK_IMAGE;
      // V13/V14 target is dynamic: prefer the indexer's per-curve grad_threshold_sui
      // (the contract's current_grad_threshold from the last buy) over the static
      // per-package floor. Legacy V4-V12 keep their static drain.
      const isV13 = V13_PACKAGE && String(d.package_id ?? '').toLowerCase() === V13_PACKAGE;
      const drain  = (isV13 && Number(d.grad_threshold_sui) > 0)
        ? Number(d.grad_threshold_sui)
        : Number(paramsForPackage(d.package_id).drain);
      const desc   = buildTokenDesc({
        priceSui:    Number(d.last_price ?? 0),
        reserveSui:  Number(d.reserve_sui ?? 0),
        drain,
        graduated:   d.graduated === true,
        description: d.description,
        symbol,
      });
      return { title: `$${symbol} -- ${name} on SuiPump`, desc, img, pageUrl };
    }
  } catch { /* indexer down -- fall through to chain */ }

  // FALLBACK: raw chain read.
  const { fields, type } = await getCurveFields(curveId);
  const tokenType = type?.match(/Curve<(.+)>$/)?.[1] ?? null;
  const coinMeta  = tokenType ? await getCoinMetadata(tokenType) : null;

  const name   = coinMeta?.name   ?? fields?.name   ?? 'Unknown Token';
  const symbol = coinMeta?.symbol ?? fields?.symbol ?? '???';
  const img    = cleanIcon(coinMeta?.iconUrl) ?? FALLBACK_IMAGE;
  const { priceSui, progress } = calcPriceAndProgress(fields, type);

  const parts = [];
  const price = fmtPrice(priceSui);
  if (price)    { parts.push(`Price ${price} SUI`); parts.push(`MCap ${fmtSui(priceSui * TOTAL_SUPPLY)} SUI`); }
  if (fields?.graduated) parts.push('Graduated to DEX');
  else if (progress != null) parts.push(`Curve ${progress.toFixed(1)}%`);
  const desc = parts.join(' | ') || `Trade $${symbol} on SuiPump.`;

  return { title: `$${symbol} -- ${name} on SuiPump`, desc, img, pageUrl };
}

async function statsMeta() {
  try {
    const r = await fetch(`${INDEXER_URL}/stats`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      const vol    = Number(d.totalVolume ?? d.total_volume ?? 0);
      const trades = Number(d.totalTrades ?? d.total_trades ?? 0);
      const desc   = vol > 0
        ? `${fmtSui(vol)} SUI traded across ${trades}+ trades on SuiPump. 1% fee -- 40% to creators, 50% protocol, 10% LP.`
        : 'Live protocol metrics for SuiPump -- permissionless token launchpad on Sui.';
      return { title: 'SuiPump Protocol Stats', desc, img: FALLBACK_IMAGE, pageUrl: `${APP_URL}/stats` };
    }
  } catch {}

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
    ? `${fmtSui(volumeSui)} SUI traded across ${trades}+ recent trades on SuiPump. 1% fee -- 40% to creators, 50% protocol, 10% LP.`
    : 'Live protocol metrics for SuiPump -- permissionless token launchpad on Sui.';

  return { title: 'SuiPump Protocol Stats', desc, img: FALLBACK_IMAGE, pageUrl: `${APP_URL}/stats` };
}

async function leaderboardMeta() {
  try {
    const r = await fetch(`${INDEXER_URL}/leaderboard/volume?limit=1`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const rows = await r.json();
      const topVolume = Number(rows?.[0]?.volume_sui ?? 0);
      const desc = topVolume > 0
        ? `Top tokens and traders on SuiPump. #1 token: ${fmtSui(topVolume)} SUI volume.`
        : 'Top tokens and traders ranked by volume on SuiPump.';
      return { title: 'SuiPump Leaderboard -- Top Tokens & Traders', desc, img: FALLBACK_IMAGE, pageUrl: `${APP_URL}/leaderboard` };
    }
  } catch {}

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

  const sorted    = Object.entries(volByCurve).sort((a, b) => b[1] - a[1]);
  const topVolume = sorted[0]?.[1] ?? 0;
  const desc = sorted.length > 0
    ? `Top tokens and traders on SuiPump. #1 token: ${fmtSui(topVolume)} SUI volume. ${sorted.length} tokens ranked.`
    : 'Top tokens and traders ranked by volume on SuiPump -- permissionless token launchpad on Sui.';

  return { title: 'SuiPump Leaderboard -- Top Tokens & Traders', desc, img: FALLBACK_IMAGE, pageUrl: `${APP_URL}/leaderboard` };
}

// -- Main handler -----------------------------------------------------------------

export default async function handler(req) {
  const url     = new URL(req.url);
  const page    = url.searchParams.get('page') || 'token';
  const curveId = url.searchParams.get('curveId') || '';

  // vercel.json only routes crawler user-agents here, but if a human request
  // reaches this function for any reason, we must serve the SPA shell DIRECTLY
  // -- NEVER redirect. Redirecting to the same /token/:id that routed here
  // produces an infinite loop (ERR_TOO_MANY_REDIRECTS). Serving index.html
  // returns the normal SPA and the client router takes over.
  const ua = (req.headers.get('user-agent') || '').toLowerCase();
  const looksLikeBot = /bot|whatsapp|facebookexternalhit|embedly|pinterest|vkshare|validator|ia_archiver/.test(ua);
  if (!looksLikeBot) {
    const html = await fetchIndexHtml();
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'Vary': 'User-Agent',
      },
    });
  }

  let meta = {
    title:   'SuiPump -- Permissionless Token Launchpad on Sui',
    desc:    'Launch a token on Sui in 2 wallet signatures. Fair launch, no pre-mine, 40% creator fees.',
    img:     FALLBACK_IMAGE,
    pageUrl: APP_URL,
  };

  try {
    if (page === 'token' && /^0x[0-9a-fA-F]{1,64}$/.test(curveId)) {
      meta = await tokenMeta(curveId);
    } else if (page === 'stats') {
      meta = await statsMeta();
    } else if (page === 'leaderboard') {
      meta = await leaderboardMeta();
    }
  } catch { /* default meta already set */ }

  const html = injectMeta(await fetchIndexHtml(), meta);

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // NO shared caching. Vercel's CDN keys on the URL, not the user-agent,
      // so a cacheable crawler response gets served to HUMANS hitting the
      // same /token/:id within the TTL - observed live: plain curl received
      // the OG page for a minute after a Twitterbot fetch, BEFORE the
      // rewrites were even evaluated. Crawler fetches are rare; correctness
      // beats cache here. Vary is belt-and-suspenders for any cache that
      // does honor it.
      'Cache-Control': 'private, no-store',
      'Vary': 'User-Agent',
    },
  });
}
