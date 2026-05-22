"""
Run from suipump root:
  python patch_api.py
Adds /trader/:address endpoint to indexer/api.js
"""
import sys

path = 'indexer/api.js'
content = open(path, encoding='utf-8').read()

if '/trader/:address' in content:
    print("Already patched.")
    sys.exit(0)

ENDPOINT = '''
// ── Trader portfolio (for portfolio page traded tab) ─────────────────────────

app.get('/trader/:address', async (req, res) => {
  try {
    const addr = req.params.address;
    const MIST = 1e9;
    const TOKEN_SCALE = 1e6;

    const [buysRes, sellsRes] = await Promise.all([
      pool.query(
        `SELECT e.curve_id, e.data, c.name, c.symbol, c.token_type, c.package_id
         FROM events e
         LEFT JOIN curves c ON c.curve_id = e.curve_id
         WHERE e.event_type LIKE '%TokensPurchased'
           AND e.data->>'buyer' = $1`,
        [addr]
      ),
      pool.query(
        `SELECT e.curve_id, e.data, c.name, c.symbol, c.token_type, c.package_id
         FROM events e
         LEFT JOIN curves c ON c.curve_id = e.curve_id
         WHERE e.event_type LIKE '%TokensSold'
           AND e.data->>'seller' = $1`,
        [addr]
      ),
    ]);

    const curveMap = {};

    for (const row of buysRes.rows) {
      const id = row.curve_id;
      if (!curveMap[id]) curveMap[id] = {
        curve_id: id, name: row.name, symbol: row.symbol,
        token_type: row.token_type, package_id: row.package_id,
        sui_spent: 0, sui_received: 0, buys: 0, sells: 0,
        tokens_bought: 0, tokens_sold: 0,
      };
      curveMap[id].sui_spent     += Number(row.data.sui_in     ?? 0) / MIST;
      curveMap[id].tokens_bought += Number(row.data.tokens_out ?? 0) / TOKEN_SCALE;
      curveMap[id].buys++;
    }

    for (const row of sellsRes.rows) {
      const id = row.curve_id;
      if (!curveMap[id]) curveMap[id] = {
        curve_id: id, name: row.name, symbol: row.symbol,
        token_type: row.token_type, package_id: row.package_id,
        sui_spent: 0, sui_received: 0, buys: 0, sells: 0,
        tokens_bought: 0, tokens_sold: 0,
      };
      curveMap[id].sui_received += Number(row.data.sui_out   ?? 0) / MIST;
      curveMap[id].tokens_sold  += Number(row.data.tokens_in ?? 0) / TOKEN_SCALE;
      curveMap[id].sells++;
    }

    const result = Object.values(curveMap).map(c => ({
      curve_id:        c.curve_id,
      name:            c.name,
      symbol:          c.symbol,
      token_type:      c.token_type,
      package_id:      c.package_id,
      sui_spent:       c.sui_spent,
      sui_received:    c.sui_received,
      buys:            c.buys,
      sells:           c.sells,
      net_tokens:      c.tokens_bought - c.tokens_sold,
      avg_entry_price: c.tokens_bought > 0 ? c.sui_spent / c.tokens_bought : 0,
    })).sort((a, b) => (b.sui_spent + b.sui_received) - (a.sui_spent + a.sui_received));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
'''

# Insert before the startApi export
target = 'export function startApi()'
assert target in content, f"Could not find '{target}' in api.js"
content = content.replace(target, ENDPOINT + '\n' + target)
open(path, 'w', encoding='utf-8').write(content)
print("✓ /trader/:address endpoint added to indexer/api.js")
