// bounty.js -- SuiPump content-bounty tracker (backend).
//
// Self-contained module, same shape as game_progress.js / orders.js: it owns
// its OWN four tables (bounty_posts, bounty_snapshots, bounty_budget,
// bounty_state), ensures them itself, and reuses the shared pool exported by
// db.js. It NEVER modifies or joins an existing indexer table, and never
// touches contracts/bridge/agent-runner. The only edits outside this file are
// the import + mountBounty(app) call in api.js and the import + armed
// startBountyPoller() call in index.js.
//
// WHAT IT DOES: community members post about SuiPump on X. This tracker
// discovers those posts (advanced search) and/or accepts manual submissions,
// snapshots their engagement on a tiered schedule (frequent while fresh, rarer
// once they plateau), and ranks them by
//   score = retweets*3 + likes*2 + replies*1
// computed from each post's LATEST snapshot. The full snapshot time series is
// kept append-only so implausible spikes can be flagged for HUMAN review (the
// `suspicious` signal); nothing is ever auto-disqualified -- `disqualified` is
// set only by an admin, manually, in the DB.
//
// PROCESS SPLIT: the poller runs in the WORKER (index.js). The routes are
// served by the WEB service (api_server.js) via the shared Express app. So any
// poller state the routes must report (last discovery time, governor mode)
// lives in the bounty_state table, not in memory.
//
// PROVIDER: all X access goes through the XProvider contract in x_provider.js,
// selected by X_PROVIDER (default 'twitterapi_io'). Swapping providers is a
// one-file change there; nothing here references a provider-specific field.
//
// BUDGET GOVERNOR: every provider call is billed (tweet-reads + requests) into
// bounty_budget per UTC day and enforced against BOUNTY_MONTHLY_TWEET_BUDGET.
// As the month's budget depletes the poller degrades in stages -- widen polling
// tiers -> stop discovery -> freeze -- logging loudly at each transition, so it
// never silently 429s and leaves a stale leaderboard that looks live.

import { pool } from './db.js';
import { getXProvider, xProviderConfigured, validatePostUrl, extractPostId } from './x_provider.js';

// -- Contest constants (fixed program terms) ----------------------------------
const POOL_USD = 200;
const PRIZES = [
  { rank: 1, usd: 100 },
  { rank: 2, usd: 75 },
  { rank: 3, usd: 25 },
];
const SCORING = { retweets: 3, likes: 2, replies: 1 };

// -- Config (env with defaults) -----------------------------------------------
// Read fresh each call so the operator can retune on the running service (the
// poller reads once per tick; the routes read per request).
function num(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}
function cfg() {
  return {
    query:               (process.env.BOUNTY_QUERY ?? 'suipump OR @SuiPump_SUMP').trim(),
    // Relevance terms enforced on MANUAL submissions (case-insensitive, OR
    // semantics). Mirrors BOUNTY_QUERY so the submit path cannot drift from what
    // discovery finds. Discovery needs no such check -- its results match the
    // search query by construction.
    requiredTerms:       (process.env.BOUNTY_REQUIRED_TERMS ?? 'suipump,@SuiPump_SUMP')
                           .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    discoveryIntervalMs: num('BOUNTY_DISCOVERY_INTERVAL_MS', 6 * 3600_000),
    pollTickMs:          num('BOUNTY_POLL_TICK_MS', 3600_000),
    // Tier boundaries by post age, and the refresh interval within each tier.
    tier1MaxMs:          num('BOUNTY_TIER1_MAX_MS', 1 * 86_400_000),
    tier1IntervalMs:     num('BOUNTY_TIER1_INTERVAL_MS', 6 * 3600_000),
    tier2MaxMs:          num('BOUNTY_TIER2_MAX_MS', 3 * 86_400_000),
    tier2IntervalMs:     num('BOUNTY_TIER2_INTERVAL_MS', 12 * 3600_000),
    tier3MaxMs:          num('BOUNTY_TIER3_MAX_MS', 7 * 86_400_000),
    tier3IntervalMs:     num('BOUNTY_TIER3_INTERVAL_MS', 24 * 3600_000),
    tier4IntervalMs:     num('BOUNTY_TIER4_INTERVAL_MS', 48 * 3600_000),
    batchSize:           Math.max(1, num('BOUNTY_BATCH_SIZE', 20)),
    maxDiscoveryPages:   Math.max(1, num('BOUNTY_MAX_DISCOVERY_PAGES', 3)),
    maxRefreshPerTick:   Math.max(1, num('BOUNTY_MAX_REFRESH_PER_TICK', 200)),
    monthlyBudget:       Math.max(0, num('BOUNTY_MONTHLY_TWEET_BUDGET', 5000)),
    govSlowPct:          num('BOUNTY_GOV_SLOW_PCT', 0.70),
    govPausePct:         num('BOUNTY_GOV_PAUSE_PCT', 0.85),
    slowFactor:          Math.max(1, num('BOUNTY_SLOW_FACTOR', 2)),
    suspiciousMult:      Math.max(2, num('BOUNTY_SUSPICIOUS_MULT', 5)),
    suspiciousFloor:     Math.max(1, num('BOUNTY_SUSPICIOUS_FLOOR', 50)),
    startMs:             num('BOUNTY_START_MS', 0),
    endMs:               num('BOUNTY_END_MS', 0),
    settleGraceMs:       num('BOUNTY_SETTLE_GRACE_MS', 86_400_000),
  };
}

// -- Schema (self-owned; idempotent) ------------------------------------------
let _schemaReady = null;
function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bounty_posts (
        post_id             TEXT PRIMARY KEY,
        author_handle       TEXT NOT NULL,
        post_url            TEXT NOT NULL,
        text                TEXT,
        created_ms          BIGINT,
        discovered_ms       BIGINT NOT NULL,
        source              TEXT NOT NULL,
        disqualified        BOOLEAN NOT NULL DEFAULT false,
        disqualified_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS bounty_snapshots (
        post_id   TEXT NOT NULL,
        ts_ms     BIGINT NOT NULL,
        retweets  INT, likes INT, replies INT, quotes INT, bookmarks INT, views INT,
        PRIMARY KEY (post_id, ts_ms)
      );
      CREATE INDEX IF NOT EXISTS bounty_snapshots_post_idx ON bounty_snapshots (post_id, ts_ms DESC);
      CREATE TABLE IF NOT EXISTS bounty_budget (
        day         TEXT PRIMARY KEY,
        tweet_reads INT NOT NULL DEFAULT 0,
        requests    INT NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS bounty_state (
        k TEXT PRIMARY KEY,
        v TEXT
      );
    `);
  })();
  return _schemaReady;
}

// -- Time helpers (UTC day/month keys) ----------------------------------------
function dayKey(ms)   { return new Date(ms).toISOString().slice(0, 10); }  // YYYY-MM-DD
function monthKey(ms) { return new Date(ms).toISOString().slice(0, 7); }   // YYYY-MM

// -- State kv -----------------------------------------------------------------
async function getState(k) {
  const r = await pool.query('SELECT v FROM bounty_state WHERE k = $1', [k]);
  return r.rows[0]?.v ?? null;
}
async function setState(k, v) {
  await pool.query(
    `INSERT INTO bounty_state (k, v) VALUES ($1, $2)
     ON CONFLICT (k) DO UPDATE SET v = $2`,
    [k, v == null ? null : String(v)]
  );
}

// -- Budget governor ----------------------------------------------------------
async function monthReads(now = Date.now()) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(tweet_reads), 0) AS reads FROM bounty_budget WHERE day LIKE $1`,
    [monthKey(now) + '-%']
  );
  return Number(r.rows[0]?.reads ?? 0);
}
async function bill(reads, requests = 1, now = Date.now()) {
  await pool.query(
    `INSERT INTO bounty_budget (day, tweet_reads, requests)
     VALUES ($1, $2, $3)
     ON CONFLICT (day) DO UPDATE SET
       tweet_reads = bounty_budget.tweet_reads + $2,
       requests    = bounty_budget.requests + $3`,
    [dayKey(now), Math.max(0, Math.floor(reads)), Math.max(0, Math.floor(requests))]
  );
}
// Map month-to-date usage to a governor mode. Order matters: freeze first.
function modeFor(used, total, c) {
  if (total <= 0) return 'frozen';
  const frac = used / total;
  if (frac >= 1.0)          return 'frozen';
  if (frac >= c.govPausePct) return 'discovery_paused';
  if (frac >= c.govSlowPct)  return 'slow';
  return 'normal';
}

// -- Tiering ------------------------------------------------------------------
function baseTierInterval(ageMs, c) {
  if (ageMs < c.tier1MaxMs) return c.tier1IntervalMs;
  if (ageMs < c.tier2MaxMs) return c.tier2IntervalMs;
  if (ageMs < c.tier3MaxMs) return c.tier3IntervalMs;
  return c.tier4IntervalMs;
}
// Governor widens tiers in the 'slow' / 'discovery_paused' stages.
function tierInterval(ageMs, mode, c) {
  const base = baseTierInterval(ageMs, c);
  return (mode === 'slow' || mode === 'discovery_paused') ? base * c.slowFactor : base;
}

// Relevance check for manual submissions: does the post TEXT contain at least
// one required term (case-insensitive)? Text only -- never URLs, quoted posts,
// or media, since the rule is stated publicly and must be simple and
// predictable. Empty/missing text (media-only post) returns false and is
// rejected. An empty terms list (operator cleared it) disables the gate.
function mentionsRequiredTerms(text, terms) {
  if (!terms || terms.length === 0) return true;
  if (!text) return false;
  const hay = String(text).toLowerCase();
  return terms.some(t => hay.includes(t));
}

// -- Scoring + suspicious -----------------------------------------------------
function scoreOf(s) {
  return (Number(s.retweets) || 0) * SCORING.retweets
       + (Number(s.likes)    || 0) * SCORING.likes
       + (Number(s.replies)  || 0) * SCORING.replies;
}
// A metric that leapt by >= mult x between two consecutive snapshots (and the
// earlier value was at least the floor, so low-count noise like 1 -> 6 never
// trips it) is implausible enough to flag for a human. Checks all six metrics.
function isSuspicious(latest, prev, c) {
  if (!prev) return false;
  const keys = ['retweets', 'likes', 'replies', 'quotes', 'bookmarks', 'views'];
  for (const k of keys) {
    const a = Number(prev[k]) || 0;
    const b = Number(latest[k]) || 0;
    if (a >= c.suspiciousFloor && b >= a * c.suspiciousMult) return true;
  }
  return false;
}

// -- Post + snapshot writes ---------------------------------------------------
async function upsertPost(p, source, now = Date.now()) {
  await pool.query(
    `INSERT INTO bounty_posts
       (post_id, author_handle, post_url, text, created_ms, discovered_ms, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (post_id) DO NOTHING`,
    [
      p.postId,
      p.authorHandle || 'unknown',
      p.postUrl,
      p.text ?? null,
      p.createdMs ?? null,
      now,
      source,
    ]
  );
}
async function insertSnapshot(p, tsMs = Date.now()) {
  await pool.query(
    `INSERT INTO bounty_snapshots
       (post_id, ts_ms, retweets, likes, replies, quotes, bookmarks, views)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (post_id, ts_ms) DO NOTHING`,
    [p.postId, tsMs, p.retweets, p.likes, p.replies, p.quotes, p.bookmarks, p.views]
  );
}
function inWindow(createdMs, c) {
  if (createdMs == null) return false;
  if (c.startMs > 0 && createdMs < c.startMs) return false;
  if (c.endMs   > 0 && createdMs > c.endMs)   return false;
  return true;
}

// =============================================================================
// POLLER (runs in the worker)
// =============================================================================

// A running budget ledger for one tick, so we can stop mid-tick the instant we
// would cross the monthly ceiling (rather than discovering it next month).
function makeLedger(startReads, total) {
  let spent = 0;
  return {
    remaining() { return Math.max(0, total - startReads - spent); },
    add(reads)  { spent += reads; },
    spent()     { return spent; },
  };
}

async function runDiscovery(provider, c, ledger, now) {
  const covered = new Set();
  let cursor = '';
  let pages = 0;
  let inserted = 0;
  while (pages < c.maxDiscoveryPages) {
    if (ledger.remaining() <= 0) {
      console.warn('[bounty] discovery halted mid-sweep: monthly budget exhausted');
      break;
    }
    let res;
    try {
      res = await provider.searchRecent(c.query, cursor);
    } catch (err) {
      console.error('[bounty] discovery search failed:', err.message);
      break;
    }
    await bill(res.cost ?? Math.max(1, res.posts.length), 1, now);
    ledger.add(res.cost ?? Math.max(1, res.posts.length));
    for (const p of res.posts) {
      if (!inWindow(p.createdMs, c)) continue;
      await upsertPost(p, 'discovered', now);
      await insertSnapshot(p, now);
      covered.add(p.postId);
      inserted++;
    }
    pages++;
    if (!res.cursor) break;
    cursor = res.cursor;
  }
  await setState('last_discovery_ms', now);
  console.log(`[bounty] discovery sweep: ${pages} page(s), ${covered.size} in-window post(s) snapshotted, ${ledger.spent()} reads`);
  return covered;
}

async function runRefresh(provider, c, ledger, covered, mode, now) {
  // Candidate tracked posts (not disqualified) with their newest snapshot ts.
  const rows = (await pool.query(
    `SELECT p.post_id, p.created_ms, p.discovered_ms,
            (SELECT MAX(ts_ms) FROM bounty_snapshots s WHERE s.post_id = p.post_id) AS last_ts
     FROM bounty_posts p
     WHERE p.disqualified = false`
  )).rows;

  // Keep only posts that are DUE by their tier and were not just refreshed for
  // free by the discovery sweep. Stalest first.
  const due = [];
  for (const r of rows) {
    if (covered.has(r.post_id)) continue;
    const created = r.created_ms != null ? Number(r.created_ms) : Number(r.discovered_ms);
    const lastTs = r.last_ts != null ? Number(r.last_ts) : null;
    const age = Math.max(0, now - created);
    const interval = tierInterval(age, mode, c);
    if (lastTs == null || now - lastTs >= interval) {
      due.push({ postId: r.post_id, lastTs: lastTs ?? 0 });
    }
  }
  due.sort((a, b) => a.lastTs - b.lastTs);
  const selected = due.slice(0, c.maxRefreshPerTick).map(d => d.postId);

  let refreshed = 0;
  for (let i = 0; i < selected.length; i += c.batchSize) {
    if (ledger.remaining() <= 0) {
      console.warn(`[bounty] refresh halted: monthly budget exhausted (${refreshed}/${selected.length} refreshed this tick)`);
      break;
    }
    const ids = selected.slice(i, i + c.batchSize);
    let res;
    try {
      res = await provider.getPostsByIds(ids);
    } catch (err) {
      console.error('[bounty] refresh batch failed:', err.message);
      continue;
    }
    await bill(res.cost ?? Math.max(1, res.posts.length), 1, now);
    ledger.add(res.cost ?? Math.max(1, res.posts.length));
    for (const p of res.posts) {
      await insertSnapshot(p, now);
      refreshed++;
    }
  }
  if (selected.length > 0) {
    console.log(`[bounty] refresh: ${refreshed}/${selected.length} due post(s) snapshotted, ${ledger.spent()} reads spent this tick`);
  }
}

async function tick(provider) {
  const c = cfg();
  const now = Date.now();

  // Contest must be configured; after end + grace, stop spending (final
  // settlement snapshots are already in the series).
  if (c.endMs <= 0) {
    console.log('[bounty] tick skipped: contest window not configured (set BOUNTY_START_MS / BOUNTY_END_MS)');
    return;
  }
  if (now > c.endMs + c.settleGraceMs) {
    return; // contest closed and settled -- leaderboard serves final snapshots
  }

  // Governor mode from month-to-date usage; log loudly on transition.
  const used = await monthReads(now);
  const mode = modeFor(used, c.monthlyBudget, c);
  const prevMode = await getState('governor_mode');
  if (prevMode !== mode) {
    console.warn(`[bounty] GOVERNOR ${prevMode ?? 'init'} -> ${mode} (used ${used}/${c.monthlyBudget} tweet-reads this month)`);
    await setState('governor_mode', mode);
  }

  if (mode === 'frozen') {
    console.warn('[bounty] FROZEN: monthly budget exhausted; no calls until next month or budget raise. Leaderboard is serving last-known snapshots.');
    return;
  }

  const ledger = makeLedger(used, c.monthlyBudget);

  // Discovery, at most every discoveryIntervalMs, and only while the governor
  // still permits it (paused stage keeps refreshing known posts but stops
  // finding new ones).
  let covered = new Set();
  const lastDisc = Number(await getState('last_discovery_ms')) || 0;
  const discoveryDue = now - lastDisc >= c.discoveryIntervalMs;
  if (mode === 'discovery_paused') {
    if (discoveryDue) console.warn('[bounty] discovery paused by governor (budget); refreshing known posts only');
  } else if (discoveryDue) {
    covered = await runDiscovery(provider, c, ledger, now);
  }

  // Tiered refresh of everything the discovery sweep did not just cover.
  await runRefresh(provider, c, ledger, covered, mode, now);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Public entry point, called (armed) from index.js. Never throws into the
// worker: every tick is contained, and the loop sleeps between ticks.
export async function startBountyPoller() {
  await ensureSchema();
  const c = cfg();
  let provider;
  try {
    provider = getXProvider();
  } catch (err) {
    console.error('[bounty] poller not started:', err.message);
    return;
  }
  console.log(
    `[bounty] poller armed: provider=${provider.name} query="${c.query}" ` +
    `discovery=${Math.round(c.discoveryIntervalMs / 60000)}min tick=${Math.round(c.pollTickMs / 60000)}min ` +
    `budget=${c.monthlyBudget} reads/mo window=[${c.startMs},${c.endMs}]`
  );
  // Continuous loop. tick() reads config fresh each pass.
  for (;;) {
    try {
      await tick(provider);
    } catch (err) {
      console.error('[bounty] tick error (non-fatal):', err.message);
    }
    await sleep(cfg().pollTickMs);
  }
}

// =============================================================================
// ROUTES (served by the web service)
// =============================================================================

// Per-IP sliding-window throttle for the unauthenticated POST /bounty/submit,
// mirroring the in-memory guard used elsewhere in api.js. Not a security
// control -- a courtesy throttle; resets on redeploy.
const submitRate = new Map(); // ip -> [timestamps]
const SUBMIT_WINDOW_MS = 60_000;
const SUBMIT_MAX = 10;        // max submits per IP per window
function submitRateOk(ip) {
  const now = Date.now();
  const hits = (submitRate.get(ip) ?? []).filter(t => now - t < SUBMIT_WINDOW_MS);
  if (hits.length >= SUBMIT_MAX) { submitRate.set(ip, hits); return false; }
  hits.push(now);
  submitRate.set(ip, hits);
  return true;
}

function contestBlock(c) {
  return {
    start_ms: c.startMs,
    end_ms:   c.endMs,
    pool_usd: POOL_USD,
    prizes:   PRIZES,
    scoring:  SCORING,
  };
}

export function mountBounty(app) {
  // Ensure the tables exist before any route touches them (the worker also
  // ensures them; both are idempotent).
  ensureSchema().catch(err => console.error('[bounty] ensureSchema failed:', err.message));

  // GET /bounty/leaderboard -- ranked entries from each post's latest snapshot.
  // Excludes disqualified posts. suspicious is computed from the latest vs the
  // previous snapshot (implausible spike -> flag for human review, never a ban).
  app.get('/bounty/leaderboard', async (req, res) => {
    try {
      await ensureSchema();
      const c = cfg();
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);

      const latest = (await pool.query(
        `SELECT DISTINCT ON (post_id)
                post_id, ts_ms, retweets, likes, replies, quotes, bookmarks, views
         FROM bounty_snapshots
         ORDER BY post_id, ts_ms DESC`
      )).rows;
      const prev = (await pool.query(
        `SELECT DISTINCT ON (s.post_id)
                s.post_id, s.retweets, s.likes, s.replies, s.quotes, s.bookmarks, s.views
         FROM bounty_snapshots s
         JOIN (
           SELECT post_id, MAX(ts_ms) AS max_ts FROM bounty_snapshots GROUP BY post_id
         ) l ON l.post_id = s.post_id AND s.ts_ms < l.max_ts
         ORDER BY s.post_id, s.ts_ms DESC`
      )).rows;
      const prevOf = {};
      for (const r of prev) prevOf[r.post_id] = r;

      const posts = (await pool.query(
        `SELECT post_id, author_handle, post_url, text FROM bounty_posts WHERE disqualified = false`
      )).rows;
      const metaOf = {};
      for (const r of posts) metaOf[r.post_id] = r;

      let updatedMs = 0;
      const entries = [];
      for (const s of latest) {
        const meta = metaOf[s.post_id];
        if (!meta) continue; // disqualified or unknown -> excluded
        const ts = Number(s.ts_ms);
        if (ts > updatedMs) updatedMs = ts;
        entries.push({
          post_id:       s.post_id,
          author_handle: meta.author_handle,
          post_url:      meta.post_url,
          text:          meta.text,
          retweets:      Number(s.retweets) || 0,
          likes:         Number(s.likes) || 0,
          replies:       Number(s.replies) || 0,
          quotes:        Number(s.quotes) || 0,
          bookmarks:     Number(s.bookmarks) || 0,
          views:         Number(s.views) || 0,
          score:         scoreOf(s),
          snapshot_ts_ms: ts,
          suspicious:    isSuspicious(s, prevOf[s.post_id], c),
        });
      }
      entries.sort((a, b) => b.score - a.score || b.snapshot_ts_ms - a.snapshot_ts_ms);
      const ranked = entries.slice(0, limit).map((e, i) => ({ rank: i + 1, ...e }));

      res.json({
        updated_ms: updatedMs || null,
        contest: contestBlock(c),
        entries: ranked,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /bounty/post/:postId -- the full snapshot time series for one post,
  // ascending, each row carrying its score. For charting and dispute review.
  app.get('/bounty/post/:postId', async (req, res) => {
    try {
      await ensureSchema();
      const postId = String(req.params.postId ?? '').trim();
      if (!/^\d{6,25}$/.test(postId)) return res.status(400).json({ error: 'invalid post id' });

      const meta = (await pool.query(
        `SELECT post_id, author_handle, post_url, text, created_ms, discovered_ms,
                source, disqualified, disqualified_reason
         FROM bounty_posts WHERE post_id = $1`,
        [postId]
      )).rows[0];
      if (!meta) return res.status(404).json({ error: 'post not tracked' });

      const snaps = (await pool.query(
        `SELECT ts_ms, retweets, likes, replies, quotes, bookmarks, views
         FROM bounty_snapshots WHERE post_id = $1 ORDER BY ts_ms ASC`,
        [postId]
      )).rows.map(s => ({
        ts_ms:     Number(s.ts_ms),
        retweets:  Number(s.retweets) || 0,
        likes:     Number(s.likes) || 0,
        replies:   Number(s.replies) || 0,
        quotes:    Number(s.quotes) || 0,
        bookmarks: Number(s.bookmarks) || 0,
        views:     Number(s.views) || 0,
        score:     scoreOf(s),
      }));

      res.json({
        post: {
          post_id:             meta.post_id,
          author_handle:       meta.author_handle,
          post_url:            meta.post_url,
          text:                meta.text,
          created_ms:          meta.created_ms != null ? Number(meta.created_ms) : null,
          discovered_ms:       meta.discovered_ms != null ? Number(meta.discovered_ms) : null,
          source:              meta.source,
          disqualified:        meta.disqualified === true,
          disqualified_reason: meta.disqualified_reason ?? null,
        },
        snapshots: snaps,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /bounty/submit { post_url } -- manual entry. Validates the URL, fetches
  // the post once to confirm it exists and falls inside the contest window, then
  // inserts it with source='submitted' and writes its first snapshot.
  app.post('/bounty/submit', async (req, res) => {
    try {
      await ensureSchema();
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
      if (!submitRateOk(ip)) return res.status(429).json({ error: 'rate limited, try again shortly' });

      const c = cfg();
      const url = String(req.body?.post_url ?? '').trim();
      if (!validatePostUrl(url)) return res.status(400).json({ error: 'not a valid x.com/twitter.com status URL' });
      const postId = extractPostId(url);
      if (!postId) return res.status(400).json({ error: 'could not extract post id from URL' });

      if (c.endMs <= 0) return res.status(503).json({ error: 'contest is not open yet' });
      if (!xProviderConfigured()) return res.status(503).json({ error: 'tracker not configured (provider key missing)' });

      // Duplicate?
      const existing = (await pool.query('SELECT source, disqualified FROM bounty_posts WHERE post_id = $1', [postId])).rows[0];
      if (existing) return res.status(409).json({ error: 'post already tracked', post_id: postId });

      // Budget: do not fetch while frozen.
      const now = Date.now();
      const used = await monthReads(now);
      if (modeFor(used, c.monthlyBudget, c) === 'frozen') {
        return res.status(503).json({ error: 'tracker paused (budget exhausted); try again next cycle' });
      }

      let provider, fetched;
      try {
        provider = getXProvider();
        fetched = await provider.getPostsByIds([postId]);
      } catch (err) {
        return res.status(502).json({ error: 'provider fetch failed: ' + err.message });
      }
      await bill(fetched.cost ?? Math.max(1, fetched.posts.length), 1, now);
      const post = fetched.posts.find(p => p.postId === postId) ?? fetched.posts[0];
      if (!post) return res.status(404).json({ error: 'post not found on X' });

      if (post.createdMs == null) return res.status(400).json({ error: 'could not determine post time' });
      if (!inWindow(post.createdMs, c)) {
        return res.status(400).json({ error: 'post is outside the contest window', created_ms: post.createdMs });
      }

      // Relevance gate: the post TEXT must mention SuiPump (same terms discovery
      // uses). A media-only post with no text fails this too. The provider read
      // above is already billed; we simply persist nothing on rejection, so a
      // rejected submit costs the user no future attempt.
      if (!mentionsRequiredTerms(post.text, c.requiredTerms)) {
        return res.status(400).json({
          error: 'That post does not mention SuiPump. Posts must mention SuiPump or tag @SuiPump_SUMP to be counted.',
        });
      }

      await upsertPost(post, 'submitted', now);
      await insertSnapshot(post, now);
      res.json({ ok: true, post_id: post.postId, score: scoreOf(post) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /bounty/status -- operator view of the governor. All values are derived
  // from the tables (cross-process safe): budget from bounty_budget, counts from
  // bounty_posts, last discovery + mode from bounty_state.
  app.get('/bounty/status', async (req, res) => {
    try {
      await ensureSchema();
      const c = cfg();
      const now = Date.now();
      const used = await monthReads(now);
      const mode = modeFor(used, c.monthlyBudget, c);
      const [counts, lastDisc, storedMode] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*)                                            AS tracked,
             COUNT(*) FILTER (WHERE source = 'discovered')       AS discovered,
             COUNT(*) FILTER (WHERE source = 'submitted')        AS submitted,
             COUNT(*) FILTER (WHERE disqualified = true)         AS disqualified
           FROM bounty_posts`
        ),
        getState('last_discovery_ms'),
        getState('governor_mode'),
      ]);
      const r = counts.rows[0] ?? {};
      res.json({
        provider:         (process.env.X_PROVIDER ?? 'twitterapi_io').trim(),
        provider_ready:   xProviderConfigured(),
        budget_total:     c.monthlyBudget,
        budget_used:      used,
        budget_remaining: Math.max(0, c.monthlyBudget - used),
        // mode is recomputed live here; governor_mode is what the poller last
        // acted on (they agree unless a tick has not run since a config change).
        mode,
        poller_mode:      storedMode ?? null,
        last_discovery_ms: lastDisc != null ? Number(lastDisc) : null,
        tracked_posts:    Number(r.tracked ?? 0),
        discovered:       Number(r.discovered ?? 0),
        submitted:        Number(r.submitted ?? 0),
        disqualified:     Number(r.disqualified ?? 0),
        contest:          contestBlock(c),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
