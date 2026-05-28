// api/analyze.js — Vercel serverless function (Groq / Llama 3.3 70B)
// Set GROQ_API_KEY in Vercel environment variables.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt } = req.body ?? {};
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
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
