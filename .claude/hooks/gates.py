#!/usr/bin/env python3
"""SuiPump PostToolUse gate - runs after every Edit/Write/MultiEdit.

Reads the hook event JSON from stdin, extracts the edited file path, and gates it:
  .js  -> acorn ES2023 syntax parse + strict ASCII check
  .jsx -> esbuild parse (jsx loader)
  both -> truncated on-chain identifier check (0x....... with '...')
Exit 0 = clean/skip. Exit 2 = FAIL: stderr is fed back to Claude so it fixes the
file immediately. Any unexpected internal error exits 0 (never wedge the session).
"""
import json, re, subprocess, sys, os

def run(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120)

def fail(msg):
    sys.stderr.write(msg.strip() + "\n")
    sys.exit(2)

def main():
    try:
        event = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    ti = event.get("tool_input") or {}
    path = ti.get("file_path") or ti.get("path") or ""
    if not path or not os.path.isfile(path):
        sys.exit(0)
    low = path.lower()
    if not (low.endswith(".js") or low.endswith(".jsx")):
        sys.exit(0)

    try:
        with open(path, "rb") as f:
            raw = f.read()
    except Exception:
        sys.exit(0)

    # Truncated on-chain identifier gate (applies to both .js and .jsx)
    text = raw.decode("utf-8", errors="replace")
    trunc = re.findall(r"0x[0-9a-fA-F]{4,60}\.\.\.", text)
    if trunc:
        fail(f"GATE FAIL {path}: truncated on-chain identifier(s) {trunc[:3]} - "
             "write the FULL 66-char string everywhere (CLAUDE.md hard rule 4).")

    if low.endswith(".js"):
        # Strict ASCII for .js
        bad = [i + 1 for i, line in enumerate(raw.splitlines()) if any(b > 127 for b in line)]
        if bad:
            fail(f"GATE FAIL {path}: non-ASCII bytes on line(s) {bad[:10]} - "
                 ".js sources must be pure ASCII (CLAUDE.md hard rule 14).")
        r = run(f'npx --yes acorn --ecma2023 --module --silent "{path}"')
        if r.returncode != 0:
            fail(f"GATE FAIL {path}: acorn ES2023 parse error:\n"
                 f"{(r.stderr or r.stdout)[:2000]}\nFix the syntax now.")
    else:
        r = run(f'npx --yes esbuild "{path}" --loader:.jsx=jsx --log-level=error')
        if r.returncode != 0:
            fail(f"GATE FAIL {path}: esbuild JSX parse error:\n"
                 f"{(r.stderr or r.stdout)[:2000]}\nFix the syntax now.")
    sys.exit(0)

try:
    main()
except SystemExit:
    raise
except Exception:
    sys.exit(0)
