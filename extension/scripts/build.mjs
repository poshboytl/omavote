// Builds the unpacked extension.
//
//   node scripts/build.mjs                 release build into dist/ (mainnet, official.json)
//   node scripts/build.mjs --strict        same, but fails while official.json is a placeholder
//   node scripts/build.mjs --devnet [--api http://127.0.0.1:18080]
//                                          devnet build into dist-devnet/: network parameters
//                                          from the local server's /api/network, official
//                                          origins = localhost and 127.0.0.1 (any port)
//
// Pages and the service worker are ES modules; the content scripts are single IIFE
// files, since Chrome does not load content scripts as modules.

import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const devnet = args.includes("--devnet");
const strict = args.includes("--strict");
const apiIndex = args.indexOf("--api");
const api = (apiIndex >= 0 ? args[apiIndex + 1] : process.env.OMAVOTE_API) ?? "http://127.0.0.1:18080";
const outDir = `${root}${devnet ? "dist-devnet" : "dist"}`;
const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));

for (const f of ["omavote_wasm.js", "omavote_wasm_bg.wasm"]) {
  if (!existsSync(`${root}src/wasm/pkg/${f}`)) {
    console.error("The protocol core (WASM) is missing in src/wasm/pkg/. Build it first with `npm run wasm`.");
    process.exit(1);
  }
}

const hostPattern = (origin) => {
  const u = new URL(origin);
  if (u.origin !== origin || u.protocol !== "https:") throw new Error(`official origins must be https origins: ${origin}`);
  return `https://${u.hostname}/*`;
};

let network = null;
let official;
if (devnet) {
  const res = await fetch(`${api.replace(/\/$/, "")}/api/network`);
  if (!res.ok) throw new Error(`GET ${api}/api/network: HTTP ${res.status}`);
  network = (await res.json()).network;
  official = ["http://localhost/*", "http://127.0.0.1/*"];
  console.log(`devnet build for ${network.name} (genesis ${network.genesis_hash}) from ${api}`);
} else {
  const origins = JSON.parse(readFileSync(`${root}official.json`, "utf8")).origins;
  official = origins.map(hostPattern);
  if (origins.some((o) => new URL(o).hostname.endsWith(".invalid"))) {
    const msg = "official.json still holds the placeholder domain: set the official origins before publishing (docs/19 §8).";
    if (strict) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(`warning: ${msg}`);
  }
}

const define = {
  __OMAVOTE_FLAVOR__: JSON.stringify(devnet ? "devnet" : "release"),
  __OMAVOTE_NETWORK__: JSON.stringify(network),
  __OMAVOTE_OFFICIAL__: JSON.stringify(official),
};
const common = { configFile: false, root, base: "./", define, logLevel: "warn", publicDir: false };

// 1. Popup, confirmation window and service worker (ES modules, shared chunks).
await build({
  ...common,
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    modulePreload: false,
    rollupOptions: {
      input: { popup: `${root}popup.html`, confirm: `${root}confirm.html`, background: `${root}src/background.ts` },
      output: { entryFileNames: (c) => (c.name === "background" ? "background.js" : "assets/[name]-[hash].js") },
    },
  },
});

// 2. Content scripts: one self-contained file each.
for (const [entry, name] of [
  ["src/content.ts", "content"],
  ["src/inpage.ts", "inpage"],
]) {
  await build({
    ...common,
    build: {
      outDir,
      emptyOutDir: false,
      target: "es2022",
      sourcemap: false,
      lib: { entry: `${root}${entry}`, formats: ["iife"], name: `omavote_${name}`, fileName: () => `${name}.js` },
    },
  });
}

cpSync(`${root}public/icons`, `${outDir}/icons`, { recursive: true });

const icons = Object.fromEntries([16, 32, 48, 128].map((s) => [String(s), `icons/icon-${s}.png`]));
const manifest = {
  manifest_version: 3,
  name: devnet ? "Omavote Signer (DEVNET)" : "Omavote Signer",
  version: pkg.version,
  description: "Holds one dedicated voting key and signs only Omavote delegate ballots. No transfers, no transactions.",
  minimum_chrome_version: "111",
  icons,
  action: { default_popup: "popup.html", default_title: devnet ? "Omavote Signer (DEVNET)" : "Omavote Signer", default_icon: icons },
  background: { service_worker: "background.js", type: "module" },
  permissions: ["storage", "alarms", "scripting", "activeTab"],
  host_permissions: official,
  optional_host_permissions: devnet ? ["https://*/*"] : ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  content_scripts: [
    { matches: official, js: ["content.js"], run_at: "document_start", all_frames: false },
    { matches: official, js: ["inpage.js"], run_at: "document_start", all_frames: false, world: "MAIN" },
  ],
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
};
writeFileSync(`${outDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built ${outDir}`);
