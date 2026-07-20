// Pre-commit gate for the suipump repo.
//
// Validates STAGED content only (git show :<path>), never the worktree copy:
//   a. .js/.mjs        -> acorn parse (ecmaVersion 2023, sourceType module)
//   b. .jsx            -> esbuild transformSync (loader jsx)
//   c. ASCII purity    -> any code point >127 fails, except inside ''/""/``
//                         string literals and rendered JSX text in .jsx files
//                         (rendered UI glyphs); comments must be ASCII
//                         everywhere
//   d. JSON-RPC tripwire on .js/.mjs/.jsx/.cjs/.ts/.tsx (banned legacy client
//      identifiers and the banned JSON-RPC import specifier)
//
// Exit 1 with every failure printed; exit 0 quietly on success.
// Invoked by .githooks/pre-commit (git config core.hooksPath .githooks).

import { execFileSync } from 'node:child_process';
import { parse } from 'acorn';
import { transformSync } from 'esbuild';

const SOURCE_EXTS = ['.js', '.mjs', '.jsx', '.cjs', '.ts', '.tsx'];

// Banned tokens are assembled from fragments so this gate never trips on its
// own staged source.
const BANNED_IDENTIFIERS = [
  'Sui' + 'Client',
  'get' + 'Fullnode' + 'Url',
  'Sui' + 'JsonRpc' + 'Client',
  'get' + 'JsonRpc' + 'Fullnode' + 'Url',
];
const BANNED_IMPORT_PATH = '@mysten' + '/sui' + '/client';

const TRIPWIRE_PATTERNS = [
  {
    // The quoted specifier anywhere: import ... from, require(), import().
    re: new RegExp("['\"]" + BANNED_IMPORT_PATH.replace(/\//g, '\\/') + "['\"]"),
    label: "banned import path '" + BANNED_IMPORT_PATH + "'",
  },
  ...BANNED_IDENTIFIERS.map((id) => ({
    re: new RegExp('\\b' + id + '\\b'),
    label: 'banned identifier ' + id,
  })),
];

function git(args, opts = {}) {
  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024, ...opts });
}

function extOf(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

function stagedFiles() {
  const out = git(
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { encoding: 'utf8' }
  );
  return out.split('\0').filter(Boolean);
}

function stagedBytes(path) {
  try {
    return git(['show', ':' + path]);
  } catch {
    return null; // unreadable index entry (e.g. submodule) - skip gracefully
  }
}

function isBinary(buf) {
  const probe = Math.min(buf.length, 8192);
  for (let i = 0; i < probe; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function hexCp(cp) {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

// Strict ASCII scan (.js/.mjs/.cjs/.ts/.tsx): every code point >127 fails.
function strictAsciiViolations(text) {
  const violations = [];
  let line = 1;
  for (const ch of text) {
    if (ch === '\n') {
      line++;
      continue;
    }
    const cp = ch.codePointAt(0);
    if (cp > 127) {
      violations.push({ line, msg: 'non-ASCII ' + hexCp(cp) });
    }
  }
  return violations;
}

// Single-pass lexer over .jsx source. Emits every code point >127 tagged with
// the context it sits in: 'string' (''/""/`` literal, template ${} included),
// 'comment' (// or /* */), or 'code' (anything else, which includes JSX text -
// disambiguated afterwards against the esbuild transform output).
function lexNonAscii(text) {
  const out = [];
  const chars = Array.from(text); // iterate by code point, not byte/code unit
  let line = 1;
  let state = 0; // 0 code, 1 ', 2 ", 3 `, 4 line comment, 5 block comment
  let escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '\n') {
      line++;
      if (state === 1 || state === 2 || state === 4) state = 0;
      escaped = false;
      continue;
    }
    const cp = c.codePointAt(0);
    if (state === 1 || state === 2 || state === 3) {
      if (escaped) {
        escaped = false;
        if (cp > 127) out.push({ line, cp, ctx: 'string' });
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (cp > 127) {
        out.push({ line, cp, ctx: 'string' });
        continue;
      }
      if (
        (state === 1 && c === "'") ||
        (state === 2 && c === '"') ||
        (state === 3 && c === '`')
      ) {
        state = 0;
      }
      continue;
    }
    if (state === 4) {
      if (cp > 127) out.push({ line, cp, ctx: 'comment' });
      continue;
    }
    if (state === 5) {
      if (cp > 127) {
        out.push({ line, cp, ctx: 'comment' });
        continue;
      }
      if (c === '*' && chars[i + 1] === '/') {
        state = 0;
        i++;
      }
      continue;
    }
    // code
    if (cp > 127) {
      out.push({ line, cp, ctx: 'code' });
      continue;
    }
    if (c === '/' && chars[i + 1] === '/') {
      state = 4;
      i++;
      continue;
    }
    if (c === '/' && chars[i + 1] === '*') {
      state = 5;
      i++;
      continue;
    }
    if (c === "'") state = 1;
    else if (c === '"') state = 2;
    else if (c === '`') state = 3;
  }
  return out;
}

// Per-code-point counts of non-ASCII characters that end up inside string or
// template literals of the transformed (JSX-free) code. esbuild lowers JSX
// text children and attribute values into plain string literals and strips
// comments, so this is exactly the set of rendered characters. Decoded values
// (Literal.value / TemplateElement.value.cooked) are used so esbuild's
// \uXXXX escaping cannot hide characters from the count.
function renderedCharCounts(code) {
  let ast;
  try {
    ast = parse(code, { ecmaVersion: 2023, sourceType: 'module' });
  } catch {
    return new Map(); // fall back to strict treatment of 'code' occurrences
  }
  const counts = new Map();
  const count = (str) => {
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp > 127) counts.set(cp, (counts.get(cp) || 0) + 1);
    }
  };
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (typeof node.type !== 'string') return;
    if (node.type === 'Literal' && typeof node.value === 'string') {
      count(node.value);
    } else if (node.type === 'TemplateElement') {
      if (node.value && typeof node.value.cooked === 'string') count(node.value.cooked);
    }
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      visit(node[key]);
    }
  };
  visit(ast);
  return counts;
}

// .jsx ASCII check. String-literal occurrences are always allowed. Comment
// occurrences always fail. 'code' occurrences are allowed only when they are
// accounted for by a rendered string in the transformed output (i.e. they are
// JSX text); non-ASCII in identifiers or operators never survives into a
// string literal, so it fails.
function jsxAsciiViolations(text, transformedCode) {
  const occurrences = lexNonAscii(text);
  if (occurrences.length === 0) return [];
  const budget = transformedCode == null ? new Map() : renderedCharCounts(transformedCode);
  const take = (cp) => {
    const n = budget.get(cp) || 0;
    if (n <= 0) return false;
    budget.set(cp, n - 1);
    return true;
  };
  // String-literal occurrences consume their share of the rendered budget
  // first so JSX-text accounting stays exact.
  for (const o of occurrences) {
    if (o.ctx === 'string') take(o.cp);
  }
  const violations = [];
  for (const o of occurrences) {
    if (o.ctx === 'string') continue;
    if (o.ctx === 'comment') {
      violations.push({ line: o.line, msg: 'non-ASCII ' + hexCp(o.cp) + ' in a comment' });
      continue;
    }
    if (take(o.cp)) continue; // JSX text - rendered UI glyph
    violations.push({
      line: o.line,
      msg: 'non-ASCII ' + hexCp(o.cp) + ' outside string literals / JSX text',
    });
  }
  return violations;
}

function checkFile(path, buf, failures) {
  const ext = extOf(path);
  if (!SOURCE_EXTS.includes(ext)) return;
  if (isBinary(buf)) return;

  const text = buf.toString('utf8');
  const lines = text.split('\n');

  // a. acorn parse for .js/.mjs
  if (ext === '.js' || ext === '.mjs') {
    try {
      parse(text, { ecmaVersion: 2023, sourceType: 'module' });
    } catch (err) {
      const loc = err.loc ? ':' + err.loc.line : '';
      failures.push(path + loc + ' acorn parse failed: ' + err.message);
    }
  }

  // b. esbuild jsx transform for .jsx (output reused by the ASCII check)
  let jsxCode = null;
  if (ext === '.jsx') {
    try {
      jsxCode = transformSync(text, { loader: 'jsx' }).code;
    } catch (err) {
      const first = err.errors && err.errors[0];
      const loc = first && first.location ? ':' + first.location.line : '';
      const msg = first ? first.text : err.message;
      failures.push(path + loc + ' esbuild jsx transform failed: ' + msg);
    }
  }

  // c. ASCII purity
  const asciiViolations =
    ext === '.jsx' ? jsxAsciiViolations(text, jsxCode) : strictAsciiViolations(text);
  for (const v of asciiViolations) {
    failures.push(path + ':' + v.line + ' ' + v.msg);
  }

  // d. JSON-RPC tripwire
  for (let i = 0; i < lines.length; i++) {
    for (const p of TRIPWIRE_PATTERNS) {
      if (p.re.test(lines[i])) {
        failures.push(
          path + ':' + (i + 1) + ' JSON-RPC tripwire (' + p.label + '): ' +
          lines[i].trim()
        );
      }
    }
  }
}

function main() {
  const root = git(['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  process.chdir(root);

  const failures = [];
  for (const path of stagedFiles()) {
    if (path.split('/').includes('node_modules')) continue;
    const buf = stagedBytes(path);
    if (buf == null) continue;
    checkFile(path, buf, failures);
  }

  if (failures.length > 0) {
    console.error('pre-commit gate: ' + failures.length + ' failure(s)');
    for (const f of failures) console.error('  FAIL ' + f);
    process.exit(1);
  }
  process.exit(0);
}

main();
