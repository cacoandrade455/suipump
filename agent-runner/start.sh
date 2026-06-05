#!/usr/bin/env bash
set -euo pipefail

# start.sh — Render START command for the agent-runner service.
# Configures the Nexus CLI headless from env vars, then launches server.js.
#
# Required env vars (set on Render dashboard):
#   SUI_PRIVATE_KEY   base64WithFlag Sui private key of the Nexus invoker wallet
#                     (the SAME wallet whose Nexus gas budget is funded, and the
#                     same address used to register the tools / fund the vault).
#   NEXUS_DAG_ID      the published DAG object id to execute.
#
# Optional:
#   SUI_RPC_URL       default https://fullnode.testnet.sui.io
#   PORT              provided by Render automatically.

cd "$(dirname "$0")"

RPC_URL="${SUI_RPC_URL:-https://fullnode.testnet.sui.io}"
OBJECTS="$HOME/.nexus/objects.testnet.toml"

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

echo "[start] configuring nexus CLI (network=testnet)…"
nexus conf set \
  --sui.rpc-url "$RPC_URL" \
  --nexus.objects "$OBJECTS"

# Set the invoker private key. The Nexus CLI accepts the base64WithFlag form
# (same format as SUI_PRIVATE_KEY used elsewhere). Don't echo the key.
nexus conf set --sui.pk "$SUI_PRIVATE_KEY" >/dev/null 2>&1 || {
  echo "FATAL: nexus conf set --sui.pk failed (check SUI_PRIVATE_KEY format)" >&2
  exit 1
}

echo "[start] nexus configured. Launching agent-runner server…"
exec node server.js
