// api/agent-plan.js -- Vercel serverless function (Groq / Llama 3.3 70B)
// Turns a natural-language goal into a structured SuiPump agent plan.
//
// NEW MODEL (one DAG per workflow): the planner picks ONE published DAG by
// `workflow`, and emits ONLY that workflow's fields.
//
// Workflows map 1:1 to published Nexus DAG ids (resolved in the runner/UI):
//   launch_and_buy : launch -> dev-buy            (needs launch fields + buy.amount_sui)
//   buy            : buy an existing curve         (needs curve_id + amount_sui)
//   sell           : sell tokens on an existing curve (needs curve_id + token_amount)
//   claim          : claim creator fees            (needs curve_id + token_type)
//   alerts         : monitor curves                (needs curve_ids[])
//
// The LLM plans OFF-CHAIN here; the DAG does on-chain execution.
//
// 2026-06-09: added deterministic extractors so launch plans don't depend on
// the LLM being consistent:
//   - extractSuiAmount(): pulls "buy N sui" / "N sui" from the goal as a fallback
//     for devBuySui/amountSui (LLM was returning 0 for "buy 2 sui").
//   - extractDescription(): pulls text after "description:" so the user's real
//     description is used instead of the whole goal sentence (summary).
//
// 2026-07-13 SECURITY (bleed-stopper; see HANDOFF_2026-07-13 sec.3): this route
// makes a PAID LLM call and was reachable with zero auth and no rate limit.
// Guards run in the handler BEFORE any body work or the Groq call - see the
// guard block right above the handler. The block is duplicated verbatim in
// api/analyze.js ON PURPOSE: a shared helper under api/ would itself deploy
// as a public endpoint. Dedup lands with the full-auth task.

// Pull an explicit SUI amount from phrases like "buy 2 sui", "dev buy 1.5 sui",
// "2 sui". Returns a number or null. Ignores amounts that are clearly a curve's
// SUI target etc. by only matching small leading "buy"/"dev-buy" contexts first.
function extractSuiAmount(goal) {
  const g = String(goal).toLowerCase();
  // Prefer an amount tied to a buy verb: "buy 2 sui", "dev-buy 1.5 sui", "buy 2sui"
  const buyCtx = g.match(/(?:dev[\s-]?buy|buy|ape|snipe)\s+(\d*\.?\d+)\s*sui/);
  if (buyCtx) return Number(buyCtx[1]);
  // Fallback: any "<number> sui" in the goal.
  const anySui = g.match(/(\d*\.?\d+)\s*sui/);
  if (anySui) return Number(anySui[1]);
  return null;
}

// Pull the user's intended description from "description: <text>" (case-insensitive).
// Returns the trimmed text after the marker, or null if not present.
function extractDescription(goal) {
  const m = String(goal).match(/description\s*[:\-]\s*(.+)$/i);
  if (!m) return null;
  let v = m[1].trim().replace(/\s+/g, ' ');
  // Stop before a trailing launch-instruction clause that isn't part of the
  // description (e.g. "... pre-demo video. graduate to cetus" -> drop the grad
  // clause). Cut at the first occurrence of these clause markers.
  v = v.replace(/[.;,]?\s*(?:graduate(?:s|d)?\s+to|grad(?:uate)?\s+target|anti[\s-]?bot|dev[\s-]?buy|buy\s+\d|symbol\b|ticker\b|name(?:d)?\s*[:\-]).*$/i, '').trim();
  return v ? v.slice(0, 200) : null;
}

// ── Sniper intent + filters (deterministic; the LLM is unreliable on 64-hex) ──
//
// Sniper is a STANDING order, not a one-shot DAG run: "buy when a launch matching
// X appears". It routes to /api/create-order (strategy store), NOT /run-dag.
//
// Trigger: an explicit snipe/standing-buy verb. We require one of these so a
// stray "every" in a normal buy can never misroute. Matches:
//   "snipe", "snipe every", "buy every token", "every launch",
//   "every token (launched) by", "all tokens (launched) by".
function isSniperGoal(goal) {
  const g = String(goal).toLowerCase();
  if (/\bsnipe\b|\bsniper\b/.test(g)) return true;
  // "buy/ape every|all token(s)|launch(es)" — standing-buy phrasing without "snipe".
  if (/\b(?:buy|ape|grab|get)\b[\s\S]*\b(?:every|all)\b[\s\S]*\b(?:token|launch|coin)/.test(g)) return true;
  if (/\b(?:every|all)\b[\s\S]*\b(?:token|launch|coin)s?\b[\s\S]*\b(?:launched\s+)?by\b/.test(g)) return true;
  return false;
}

// ── Claim-all intent (deterministic; never hits the LLM) ─────────────────────
//
// "claim all (my) creator fees" / "claim everything" / "claim all fees" — a
// FAN-OUT over every curve the connected (agent) wallet created that has fees
// pending. Routed to /api/agent-claim-all, which enumerates server-side and
// fires the claim DAG per curve. Like sniper, this short-circuits before the
// LLM. ONLY fires when NO specific curve id is pasted: "claim 0xCURVE" stays the
// normal single-curve claim, preserving the tutorial's "Claim ... on 0xCURVE".
function isClaimAllGoal(goal, pastedCurveId) {
  if (pastedCurveId) return false; // a specific CA -> single-curve claim
  const g = String(goal).toLowerCase();
  if (!/\bclaim\b/.test(g)) return false;
  // Requires an "all/every/everything" scope alongside the claim verb.
  return /\bclaim\b[\s\S]*\b(?:all|every|everything)\b/.test(g)
      || /\b(?:all|every|everything)\b[\s\S]*\bclaim\b/.test(g);
}

// All 64-hex object/address ids in the goal -> creator filter list. (A creator is
// a wallet address; same 0x{60,66} shape as a curve id, so we lift ALL of them
// and treat them as creators in sniper context.)
function extractAllHex(goal) {
  const m = String(goal).match(/0x[a-fA-F0-9]{60,66}/g);
  return m ? Array.from(new Set(m.map(s => s.toLowerCase()))) : [];
}

// Optional snipe cap: "first 5", "up to 5", "max 5", "5 snipes", "5 times".
// Returns a positive integer or null (null = unbounded, by design).
function extractMaxSnipes(goal) {
  const g = String(goal).toLowerCase();
  const m = g.match(/(?:first|up\s+to|max(?:imum)?|limit(?:\s+to)?)\s+(\d+)/)
        ?? g.match(/(\d+)\s*(?:snipes?|times|buys?)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// "any"/"or" across categories -> match:"any"; default "all" (AND).
function extractMatchMode(goal) {
  return /\b(?:any of|or|either)\b/i.test(String(goal)) ? 'any' : 'all';
}

// Optional symbol/name narrative filters from explicit markers, so we don't lean
// on the LLM for these either. "symbol: PEPE" / "ticker PEPE" / 'named "ai"' /
// "name contains ai" / "called ai".
function extractSymbolFilters(goal) {
  const out = [];
  const g = String(goal);
  let m;
  const re = /(?:symbol|ticker)\s*[:\-]?\s*\$?([a-z0-9]{1,12})/ig;
  while ((m = re.exec(g)) !== null) out.push(m[1].toUpperCase());
  return Array.from(new Set(out));
}
function extractNameIncludes(goal) {
  const g = String(goal);
  // Capture the word(s) right after the marker, but STOP at a clause boundary
  // (by/from/launched/with/and/symbol/ticker), at a 0x address, or end of string.
  // Non-greedy, bounded, and we strip any trailing boundary word that slipped in.
  const m = g.match(/(?:name\s+(?:contains|includes|with)|named|called)\s*[:\-]?\s*["']?([a-z0-9][a-z0-9 ]{0,38}?)["']?(?=\s+(?:by|from|launched|with|and|or|symbol|ticker|max|first|up\s+to|limit)\b|\s+0x|["']|$)/i);
  if (!m) return null;
  let v = m[1].trim().toLowerCase();
  // Defensive: drop a trailing boundary word if the lookahead still let one in.
  v = v.replace(/\s+(?:by|from|launched|with|and|or)$/i, '').trim();
  return v ? v.slice(0, 64) : null;
}

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
// Layer 3: goal length cap (also bounds the regex extractors) + AbortSignal
//   timeout on the upstream Groq call.

const RATE_WINDOW_MS  = 5 * 60 * 1000; // 5 minutes
const RATE_MAX_HITS   = 20;            // per IP per window
const RATE_MAX_IPS    = 5000;          // tracked-IP hard cap (anti-balloon)
const MAX_GOAL_CHARS  = 1200;          // a legit goal is a sentence or two
const GROQ_TIMEOUT_MS = 20000;

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
  if (!want) return res.status(503).json({ error: 'planning disabled' });
  if (req.headers['x-sp-key'] !== want) return res.status(401).json({ error: 'unauthorized' });

  // -- Guard 2: per-IP rate limit (the bill ceiling). ------------------------
  const wait = rateLimited(clientIp(req));
  if (wait != null) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'rate limited' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body ?? {};

  const { goal } = body;
  if (!goal) return res.status(400).json({ error: 'Missing goal' });
  // -- Guard 3a: input cap. Bounds Groq input tokens AND the regex extractors
  // below (none of them should ever chew on a megabyte of attacker text). ----
  if (String(goal).length > MAX_GOAL_CHARS) {
    return res.status(413).json({ error: `goal too long (max ${MAX_GOAL_CHARS} chars)` });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  // Pull any 0x object id the user pasted (curve id for buy/sell/claim).
  const caMatch = String(goal).match(/0x[a-fA-F0-9]{60,66}/);
  const pastedCurveId = caMatch ? caMatch[0] : null;

  // Deterministic extractors (used as fallback / override of the LLM).
  const explicitSui  = extractSuiAmount(goal);   // number | null
  const explicitDesc = extractDescription(goal); // string | null

  // ── CLAIM-ALL short-circuit (deterministic; never hits the LLM) ───────────
  // Fan-out over every curve the connected (agent) wallet created with fees
  // pending. Enumeration happens SERVER-SIDE in /api/agent-claim-all (the planner
  // doesn't know the wallet). Checked BEFORE sniper so claim intent is
  // unambiguous. A pasted CA suppresses this (handled inside isClaimAllGoal),
  // so single-curve "claim 0xCURVE" still routes to the normal claim workflow.
  if (isClaimAllGoal(goal, pastedCurveId)) {
    return res.status(200).json({
      plan: {
        workflow: 'claim_all',
        claimAll: {},
        summary: 'Claim creator fees from every curve you created that has fees pending. The agent enumerates your curves and claims each one through Nexus.',
      },
    });
  }

  // ── SNIPER short-circuit (deterministic; never hits the LLM) ──────────────
  // Sniper is a standing order keyed on a filter, routed to /api/create-order
  // (not /run-dag). The address(es) are CREATOR filters, not a curve to buy, so
  // we lift all 0x ids as creators and ignore pastedCurveId here. The `then`
  // block is reserved now (empty) so sniper->TP/SL chaining is additive later.
  if (isSniperGoal(goal)) {
    const creators     = extractAllHex(goal);
    const symbols      = extractSymbolFilters(goal);
    const nameIncludes = extractNameIncludes(goal);
    const hasFilter    = creators.length > 0 || symbols.length > 0 || nameIncludes != null;
    const amountSui    = explicitSui != null ? explicitSui : 0.1;

    const params = { amountSui, match: extractMatchMode(goal) };
    if (creators.length)      params.creators = creators;
    if (symbols.length)       params.symbols = symbols;
    if (nameIncludes != null) params.nameIncludes = nameIncludes;
    // No filter named -> explicit all-launches opt-in (store requires one or the
    // other; this makes "snipe 1 sui of every token" valid).
    if (!hasFilter)           params.all = true;
    const maxSnipes = extractMaxSnipes(goal);
    if (maxSnipes != null)    params.maxSnipes = maxSnipes;

    const scope = hasFilter
      ? [
          creators.length ? `creators[${creators.length}]` : null,
          symbols.length ? `symbol ${symbols.join('/')}` : null,
          nameIncludes ? `name~"${nameIncludes}"` : null,
        ].filter(Boolean).join(params.match === 'any' ? ' OR ' : ' AND ')
      : 'every new launch';

    return res.status(200).json({
      plan: {
        workflow: 'sniper',
        sniper: params,
        summary: `Standing snipe: buy ${amountSui} SUI of ${scope}${maxSnipes != null ? ` (first ${maxSnipes})` : ' (unbounded)'}.`,
      },
    });
  }

  const prompt = `You are the planning layer of an autonomous agent on SuiPump, a bonding-curve token launchpad on Sui. The agent executes ONE workflow per run, each a published Nexus DAG. Pick the single workflow that matches the user's goal and emit ONLY that workflow's fields.

Workflows:
- "launch_and_buy": launch a NEW token then dev-buy it. Use when the user wants to create/launch a token. Fields: launch{name,symbol,description,graduationTarget,devBuySui,antiBotDelay}, buy{amountSui}.
- "buy": buy an EXISTING token by curve id. Use when the user wants to buy a token that already exists (a curve id / CA is given). Fields: buy{curveId, amountSui}.
- "sell": sell tokens of an EXISTING token by curve id. Use when the user wants to sell/dump. Fields: sell{curveId, tokenAmount}. tokenAmount can be the string "ALL" to sell the whole balance.
- "claim": claim creator fees on an existing curve. Fields: claim{curveId}.
- "alerts": monitor existing curves for graduation/price. Fields: alerts{curveIds:[...]}.
- "autopilot": run an autonomous trading mandate that scans trending curves and enters the best ones on its own, within a spend cap, arming a TP/SL exit on each entry. Use when the user wants the agent to trade/ape/farm trending tokens automatically without naming a specific curve. Fields: autopilot{spendCapSui, perEntrySui, maxOpenPositions, minMomentum, maxConcentrationPct, cooldownMs, then{tpsl{takeProfit:[{multiple,sellPct}], stopLoss{multiple}}}}.

Classification examples (match the WORKFLOW, then extract fields):
- "ape into trending memecoins for me, half a sui each, 5 sui bankroll" -> autopilot (perEntrySui 0.5, spendCapSui 5)
- "let the bot loose on trending coins with 10 sui, point five each" -> autopilot (perEntrySui 0.5, spendCapSui 10)
- "trade the market automatically, 1 sui per position, max 4, sell at 2x" -> autopilot (perEntrySui 1, maxOpenPositions 4, then.tpsl.takeProfit [{multiple:2,sellPct:100}])
- "buy 5 sui of 0xABC..." -> buy (NOT autopilot: a curve id is named)
- "snipe 1 sui of every new launch" -> sniper
- "copy wallet 0xWALLET at 2 sui each" -> copytrade
- "dca 2 sui into 0xCURVE hourly" -> (handled client-side; if seen, it is a standing strategy, not buy)
CRITICAL: "autopilot" means the agent discovers curves ITSELF — it is chosen ONLY when NO specific curve id (0x...) is named. If a 0x curve id is present, it is buy/sell/claim/alerts, never autopilot.

The user's goal: "${goal}"
${pastedCurveId ? `Detected curve id in goal: ${pastedCurveId} (use it as curveId).` : ''}

Return ONLY a JSON object, no prose, no markdown fences:
{
  "workflow": "launch_and_buy" | "buy" | "sell" | "claim" | "alerts" | "autopilot",
  "launch": { "name": string, "symbol": string (<=6 upper), "description": string, "graduationTarget": 0|1|2, "devBuySui": number, "antiBotDelay": 0 },
  "buy":    { "curveId": string|null, "amountSui": number },
  "sell":   { "curveId": string|null, "tokenAmount": number|"ALL" },
  "claim":  { "curveId": string|null },
  "alerts": { "curveIds": string[] },
  "autopilot": { "spendCapSui": number, "perEntrySui": number, "maxOpenPositions": number, "minMomentum": number, "maxConcentrationPct": number, "cooldownMs": number, "then": { "tpsl": { "takeProfit": [{ "multiple": number, "sellPct": number }], "stopLoss": { "multiple": number } } } },
  "summary": string (one sentence)
}

Rules:
- Choose exactly ONE workflow. Only the object for that workflow needs real values; others may be null/empty.
- For launch_and_buy: devBuySui is the amount of SUI to buy. If the user says "buy 2 sui", set devBuySui=2 AND buy.amountSui=2. Read the number carefully.
- For launch_and_buy: description is the token's description. If the user writes "description: X" use exactly X. Do NOT use the whole goal sentence as the description. If no description is given, use a short clean phrase, not the goal.
- name is the token name only (e.g. "Finally"), NOT the whole sentence. symbol is the ticker without "$".
- graduationTarget: 0=Cetus, 1=DeepBook, 2=Turbos. Use what the user asks; default 2 only if launching and unspecified.
- For sell, if the user says "all"/"everything", set tokenAmount to "ALL".
- Never put launch fields (devBuySui, graduationTarget) on a sell/buy/claim/alerts plan.
- For "autopilot": the user does NOT name a curve — the agent discovers curves itself. Map the goal's numbers: "0.5 sui per entry/trade/position" -> perEntrySui; "3 sui total/cap/budget" -> spendCapSui; "max N positions/at once" -> maxOpenPositions. If the goal adds "sell at 1.5x / take profit 50%" or "stop loss 0.7x / -30%", put them in then.tpsl exactly like a TP/SL exit (multiple is a price multiple: 1.5x->1.5, +50%->1.5, -30%->0.7). Defaults when unspecified: perEntrySui=0.5, spendCapSui=3, maxOpenPositions=6, minMomentum=0, maxConcentrationPct=90, cooldownMs=60000. Only emit then.tpsl if the user asked for an exit; otherwise omit it.
- Output strictly valid JSON. No trailing commas. No commentary.`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // -- Guard 3b: upstream timeout - a hung Groq call can't pin the lambda.
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        max_tokens:  500,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(groqRes.status).json({ error: data.error?.message ?? 'Groq error' });

    const raw = data.choices?.[0]?.message?.content ?? '';
    let plan;
    try { plan = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
    catch { return res.status(502).json({ error: 'Model returned unparseable plan', raw }); }

    // ---- Normalize per workflow (only keep what the chosen workflow needs) ----
    const valid = ['launch_and_buy', 'buy', 'sell', 'claim', 'alerts', 'autopilot'];
    let wf = valid.includes(plan.workflow) ? plan.workflow : null;

    // Safety: if a curve id was pasted and the model still picked launch, it's
    // almost certainly an existing-curve action, not a new launch.
    if (!wf) wf = pastedCurveId ? 'buy' : 'launch_and_buy';

    const out = { workflow: wf, summary: '' };

    if (wf === 'launch_and_buy') {
      const L = plan.launch ?? {};
      const B = plan.buy ?? {};
      // Deterministic override: if the user typed an explicit "N sui", trust it
      // over the LLM (which has been returning 0). Else use LLM value.
      const devBuy = explicitSui != null
        ? explicitSui
        : Math.max(0, Number(L.devBuySui ?? 0));
      // Description: prefer the user's explicit "description: X"; else the LLM's
      // description field; else a clean fallback (NEVER the whole goal/summary).
      const desc = explicitDesc
        ?? (L.description ? String(L.description) : null)
        ?? `${String(L.name ?? 'DemoToken')} on SuiPump`;
      out.launch = {
        name:             String(L.name ?? 'DemoToken').slice(0, 32),
        symbol:           String(L.symbol ?? 'DEMO').toUpperCase().slice(0, 6),
        description:      String(desc).slice(0, 200),
        graduationTarget: [0, 1, 2].includes(L.graduationTarget) ? L.graduationTarget : 2,
        devBuySui:        devBuy,
        antiBotDelay:     0,
      };
      // buy amount mirrors the dev-buy unless the LLM gave a distinct one.
      const buyAmt = explicitSui != null
        ? explicitSui
        : Math.max(0, Number(B.amountSui ?? L.devBuySui ?? 0));
      out.buy = { amountSui: buyAmt };
    } else if (wf === 'buy') {
      const B = plan.buy ?? {};
      out.buy = {
        curveId:   B.curveId ?? pastedCurveId ?? null,
        amountSui: explicitSui != null ? explicitSui : Math.max(0, Number(B.amountSui ?? 0.1)),
      };
    } else if (wf === 'sell') {
      const S = plan.sell ?? {};
      out.sell = {
        curveId:     S.curveId ?? pastedCurveId ?? null,
        tokenAmount: (S.tokenAmount === 'ALL' || S.tokenAmount == null) ? 'ALL' : Math.max(0, Number(S.tokenAmount)),
      };
    } else if (wf === 'claim') {
      const C = plan.claim ?? {};
      out.claim = { curveId: C.curveId ?? pastedCurveId ?? null };
    } else if (wf === 'alerts') {
      const A = plan.alerts ?? {};
      const ids = Array.isArray(A.curveIds) ? A.curveIds.filter(Boolean) : [];
      if (pastedCurveId && !ids.includes(pastedCurveId)) ids.push(pastedCurveId);
      out.alerts = { curveIds: ids };
    } else if (wf === 'autopilot') {
      // autopilot is curve-less: the agent discovers curves at runtime. Clamp the
      // mandate params to safe bounds and only attach a TP/SL exit if the goal
      // actually asked for one. Mirrors the indexer sanitizeParams autopilot branch.
      const A = plan.autopilot ?? {};
      const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
      const perEntry = num(A.perEntrySui, 0.5) || 0.5;
      let cap = num(A.spendCapSui, 3) || 3;
      if (cap < perEntry) cap = perEntry; // cap must cover at least one entry
      const ap = {
        spendCapSui:        cap,
        perEntrySui:        perEntry,
        maxOpenPositions:   Math.max(1, Math.floor(num(A.maxOpenPositions, 6) || 6)),
        minMomentum:        num(A.minMomentum, 0),
        maxConcentrationPct: Math.min(100, num(A.maxConcentrationPct, 90) || 90),
        cooldownMs:         Math.max(0, Math.floor(num(A.cooldownMs, 60000))),
      };
      // Optional exit: only keep a well-formed then.tpsl.
      const t = A.then?.tpsl;
      if (t && (Array.isArray(t.takeProfit) || t.stopLoss)) {
        const tp = Array.isArray(t.takeProfit)
          ? t.takeProfit
              .map((r) => ({ multiple: Number(r?.multiple), sellPct: Number(r?.sellPct) }))
              .filter((r) => Number.isFinite(r.multiple) && r.multiple > 0 && Number.isFinite(r.sellPct) && r.sellPct > 0)
          : [];
        const slMult = Number(t.stopLoss?.multiple);
        const tpsl = {};
        if (tp.length) tpsl.takeProfit = tp;
        if (Number.isFinite(slMult) && slMult > 0) tpsl.stopLoss = { multiple: slMult };
        if (tpsl.takeProfit || tpsl.stopLoss) ap.then = { tpsl };
      }
      out.autopilot = ap;
    }

    out.summary = String(plan.summary ?? 'Execute the requested workflow.').slice(0, 200);
    return res.status(200).json({ plan: out });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
