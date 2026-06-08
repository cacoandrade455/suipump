// server.js — SuiPump agent runner.
// Accepts an approved plan from the agent UI, picks the matching published
// Nexus DAG, and executes it via the `nexus` CLI, returning the on-chain
// DAGExecution id + tx digest.
//
// NEW MODEL: one DAG per workflow. The UI/planner sends { workflow, ... } and
// this runner maps workflow -> published DAG id and builds that DAG's input
// JSON (keyed by vertex name, matching the published DAG's vertices).
//
// Endpoints:
//   GET  /health   -> { ok, ts, dags }
//   POST /run-dag  -> { ok, workflow, dagId, executionId, digest, checkpoint }
//
// Body for /run-dag (per workflow):
//   { workflow: "launch_and_buy", launch:{name,symbol,graduationTarget,devBuySui,antiBotDelay}, buy:{amountSui} }
//   { workflow: "buy",   buy:{curveId, amountSui} }
//   { workflow: "sell",  sell:{curveId, tokenAmount} }     // tokenAmount number (UI resolves "ALL")
//   { workflow: "claim", claim:{curveId, tokenType} }
//   { workflow: "alerts", alerts:{curveIds:[...]} }
//   Optional: { dagId } to override the mapping.
//
// Security: only whitelisted fields are interpolated; command is invoked via
// execFile (no shell) — no shell-injection surface and no cmd quoting issues.

import http from 'node:http';
import { execFile } from 'node:child_process';

const PORT           = parseInt(process.env.PORT ?? '3040', 10);
const RUN_TIMEOUT_MS = parseInt(process.env.RUN_TIMEOUT_MS ?? '180000', 10);

// Published DAG ids (testnet). Override any via env if re-published.
const DAG_IDS = {
  launch_and_buy: process.env.DAG_LAUNCH_BUY ?? '0xb385a6452c50125b5d91f9285c72d4d09c6ca025edc505200107a0a3c60841ab',
  buy:            process.env.DAG_BUY        ?? '0xf59d689bc1697ddc03e8ca3363ed93eb71c8c3ada1011b6a23eb83c0bef22831',
  sell:           process.env.DAG_SELL       ?? '0x73db18930ab13894e46279fbf8ef2700dd8772aac566021abf5214df9fa43d68',
  claim:          process.env.DAG_CLAIM      ?? '0xc6c0936d01740a967e1cbeb146026bd519ec6681400eadc7405441d4d3f38eb0',
  alerts:         process.env.DAG_ALERTS     ?? '0x9c189902c9f53cc13b6a66459fd8bbe56b4da51c872c73f8eec5a3b0a7859dbc',
};

// Entry-group name inside each published DAG. nexus dag execute defaults to
// "_default_group" which does NOT exist in our DAGs, so we must pass -e.
const ENTRY_GROUPS = {
  launch_and_buy: 'launch_and_buy',
  buy:            'buy_only',
  sell:           'sell_only',
  claim:          'claim_only',
  alerts:         'alerts_only',
};

const GRAD_MAP = { 0: 'cetus', 1: 'deepbook', 2: 'turbos' };

const ALLOWED_ORIGINS = new Set([
  'https://suipump.org',
  'https://www.suipump.org',
  'http://localhost:5173',
  'http://localhost:3000',
]);

function cors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://suipump.org');
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

const num = (v, dflt = 0) => { const n = Number(v); return Number.isFinite(n) ? n : dflt; };
const str = (v, max = 200) => String(v ?? '').slice(0, max);

// Build the Nexus DAG input JSON for a workflow.
// Inputs are keyed by VERTEX NAME, each an object of entry-port -> value,
// matching the published DAG vertices (e.g. dag_sell has vertex "sell" with
// entry_ports curve_id/token_amount/min_sui_out/referral).
function buildInput(workflow, body) {
  switch (workflow) {
    case 'launch_and_buy': {
      const L = body.launch ?? {};
      const B = body.buy ?? {};
      const name   = str(L.name, 64);
      const symbol = str(L.symbol, 6).toUpperCase();
      if (!name)   throw new Error('launch.name required');
      if (!symbol) throw new Error('launch.symbol required');
      const grad = GRAD_MAP[L.graduationTarget] ?? 'turbos';
      // launch vertex entry_ports: name, symbol, description, icon_url,
      // dev_buy_sui, graduation_target, anti_bot_delay
      // buy vertex: amount_sui (+ slippage_bps, referrer optional); curve_id comes via edge
      return {
        launch: {
          name,
          symbol,
          description: str(L.description || `${name} via SuiPump agent`, 200),
          graduation_target: grad,
          dev_buy_sui: num(L.devBuySui, 0),
          anti_bot_delay: num(L.antiBotDelay, 0),
        },
        buy: {
          amount_sui: num(B.amountSui, num(L.devBuySui, 0)),
        },
      };
    }
    case 'buy': {
      const B = body.buy ?? {};
      if (!B.curveId) throw new Error('buy.curveId required');
      return { buy: { curve_id: str(B.curveId, 66), amount_sui: num(B.amountSui, 0.1) } };
    }
    case 'sell': {
      const S = body.sell ?? {};
      if (!S.curveId) throw new Error('sell.curveId required');
      const amt = num(S.tokenAmount, 0);
      if (!(amt > 0)) throw new Error('sell.tokenAmount must be > 0 (UI resolves "ALL" to a number)');
      return { sell: { curve_id: str(S.curveId, 66), token_amount: amt } };
    }
    case 'claim': {
      const C = body.claim ?? {};
      if (!C.curveId)   throw new Error('claim.curveId required');
      if (!C.tokenType) throw new Error('claim.tokenType required');
      return { claim: { curve_id: str(C.curveId, 66), token_type: str(C.tokenType, 200) } };
    }
    case 'alerts': {
      const A = body.alerts ?? {};
      const ids = Array.isArray(A.curveIds) ? A.curveIds.map(x => str(x, 66)).filter(Boolean) : [];
      if (!ids.length) throw new Error('alerts.curveIds must be a non-empty array');
      return { alerts: { curve_ids: ids } };
    }
    default:
      throw new Error(`Unknown workflow: ${workflow}`);
  }
}

// Run `nexus dag execute -d <dag> -e <group> --input-json <json> --json` via execFile.
// execFile passes args directly (no shell), so JSON quoting is never an issue.
function runDag(dagId, entryGroup, inputObj) {
  return new Promise((resolve, reject) => {
    const inputJson = JSON.stringify(inputObj);
    const args = ['dag', 'execute', '-d', dagId, '-e', entryGroup, '--input-json', inputJson, '--json'];
    console.log(`[runner] nexus ${args.join(' ')}`);
    execFile('nexus', args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`nexus dag execute failed: ${stderr?.trim() || err.message}`));
      const text = (stdout ?? '').trim();
      let parsed = null;
      try { parsed = JSON.parse(text); }
      catch { const m = text.match(/\{[\s\S]*\}\s*$/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
      if (!parsed) return reject(new Error(`Could not parse nexus --json output: ${text.slice(0, 300)}`));
      resolve(parsed);
    });
  });
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, ts: Date.now(), dags: DAG_IDS });
  }

  if (req.method === 'POST' && req.url === '/run-dag') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }

    const workflow = String(body?.workflow ?? '');
    const dagId    = String(body?.dagId ?? DAG_IDS[workflow] ?? '');
    const entryGroup = ENTRY_GROUPS[workflow];
    if (!dagId) return json(res, 400, { ok: false, error: `No DAG id for workflow "${workflow}"` });
    if (!entryGroup) return json(res, 400, { ok: false, error: `No entry group for workflow "${workflow}"` });

    let input;
    try { input = buildInput(workflow, body); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }

    try {
      console.log(`[runner] executing ${workflow} via DAG ${dagId} (group ${entryGroup})`);
      const receipt = await runDag(dagId, entryGroup, input);
      const executionId = receipt.execution_id ?? receipt.executionId ?? receipt.dag_execution_id ?? null;
      console.log(`[runner] execution_id=${executionId} digest=${receipt.digest}`);
      return json(res, 200, {
        ok: true,
        workflow,
        dagId,
        executionId,
        digest:     receipt.digest ?? receipt.tx_digest ?? null,
        checkpoint: receipt.tx_checkpoint ?? receipt.checkpoint ?? null,
      });
    } catch (e) {
      console.error('[runner] /run-dag error:', e.message);
      return json(res, 500, { ok: false, workflow, dagId, error: e.message });
    }
  }

  json(res, 404, { ok: false, error: `Unknown endpoint: ${req.method} ${req.url}` });
});

server.listen(PORT, () => {
  console.log(`[runner] SuiPump agent-runner on ${PORT}`);
  console.log(`[runner] workflows: ${Object.keys(DAG_IDS).join(', ')}`);
});
