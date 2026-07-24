// x_provider.js -- pluggable X (Twitter) data-access layer for the content
// bounty tracker.
//
// WHY AN INTERFACE: unofficial X data providers break or disappear without
// notice (see the Phase-1 research). Every X read in the bounty tracker goes
// through the XProvider contract below, so swapping the underlying API is a
// single-file change here plus flipping the X_PROVIDER env var -- nothing in
// bounty.js (poller, routes) touches a provider-specific field name or URL.
//
// XProvider contract:
//   searchRecent(query, cursor?) ->
//     { posts: NormalizedPost[], cursor?: string, cost: number }
//   getPostsByIds(ids)           ->
//     { posts: NormalizedPost[], cost: number }
//
// NormalizedPost:
//   { postId, authorHandle, postUrl, text, createdMs,
//     retweets, likes, replies, quotes, bookmarks, views }
//
// `cost` is the number of tweet-reads the call is billed for. Providers price
// per returned tweet with a per-request minimum, so cost is reported as
// max(1, posts.length) -- the poller/governor bill exactly what the provider
// bills. This module is self-contained: no pg, no Sui client, only global
// fetch (Node 18+). It never throws for a normal empty result; network/parse
// failures reject so the caller's try/catch can bill nothing and log.

// -- Post URL validation + ID extraction --------------------------------------
// Accept x.com and twitter.com (optionally www./mobile.), a 1-15 char handle,
// then /status/<digits>. Trailing path/query/fragment after the id is tolerated
// so a pasted link with ?s=20 still validates. The captured groups are
// (handle, tweetId). Mirrors the shape used by Deezzir/x-raid-bot's validator,
// widened to both hosts and to tolerate query strings on submitted links.
const POST_URL_RE =
  /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:[/?#].*)?$/;

export function validatePostUrl(postUrl) {
  return typeof postUrl === 'string' && POST_URL_RE.test(postUrl.trim());
}

export function extractPostId(postUrl) {
  if (typeof postUrl !== 'string') return null;
  const m = postUrl.trim().match(POST_URL_RE);
  return m ? m[2] : null;
}

// A bare tweet id is 15-20 digits. Used to sanity-check ids before a batch call.
const TWEET_ID_RE = /^\d{6,25}$/;
export function isTweetId(id) {
  return typeof id === 'string' && TWEET_ID_RE.test(id);
}

// -- Shared helpers ------------------------------------------------------------

// Parse the X "created_at" string ("Tue Dec 10 07:00:30 +0000 2024") to epoch
// ms. Returns null on anything unparseable so a bad timestamp never becomes a
// NaN that silently breaks the contest-window check.
export function parseCreatedMs(createdAt) {
  if (createdAt == null) return null;
  const t = Date.parse(String(createdAt));
  return Number.isFinite(t) ? t : null;
}

// Coerce a provider metric to a non-negative integer. Providers sometimes send
// counts as strings ("1234") or omit a field; this yields 0 rather than NaN.
function intMetric(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// -- twitterapi.io adapter -----------------------------------------------------
// Docs: https://docs.twitterapi.io/introduction
//   Search: GET /twitter/tweet/advanced_search?query=&queryType=Latest&cursor=
//           -> { tweets:[...], has_next_page, next_cursor }
//   Batch:  GET /twitter/tweets?tweet_ids=<comma-separated>
//           -> { tweets:[...], status, message }
//   Auth:   header X-API-Key
//   Tweet fields: id, url, text, createdAt, author.userName,
//                 likeCount, retweetCount, replyCount, quoteCount,
//                 bookmarkCount, viewCount
// The max ids per batch call is undocumented (an example shows 3, the docs say
// "no maximum"). bounty.js batches conservatively at BOUNTY_BATCH_SIZE (default
// 20); this adapter imposes no ceiling of its own.
const TWITTERAPI_IO_BASE = 'https://api.twitterapi.io';

function twitterApiIoTweetToNormalized(tw) {
  if (!tw || typeof tw !== 'object') return null;
  const postId = tw.id != null ? String(tw.id) : null;
  if (!postId) return null;
  const handle = tw.author && tw.author.userName ? String(tw.author.userName) : null;
  const url = tw.url
    ? String(tw.url)
    : (handle ? `https://x.com/${handle}/status/${postId}` : `https://x.com/i/status/${postId}`);
  return {
    postId,
    authorHandle: handle,
    postUrl: url,
    text: tw.text != null ? String(tw.text) : null,
    createdMs: parseCreatedMs(tw.createdAt),
    retweets: intMetric(tw.retweetCount),
    likes: intMetric(tw.likeCount),
    replies: intMetric(tw.replyCount),
    quotes: intMetric(tw.quoteCount),
    bookmarks: intMetric(tw.bookmarkCount),
    views: intMetric(tw.viewCount),
  };
}

function makeTwitterApiIoProvider() {
  const apiKey = (process.env.TWITTERAPI_IO_KEY ?? '').trim();
  const base = (process.env.TWITTERAPI_IO_BASE_URL ?? TWITTERAPI_IO_BASE).trim().replace(/\/+$/, '');
  const timeoutMs = Number(process.env.BOUNTY_HTTP_TIMEOUT_MS ?? 15000);

  if (!apiKey) {
    // Fail loudly at construction rather than sending an unauthenticated call.
    throw new Error('twitterapi_io provider: TWITTERAPI_IO_KEY is not set');
  }

  async function call(path, params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${base}${path}?${qs}`, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`twitterapi_io ${path} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    name: 'twitterapi_io',

    async searchRecent(query, cursor) {
      const data = await call('/twitter/tweet/advanced_search', {
        query: String(query ?? ''),
        queryType: 'Latest',
        cursor: cursor ?? '',
      });
      const raw = Array.isArray(data?.tweets) ? data.tweets : [];
      const posts = raw.map(twitterApiIoTweetToNormalized).filter(Boolean);
      const nextCursor = data?.has_next_page && data?.next_cursor ? String(data.next_cursor) : undefined;
      return { posts, cursor: nextCursor, cost: Math.max(1, posts.length) };
    },

    async getPostsByIds(ids) {
      const clean = (Array.isArray(ids) ? ids : []).map(String).filter(isTweetId);
      if (clean.length === 0) return { posts: [], cost: 0 };
      const data = await call('/twitter/tweets', { tweet_ids: clean.join(',') });
      const raw = Array.isArray(data?.tweets) ? data.tweets : [];
      const posts = raw.map(twitterApiIoTweetToNormalized).filter(Boolean);
      // Billed per returned tweet with a per-request minimum.
      return { posts, cost: Math.max(1, posts.length) };
    },
  };
}

// -- Provider registry ---------------------------------------------------------
// To add the official X API (or any other source): write a make<Name>Provider
// factory returning the same { searchRecent, getPostsByIds } contract, register
// it here, and select it with X_PROVIDER. Nothing else in the tracker changes.
const PROVIDERS = {
  twitterapi_io: makeTwitterApiIoProvider,
};

export function getXProvider() {
  const name = (process.env.X_PROVIDER ?? 'twitterapi_io').trim();
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new Error(
      `unknown X_PROVIDER '${name}'; known providers: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }
  return factory();
}

// True when the selected provider has the credentials it needs to run. Used by
// the arming gate and the submit route so a missing key degrades to a clear
// "not configured" state instead of an opaque 500.
export function xProviderConfigured() {
  const name = (process.env.X_PROVIDER ?? 'twitterapi_io').trim();
  if (name === 'twitterapi_io') return Boolean((process.env.TWITTERAPI_IO_KEY ?? '').trim());
  // Unknown providers are treated as unconfigured until their factory exists.
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name);
}
