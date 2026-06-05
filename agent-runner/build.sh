#!/usr/bin/env bash
set -euo pipefail

# build.sh — Render BUILD command for the agent-runner service.
# Installs the Nexus CLI and downloads the testnet Nexus object set into the
# PROJECT directory (preserved into the runtime), not $HOME (which differs
# between Render's build and run phases).

cd "$(dirname "$0")"

echo "[build] installing nexus CLI (v1.0.0)…"
cargo install nexus-cli \
  --git https://github.com/talus-network/nexus-sdk \
  --tag v1.0.0 \
  --locked

echo "[build] nexus version:"
nexus --version || { echo "[build] FATAL: nexus not on PATH after install"; exit 1; }

echo "[build] downloading testnet Nexus objects into project dir…"
wget -q -O ./objects.testnet.toml \
  https://storage.googleapis.com/production-talus-sui-objects/v1.0.0/objects.testnet.toml

echo "[build] objects.testnet.toml: $(wc -c < ./objects.testnet.toml) bytes at $(pwd)/objects.testnet.toml"
echo "[build] done."
