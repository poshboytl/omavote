#!/usr/bin/env bash
# Start a local CKB development chain for Omavote (Dummy PoW, ~1 block/s).
# Usage: deploy/devnet/setup.sh [DIR]   (default DIR = devnet/ at the repo root)
# Development keys and chains only: never send real funds to these addresses.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${1:-$ROOT/devnet}"
VERSION=v0.210.0
ASSET="ckb_${VERSION}_x86_64-unknown-linux-gnu-portable"
SHA256=f7ea14476229883153eaef2f96aa3ae9e67c6f7254fe642aa06014cc6333d017
RPC_PORT="${RPC_PORT:-18114}"
P2P_PORT="${P2P_PORT:-18115}"
# Dev chain key 1 from the ckb dev spec (publicly known): receives mining rewards.
DEV_ARGS=0xc8328aabcd9b9e8e64fbc566c4385c3bdeb219d7

mkdir -p "$DIR/bin"
if [ ! -x "$DIR/bin/ckb" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/ckb.tar.gz" "https://github.com/nervosnetwork/ckb/releases/download/${VERSION}/${ASSET}.tar.gz"
  echo "$SHA256  $tmp/ckb.tar.gz" | sha256sum -c -
  tar -xzf "$tmp/ckb.tar.gz" -C "$tmp"
  cp "$tmp/$ASSET/ckb" "$DIR/bin/ckb"
  rm -rf "$tmp"
fi

if [ ! -f "$DIR/data/ckb.toml" ]; then
  # A fixed genesis message gives deterministic genesis and dep-group hashes.
  "$DIR/bin/ckb" init -C "$DIR/data" --chain dev --genesis-message ckb_dev \
    --ba-arg "$DEV_ARGS" --ba-hash-type type \
    --rpc-port "$RPC_PORT" --p2p-port "$P2P_PORT" --force
  sed -i 's/^modules = \[\(.*\)\]/modules = [\1, "Indexer", "IntegrationTest"]/' "$DIR/data/ckb.toml"
  sed -i 's/^listen_address = "0.0.0.0:/listen_address = "127.0.0.1:/' "$DIR/data/ckb.toml"
  # The dummy miner delay is in milliseconds.
  sed -i 's/^value = 5000/value = 1000/' "$DIR/data/ckb-miner.toml"
fi

if ! pgrep -f "$DIR/bin/ckb run -C $DIR/data" >/dev/null; then
  nohup "$DIR/bin/ckb" run -C "$DIR/data" > "$DIR/node.log" 2>&1 &
  sleep 3
fi
if ! pgrep -f "$DIR/bin/ckb miner -C $DIR/data" >/dev/null; then
  nohup "$DIR/bin/ckb" miner -C "$DIR/data" > "$DIR/miner.log" 2>&1 &
fi
echo "dev chain RPC: http://127.0.0.1:$RPC_PORT"
