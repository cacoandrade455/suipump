// api/agent-plan.js -- Vercel serverless function (Groq / Llama 3.3 70B)
// Turns a natural-language goal into a structured SuiPump agent plan (JSON).
// Same pattern as api/analyze.js. Uses the existing GROQ_API_KEY env var.
//
// IN:  { goal: "launch a dog token and dev-buy 1 SUI" }
// OUT: { plan: { workflow, launch:{...}, buy:{...}, summary } }
//
// The LLM runs OFF-CHAIN here (never as a Nexus tool) -- on testnet the Nexus
// LLM tool would expose the API key on-chain (per Talus eng), so intent parsing
// stays in this serverless function. The DAG handles only on-chain execution.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body ?? {};

  const { goal } = body;
  if (!goal) return res.status(400).json({ error: 'Missing goal' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  const prompt = `You are the planning layer of an autonomous trading agent on SuiPump, a bonding-curve token launchpad on the Sui blockchain. The agent executes plans as a Nexus DAG with these workflows:

- "launch_and_buy": launch a new token, then dev-buy it.
- "full_lifecycle": launch, dev-buy, monitor for graduation, claim creator fees.
- "buy_sell": buy then sell an existing curve (needs an existing curveId).

The user's goal: "${goal}"

Return ONLY a JSON object, no prose, no markdown fences, with this exact shape:
{
  "workflow": "launch_and_buy" | "full_lifecycle" | "buy_sell",
  "launch": { "name": string, "symbol": string (<=6 chars, uppercase), "graduationTarget": 0 | 1 | 2, "devBuyMist": integer, "antiBotDelay": 0 },
  "buy": { "suiAmount": number, "minTokensOut": 0 },
  "summary": string (one sentence describing what the agent will do)
}

Rules:
- If the user names a token, use it; otherwise invent a fitting name+symbol.
- devBuyMist is in MIST (1 SUI = 1000000000 MIST). If the user says "dev-buy 1 SUI", devBuyMist = 1000000000 and buy.suiAmount = 1.
- graduationTarget: 0 = Cetus, 1 = DeepBook, 2 = Turbos. Use exactly what the user asks for. Default to 2 (Turbos) ONLY if the user does not specify a DEX.
- Default workflow to "full_lifecycle" unless the goal is clearly just launch+buy.
- Set buy.suiAmount to exactly the amount the user states. Do not cap or reduce it.
- Output strictly valid JSON. No trailing commas. No commentary.`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:           'llama-3.3-70b-versatile',
        max_tokens:      500,
        temperature:     0.4,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await groqRes.json();
    if (!groqRes.ok) {
      return res.status(groqRes.status).json({ error: data.error?.message ?? 'Groq error' });
    }

    const raw = data.choices?.[0]?.message?.content ?? '';

    let plan;
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      plan = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({ error: 'Model returned unparseable plan', raw });
    }

    const validWorkflows = ['launch_and_buy', 'full_lifecycle', 'buy_sell'];
    if (!validWorkflows.includes(plan.workflow)) plan.workflow = 'full_lifecycle';
    if (!plan.launch || typeof plan.launch !== 'object') plan.launch = {};
    if (!plan.buy || typeof plan.buy !== 'object') plan.buy = {};
    plan.launch.name             = String(plan.launch.name ?? 'DemoToken').slice(0, 32);
    plan.launch.symbol           = String(plan.launch.symbol ?? 'DEMO').toUpperCase().slice(0, 6);
    plan.launch.graduationTarget = [0, 1, 2].includes(plan.launch.graduationTarget) ? plan.launch.graduationTarget : 2;
    plan.launch.devBuyMist       = Math.max(0, Math.floor(Number(plan.launch.devBuyMist ?? 0)));
    plan.launch.antiBotDelay     = 0;
    plan.buy.suiAmount           = Math.max(0, Number(plan.buy.suiAmount ?? 0.5));
    plan.buy.minTokensOut        = 0;
    plan.summary                 = String(plan.summary ?? 'Launch and trade a token autonomously.');

    return res.status(200).json({ plan });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
