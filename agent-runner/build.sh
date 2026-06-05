#!/usr/bin/env bash
set -euo pipefail

# build.sh — Render BUILD command for the agent-runner service.
# Installs the Nexus CLI and downloads the testnet Nexus object set.
# Heavy/slow steps live here (build time) so boot stays fast.
#
# Requires Rust/Cargo in the build image. On Render, set the service's
# "Runtime" to Rust (or use a Docker image with rust+node). If using the
# Node runtime, prepend a rustup install (see README_DEPLOY.md).

echo "[build] installing nexus CLI (v1.0.0)…"
# --locked uses the repo's lockfile; matches your tool deps tag.
cargo install nexus-cli \
  --git https://github.com/talus-network/nexus-sdk \
  --tag v1.0.0 \
  --locked

echo "[build] nexus version:"
nexus --version || { echo "[build] FATAL: nexus not on PATH after install"; exit 1; }

echo "[build] downloading testnet Nexus objects…"
mkdir -p "$HOME/.nexus"
wget -q -O "$HOME/.nexus/objects.testnet.toml" \
  https://storage.googleapis.com/production-talus-sui-objects/v1.0.0/objects.testnet.toml

echo "[build] objects.testnet.toml: $(wc -c < "$HOME/.nexus/objects.testnet.toml") bytes"
echo "[build] done."
