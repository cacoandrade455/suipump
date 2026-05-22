#!/usr/bin/env python3
import pathlib, sys

target = pathlib.Path("frontend-app/src/TokenPage.jsx")
src = target.read_text(encoding="utf-8")

# Remove the duplicate block that the patch inserted before the original
BAD = (
    "  const isV8Token = isV8OrLater(pkgId);\n"
    "  // V8+ tokens have shared (not frozen) CoinMetadata — update_metadata works\n"
    "  const isV8Token = isV8OrLater(pkgId);\n"
)
GOOD = (
    "  // V8+ tokens have shared (not frozen) CoinMetadata — update_metadata works\n"
    "  const isV8Token = isV8OrLater(pkgId);\n"
)

if BAD not in src:
    print("Duplicate not found — may already be fixed.")
    sys.exit(0)

src = src.replace(BAD, GOOD, 1)
target.write_text(src, encoding="utf-8")
print("✅ Fixed duplicate isV8Token declaration")
