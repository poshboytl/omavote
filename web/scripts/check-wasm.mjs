// Fails early with a clear message when the WASM core has not been built yet.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("../src/wasm/pkg/", import.meta.url));
const needed = ["omavote_wasm.js", "omavote_wasm_bg.wasm", "omavote_wasm.d.ts"];
const missing = needed.filter((f) => !existsSync(pkg + f));
if (missing.length > 0) {
  console.error(
    `The protocol core (WASM) is missing: ${missing.join(", ")} in src/wasm/pkg/.\n` +
      "Build it first with `npm run wasm` (needs Rust, the wasm32-unknown-unknown target and wasm-pack).",
  );
  process.exit(1);
}
