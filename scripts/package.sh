#!/usr/bin/env bash
# Release package: binary, built web app, built second verifier, specs, schemas,
# vectors and deployment files, with a SHA256SUMS manifest and BUILD.txt.
# Output: output/releases/omavote-<commit>-<arch>.tar.gz (+ .sha256)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
revision=$(git rev-parse HEAD)
cargo build --locked --release -p omavote
(cd web && npm ci --silent && npm run wasm && npm run build)
(cd verifier-ts && npm ci --silent && npm run build)
stage=$(mktemp -d -t omavote-release.XXXXXX)
trap 'rm -rf "$stage"' EXIT
dst="$stage/omavote"
mkdir -p "$dst/bin" "$dst/web" "$dst/verifier-ts" output/releases
cp target/release/omavote "$dst/bin/"
cp -r web/dist "$dst/web/dist"
cp -r verifier-ts/dist verifier-ts/package.json verifier-ts/package-lock.json verifier-ts/README.md verifier-ts/SPEC-NOTES.md "$dst/verifier-ts/"
cp -r docs schemas vectors deploy evidence "$dst/"
rm -rf "$dst/schemas/node_modules"
cp README.md Cargo.toml Cargo.lock rustfmt.toml "$dst/"
{
  printf 'source_commit=%s\n' "$revision"
  git status --porcelain | sed 's/^/source_status=/'
  rustc --version
  node --version
  uname -sm
} > "$dst/BUILD.txt"
(cd "$dst" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
archive="output/releases/omavote-${revision:0:12}-$(uname -m).tar.gz"
tar -czf "$archive" -C "$stage" omavote
sha256sum "$archive" > "$archive.sha256"
echo "package: $archive"
cat "$archive.sha256"
