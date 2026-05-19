#!/usr/bin/env python3
"""
patch_tokenpage_v8.py
Applies the two V8 changes to frontend-app/src/TokenPage.jsx:

  1. Flip METADATA_UPDATE_ENABLED = false  →  true
  2. Update resolvePackageId() to recognise PACKAGE_ID_V8
  3. Update metadataPkg reference — V8 tokens use PACKAGE_ID_V8

Run from the repo root:
  python scripts/patch_tokenpage_v8.py

Then commit:
  git add frontend-app/src/TokenPage.jsx
  git commit -m "feat: enable update_metadata for V8 tokens (V8 contract live)"
  git push
"""
import re, pathlib, sys

target = pathlib.Path("frontend-app/src/TokenPage.jsx")
if not target.exists():
    sys.exit(f"ERROR: {target} not found — run from repo root.")

src = target.read_text(encoding="utf-8")
original = src

# ── Patch 1: flip METADATA_UPDATE_ENABLED ────────────────────────────────────
OLD_FLAG = "  const METADATA_UPDATE_ENABLED = false;"
NEW_FLAG = "  const METADATA_UPDATE_ENABLED = true;"
if OLD_FLAG not in src:
    print("WARN: METADATA_UPDATE_ENABLED = false not found — already patched or different whitespace.")
else:
    src = src.replace(OLD_FLAG, NEW_FLAG, 1)
    print("✓ Flipped METADATA_UPDATE_ENABLED to true")

# ── Patch 2: update the metadata tab visibility guard ────────────────────────
# Old:  (isV6Token || isV7Token)
# New:  (isV6Token || isV7Token || isV8Token)
# We also need isV8Token to be defined. Find where isV7Token is defined and add it.
OLD_V7_TOKEN_LINE = "  const isV7Token = isV7OrLater(pkgId);"
NEW_V7_TOKEN_LINE = (
    "  const isV7Token = isV7OrLater(pkgId);\n"
    "  // V8+ tokens have shared (not frozen) CoinMetadata — update_metadata works\n"
    "  const isV8Token = isV8OrLater(pkgId);"
)
if OLD_V7_TOKEN_LINE not in src:
    print("WARN: isV7Token definition not found — skipping isV8Token addition.")
else:
    src = src.replace(OLD_V7_TOKEN_LINE, NEW_V7_TOKEN_LINE, 1)
    print("✓ Added isV8Token = isV8OrLater(pkgId)")

# ── Patch 3: update metadataPkg to resolve V8 package ────────────────────────
# Old:  const metadataPkg = PACKAGE_ID_V7;
# New:  const metadataPkg = isV8Token ? PACKAGE_ID_V8 : PACKAGE_ID_V7;
OLD_META_PKG = "  const metadataPkg = PACKAGE_ID_V7;"
NEW_META_PKG = "  const metadataPkg = isV8Token ? PACKAGE_ID_V8 : PACKAGE_ID_V7;"
if OLD_META_PKG not in src:
    print("WARN: metadataPkg assignment not found — skipping.")
else:
    src = src.replace(OLD_META_PKG, NEW_META_PKG, 1)
    print("✓ Updated metadataPkg to dispatch V8 vs V7")

# ── Patch 4: extend tab visibility guard ────────────────────────────────────
OLD_TAB_GUARD = "(METADATA_UPDATE_ENABLED && (isV6Token || isV7Token))"
NEW_TAB_GUARD = "(METADATA_UPDATE_ENABLED && (isV6Token || isV7Token || isV8Token))"
if OLD_TAB_GUARD not in src:
    print("WARN: tab visibility guard not found — skipping.")
else:
    src = src.replace(OLD_TAB_GUARD, NEW_TAB_GUARD, 1)
    print("✓ Extended metadata tab guard to include isV8Token")

# ── Patch 5: update resolvePackageId to recognise V8 ────────────────────────
OLD_RESOLVE = (
    "  if (PACKAGE_ID_V7 && tokenType.startsWith(PACKAGE_ID_V7)) return PACKAGE_ID_V7;"
)
NEW_RESOLVE = (
    "  if (PACKAGE_ID_V8 && tokenType.startsWith(PACKAGE_ID_V8)) return PACKAGE_ID_V8;\n"
    "  if (PACKAGE_ID_V7 && tokenType.startsWith(PACKAGE_ID_V7)) return PACKAGE_ID_V7;"
)
if OLD_RESOLVE not in src:
    print("WARN: resolvePackageId V7 line not found — skipping V8 insertion.")
else:
    src = src.replace(OLD_RESOLVE, NEW_RESOLVE, 1)
    print("✓ Added PACKAGE_ID_V8 to resolvePackageId()")

# Also fix the packageIdHint branch
OLD_HINT = "    if (PACKAGE_ID_V7 && packageIdHint === PACKAGE_ID_V7) return PACKAGE_ID_V7;"
NEW_HINT = (
    "    if (PACKAGE_ID_V8 && packageIdHint === PACKAGE_ID_V8) return PACKAGE_ID_V8;\n"
    "    if (PACKAGE_ID_V7 && packageIdHint === PACKAGE_ID_V7) return PACKAGE_ID_V7;"
)
if OLD_HINT not in src:
    print("WARN: packageIdHint V7 branch not found — skipping.")
else:
    src = src.replace(OLD_HINT, NEW_HINT, 1)
    print("✓ Added PACKAGE_ID_V8 to resolvePackageId() hint branch")

# ── Write result ─────────────────────────────────────────────────────────────
if src == original:
    print("\nNo changes made — file may already be patched.")
else:
    target.write_text(src, encoding="utf-8")
    print(f"\n✅ Patched {target}")
    print("\nNext steps:")
    print("  git add frontend-app/src/TokenPage.jsx")
    print('  git commit -m "feat: enable update_metadata for V8 tokens"')
    print("  git push")
