"""
Run from suipump root:
  python patch_leaderboard.py
Adds GET /leaderboard/traders to indexer/api.js — top traders by total
SUI volume, aggregated across ALL packages from the events table.
"""
import sys

path = 'indexer/api.js'
content = open(path, encoding='utf-8').read()

if '/leaderboard/traders' in content:
    print("Already patched.")
    sys.exit(0)

ENDPOINT = '''
// ── Top traders by volume (all packages) ─────────────────────────────────────

app.get('/leaderboard/traders', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);
    // Aggregate SUI volume + trade count per wallet across every buy and sell.
    // buyer/seller live in the JSONB `data` column; sui_in / sui_out are MIST.
    const result = await pool.query(
      `SELECT wallet,
              SUM(vol_sui)      AS volume_sui,
              SUM(trade_count)  AS trades
       FROM (
         SELECT data->>'buyer' AS wallet,
                (data->>'sui_in')::float / 1e9 AS vol_sui,
                1 AS trade_count
         FROM events
         WHERE event_type LIKE '%TokensPurchased'
           AND data->>'buyer' IS NOT NULL
         UNION ALL
         SELECT data->>'seller' AS wallet,
                (data->>'sui_out')::float / 1e9 AS vol_sui,
                1 AS trade_count
         FROM events
         WHERE event_type LIKE '%TokensSold'
           AND data->>'seller' IS NOT NULL
       ) t
       GROUP BY wallet
       ORDER BY volume_sui DESC
       LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
'''

target = 'export function startApi()'
assert target in content, f"Could not find '{target}' in api.js"
content = content.replace(target, ENDPOINT + '\n' + target)
open(path, 'w', encoding='utf-8').write(content)
print("\u2713 /leaderboard/traders endpoint added to indexer/api.js")
