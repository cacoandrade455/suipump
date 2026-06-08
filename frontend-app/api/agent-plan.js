// api/agent-plan.js -- Vercel serverless function (Groq / Llama 3.3 70B)
// Turns a natural-language goal into a structured SuiPump agent plan.
//
// NEW MODEL (one DAG per workflow): the planner picks ONE published DAG by
// `workflow`, and emits ONLY that workflow's fields. No more launch-shaped
// output forced onto every plan (that caused "dev-buy: 3 SUI" on a sell).
//
// Workflows map 1:1 to published Nexus DAG ids (resolved in the runner/UI):
//   launch_and_buy : launch -> dev-buy            (needs launch fields + buy.amount_sui)
//   buy            : buy an existing curve         (needs curve_id + amount_sui)
//   sell           : sell tokens on an existing curve (needs curve_id + token_amount)
//   claim          : claim creator fees            (needs curve_id + token_type)
//   alerts         : monitor curves                (needs curve_ids[])
//
// The LLM plans OFF-CHAIN here; the DAG does on-chain execution.

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

  const prompt = `You are the planning layer of an autonomous agent on SuiPump, a bonding-curve token launchpad on Sui. The agent executes ONE workflow per run, each a published Nexus DAG. Pick the single workflow that matches the user's goal and emit ONLY that workflow's fields.

Workflows:
- "launch_and_buy": launch a NEW token then dev-buy it. Use when the user wants to create/launch a token. Fields: launch{name,symbol,graduationTarget,devBuySui,antiBotDelay}, buy{amountSui}.
- "buy": buy an EXISTING token by curve id. Use when the user wants to buy a token that already exists (a curve id / CA is given). Fields: buy{curveId, amountSui}.
- "sell": sell tokens of an EXISTING token by curve id. Use when the user wants to sell/dump. Fields: sell{curveId, tokenAmount}. tokenAmount can be the string "ALL" to sell the whole balance.
- "claim": claim creator fees on an existing curve. Fields: claim{curveId}.
- "alerts": monitor existing curves for graduation/price. Fields: alerts{curveIds:[...]}.

The user's goal: "${goal}"
${pastedCurveId ? `Detected curve id in goal: ${pastedCurveId} (use it as curveId).` : ''}

Return ONLY a JSON object, no prose, no markdown fences:
{
  "workflow": "launch_and_buy" | "buy" | "sell" | "claim" | "alerts",
  "launch": { "name": string, "symbol": string (<=6 upper), "graduationTarget": 0|1|2, "devBuySui": number, "antiBotDelay": 0 },
  "buy":    { "curveId": string|null, "amountSui": number },
  "sell":   { "curveId": string|null, "tokenAmount": number|"ALL" },
  "claim":  { "curveId": string|null },
  "alerts": { "curveIds": string[] },
  "summary": string (one sentence)
}

Rules:
- Choose exactly ONE workflow. Only the object for that workflow needs real values; others may be null/empty.
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
        temperature: 0.3,
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
      out.launch = {
        name:             String(L.name ?? 'DemoToken').slice(0, 32),
        symbol:           String(L.symbol ?? 'DEMO').toUpperCase().slice(0, 6),
        graduationTarget: [0, 1, 2].includes(L.graduationTarget) ? L.graduationTarget : 2,
        devBuySui:        Math.max(0, Number(L.devBuySui ?? 0)),
        antiBotDelay:     0,
      };
      out.buy = { amountSui: Math.max(0, Number(B.amountSui ?? L.devBuySui ?? 0)) };
    } else if (wf === 'buy') {
      const B = plan.buy ?? {};
      out.buy = {
        curveId:   B.curveId ?? pastedCurveId ?? null,
        amountSui: Math.max(0, Number(B.amountSui ?? 0.1)),
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
