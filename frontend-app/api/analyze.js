// api/analyze.js — Vercel serverless function (Groq / Llama 3.3 70B)
// Set GROQ_API_KEY in Vercel environment variables.
//
// 2026-07-13 SECURITY (bleed-stopper; see HANDOFF_2026-07-13 sec.3): this route
// makes a PAID LLM call and was reachable with zero auth and no rate limit.
// Guards run BEFORE any body work or the Groq call. The guard block is
// duplicated verbatim in api/agent-plan.js ON PURPOSE: a shared helper under
// api/ would itself deploy as a public endpoint. Dedup lands with the
// full-auth task.

// ---- Bleed-stopper guard (2026-07-13) --------------------------------------
// Layer 1: X-SP-Key header must equal SP_INTERNAL_KEY (Vercel server env).
//   The client sends VITE_SP_INTERNAL_KEY, which ships in the public JS
//   bundle - so this layer is a tripwire against drive-by scripts/scanners,
//   NOT auth. Real per-caller auth (wallet-signed) is a later task.
//   Fail-closed: SP_INTERNAL_KEY unset -> 503, so a missed env var can never
//   silently reopen the unmetered route.
// Layer 2: per-IP sliding-window rate limit - the actual bill ceiling.
//   In-memory, per lambda instance: approximate under scale-out, which is
//   acceptable for a bleed-stopper.
// Layer 3: prompt length cap + AbortSignal timeout on the upstream Groq call.

const RATE_WINDOW_MS   = 5 * 60 * 1000; // 5 minutes
const RATE_MAX_HITS    = 20;            // per IP per window
const RATE_MAX_IPS     = 5000;          // tracked-IP hard cap (anti-balloon)
const MAX_PROMPT_CHARS = 6000;          // AIAnalysis prompts sit well under this
const GROQ_TIMEOUT_MS  = 20000;

const rateMap = new Map(); // ip -> number[] of hit timestamps (pruned per hit)

function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real;
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

// Returns null when allowed; otherwise seconds to wait (for Retry-After).
// Map insertion order doubles as an LRU: re-inserting on every hit keeps the
// coldest IP first, so the size-cap eviction always drops the least recent.
function rateLimited(ip) {
  const now = Date.now();
  const hits = rateMap.get(ip) ?? [];
  while (hits.length && now - hits[0] > RATE_WINDOW_MS) hits.shift();
  if (hits.length >= RATE_MAX_HITS) {
    rateMap.delete(ip); rateMap.set(ip, hits);
    return Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 1000));
  }
  hits.push(now);
  rateMap.delete(ip); rateMap.set(ip, hits);
  if (rateMap.size > RATE_MAX_IPS) rateMap.delete(rateMap.keys().next().value);
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-SP-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // -- Guard 1: internal key (fail-closed). Node lowercases header names. ----
  const want = process.env.SP_INTERNAL_KEY;
  if (!want) return res.status(503).json({ error: 'analysis disabled' });
  if (req.headers['x-sp-key'] !== want) return res.status(401).json({ error: 'unauthorized' });

  // -- Guard 2: per-IP rate limit (the bill ceiling). ------------------------
  const wait = rateLimited(clientIp(req));
  if (wait != null) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'rate limited' });
  }

  // Parse body - Vercel may or may not auto-parse depending on config.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body ?? {};

  const { prompt } = body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
  // -- Guard 3a: input cap (bounds Groq input tokens per request). -----------
  if (String(prompt).length > MAX_PROMPT_CHARS) {
    return res.status(413).json({ error: `prompt too long (max ${MAX_PROMPT_CHARS} chars)` });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      // -- Guard 3b: upstream timeout - a hung Groq call can't pin the lambda.
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        max_tokens:  350,
        temperature: 0.6,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await groqRes.json();
    if (!groqRes.ok) {
      return res.status(groqRes.status).json({ error: data.error?.message ?? 'Groq error' });
    }

    const result = data.choices?.[0]?.message?.content ?? '';
    return res.status(200).json({ result });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
