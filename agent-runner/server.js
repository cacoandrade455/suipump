// server.js — SuiPump agent runner.
// One job: accept an approved plan from the SuiPump agent UI and execute the
// real Nexus DAG via the `nexus` CLI, returning the on-chain DAGExecution id.
//
// Endpoints:
//   GET  /health   -> { ok, ts }
//   POST /run-dag  -> { ok, executionId, digest, checkpoint }
//
// Body for /run-dag:
//   {
//     dagId?: string,                    // overrides NEXUS_DAG_ID
//     launch: { name, symbol, description },
//     buy:    { amount_sui },
//     entryGroup?: string                // default: the DAG's default group
//   }
//
// Security: only the fields above are interpolated into the input JSON; the
// command is invoked via execFile (no shell), so there is no shell injection
// surface. CORS is locked to the SuiPump origins.

import http from 'node:http';
import { execFile } from 'node:child_process';

const PORT       = parseInt(process.env.PORT ?? '3040', 10);
const DAG_ID     = process.env.NEXUS_DAG_ID ?? '';
const RUN_TIMEOUT_MS = parseInt(process.env.RUN_TIMEOUT_MS ?? '120000', 10);

const ALLOWED_ORIGINS = new Set([
  'https://suipump.org',
  'https://www.suipump.org',
  'http://localhost:5173',
  'http://localhost:3000',
]);

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://suipump.org');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

// Build the Nexus input JSON from the approved plan. Only whitelisted string/
// number fields are passed through — never raw user shell input.
function buildInput(body) {
  const name        = String(body?.launch?.name ?? '').slice(0, 64);
  const symbol      = String(body?.launch?.symbol ?? '').toUpperCase().slice(0, 6);
  const description = String(body?.launch?.description ?? `${name} via SuiPump agent`).slice(0, 200);
  const amountSui   = Number(body?.buy?.amount_sui ?? 0);

  if (!name)   throw new Error('launch.name required');
  if (!symbol) throw new Error('launch.symbol required');
  if (!(amountSui >= 0)) throw new Error('buy.amount_sui must be a non-negative number');

  return {
    launch: { name, symbol, description },
    buy:    { amount_sui: amountSui },
  };
}

// Run `nexus dag execute -d <dag> -i <input> --json` via execFile (no shell).
function runDag(dagId, inputObj) {
  return new Promise((resolve, reject) => {
    const args = ['dag', 'execute', '-d', dagId, '-i', JSON.stringify(inputObj), '--json'];
    execFile('nexus', args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`nexus dag execute failed: ${stderr?.trim() || err.message}`));
      }
      // --json prints only the receipt: { digest, execution_id, tx_checkpoint }
      let parsed = null;
      const text = (stdout ?? '').trim();
      try {
        parsed = JSON.parse(text);
      } catch {
        // Some CLI builds may print a banner line before JSON — grab the last { ... } block.
        const m = text.match(/\{[\s\S]*\}\s*$/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
      }
      if (!parsed) return reject(new Error(`Could not parse nexus --json output: ${text.slice(0, 300)}`));
      resolve(parsed);
    });
  });
}

const server = http.createServer(async (req, res) => {
  cors(req, res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, ts: Date.now(), dagConfigured: Boolean(DAG_ID) });
  }

  if (req.method === 'POST' && req.url === '/run-dag') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }

    const dagId = String(body?.dagId ?? DAG_ID);
    if (!dagId) return json(res, 400, { ok: false, error: 'No dagId (set NEXUS_DAG_ID or pass dagId)' });

    let input;
    try { input = buildInput(body); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }

    try {
      console.log(`[runner] executing DAG ${dagId} for ${input.launch.symbol}`);
      const receipt = await runDag(dagId, input);
      const executionId = receipt.execution_id ?? receipt.executionId ?? null;
      console.log(`[runner] execution_id=${executionId} digest=${receipt.digest}`);
      return json(res, 200, {
        ok: true,
        executionId,
        digest:     receipt.digest ?? null,
        checkpoint: receipt.tx_checkpoint ?? receipt.checkpoint ?? null,
        dagId,
      });
    } catch (e) {
      console.error('[runner] /run-dag error:', e.message);
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  json(res, 404, { ok: false, error: `Unknown endpoint: ${req.method} ${req.url}` });
});

server.listen(PORT, () => {
  console.log(`[runner] SuiPump agent-runner listening on ${PORT}`);
  console.log(`[runner] DAG: ${DAG_ID || '(none — pass dagId in body)'}`);
});
