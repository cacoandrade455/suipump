// api/token-og.js
// Vercel Edge Function — injects token-specific OG meta tags for /token/:curveId
// Runs at the edge before the SPA HTML is served, so Discord/X/Telegram
// crawlers see real token name, symbol, image, and price instead of the
// generic SuiPump homepage preview.
//
// Deploy: this file goes in frontend-app/api/token-og.js
// Vercel auto-detects api/ directory and treats each file as a serverless fn.
// vercel.json routes /token/:curveId here ONLY for non-browser requests
// (User-Agent sniff) — real users still get the SPA.

export const config = { runtime: 'edge' };

const PACKAGE_ID = '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';
const SUI_RPC    = 'https://fullnode.testnet.sui.io';
const APP_URL    = 'https://suipump.vercel.app';
const FALLBACK_IMAGE = 'https://i.imgur.com/qS6SGc7.jpeg';

// ── RPC helpers ─────────────────────────────────────────────────────────────

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
  try {
    return await rpc('suix_getCoinMetadata', [coinType]);
  } catch {
    return null;
  }
}

// ── Bonding curve math (mirrors curve.js) ────────────────────────────────────

const MIST_PER_SUI   = 1_000_000_000n;
const TOKEN_DECIMALS = 6;
const VIRTUAL_SUI    = 30_000n * 1_000_000_000n;   // 30k SUI in MIST
const VIRTUAL_TOKENS = 1_073_000_000n * 1_000_000n; // 1.073B tokens in micro
const TOTAL_SUPPLY   = 1_000_000_000;               // whole tokens

function priceMistPerToken(suiReserveMist, tokensSoldMicro) {
  const vs = VIRTUAL_SUI + BigInt(suiReserveMist);
  const vt = VIRTUAL_TOKENS - BigInt(tokensSoldMicro);
  if (vt <= 0n) return 0n;
  // price = vs / vt  (MIST per micro-token) × 1e6 to get MIST per whole token
  return (vs * 1_000_000n) / vt;
}

function calcProgress(suiReserveMist) {
  const DRAIN = 87_912n * MIST_PER_SUI;
  const pct = (BigInt(suiReserveMist) * 10_000n) / DRAIN;
  return Math.min(100, Number(pct) / 100);
}

// ── Meta tag injection ───────────────────────────────────────────────────────

function buildMeta({ name, symbol, description, imageUrl, price, mcap, progress, curveId, graduated }) {
  const title = `$${symbol} — ${name} on SuiPump`;

  const descParts = [];
  if (price)    descParts.push(`Price: ${price} SUI`);
  if (mcap)     descParts.push(`MCap: ${mcap} SUI`);
  if (progress) descParts.push(`Curve: ${progress}%`);
  if (graduated) descParts.push('✅ Graduated to DEX');
  if (description) descParts.push(description.slice(0, 120));
  const desc = descParts.join(' · ') || `Trade $${symbol} on SuiPump — permissionless token launchpad on Sui.`;

  const tokenUrl = `${APP_URL}/token/${curveId}`;
  const img = imageUrl || FALLBACK_IMAGE;

  return `
    <!-- Primary meta — token-specific (injected by edge fn) -->
    <title>${escHtml(title)}</title>
    <meta name="description" content="${escHtml(desc)}" />

    <!-- Open Graph -->
    <meta property="og:type"        content="website" />
    <meta property="og:url"         content="${escHtml(tokenUrl)}" />
    <meta property="og:title"       content="${escHtml(title)}" />
    <meta property="og:description" content="${escHtml(desc)}" />
    <meta property="og:image"       content="${escHtml(img)}" />
    <meta property="og:image:width"  content="400" />
    <meta property="og:image:height" content="400" />
    <meta property="og:site_name"   content="SuiPump" />

    <!-- Twitter / X Card -->
    <meta name="twitter:card"        content="summary" />
    <meta name="twitter:site"        content="@SuiPump_SUMP" />
    <meta name="twitter:title"       content="${escHtml(title)}" />
    <meta name="twitter:description" content="${escHtml(desc)}" />
    <meta name="twitter:image"       content="${escHtml(img)}" />
  `.trim();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Bot / crawler detection ──────────────────────────────────────────────────

function isCrawler(ua = '') {
  const bots = [
    'twitterbot', 'discordbot', 'telegrambot', 'slackbot',
    'facebot', 'linkedinbot', 'whatsapp', 'applebot',
    'googlebot', 'bingbot', 'ia_archiver', 'embedly',
    'outbrain', 'pinterest', 'rogerbot', 'showyoubot',
    'vkshare', 'w3c_validator',
  ];
  const lower = ua.toLowerCase();
  return bots.some(b => lower.includes(b));
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req) {
  const url     = new URL(req.url);
  const ua      = req.headers.get('user-agent') || '';
  const curveId = url.searchParams.get('curveId') || url.pathname.split('/').pop();

  // Only intercept crawlers — real users get normal SPA response
  if (!isCrawler(ua)) {
    // Redirect to the SPA (Vercel will serve index.html via the rewrite)
    return new Response(null, {
      status: 302,
      headers: { Location: `${APP_URL}/token/${curveId}` },
    });
  }

  // Fetch the static index.html from Vercel's own origin
  let html;
  try {
    const indexRes = await fetch(`${APP_URL}/index.html`);
    html = await indexRes.text();
  } catch {
    return new Response('Not found', { status: 404 });
  }

  // Fetch token data from Sui RPC (best-effort — fall back to generic meta on error)
  let meta = null;
  try {
    const { fields, type } = await getCurveFields(curveId);

    // Extract tokenType from Curve<T> type string
    const tokenType = type?.match(/Curve<(.+)>$/)?.[1] ?? null;

    // Fetch coin metadata for icon, name, symbol, description
    const coinMeta = tokenType ? await getCoinMetadata(tokenType) : null;

    const name        = coinMeta?.name        ?? fields?.name        ?? 'Unknown Token';
    const symbol      = coinMeta?.symbol      ?? fields?.symbol      ?? '???';
    const description = coinMeta?.description ?? '';
    const imageUrl    = coinMeta?.iconUrl      ?? null;
    const graduated   = fields?.graduated      ?? false;

    // Price & market cap
    let priceStr = null;
    let mcapStr  = null;
    if (fields) {
      const suiReserve  = BigInt(fields.sui_reserve  ?? 0);
      const tokensSold  = BigInt(800_000_000) * BigInt(10 ** TOKEN_DECIMALS)
                        - BigInt(fields.token_reserve ?? 0);
      const priceMist   = priceMistPerToken(suiReserve, tokensSold);
      const priceSui    = Number(priceMist) / 1e9;
      const mcapSui     = priceSui * TOTAL_SUPPLY;
      priceStr = priceSui.toFixed(8);
      mcapStr  = mcapSui >= 1_000 ? `${(mcapSui / 1_000).toFixed(1)}k` : mcapSui.toFixed(0);
    }

    const progress = fields ? calcProgress(fields.sui_reserve).toFixed(1) : null;

    meta = buildMeta({ name, symbol, description, imageUrl, price: priceStr, mcap: mcapStr, progress, curveId, graduated });
  } catch (err) {
    // Fall back: inject minimal meta pointing to the token URL
    const tokenUrl = `${APP_URL}/token/${curveId}`;
    meta = `
      <title>Token on SuiPump</title>
      <meta property="og:title"       content="Token on SuiPump" />
      <meta property="og:description" content="Permissionless token launchpad on Sui." />
      <meta property="og:image"       content="${FALLBACK_IMAGE}" />
      <meta property="og:url"         content="${tokenUrl}" />
      <meta name="twitter:card"       content="summary" />
      <meta name="twitter:image"      content="${FALLBACK_IMAGE}" />
    `.trim();
  }

  // Replace the existing <title> and static OG tags in index.html
  // Strategy: remove the existing static title + OG block, inject token meta
  const injected = html
    // Remove existing static title
    .replace(/<title>[^<]*<\/title>/, '')
    // Remove existing OG/Twitter meta tags
    .replace(/<meta\s+(?:property|name)="(?:og:|twitter:|description)[^"]*"[^>]*\/>/gi, '')
    // Inject token meta right after <head>
    .replace('<head>', `<head>\n    ${meta}`);

  return new Response(injected, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=30, stale-while-revalidate=60',
      'X-Robots-Tag': 'index, follow',
    },
  });
}
