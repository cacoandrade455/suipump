// server.js — SuiPump agent runner.
// Accepts an approved plan from the agent UI, picks the matching published
// Nexus DAG, and executes it via the `nexus` CLI, returning the on-chain
// DAGExecution id + tx digest.
//
// NEW MODEL: one DAG per workflow. The UI/planner sends { workflow, ... } and
// this runner maps workflow -> published DAG id and builds that DAG's input
// JSON (keyed by vertex name, matching the published DAG's vertices).
//
// NOTE (2026-06-09): launch_and_buy is pinned to the proven combined DAG
// 0xfd88… (_default_group) whose entry group includes BOTH launch and buy as
// entry vertices and whose launch ports are only name/symbol/description and
// buy port is only amount_sui. The newer one-DAG-per-workflow launch_and_buy
// (0xb385…) aborts in begin_execution_of_entry_group_ because its entry group
// lists only [launch] while we also supply buy input. Until that DAG's entry
// group is re-published to include buy, we run launch_and_buy on 0xfd88.
// All ids/groups remain env-overridable to switch back without a code change.
//
// NOTE (2026-06-10): alerts entry-port fix. The published alerts DAG
// (alerts_only) declares FOUR entry ports: curve_ids, graduation_warning_sui,
// claim_threshold_sui, price_change_pct. We previously sent only curve_ids,
// so begin_execution_of_entry_group_ aborted (same strict-matching bug as the
// buy/sell fixes). We now supply all four with overridable defaults.
// claim (claim_only) declares exactly curve_id + token_type — already matched.
//
// Endpoints:
//   GET  /health        -> { ok, ts, dags }
//   POST /run-dag        -> { ok, workflow, dagId, executionId, digest, checkpoint }
//   POST /schedule-task  -> { ok, workflow, dagId, generator, taskId, detail }
//        (creates an on-chain Nexus scheduler Task + occurrence beside /run-dag;
//         emits real task id + RequestScheduledExecution, leader-independent.)
//
// Body for /run-dag (per workflow):
//   { workflow: "launch_and_buy", launch:{name,symbol,description,graduationTarget,devBuySui,antiBotDelay}, buy:{amountSui} }
//   { workflow: "buy",   buy:{curveId, amountSui} }
//   { workflow: "sell",  sell:{curveId, tokenAmount} }     // tokenAmount number (UI resolves "ALL")
//   { workflow: "claim", claim:{curveId, tokenType} }
//   { workflow: "alerts", alerts:{curveIds:[...], graduationWarningSui?, claimThresholdSui?, priceChangePct?} }
//   Optional: { dagId } to override the mapping.
//
// Security: only whitelisted fields are interpolated; command is invoked via
// execFile (no shell) — no shell-injection surface and no cmd quoting issues.

import http from 'node:http';
import { execFile } from 'node:child_process';

const PORT           = parseInt(process.env.PORT ?? '3040', 10);
const RUN_TIMEOUT_MS = parseInt(process.env.RUN_TIMEOUT_MS ?? '180000', 10);

// Write-endpoint auth: /run-dag and /schedule-task emit on-chain Nexus walks and
// must only be reachable by our own server-side callers (Vercel agent proxy and
// the strategy brain), never a random browser/curl. Shared secret via x-agent-key
// header; key lives only in server-side envs, never the browser. Unset = open
// (dev) with a loud warning.
const AGENT_API_KEY  = process.env.AGENT_API_KEY ?? '';

// Published DAG ids (testnet). Override any via env if re-published.
// launch_and_buy now points at the reworked combo DAG
// 0x42a18814429c433e141c82a02a68100e254f598fc0aedfb0262581a15c32bc0d
// (launch@1 + buy@2, curve_id edge, named entry group "launch_and_buy"). The
// legacy 0xfd88 DAG wired buy to the DEAD buy@1 FQN: launch settled Ok and the
// curve_id edge propagated, but the buy walk was scheduled against buy@1 which
// can no longer respond, so no trade ever landed. The new DAG uses the live
// buy@2 tool. To revert to legacy in one restart, set both:
//   DAG_LAUNCH_BUY=0xfd88d4d2f60340c268e77409b24fb129696d230a50fb21667de313531eb24c3b
//   GROUP_LAUNCH_BUY=_default_group  and  DAG_LAUNCH_BUY_LEGACY=1
const DAG_IDS = {
  launch:         process.env.DAG_LAUNCH     ?? '0x7af3c02275ef1902bce0706d2645311faa291a95ad719ed6603ce96442952237',
  launch_and_buy: process.env.DAG_LAUNCH_BUY ?? '0x42a18814429c433e141c82a02a68100e254f598fc0aedfb0262581a15c32bc0d',
  buy:            process.env.DAG_BUY        ?? '0x594d3f1404fbc69667354fefd68b1a8a234775641d1c2911c02ddf616ea16e56',
  sell:           process.env.DAG_SELL       ?? '0x73db18930ab13894e46279fbf8ef2700dd8772aac566021abf5214df9fa43d68',
  claim:          process.env.DAG_CLAIM      ?? '0xc6c0936d01740a967e1cbeb146026bd519ec6681400eadc7405441d4d3f38eb0',
  alerts:         process.env.DAG_ALERTS     ?? '0x9c189902c9f53cc13b6a66459fd8bbe56b4da51c872c73f8eec5a3b0a7859dbc',
};

// Entry-group name inside each published DAG. nexus dag execute defaults to
// "_default_group". The 0xfd88 combined DAG uses _default_group; the newer
// single-workflow DAGs use named groups (buy_only, etc.).
const ENTRY_GROUPS = {
  launch:         process.env.GROUP_LAUNCH      ?? 'launch_only',
  launch_and_buy: process.env.GROUP_LAUNCH_BUY ?? 'launch_and_buy',
  buy:            process.env.GROUP_BUY        ?? 'buy_only',
  sell:           process.env.GROUP_SELL       ?? 'sell_only',
  claim:          process.env.GROUP_CLAIM      ?? 'claim_only',
  alerts:         process.env.GROUP_ALERTS     ?? 'alerts_only',
};

// Set DAG_LAUNCH_BUY_LEGACY=1 (env) to fall back to the legacy 0xfd88 combo DAG
// (also requires DAG_LAUNCH_BUY + GROUP_LAUNCH_BUY env overrides, see above).
// Default (0) uses the reworked combo DAG: launch emits full ports
// (name/symbol/description/dev_buy_sui/graduation_target/anti_bot_delay) and the
// buy vertex gets curve_id via the on-chain edge plus amount_sui/slippage_bps/
// referrer from input. launch's internal dev_buy is set to 0 so the SINGLE buy
// is performed by the buy@2 vertex with the real amount.
const LAUNCH_BUY_LEGACY = (process.env.DAG_LAUNCH_BUY_LEGACY ?? '0') !== '0';

// Alerts entry-port defaults (env-overridable). Tool: xyz.suipump.alerts@1.
//   graduation_warning_sui — warn when curve is within this many SUI of graduation
//   claim_threshold_sui    — alert when unclaimed creator fees exceed this
//   price_change_pct       — alert on price moves >= this percent
const ALERTS_DEFAULTS = {
  graduation_warning_sui: num(process.env.ALERTS_GRAD_WARNING_SUI, 500),
  claim_threshold_sui:    num(process.env.ALERTS_CLAIM_THRESHOLD_SUI, 10),
  price_change_pct:       num(process.env.ALERTS_PRICE_CHANGE_PCT, 10),
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-agent-key');
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

function num(v, dflt = 0) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }
const str = (v, max = 200) => String(v ?? '').slice(0, max);

// Build the Nexus DAG input JSON for a workflow.
// Inputs are keyed by VERTEX NAME, each an object of entry-port -> value,
// matching the published DAG vertices.
function buildInput(workflow, body) {
  switch (workflow) {
    case 'launch': {
      // Standalone launch DAG (launch_only). The launch vertex declares exactly
      // seven entry ports: name, symbol, description, icon_url, dev_buy_sui,
      // graduation_target, anti_bot_delay. Strict entry-group matching requires
      // ALL of them or begin_execution_of_entry_group_ aborts, so we supply all
      // seven. icon_url is Option<String> -> null = none; dev_buy_sui defaults 0
      // (no dev-buy on a bare launch); graduation_target maps from the UI index.
      const L = body.launch ?? {};
      const name   = str(L.name, 64);
      const symbol = str(L.symbol, 6).toUpperCase();
      if (!name)   throw new Error('launch.name required');
      if (!symbol) throw new Error('launch.symbol required');
      const grad = GRAD_MAP[L.graduationTarget] ?? 'turbos';
      return {
        launch: {
          name,
          symbol,
          description:       str(L.description || `${name} via SuiPump agent`, 200),
          icon_url:          L.iconUrl ? str(L.iconUrl, 256) : null,
          dev_buy_sui:       num(L.devBuySui, 0),
          graduation_target: grad,
          anti_bot_delay:    num(L.antiBotDelay, 0),
        },
      };
    }
    case 'launch_and_buy': {
      const L = body.launch ?? {};
      const B = body.buy ?? {};
      const name   = str(L.name, 64);
      const symbol = str(L.symbol, 6).toUpperCase();
      if (!name)   throw new Error('launch.name required');
      if (!symbol) throw new Error('launch.symbol required');

      if (LAUNCH_BUY_LEGACY) {
        // 0xfd88 _default_group: launch entry ports are ONLY name/symbol/
        // description; buy entry port is ONLY amount_sui (curve_id via edge).
        // Any extra key causes begin_execution_of_entry_group_ MoveAbort, so
        // we emit nothing else. amount_sui floored to 0.1 so the buy vertex
        // never gets 0.
        return {
          launch: {
            name,
            symbol,
            description: str(L.description || `${name} via SuiPump agent`, 200),
          },
          buy: {
            amount_sui: num(B.amountSui, num(L.devBuySui, 0)) || 0.1,
          },
        };
      }

      // Reworked combo DAG (0x42a1...): launch@1 + buy@2, curve_id via on-chain
      // edge. The launch vertex declares name/symbol/description/dev_buy_sui/
      // graduation_target/anti_bot_delay; the buy vertex declares amount_sui/
      // slippage_bps/referrer (curve_id arrives via the edge, NOT as input).
      // Strict entry-group matching requires EVERY declared non-edge port, so we
      // supply all of them.
      //
      // dev_buy_sui is forced to 0 on launch: the SINGLE buy is performed by the
      // buy@2 vertex with the real amount below. (Putting a dev-buy on launch too
      // would double-buy.) The requested dev-buy amount becomes the buy vertex's
      // amount_sui, floored to 0.1 so the buy is never 0 — the legacy bug was
      // launch dev_buy=0 AND a dead buy@1 vertex, so nothing bought at all.
      const grad = GRAD_MAP[L.graduationTarget] ?? 'turbos';
      const buyAmount = num(B.amountSui, num(L.devBuySui, 0)) || 0.1;
      return {
        launch: {
          name,
          symbol,
          description: str(L.description || `${name} via SuiPump agent`, 200),
          dev_buy_sui: 0,
          graduation_target: grad,
          anti_bot_delay: num(L.antiBotDelay, 0),
        },
        buy: {
          amount_sui:   buyAmount,
          slippage_bps: num(B.slippageBps, 500),
          referrer:     B.referrer ? str(B.referrer, 66) : null,
        },
      };
    }
    case 'buy': {
      // buy DAG (buy_only) declares 4 entry ports: curve_id, amount_sui,
      // slippage_bps, referrer. Entry-group matching is strict — EVERY declared
      // port must be present or begin_execution_of_entry_group_ aborts. So we
      // supply all four. referrer is Option<String> -> null = none.
      const B = body.buy ?? {};
      if (!B.curveId) throw new Error('buy.curveId required');
      return {
        buy: {
          curve_id:     str(B.curveId, 66),
          amount_sui:   num(B.amountSui, 0.1) || 0.1,
          slippage_bps: num(B.slippageBps, 500),
          referrer:     B.referrer ? str(B.referrer, 66) : null,
        },
      };
    }
    case 'sell': {
      // sell DAG (sell_only) declares 4 entry ports: curve_id, token_amount,
      // min_sui_out, referral. Strict entry-group matching means ALL must be
      // present or begin_execution_of_entry_group_ aborts. We supply all four.
      // min_sui_out=0 accepts any output (no slippage floor); referral is
      // Option<String> -> null = none.
      const S = body.sell ?? {};
      if (!S.curveId) throw new Error('sell.curveId required');
      const amt = num(S.tokenAmount, 0);
      if (!(amt > 0)) throw new Error('sell.tokenAmount must be > 0 (UI resolves "ALL" to a number)');
      return {
        sell: {
          curve_id:    str(S.curveId, 66),
          token_amount: amt,
          min_sui_out: num(S.minSuiOut, 0),
          referral:    S.referral ? str(S.referral, 66) : null,
        },
      };
    }
    case 'claim': {
      // claim DAG (claim_only) declares exactly 2 entry ports: curve_id,
      // token_type. Input shape already matches — no change needed.
      const C = body.claim ?? {};
      if (!C.curveId)   throw new Error('claim.curveId required');
      if (!C.tokenType) throw new Error('claim.tokenType required');
      return { claim: { curve_id: str(C.curveId, 66), token_type: str(C.tokenType, 200) } };
    }
    case 'alerts': {
      // alerts DAG (alerts_only) declares FOUR entry ports: curve_ids,
      // graduation_warning_sui, claim_threshold_sui, price_change_pct.
      // Strict entry-group matching means ALL must be present or
      // begin_execution_of_entry_group_ aborts — this was the bug (we sent
      // only curve_ids). Supply all four; thresholds default sensibly and are
      // overridable per-request or via env (ALERTS_* vars).
      const A = body.alerts ?? {};
      const ids = Array.isArray(A.curveIds) ? A.curveIds.map(x => str(x, 66)).filter(Boolean) : [];
      if (!ids.length) throw new Error('alerts.curveIds must be a non-empty array');
      return {
        alerts: {
          curve_ids:              ids,
          graduation_warning_sui: num(A.graduationWarningSui, ALERTS_DEFAULTS.graduation_warning_sui),
          claim_threshold_sui:    num(A.claimThresholdSui,    ALERTS_DEFAULTS.claim_threshold_sui),
          price_change_pct:       num(A.priceChangePct,       ALERTS_DEFAULTS.price_change_pct),
        },
      };
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

// ── Leader-settlement confirm (C2 demo path) ─────────────────────────────────
// After runDag returns a DAGExecution id, the leader settles the walk on a
// SEPARATE tx (sender = a Talus leader address, not our invoker). This confirms
// the leader reached an Ok/Empty EndState and returns that leader settlement
// digest — the unforgeable proof the Talus network executed the action, distinct
// from the bridge self-signed path. Best-effort: polls the DAGExecution object's
// prevTx (which advances to the leader settlement once the walk settles) for up
// to CONFIRM_TIMEOUT_MS, reading EndStateReachedEvent.variant.
//
// Returns { endState: 'Ok'|'Empty'|'_err_eval'|'pending', settlementDigest, leaderSender }.
// Never throws — a confirm failure must not break the /run-dag response.
const CONFIRM_TIMEOUT_MS = parseInt(process.env.CONFIRM_TIMEOUT_MS ?? '60000', 10);
const CONFIRM_POLL_MS    = parseInt(process.env.CONFIRM_POLL_MS    ?? '3000',  10);
// Our own invoker address — the settlement is "leader" only if the sender is NOT us.
const INVOKER_ADDRESS = process.env.INVOKER_ADDRESS ?? process.env.AGENT_ADDRESS ?? '';
// GraphQL endpoint — the runner reads chain state over the network (no local sui
// CLI dependency; the runner box only ships the nexus CLI). Aligns with the
// SuiGraphQLClient-only transport rule.
const SUI_GRAPHQL_URL = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';

async function gqlQuery(query, variables) {
  try {
    const r = await fetch(SUI_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j?.data ?? null;
  } catch { return null; }
}

// Read the DAGExecution object's previous (latest) transaction digest via GraphQL.
// Verified schema: object(address:) { previousTransaction { digest } }.
async function execLatestTxDigest(executionId) {
  const data = await gqlQuery(
    `query($id: SuiAddress!) { object(address: $id) { previousTransaction { digest } } }`,
    { id: executionId },
  );
  return data?.object?.previousTransaction?.digest ?? null;
}

// Read a tx's sender via GraphQL. Verified schema: transaction(digest:) { sender { address } }.
// The leader settlement is the tx whose sender is a Talus leader (NOT our invoker).
async function txSender(digest) {
  const data = await gqlQuery(
    `query($d: String!) { transaction(digest: $d) { sender { address } } }`,
    { d: digest },
  );
  return data?.transaction?.sender?.address ?? null;
}

// Confirm the walk was settled by a Talus leader. The DAGExecution object's
// previousTransaction starts as our invoker's request tx, then advances to the
// LEADER settlement once the walk settles. We detect leader settlement by the
// settlement tx's sender being an address OTHER than our invoker — that is the
// unforgeable proof the Talus network (not us) executed the action. Best-effort;
// never throws. endState reports 'leader' (settled by a leader), 'self' (only
// our request tx so far), or 'pending' (could not read in the window).
async function confirmLeaderSettlement(executionId) {
  const out = { endState: 'pending', settlementDigest: null, leaderSender: null };
  if (!executionId) return out;
  const inv = (INVOKER_ADDRESS || '').toLowerCase();
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  let lastDigest = null;
  while (Date.now() < deadline) {
    const digest = await execLatestTxDigest(executionId);
    if (digest && digest !== lastDigest) {
      lastDigest = digest;
      const sender = await txSender(digest);
      if (sender) {
        const isLeader = inv ? sender.toLowerCase() !== inv : false;  // no known invoker -> never falsely claim leader-settled
        out.settlementDigest = digest;
        out.leaderSender = sender;
        if (isLeader) {
          // Settled by a leader — the walk completed on-chain via Talus.
          out.endState = 'Ok';
          return out;
        }
        // Still our own request tx; keep polling until a leader advances it.
        out.endState = 'self';
      }
    }
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
  }
  return out;
}

// ── Scheduler path (additive; sits beside runDag) ────────────────────────────
// Creates an on-chain Nexus scheduler Task bound to a published DAG + entry
// group, then (for queue tasks) the create call also schedules the initial
// occurrence inline via the --schedule-* flags. The Task is a persistent,
// inspectable on-chain object; every occurrence emits a real
// RequestScheduledExecution event naming the network's leaders. Emission is
// fully invoker-driven (your wallet signs the create tx) and does NOT depend
// on a leader being online — exactly the "real Nexus tx id, leader-optional"
// property we want. Settlement (the actual buy/sell) happens when a leader
// consumes the occurrence; that part is the Talus leader network's job.
//
// generator:
//   'queue'    -> one-shot task. --schedule-start-offset-ms / -deadline-offset-ms
//                 schedule the first occurrence immediately (TP/SL, sniper,
//                 copy-trade: fire once when the condition hits).
//   'periodic' -> recurring task. The create call prepares the task; the caller
//                 must follow with `nexus scheduler periodic set` to define the
//                 cadence (DCA). We expose that via schedulePeriodic() below.
//
// Returns the parsed --json output, from which we lift the created task id.
function runNexusJson(args, label) {
  return new Promise((resolve, reject) => {
    console.log(`[runner] nexus ${args.join(' ')}`);
    execFile('nexus', args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${label} failed: ${stderr?.trim() || err.message}`));
      const text = (stdout ?? '').trim();
      let parsed = null;
      try { parsed = JSON.parse(text); }
      catch { const m = text.match(/\{[\s\S]*\}\s*$/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
      // Some scheduler subcommands print human lines, not JSON. Fall back to the
      // raw text so the caller can still surface the task id / confirmation.
      resolve(parsed ?? { raw: text });
    });
  });
}

function pickTaskId(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  // Try common shapes from --json, then a raw-text scan for 0x… task id.
  const direct = parsed.task_id ?? parsed.taskId ?? parsed.task ?? parsed.object_id ?? parsed.objectId ?? null;
  if (direct) return String(direct);
  if (parsed.task_ref && parsed.task_ref.object_id) return String(parsed.task_ref.object_id);
  const hay = parsed.raw ?? JSON.stringify(parsed);
  const m = String(hay).match(/0x[0-9a-fA-F]{64}/);
  return m ? m[0] : null;
}

// Create a queue (one-shot) scheduler task for a workflow, with an immediate
// occurrence. startOffsetMs/deadlineOffsetMs default to fire-soon / 10-min
// window so a leader has time to consume before the occurrence is pruned.
function scheduleQueueTask(dagId, entryGroup, inputObj, opts = {}) {
  const inputJson = JSON.stringify(inputObj);
  const startOffsetMs    = String(num(opts.startOffsetMs, 3000));
  const deadlineOffsetMs = String(num(opts.deadlineOffsetMs, 600000));
  const args = [
    'scheduler', 'task', 'create',
    '--dag-id', dagId,
    '--entry-group', entryGroup,
    '--input-json', inputJson,
    '--generator', 'queue',
    '--schedule-start-offset-ms', startOffsetMs,
    '--schedule-deadline-offset-ms', deadlineOffsetMs,
    '--json',
  ];
  return runNexusJson(args, 'nexus scheduler task create');
}

// Create a periodic scheduler task for a workflow (e.g. DCA), then configure the
// recurring schedule. firstStartMs is absolute ms-since-epoch; periodMs is the
// spacing. Two CLI calls: create (prepares the task) + periodic set (cadence).
async function schedulePeriodicTask(dagId, entryGroup, inputObj, opts = {}) {
  const inputJson = JSON.stringify(inputObj);
  const created = await runNexusJson([
    'scheduler', 'task', 'create',
    '--dag-id', dagId,
    '--entry-group', entryGroup,
    '--input-json', inputJson,
    '--generator', 'periodic',
    '--json',
  ], 'nexus scheduler task create (periodic)');
  const taskId = pickTaskId(created);
  if (!taskId) return { created, taskId: null, periodic: null };

  const firstStartMs = String(num(opts.firstStartMs, Date.now() + 5000));
  const periodMs     = String(num(opts.periodMs, 3600000)); // default hourly
  const setArgs = [
    'scheduler', 'periodic', 'set',
    '--task-id', taskId,
    '--first-start-ms', firstStartMs,
    '--period-ms', periodMs,
  ];
  if (opts.deadlineOffsetMs != null) { setArgs.push('--deadline-offset-ms', String(num(opts.deadlineOffsetMs, 600000))); }
  if (opts.maxIterations   != null) { setArgs.push('--max-iterations',   String(num(opts.maxIterations, 0))); }
  setArgs.push('--json');
  const periodic = await runNexusJson(setArgs, 'nexus scheduler periodic set');
  return { created, taskId, periodic };
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, ts: Date.now(), dags: DAG_IDS });
  }

  // Single-shot leader-settlement check for FRONTEND POLLING (C2 demo, async).
  // The page fires /run-dag WITHOUT confirm (instant executionId), then polls
  // this endpoint every couple seconds and updates the card live when a leader
  // settles. Unlike the inline confirm in /run-dag, this does ONE GraphQL read
  // and returns immediately — the client owns the polling cadence, so no request
  // ever hangs. Read-only (executionId is already public on-chain); left open
  // like /health. Returns { ok, endState:'Ok'|'self'|'pending', settlementDigest,
  // leaderSender }.
  if (req.method === 'GET' && req.url.startsWith('/confirm')) {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const executionId = q.get('executionId') ?? '';
    if (!executionId) return json(res, 400, { ok: false, error: 'executionId required' });
    const inv = (INVOKER_ADDRESS || '').toLowerCase();
    const digest = await execLatestTxDigest(executionId);
    if (!digest) return json(res, 200, { ok: true, endState: 'pending', settlementDigest: null, leaderSender: null });
    const sender = await txSender(digest);
    if (!sender) return json(res, 200, { ok: true, endState: 'pending', settlementDigest: digest, leaderSender: null });
    const isLeader = inv ? sender.toLowerCase() !== inv : false;  // no known invoker -> never falsely claim leader-settled
    return json(res, 200, {
      ok: true,
      endState: isLeader ? 'Ok' : 'self',
      settlementDigest: digest,
      leaderSender: sender,
    });
  }

  // Auth gate: /run-dag and /schedule-task emit on-chain walks and must only be
  // reachable by our server-side callers (Vercel proxy, brain). Shared secret via
  // x-agent-key. Reads (GET /health above) are open. Unset key = open (dev) with
  // a loud warning so production is never silently open.
  if (req.method === 'POST' && (req.url === '/run-dag' || req.url === '/schedule-task')) {
    if (AGENT_API_KEY) {
      if (req.headers['x-agent-key'] !== AGENT_API_KEY) {
        return json(res, 401, { ok: false, error: 'unauthorized' });
      }
    } else {
      console.warn(`[runner] WARNING: AGENT_API_KEY unset — ${req.url} is OPEN to anyone. Set AGENT_API_KEY in env to lock it.`);
    }
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
      const resp = {
        ok: true,
        workflow,
        dagId,
        executionId,
        digest:     receipt.digest ?? receipt.tx_digest ?? null,
        checkpoint: receipt.tx_checkpoint ?? receipt.checkpoint ?? null,
      };
      // C2 demo path: when the caller asks to confirm, poll the DAGExecution for
      // the leader settlement (sender = a Talus leader, EndState Ok/Empty) and
      // surface it. This makes the leader path the sole, provable executor for
      // demo'd actions. Best-effort: a confirm timeout still returns the emit.
      if (body?.confirm === true) {
        const c = await confirmLeaderSettlement(executionId);
        resp.endState         = c.endState;
        resp.settlementDigest = c.settlementDigest;
        resp.leaderSender     = c.leaderSender;
        console.log(`[runner] confirm endState=${c.endState} settlement=${c.settlementDigest} leader=${c.leaderSender}`);
      }
      return json(res, 200, resp);
    } catch (e) {
      console.error('[runner] /run-dag error:', e.message);
      return json(res, 500, { ok: false, workflow, dagId, error: e.message });
    }
  }

  // POST /schedule-task — create an on-chain Nexus scheduler Task for a workflow.
  // Same body shape as /run-dag ({ workflow, buy|sell|claim|... }) plus optional
  // scheduling controls. Emits a real, persistent, inspectable Task object and a
  // RequestScheduledExecution event (real task id + execution request) regardless
  // of whether a leader is online to settle it.
  //
  // Body:
  //   { workflow:"sell", sell:{curveId, tokenAmount, minSuiOut?}, schedule?:{
  //       generator?: "queue"|"periodic",       // default "queue"
  //       startOffsetMs?, deadlineOffsetMs?,     // queue timing
  //       firstStartMs?, periodMs?, maxIterations? // periodic cadence
  //   }}
  // Returns: { ok, workflow, dagId, generator, taskId, detail }
  if (req.method === 'POST' && req.url === '/schedule-task') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }

    const workflow   = String(body?.workflow ?? '');
    const dagId      = String(body?.dagId ?? DAG_IDS[workflow] ?? '');
    const entryGroup = ENTRY_GROUPS[workflow];
    if (!dagId)      return json(res, 400, { ok: false, error: `No DAG id for workflow "${workflow}"` });
    if (!entryGroup) return json(res, 400, { ok: false, error: `No entry group for workflow "${workflow}"` });

    let input;
    try { input = buildInput(workflow, body); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }

    const sched     = body?.schedule ?? {};
    const generator = sched.generator === 'periodic' ? 'periodic' : 'queue';

    try {
      console.log(`[runner] scheduling ${workflow} via DAG ${dagId} (group ${entryGroup}, generator ${generator})`);
      let detail, taskId;
      if (generator === 'periodic') {
        detail = await schedulePeriodicTask(dagId, entryGroup, input, sched);
        taskId = detail.taskId ?? pickTaskId(detail.created);
      } else {
        detail = await scheduleQueueTask(dagId, entryGroup, input, sched);
        taskId = pickTaskId(detail);
      }
      console.log(`[runner] scheduled ${workflow} task_id=${taskId} generator=${generator}`);
      return json(res, 200, { ok: true, workflow, dagId, generator, taskId, detail });
    } catch (e) {
      console.error('[runner] /schedule-task error:', e.message);
      return json(res, 500, { ok: false, workflow, dagId, error: e.message });
    }
  }

  json(res, 404, { ok: false, error: `Unknown endpoint: ${req.method} ${req.url}` });
});

server.listen(PORT, () => {
  console.log(`[runner] SuiPump agent-runner on ${PORT}`);
  console.log(`[runner] workflows: ${Object.keys(DAG_IDS).join(', ')}`);
  console.log(`[runner] endpoints: POST /run-dag, POST /schedule-task (scheduler tasks)`);
  console.log(`[runner] launch -> ${DAG_IDS.launch} (group ${ENTRY_GROUPS.launch})`);
  console.log(`[runner] launch_and_buy -> ${DAG_IDS.launch_and_buy} (group ${ENTRY_GROUPS.launch_and_buy}, legacy=${LAUNCH_BUY_LEGACY})`);
  if (!INVOKER_ADDRESS) {
    console.warn(`[runner] WARNING: INVOKER_ADDRESS unset — leader-settlement confirm will NEVER report Ok (fail-safe). Set INVOKER_ADDRESS to enable the C2 leader-settled proof.`);
  } else {
    console.log(`[runner] INVOKER_ADDRESS set — leader-settlement confirm active.`);
  }
});
