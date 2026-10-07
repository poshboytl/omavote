#!/usr/bin/env bash
# Differential check: the Rust replay (omavote verify) and the independent
# TypeScript verifier must agree on every poll's result_hash for the same
# reduced block data (dumped from your own node).
# Usage: scripts/diff-verifiers.sh <rpc-url> [verify options...]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${1:?usage: diff-verifiers.sh <rpc-url> [verify options]}"; shift || true
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

"$ROOT/target/release/omavote" verify --rpc "$RPC" --dump-blocks "$OUT/blocks.json" "$@" > "$OUT/rust.json"
node "$ROOT/verifier-ts/dist/cli.js" replay "$OUT/blocks.json" > "$OUT/ts.json"

python3 - "$OUT/rust.json" "$OUT/ts.json" <<'PY'
import json, sys
rust = json.load(open(sys.argv[1]))
ts = json.load(open(sys.argv[2]))

def by_poll(report):
    polls = report.get("polls", report)
    if isinstance(polls, dict):
        polls = [dict(v, poll_id=k) for k, v in polls.items()]
    return {p["poll_id"]: p.get("result_hash") for p in polls}

r, t = by_poll(rust), by_poll(ts)
bad = 0
for pid in sorted(set(r) | set(t)):
    same = r.get(pid) == t.get(pid)
    bad += not same
    print(("OK  " if same else "DIFF"), pid, r.get(pid), t.get(pid))
print(f"{len(r)} polls, {bad} differences")
sys.exit(1 if bad else 0)
PY
