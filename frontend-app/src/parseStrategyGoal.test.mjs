// parseStrategyGoal.test.mjs
// Self-contained test for the deterministic strategy parser in AgentPage.jsx.
//
// AgentPage.jsx imports React / lucide-react / @mysten/dapp-kit-react /
// react-router-dom / @mysten/sui/graphql and uses import.meta.env, none of which
// exist under plain `node`. So we transpile the file with esbuild, stubbing those
// imports and defining import.meta.env, into a temp ESM module, then import the
// two pure exports (parseStrategyGoal, extractTakeProfitRungs) and assert on them.
//
// Run:  node frontend-app\src\parseStrategyGoal.test.mjs
// Exits 0 if all pass, 1 if any fail. ALWAYS prints a summary.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'AgentPage.jsx');

// ── 1. Transpile AgentPage.jsx with all problem imports stubbed ──────────────
// We point every bare external import at a single stub module that default- and
// named-exports harmless no-ops, and define import.meta.env to an empty object.
const tmp = mkdtempSync(join(tmpdir(), 'suipump-test-'));
const stubPath = join(tmp, 'stub.js');
const outPath = join(tmp, 'AgentPage.bundle.mjs');

// Stub: any named import resolves to a no-op; default is a no-op too.
writeFileSync(stubPath, `
  const noop = new Proxy(function(){}, { get: () => noop });
  export default noop;
  export const __esModule = true;
  // Common named hooks/components used by AgentPage; all no-ops via Proxy fallback.
  export const useState = () => [undefined, () => {}];
  export const useCallback = (f) => f;
  export const useRef = () => ({ current: null });
  export const useEffect = () => {};
  export const useCurrentAccount = () => null;
  export const useNavigate = () => () => {};
  export const SuiGraphQLClient = function(){};
  export { noop as ArrowLeft, noop as Sparkles, noop as Play, noop as Check,
           noop as X, noop as Loader, noop as ExternalLink, noop as Bot, noop as ChevronDown };
  // react/jsx-runtime names (automatic JSX runtime imports these):
  export const jsx = noop;
  export const jsxs = noop;
  export const jsxDEV = noop;
  export const Fragment = noop;
`);

try {
  execFileSync('npx', [
    'esbuild', SRC,
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--jsx=automatic',
    '--log-level=error',
    `--define:import.meta.env={}`,
    // Redirect every external bare import to our stub module.
    `--alias:react=${stubPath}`,
    `--alias:react/jsx-runtime=${stubPath}`,
    `--alias:react/jsx-dev-runtime=${stubPath}`,
    `--alias:lucide-react=${stubPath}`,
    `--alias:@mysten/dapp-kit-react=${stubPath}`,
    `--alias:react-router-dom=${stubPath}`,
    `--alias:@mysten/sui/graphql=${stubPath}`,
    `--outfile=${outPath}`,
  ], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
} catch (e) {
  console.error('\n[FATAL] esbuild transpile failed. Is esbuild installed? (npm i -D esbuild)\n');
  process.exit(1);
}

const mod = await import(pathToFileURL(outPath).href);
const { parseStrategyGoal, extractTakeProfitRungs } = mod;

if (typeof parseStrategyGoal !== 'function' || typeof extractTakeProfitRungs !== 'function') {
  console.error('\n[FATAL] Could not import parseStrategyGoal / extractTakeProfitRungs from AgentPage.jsx.');
  console.error('        Make sure both are `export function ...`.\n');
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

// ── 2. Test helpers ──────────────────────────────────────────────────────────
const CURVE = '0x9fed1e0e2afbedd1b76633099c7739840a46c99b437b4c27d4bf89e4fa9a4ba3';
let pass = 0, fail = 0;
const fails = [];

const r2 = (n) => Math.round(n * 100) / 100;

function tpEq(got, exp) {
  if (!Array.isArray(got) || !Array.isArray(exp) || got.length !== exp.length) return false;
  for (let i = 0; i < exp.length; i++) {
    if (r2(got[i].multiple) !== r2(exp[i].multiple)) return false;
    if (got[i].sellPct !== exp[i].sellPct) return false;
  }
  return true;
}
function slEq(got, exp) {
  if (exp === null) return got === null || got === undefined;
  if (!got) return false;
  return r2(got.multiple) === r2(exp.multiple);
}

// expect = null  -> parseStrategyGoal should return null (not a strategy)
// otherwise { workflow, tp:[{multiple,sellPct}], sl:{multiple}|null }
function check(goal, expect) {
  const p = parseStrategyGoal(goal);
  let ok = true, why = '';
  if (expect === null) {
    ok = (p === null);
    if (!ok) why = `expected null, got workflow=${p && p.workflow}`;
  } else {
    if (!p) { ok = false; why = 'got null'; }
    else {
      if (p.workflow !== expect.workflow) { ok = false; why = `workflow ${p.workflow} != ${expect.workflow}`; }
      const tp = (p.tpsl && p.tpsl.takeProfit) || [];
      const sl = (p.tpsl && p.tpsl.stopLoss) || null;
      if (ok && !tpEq(tp, expect.tp)) { ok = false; why = `tp ${JSON.stringify(tp)} != ${JSON.stringify(expect.tp)}`; }
      if (ok && !slEq(sl, expect.sl)) { ok = false; why = `sl ${JSON.stringify(sl)} != ${JSON.stringify(expect.sl)}`; }
    }
  }
  if (ok) { pass++; }
  else { fail++; fails.push(`  ✗ "${goal}"\n      ${why}`); }
}

// extractTakeProfitRungs unit checks (pure, no curve needed)
function checkRungs(text, exp) {
  const got = extractTakeProfitRungs(text);
  const ok = tpEq(got, exp);
  if (ok) { pass++; }
  else { fail++; fails.push(`  ✗ rungs("${text}")\n      got ${JSON.stringify(got)} != ${JSON.stringify(exp)}`); }
}

// ── 3. Cases ───────────────────────────────────────────────────────────────

// -- Original-style: explicit "+N%" take-profit, keyword stop-loss --
check(`${CURVE} take profit at +20%`,                 { workflow: 'tpsl', tp: [{ multiple: 1.20, sellPct: 100 }], sl: null });
check(`${CURVE} take profit at +20% sell 50%`,        { workflow: 'tpsl', tp: [{ multiple: 1.20, sellPct: 50 }],  sl: null });
check(`${CURVE} dump all at +20%`,                    { workflow: 'tpsl', tp: [{ multiple: 1.20, sellPct: 100 }], sl: null });
check(`${CURVE} sell 50% at +30%`,                    { workflow: 'tpsl', tp: [{ multiple: 1.30, sellPct: 50 }],  sl: null });
check(`${CURVE} sell 50% at +10% and sell all at +20%`, { workflow: 'tpsl', tp: [{ multiple: 1.10, sellPct: 50 }, { multiple: 1.20, sellPct: 100 }], sl: null });
check(`${CURVE} take profit +15% stop loss -10%`,     { workflow: 'tpsl', tp: [{ multiple: 1.15, sellPct: 100 }], sl: { multiple: 0.90 } });
check(`${CURVE} stop loss at -15%`,                   { workflow: 'tpsl', tp: [], sl: { multiple: 0.85 } });
check(`${CURVE} tp +50%`,                             { workflow: 'tpsl', tp: [{ multiple: 1.50, sellPct: 100 }], sl: null });

// -- Compound: buy then arm TP/SL --
check(`buy 500 sui of ${CURVE}, take profit at +20% sell all`, { workflow: 'buy_then_tpsl', tp: [{ multiple: 1.20, sellPct: 100 }], sl: null });
check(`buy 5 sui of ${CURVE} tp +5% sell all`,        { workflow: 'buy_then_tpsl', tp: [{ multiple: 1.05, sellPct: 100 }], sl: null });

// -- Not a strategy: should return null --
check(`${CURVE} sell all`,                            null);
check(`${CURVE} buy 10 sui`,                          null);
check(`buy 10 sui of ${CURVE}`,                       null);
check(`${CURVE}`,                                     null);
check(`just sell it`,                                 null);

// -- NEW: bare "to/at N%" arms take-profit (no + sign) --
check(`${CURVE} tp 5% sell all`,                      { workflow: 'tpsl', tp: [{ multiple: 1.05, sellPct: 100 }], sl: null });
check(`${CURVE} to 5% sell all`,                      { workflow: 'tpsl', tp: [{ multiple: 1.05, sellPct: 100 }], sl: null });
check(`${CURVE} at 5% sell all`,                      { workflow: 'tpsl', tp: [{ multiple: 1.05, sellPct: 100 }], sl: null });
check(`sell all of ${CURVE} at 5%`,                   { workflow: 'tpsl', tp: [{ multiple: 1.05, sellPct: 100 }], sl: null });
check(`sell all of ${CURVE} to 5%`,                   { workflow: 'tpsl', tp: [{ multiple: 1.05, sellPct: 100 }], sl: null });
check(`${CURVE} sell 50% at 10% and sell all at 20%`, { workflow: 'tpsl', tp: [{ multiple: 1.10, sellPct: 50 }, { multiple: 1.20, sellPct: 100 }], sl: null });
check(`${CURVE} sell 50% at 10%`,                     { workflow: 'tpsl', tp: [{ multiple: 1.10, sellPct: 50 }], sl: null });

// -- NEW: stop-loss requires explicit keyword; accepts to/at/by --
check(`${CURVE} stop loss at 5%`,                     { workflow: 'tpsl', tp: [], sl: { multiple: 0.95 } });
check(`${CURVE} sl 5%`,                               { workflow: 'tpsl', tp: [], sl: { multiple: 0.95 } });
check(`${CURVE} stop loss to 10%`,                    { workflow: 'tpsl', tp: [], sl: { multiple: 0.90 } });
check(`${CURVE} sell all at 10%, stop loss at 5%`,    { workflow: 'tpsl', tp: [{ multiple: 1.10, sellPct: 100 }], sl: { multiple: 0.95 } });

// -- NEW: compound buy + bare-percent TP --
check(`buy 5 sui of ${CURVE} to 5% sell all`,         { workflow: 'buy_then_tpsl', tp: [{ multiple: 1.05, sellPct: 100 }], sl: null });

// -- NEW: bare minus with NO stop-loss keyword arms neither (keyword required) --
check(`${CURVE} sell all at -5%`,                     null);

// -- extractTakeProfitRungs pure unit checks --
checkRungs('to 5% sell all',                          [{ multiple: 1.05, sellPct: 100 }]);
checkRungs('sell 50% at 10% and sell all at 20%',     [{ multiple: 1.10, sellPct: 50 }, { multiple: 1.20, sellPct: 100 }]);
checkRungs('stop loss at 5%',                         []);   // SL keyword clause excluded
checkRungs('sell all at -5%',                         []);   // explicit minus excluded
checkRungs('take profit at +20% sell 50%',            [{ multiple: 1.20, sellPct: 50 }]);

// ── 4. Summary ───────────────────────────────────────────────────────────────
rmSync(tmp, { recursive: true, force: true });

console.log('');
if (fails.length) {
  console.log(fails.join('\n'));
  console.log('');
}
const total = pass + fail;
console.log(`parseStrategyGoal: ${pass}/${total} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
