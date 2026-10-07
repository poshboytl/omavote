import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";

// Dev/preview proxy target: the Omavote server (`omavote serve`).
const target = process.env.OMAVOTE_API ?? "http://127.0.0.1:18080";
const proxy = {
  "/api": { target, changeOrigin: true },
  "/feed.atom": { target, changeOrigin: true },
};

/**
 * Production builds carry a CSP meta tag as defence in depth for static mirrors.
 * The server's header CSP (connect-src 'self') stays the effective, stricter policy
 * when it serves `dist/`; a mirror may need `connect-src` for its configured API.
 * The dev server is left without it (React Refresh injects an inline preamble).
 */
function cspMeta(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "omavote-csp-meta",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace(/(<meta charset="UTF-8" \/>)/, `$1\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

/** The header the Omavote server sends with `web/dist` (crates/omavote/src/api.rs). */
const SERVER_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export default defineConfig({
  // Relative asset URLs + HashRouter: the build works from any path on any static host.
  base: "./",
  plugins: [react(), cspMeta()],
  server: { proxy },
  // `npm run preview` serves dist/ under the server's exact CSP header.
  preview: { proxy, headers: { "Content-Security-Policy": SERVER_CSP } },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
    // Keep every asset (the .wasm in particular) as a separate file: no data: URLs.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
