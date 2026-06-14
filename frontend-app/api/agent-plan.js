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

// Pull an explicit SUI amount from phrases like "buy 2 sui", "dev buy 1.5 sui",
// "2 sui". Returns a number or null. Ignores amounts that are clearly a curve's
// SUI target etc. by only matching small leading "buy"/"dev-buy" contexts first.
function extractSuiAmount(goal) {
  const g = String(goal).toLowerCase();
  // Prefer an amount tied to a buy verb: "buy 2 sui", "dev-buy 1.5 sui", "buy 2sui"
  const buyCtx = g.match(/(?:dev[\s-]?buy|buy|ape|snipe)\s+(\d+(?:\.\d+)?)\s*sui/);
  if (buyCtx) return Number(buyCtx[1]);
  // Fallback: any "<number> sui" in the goal.
  const anySui = g.match(/(\d+(?:\.\d+)?)\s*sui/);
  if (anySui) return Number(anySui[1]);
  return null;
}

// Pull the user's intended description from "description: <text>" (case-insensitive).
// Returns the trimmed text after the marker, or null if not present.
function extractDescription(goal) {
  const m = String(goal).match(/description\s*[:\-]\s*(.+)$/i);
  if (!m) return null;
  // Stop at a sentence-ending period if there's trailing unrelated text; keep it simple:
  return m[1].trim().replace(/\s+/g, ' ').slice(0, 200);
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body ?? {};

  const { goal } = body;
  if (!goal) return res.status(400).json({ error: 'Missing goal' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  // Pull any 0x object id the user pasted (curve id for buy/sell/claim).
  const caMatch = String(goal).match(/0x[a-fA-F0-9]{60,66}/);
  const pastedCurveId = caMatch ? caMatch[0] : null;

  // Deterministic extractors (used as fallback / override of the LLM).
  const explicitSui  = extractSuiAmount(goal);   // number | null
  const explicitDesc = extractDescription(goal); // string | null

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

The user's goal: "${goal}"
${pastedCurveId ? `Detected curve id in goal: ${pastedCurveId} (use it as curveId).` : ''}

Return ONLY a JSON object, no prose, no markdown fences:
{
  "workflow": "launch_and_buy" | "buy" | "sell" | "claim" | "alerts",
  "launch": { "name": string, "symbol": string (<=6 upper), "description": string, "graduationTarget": 0|1|2, "devBuySui": number, "antiBotDelay": 0 },
  "buy":    { "curveId": string|null, "amountSui": number },
  "sell":   { "curveId": string|null, "tokenAmount": number|"ALL" },
  "claim":  { "curveId": string|null },
  "alerts": { "curveIds": string[] },
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
- Output strictly valid JSON. No trailing commas. No commentary.`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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
    const valid = ['launch_and_buy', 'buy', 'sell', 'claim', 'alerts'];
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
    }

    out.summary = String(plan.summary ?? 'Execute the requested workflow.').slice(0, 200);
    return res.status(200).json({ plan: out });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
