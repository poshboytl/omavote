#!/usr/bin/env bash
# End-to-end demo on the local dev chain: builds omavote, writes a devnet
# configuration with fresh relay/receipt keys, starts the server with an embedded
# relay, runs `omavote demo --reorg-test` and an independent `omavote verify`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${DEVNET_DIR:-$ROOT/devnet}"
RPC="http://127.0.0.1:${RPC_PORT:-18114}"
API_PORT="${API_PORT:-18080}"
cd "$ROOT"
cargo build --release -p omavote
BIN="$ROOT/target/release/omavote"

cd "$DIR"
# Dev chain key 1 (public, dev chains only): pays deposits and funds the relay.
[ -f faucet.key ] || { echo 0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc > faucet.key; chmod 600 faucet.key; }
[ -f relay.key ] || "$BIN" keygen relay.key
[ -f receipt.key ] || "$BIN" keygen receipt.key
"$BIN" demo-roles --rpc "$RPC" > roles.json
cat > omavote.toml <<TOML
[node]
rpc = "$RPC"
poll_interval_ms = 500

[network]
# Declared identity so EVM owners can be exercised (the lock is never executed here).
omnilock = { code_hash = "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb", hash_type = "type" }

[protocol]
initial_roles_file = "roles.json"

[server]
listen = "127.0.0.1:$API_PORT"
database = "omavote.sqlite"
web_root = "$ROOT/web/dist"
receipt_key_file = "receipt.key"

[relay]
embedded = true
key_file = "relay.key"
interval_ms = 1000
confirmations = 3
TOML

"$BIN" serve --config omavote.toml > server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$API_PORT/api/status" >/dev/null && break; sleep 1; done

"$BIN" demo --rpc "$RPC" --api "http://127.0.0.1:$API_PORT" --faucet-key faucet.key --reorg-test --out-dir demo-out
POLL=$(python3 -c 'import json;print(json.load(open("demo-out/summary.json"))["poll_id"])')
"$BIN" verify --rpc "$RPC" --poll "$POLL" --network-overrides <(printf 'omnilock = { code_hash = "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb", hash_type = "type" }\n') \
  --initial-roles-hash "$(python3 -c 'import json;print(json.load(open("demo-out/bundle.json"))["initial_roles_hash"])')" \
  --check-clock --out demo-out/verify-bundle.json > demo-out/verify.json
echo "demo finished: see $DIR/demo-out/"
