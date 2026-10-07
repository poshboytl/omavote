// Load the `--target web` WASM build in Node: initialise it synchronously with the
// .wasm bytes read from disk (no fetch), then wrap it in the same Core facade.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { call, initSync, version } from "../../src/wasm/pkg/omavote_wasm.js";
import { Core } from "../../src/lib/core";

let core: Core | null = null;

export function loadCoreForNode(): Core {
  if (!core) {
    const wasm = readFileSync(fileURLToPath(new URL("../../src/wasm/pkg/omavote_wasm_bg.wasm", import.meta.url)));
    initSync({ module: wasm });
    core = new Core(call, version());
  }
  return core;
}
