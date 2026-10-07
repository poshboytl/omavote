#!/usr/bin/env bash
# Local CI: everything that runs without a node. The dev-chain demo is separate
# (deploy/devnet/run-demo.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== Rust: build and tests"
cargo build --workspace --locked
cargo test --workspace --locked

echo "== WASM core"
cargo build -p omavote-wasm --target wasm32-unknown-unknown --release --locked

echo "== JSON Schema against the vectors"
(cd schemas && npm ci --silent && npm test)

if [ -f verifier-ts/package.json ]; then
  echo "== Independent TypeScript verifier"
  (cd verifier-ts && npm ci --silent && npm run build && npm test && node dist/cli.js check-vectors ../vectors)
fi

if [ -f web/package.json ]; then
  echo "== Frontend"
  (cd web && npm ci --silent && npm run wasm && npm test && npm run build)
fi
echo "CI passed"
