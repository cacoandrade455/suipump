// parseStrategyGoal.test.mjs — test suite for the client-side TP/SL strategy
// parser in AgentPage.jsx (extractTakeProfitRungs + parseStrategyGoal).
//
// AgentPage.jsx is JSX with React imports, so we transpile + tree-shake it with
// esbuild into a temp ESM module that exposes ONLY the two exported pure
// functions, then import and assert against them. No browser, no React runtime.
//
// Run:  node parseStrategyGoal.test.mjs
// Requires esbuild on PATH (npx esbuild) — already used by the build.
//
// RULE: tests encode the parser CONTRACT. Change the parser to fit these tests,
// never the reverse. Add cases for new behavior; do not weaken existing ones.

import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'AgentPage.jsx');
const dir = mkdtempSync(join(tmpdir(), 'pstest-'));
const entry = join(dir, 'entry.js');
const out = join(dir, 'bundle.mjs');

// Re-export only the two pure functions, so the bundle drops React/dapp-kit.
writeFileSync(entry, `export { extractTakeProfitRungs, parseStrategyGoal } from '${SRC.replace(/\\/g, '/')}';\n`);
// Stub the UI imports to an empty module: the two functions under test are pure
// and never touch React/dapp-kit, but the file imports them at top level. Alias
// each to an empty stub so the bundle is self-contained and node can import it.
const stub = join(dir, 'stub.js');
writeFileSync(stub, 'export default {}; export const x = {};\nexport function useState(){}; export function useCallback(){}; export function useRef(){}; export function useEffect(){}; export function useNavigate(){}; export function useCurrentAccount(){}; export const SuiGraphQLClient = class {};\nexport const ArrowLeft={},Sparkles={},Play={},Check={},X={},Loader={},ExternalLink={},Bot={},ChevronDown={};\n');
const sp = stub.replace(/\\/g, '/');
execSync(`npx --yes esbuild "${entry}" --bundle --format=esm --platform=node "--define:import.meta.env={}" --alias:react=${sp} --alias:react-dom=${sp} --alias:react-router-dom=${sp} --alias:lucide-react=${sp} "--alias:@mysten/sui/graphql=${sp}" "--alias:@mysten/dapp-kit-react=${sp}" --outfile="${out}"`, { stdio: 'pipe' });

const mod = await import(out);
const { extractTakeProfitRungs, parseStrategyGoal } = mod;

let pass = 0, fail = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got      ${a}\n       expected ${e}`); }
}

const CA = '0xebcd3f7d99f00c02b7d842153267b31e083bf27e80a395c18914e241dbe57dcd';

// ── extractTakeProfitRungs: rung extraction contract ───────────────────────
console.log('extractTakeProfitRungs:');
eq(extractTakeProfitRungs('take profit at +20%'),
   [{ multiple: 1.2, sellPct: 100 }], 'single +20% defaults to sell 100%');
eq(extractTakeProfitRungs('take profit at +20% sell 50%'),
   [{ multiple: 1.2, sellPct: 50 }], 'single +20% with explicit sell 50%');
eq(extractTakeProfitRungs('dump all at +20%'),
   [{ multiple: 1.2, sellPct: 100 }], 'dump all at +20%');
eq(extractTakeProfitRungs('sell 50% of 0xcurve at +30%'),
   [{ multiple: 1.3, sellPct: 50 }], 'sell 50% at +30%');
eq(extractTakeProfitRungs('take profit at +10% sell 50% and sell all at +20%'),
   [{ multiple: 1.1, sellPct: 50 }, { multiple: 1.2, sellPct: 100 }], 'TWO rungs: 50% @ +10%, all @ +20%');
eq(extractTakeProfitRungs('sell 50% of 0xcurve at +30%, sell the rest at +100%'),
   [{ multiple: 1.3, sellPct: 50 }, { multiple: 2.0, sellPct: 100 }], 'TWO rungs: 50% @ +30%, rest @ +100%');
eq(extractTakeProfitRungs('sell 25% at +10%, sell 25% at +20%, sell all at +50%'),
   [{ multiple: 1.1, sellPct: 25 }, { multiple: 1.2, sellPct: 25 }, { multiple: 1.5, sellPct: 100 }], 'THREE rungs');
eq(extractTakeProfitRungs('take-profit +5% sell all'),
   [{ multiple: 1.05, sellPct: 100 }], 'hyphenated take-profit +5% sell all');
eq(extractTakeProfitRungs('take profit on 0xcurve at +50% and stop loss at -15%'),
   [{ multiple: 1.5, sellPct: 100 }], 'tp+sl: only the +50% rung, -15% ignored');
eq(extractTakeProfitRungs('buy 10 sui of 0xcurve'),
   [], 'plain buy: no rungs');
eq(extractTakeProfitRungs('sell 50% at +10% and sell 50% at +10%'),
   [{ multiple: 1.1, sellPct: 50 }], 'dedup identical rung');

// ── parseStrategyGoal: end-to-end plan shape ───────────────────────────────
console.log('parseStrategyGoal:');
{
  const p = parseStrategyGoal(`take profit on ${CA} at +20%`);
  eq([p.workflow, p.tpsl.takeProfit], ['tpsl', [{ multiple: 1.2, sellPct: 100 }]], 'standing tpsl single rung');
}
{
  const p = parseStrategyGoal(`buy 10 sui of ${CA}, then take profit at +10% sell 50% and sell all at +20%`);
  eq([p.workflow, p.tpsl.takeProfit], ['buy_then_tpsl', [{ multiple: 1.1, sellPct: 50 }, { multiple: 1.2, sellPct: 100 }]], 'buy_then_tpsl TWO rungs (the bug case)');
}
{
  const p = parseStrategyGoal(`take profit on ${CA} at +50% and stop loss at -15%`);
  eq([p.tpsl.takeProfit, p.tpsl.stopLoss], [[{ multiple: 1.5, sellPct: 100 }], { multiple: 0.85 }], 'tp + sl together');
}
{
  const p = parseStrategyGoal('buy 10 sui of nothing here');
  eq(p, null, 'no curve / no strategy word -> null');
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
