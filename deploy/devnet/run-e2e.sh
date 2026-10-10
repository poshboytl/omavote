#!/usr/bin/env bash
# Browser end-to-end test of the web UI on the local dev chain (Playwright, Chromium),
# on a desktop viewport and on a Pixel 7, then with the Omavote signer extension
# (its devnet build loaded unpacked), one after the other.
#
# Needs the dev chain from deploy/devnet/setup.sh (node and miner, RPC 127.0.0.1:18114).
# Each run starts its own servers on 127.0.0.1:18090 (primary) and :18091 (backup)
# with fresh databases and keys, and writes devnet/e2e-out/<run>/ (report.json,
# screenshots, server logs, a Playwright trace on failure).
#
# Usage: deploy/devnet/run-e2e.sh [desktop] [mobile] [extension]   (default: all three)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RPC="${RPC:-http://127.0.0.1:18114}"
cd "$ROOT"

curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"get_tip_header","params":[]}' "$RPC" >/dev/null \
  || { echo "no dev chain at $RPC: start it with deploy/devnet/setup.sh" >&2; exit 2; }
mkdir -p devnet
# Dev chain key 1 (public, dev chains only): pays the deposits and funds the relays.
[ -f devnet/faucet.key ] || { echo 0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc > devnet/faucet.key; chmod 600 devnet/faucet.key; }

cargo build -p omavote
(cd web && { [ -d node_modules ] || npm ci; } && npm run wasm && npm run build)
(cd verifier-ts && { [ -d node_modules ] || npm ci; } && npm run build)
# The extension mode builds extension/dist-devnet against its own server.
(cd extension && { [ -d node_modules ] || npm ci; } && npm run wasm)
# Uses the browser cache when Chromium is already installed.
(cd web && npx playwright install chromium >/dev/null 2>&1) || echo "note: 'playwright install chromium' failed; using the cached browser" >&2

MODES=("$@")
[ ${#MODES[@]} -gt 0 ] || MODES=(desktop mobile extension)
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
status=0
for mode in "${MODES[@]}"; do
  echo "=== e2e $mode"
  if DEVICE="$mode" RUN_ID="$STAMP-$mode" RPC="$RPC" node web/e2e/devnet-e2e.mjs; then
    echo "=== e2e $mode: PASS"
  else
    echo "=== e2e $mode: FAIL"
    status=1
  fi
done
echo "reports: devnet/e2e-out/$STAMP-*/report.json"
exit $status
