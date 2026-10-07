import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Locates the repository's vectors/ directory (env OMAVOTE_VECTORS overrides). */
export function vectorsDir(): string {
  const env = process.env["OMAVOTE_VECTORS"];
  if (env) return resolve(env);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "vectors");
    if (existsSync(join(candidate, "replay.json"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("vectors/ directory not found; set OMAVOTE_VECTORS");
}

/** Path of the compiled CLI (dist/cli.js). */
export function cliPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "dist", "cli.js");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("dist/cli.js not found; run npm run build");
}
