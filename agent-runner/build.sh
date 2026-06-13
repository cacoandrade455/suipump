#!/usr/bin/env bash
set -euo pipefail

# build.sh — Render BUILD command for the agent-runner service.
# Installs the Nexus CLI from a PREBUILT static binary (no Rust compile) and
# downloads the testnet Nexus object set into the PROJECT directory (preserved
# into the runtime), not $HOME (which differs between Render's build and run
# phases).
#
# Previously this compiled the CLI from source with `cargo install --git`,
# which took 10-20 min on every deploy. Talus publishes a static musl Linux
# binary per release, so we just download and extract it — ~10 seconds.

cd "$(dirname "$0")"

NEXUS_VERSION="${NEXUS_VERSION:-1.0.1}"
NEXUS_TARBALL="nexus-cli-${NEXUS_VERSION}-x86_64-unknown-linux-musl.tar.gz"
NEXUS_URL="https://github.com/Talus-Network/nexus-sdk/releases/download/v${NEXUS_VERSION}/${NEXUS_TARBALL}"

# Install into a project-local bin dir that start.sh adds to PATH. Using the
# project dir (not $HOME) keeps it on the persisted side between build and run.
BIN_DIR="$(pwd)/bin"
mkdir -p "$BIN_DIR"

echo "[build] downloading prebuilt nexus CLI v${NEXUS_VERSION} (static musl, no compile)…"
curl -fsSL -o /tmp/nexus-cli.tar.gz "$NEXUS_URL"

echo "[build] extracting…"
tar -xzf /tmp/nexus-cli.tar.gz -C /tmp

# The tarball lays out a `nexus` binary; find it wherever it landed and move it
# into our bin dir (the archive's internal layout has varied across releases).
NEXUS_BIN="$(find /tmp -maxdepth 3 -type f -name nexus -perm -u+x 2>/dev/null | head -n1)"
if [ -z "$NEXUS_BIN" ]; then
  # Fall back: some archives ship the binary without the exec bit set yet.
  NEXUS_BIN="$(find /tmp -maxdepth 3 -type f -name nexus 2>/dev/null | head -n1)"
fi
if [ -z "$NEXUS_BIN" ]; then
  echo "[build] FATAL: 'nexus' binary not found in extracted tarball" >&2
  echo "[build] tarball contents:" >&2
  tar -tzf /tmp/nexus-cli.tar.gz >&2
  exit 1
fi

cp "$NEXUS_BIN" "$BIN_DIR/nexus"
chmod +x "$BIN_DIR/nexus"

echo "[build] nexus installed at $BIN_DIR/nexus"
echo "[build] nexus version:"
"$BIN_DIR/nexus" --version || { echo "[build] FATAL: nexus binary not runnable"; exit 1; }

echo "[build] downloading testnet Nexus objects into project dir…"
wget -q -O ./objects.testnet.toml \
  "https://storage.googleapis.com/production-talus-sui-objects/v${NEXUS_VERSION}/objects.testnet.toml"

echo "[build] objects.testnet.toml: $(wc -c < ./objects.testnet.toml) bytes at $(pwd)/objects.testnet.toml"
echo "[build] done (no compile)."
