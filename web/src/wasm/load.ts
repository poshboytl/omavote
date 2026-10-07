// Browser loader for the protocol core. `npm run wasm` builds ./pkg (git-ignored).

import init, { call, version } from "./pkg/omavote_wasm.js";
import wasmUrl from "./pkg/omavote_wasm_bg.wasm?url";
import { Core } from "../lib/core";

let loading: Promise<Core> | null = null;

export function loadCore(): Promise<Core> {
  if (!loading) {
    loading = init({ module_or_path: wasmUrl }).then(() => new Core(call, version()));
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
