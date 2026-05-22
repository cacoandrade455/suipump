#!/usr/bin/env bash
set -euo pipefail

# Render runs the start command from the repo root (or the configured rootDir).
# This script lives in suipump-nexus-tools/. We cd into our own directory so
# relative paths in the config work.

cd "$(dirname "$0")"

# ── Required env vars (set on Render dashboard) ─────────────────────────────
#   TOOL_SIGNING_KEY              64-char hex Ed25519 private key (secret)
#   SUI_PRIVATE_KEY               agent's Sui private key (existing)
#   SUIPUMP_BRIDGE_URL            bridge URL (existing)
#
# Optional (with defaults):
#   NEXUS_TOOLKIT_CONFIG_PATH     rendered config output path
#                                 (default: ./nexus_toolkit_config.json)

if [ -z "${TOOL_SIGNING_KEY:-}" ]; then
  echo "FATAL: TOOL_SIGNING_KEY env var not set" >&2
  exit 1
fi

if [ ! -f ./allowed_leaders.json ]; then
  echo "FATAL: allowed_leaders.json not found in $(pwd)" >&2
  exit 1
fi

if [ ! -f ./nexus_toolkit_config.template.json ]; then
  echo "FATAL: nexus_toolkit_config.template.json not found in $(pwd)" >&2
  exit 1
fi

OUT="${NEXUS_TOOLKIT_CONFIG_PATH:-$(pwd)/nexus_toolkit_config.json}"

# Render the rendered config — substitute the placeholder. Don't echo the key.
sed "s/__TOOL_SIGNING_KEY__/${TOOL_SIGNING_KEY}/g" \
    ./nexus_toolkit_config.template.json > "$OUT"

# Ensure the toolkit can find the rendered config (in case caller didn't set it)
export NEXUS_TOOLKIT_CONFIG_PATH="$OUT"

echo "Nexus toolkit config rendered to $OUT"
echo "allowed_leaders.json present: $(wc -c < ./allowed_leaders.json) bytes"
echo "Starting suipump-tools binary..."

# Hand off to the actual binary. Render builds it to target/release/.
# The binary listens on the port set by Render's PORT env var if Cargo.toml
# uses it; if not, falls back to 8080 (matches main.rs bootstrap).
exec ./target/release/suipump-tools
