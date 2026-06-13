#!/usr/bin/env bash
set -euo pipefail

# start.sh — Render START command for the agent-runner service.
# Configures the Nexus CLI headless from env vars, launches the strategy brain
# (background), then launches server.js (foreground, owns the Render port).
#
# Required env vars (Render dashboard):
#   SUI_PRIVATE_KEY   base64WithFlag Sui private key of the Nexus invoker wallet
#   NEXUS_DAG_ID      the published DAG object id to execute
# Optional:
#   SUI_RPC_URL       default https://fullnode.testnet.sui.io
#   PORT              provided by Render
#   STRATEGY_ENABLED  set to "0" to skip launching strategy.js (default on)
#   STRATEGY_ORDERS   JSON array of strategy orders (TP/SL ladders)

cd "$(dirname "$0")"

# Prebuilt nexus binary installed by build.sh into ./bin — put it on PATH.
export PATH="$(pwd)/bin:$PATH"

RPC_URL="${SUI_RPC_URL:-https://fullnode.testnet.sui.io}"
# Objects live in the project dir (preserved from build), not $HOME.
OBJECTS="$(pwd)/objects.testnet.toml"

if [ -z "${SUI_PRIVATE_KEY:-}" ]; then
  echo "FATAL: SUI_PRIVATE_KEY not set" >&2
  exit 1
fi
if [ ! -f "$OBJECTS" ]; then
  echo "FATAL: $OBJECTS missing — build step did not fetch Nexus objects" >&2
  exit 1
fi
if ! command -v nexus >/dev/null 2>&1; then
  echo "FATAL: nexus CLI not on PATH — build step did not install it" >&2
  exit 1
fi

echo "[start] nexus: $(command -v nexus) ($(nexus --version 2>/dev/null || echo '?'))"
echo "[start] configuring nexus CLI (network=testnet)…"
nexus conf set \
  --sui.rpc-url "$RPC_URL" \
  --nexus.objects "$OBJECTS"

nexus conf set --sui.pk "$SUI_PRIVATE_KEY" >/dev/null 2>&1 || {
  echo "FATAL: nexus conf set --sui.pk failed (check SUI_PRIVATE_KEY format)" >&2
  exit 1
}

# Strategy brain — separate process, no secrets, talks to server.js over
# localhost. If it crashes it CANNOT take down /run-dag (server.js is exec'd
# below and owns the port). Set STRATEGY_ENABLED=0 to disable.
if [ "${STRATEGY_ENABLED:-1}" != "0" ]; then
  echo "[start] launching strategy brain (background)…"
  node strategy.js &
else
  echo "[start] strategy brain disabled (STRATEGY_ENABLED=0)"
fi

echo "[start] nexus configured. Launching agent-runner server…"
exec node server.js
