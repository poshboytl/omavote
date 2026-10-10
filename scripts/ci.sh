#!/usr/bin/env bash
# Local CI: everything that runs without a node. The dev-chain checks are separate
# (deploy/devnet/run-demo.sh and the browser end-to-end tests).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== Rust: format, lint, build, tests"
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo build --workspace --locked
cargo test --workspace --locked

echo "== RustSec advisories"
if command -v cargo-audit >/dev/null; then
  cargo audit
else
  echo "cargo-audit not installed (cargo install cargo-audit); skipped" >&2
fi

echo "== WASM core"
cargo build -p omavote-wasm --target wasm32-unknown-unknown --release --locked

echo "== JSON Schema against the vectors and the dev-chain evidence"
(cd schemas && npm ci --silent && npm test -- ../evidence/devnet-2026-10-08/bundle.json)

echo "== Independent TypeScript verifier"
(cd verifier-ts && npm ci --silent && npm run build && npm test && node dist/cli.js check-vectors ../vectors)
# Low-severity advisories sit in CCC's transitive dependencies (elliptic, unused for
# signature checks, which use noble): fail on moderate and above.
(cd verifier-ts && npm audit --omit=dev --audit-level=moderate)

echo "== Frontend"
(cd web && npm ci --silent && npm run wasm && npm test && npm run build && npm audit --omit=dev --audit-level=moderate)

echo "== Signer extension"
# Ships only its own code and the WASM core (no runtime npm dependencies).
(cd extension && npm ci --silent && npm run wasm && npm run typecheck && npm test && npm run build)

echo "== Research model"
python3 -m unittest discover -s research -p 'test_*.py'
echo "CI passed"
