// Browser end-to-end test of the Omavote web UI on the local CKB development chain.
//
// Starts its own primary (127.0.0.1:18090) and backup (127.0.0.1:18091) servers with
// fresh databases, funds their relays, creates test identities with Nervos DAO
// deposits, and drives the UI like a user (Playwright, Chromium): create a proposal,
// admission, GRANT, delegate and direct votes, revote, key rotation with GRANT+CANCEL,
// owner take-over, relay failover to the backup, committee attestation, and the
// evidence bundle checked by `omavote verify-evidence` and the TypeScript verifier.
//
// MetaMask is an injected EIP-1193 provider whose personal_sign runs
// `omavote sign --format evm`; Neuron signatures come from `omavote sign --format ckb`
// over the exact bytes the page shows. Development chains and test keys only.
//
// DEVICE=extension runs the Omavote signer extension instead (docs/19 §12): the
// devnet build of extension/ is loaded unpacked into Chromium; the extension creates
// its key, connects the site, signs delegate ballots for two owners in one
// confirmation, then is reset and re-authorized with GRANT+CANCEL.
//
// Usage: DEVICE=desktop|mobile|extension [RUN_ID=...] node web/e2e/devnet-e2e.mjs
// Output: devnet/e2e-out/<run>/ (report.json, screenshots, server logs, trace on failure)

import { execFile, spawn } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, devices } from "playwright";

const execFileP = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = process.env.OMAVOTE_BIN ?? join(ROOT, "target/debug/omavote");
const RPC = process.env.RPC ?? "http://127.0.0.1:18114";
const FAUCET = process.env.FAUCET_KEY ?? join(ROOT, "devnet/faucet.key");
const DEVICE = ["mobile", "extension"].includes(process.env.DEVICE) ? process.env.DEVICE : "desktop";
const EXTENSION = DEVICE === "extension";
const EXT_DIR = join(ROOT, "extension/dist-devnet");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const RUN = process.env.RUN_ID ?? `${STAMP}-${DEVICE}`;
const OUT = join(ROOT, "devnet/e2e-out", RUN);
const PRIMARY_PORT = Number(process.env.PRIMARY_PORT ?? 18090);
const BACKUP_PORT = Number(process.env.BACKUP_PORT ?? 18091);
const BASE = `http://127.0.0.1:${PRIMARY_PORT}`;
const BACKUP = `http://127.0.0.1:${BACKUP_PORT}`;
const OMNILOCK = { code_hash: "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb", hash_type: "type" };
const START_LEAD_MS = Number(process.env.START_LEAD_MS ?? 5 * 60_000);
const PERIOD_MIN = Number(process.env.PERIOD_MIN ?? 8);
const DEPOSIT_A = 150_000;
const DEPOSIT_B = 80_000;
const RELAY_FUNDS = 30_000;
const SHANNON = 100_000_000n;

for (const d of ["", "shots", "keys", "tmp", "primary", "backup"]) mkdirSync(join(OUT, d), { recursive: true });
const runLog = createWriteStream(join(OUT, "run.log"), { flags: "a" });
const t0 = Date.now();
const log = (...a) => {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${a.join(" ")}`;
  console.log(line);
  runLog.write(line + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Report

const report = {
  run: RUN,
  device: DEVICE,
  base: BASE,
  backup: BACKUP,
  started_at: new Date().toISOString(),
  finished_at: null,
  duration_s: null,
  ok: false,
  failure: null,
  identities: {},
  poll_id: null,
  steps: [],
  ballots: {},
  balances: [],
  result: {},
  page_errors: [],
  csp_violations: [],
  overflow: [],
  console_errors: [],
  signatures: [],
};
const saveReport = () => writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");

class Fail extends Error {}
function check(cond, what) {
  if (!cond) throw new Fail(`check failed: ${what}`);
}

async function waitUntil(what, fn, { timeoutMs = 120_000, intervalMs = 1000 } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Fail(`timed out waiting for ${what}${last ? ` (${last.message ?? last})` : ""}`);
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// omavote CLI and HTTP helpers

async function omavote(args, { timeoutMs = 180_000 } = {}) {
  try {
    const { stdout } = await execFileP(BIN, args, { cwd: ROOT, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, RUST_LOG: "warn" } });
    return stdout;
  } catch (e) {
    throw new Error(`omavote ${args[0]} ${args[1] ?? ""} failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}
const omavoteJson = async (args, opts) => JSON.parse(await omavote(args, opts));

async function http(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) {
    const err = new Error(`${init?.method ?? "GET"} ${url}: ${r.status} ${typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body)}`);
    err.status = r.status;
    throw err;
  }
  return body;
}
const get = (base, path) => http(`${base}${path}`);
const post = (base, path, body) => http(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

// ---------------------------------------------------------------------------
// Servers

class Server {
  constructor(name, port, extra) {
    this.name = name;
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.dir = join(OUT, name);
    this.extra = extra;
    this.proc = null;
  }

  async init() {
    this.relayAddress = (await omavote(["keygen", join(this.dir, "relay.key"), "--rpc", RPC])).trim();
    await omavote(["keygen", join(this.dir, "receipt.key")]);
    writeFileSync(join(this.dir, "roles.json"), await omavote(["demo-roles", "--rpc", RPC]));
    const toml = `# e2e ${this.name} server (development chain, generated)
[node]
rpc = "${RPC}"
poll_interval_ms = 500

[network]
omnilock = { code_hash = "${OMNILOCK.code_hash}", hash_type = "${OMNILOCK.hash_type}" }

[protocol]
initial_roles_file = "roles.json"

[server]
listen = "127.0.0.1:${this.port}"
database = "omavote.sqlite"
receipt_key_file = "receipt.key"
${this.extra}

[relay]
embedded = true
key_file = "relay.key"
interval_ms = 1000
confirmations = 3
`;
    writeFileSync(join(this.dir, "omavote.toml"), toml);
  }

  async start() {
    const logFile = createWriteStream(join(this.dir, "server.log"), { flags: "a" });
    this.proc = spawn(BIN, ["serve", "--config", join(this.dir, "omavote.toml")], { cwd: this.dir, stdio: ["ignore", "pipe", "pipe"] });
    this.proc.stdout.pipe(logFile);
    this.proc.stderr.pipe(logFile);
    const proc = this.proc;
    this.exited = new Promise((r) => proc.on("exit", r));
    await waitUntil(`${this.name} server in sync`, async () => {
      if (proc.exitCode !== null) throw new Error(`${this.name} server exited (${proc.exitCode}); see ${this.dir}/server.log`);
      const s = await get(this.url, "/api/status");
      return s.synced && s.indexed;
    }, { timeoutMs: 180_000, intervalMs: 500 });
    log(`${this.name} server up on ${this.url}`);
  }

  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.kill("SIGINT");
    const done = await Promise.race([this.exited.then(() => true), sleep(10_000).then(() => false)]);
    if (!done) {
      this.proc.kill("SIGKILL");
      await this.exited;
    }
    log(`${this.name} server stopped`);
  }
}

const primary = new Server("primary", PRIMARY_PORT, `web_root = "${join(ROOT, "web/dist")}"`);
const backup = new Server("backup", BACKUP_PORT, `cors_origins = ["${BASE}"]`);

// ---------------------------------------------------------------------------
// Identities and signing

const identities = {};
let signCounter = 0;

async function identity(name, label) {
  const id = await omavoteJson(["devnet", "identity", "--label", label]);
  const keyFile = join(OUT, "keys", `${name}.key`);
  writeFileSync(keyFile, `${id.secret}\n`);
  chmodSync(keyFile, 0o600);
  const v = { name, label, public_key: id.public_key, evm_address: id.evm_address.toLowerCase(), keyFile };
  identities[name] = v;
  return v;
}

/** Sign raw UTF-8 bytes exactly as Neuron (`ckb`) or MetaMask personal_sign (`evm`) would. */
async function signBytes(id, bytes, format, purpose) {
  const file = join(OUT, "tmp", `msg-${++signCounter}.txt`);
  writeFileSync(file, bytes);
  const sig = (await omavote(["sign", "--key", id.keyFile, "--format", format, "--text-file", file])).trim();
  const text = bytes.toString("utf8");
  report.signatures.push({ n: signCounter, by: id.name, format, purpose, summary: text.split("\n")[0], bytes: bytes.length });
  return sig;
}

// ---------------------------------------------------------------------------
// Injected wallet (EIP-1193 + EIP-6963), backed by `omavote sign --format evm`

const wallet = { account: null, beforeSign: null };

async function walletRequest(method, paramsJson) {
  const params = JSON.parse(paramsJson || "[]");
  try {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return JSON.stringify({ result: wallet.account ? [wallet.account.evm_address] : [] });
      case "eth_chainId":
        return JSON.stringify({ result: "0x1" });
      case "personal_sign": {
        const [data, address] = params;
        if (!wallet.account || String(address).toLowerCase() !== wallet.account.evm_address) {
          return JSON.stringify({ error: { code: 4100, message: "the requested account is not connected" } });
        }
        if (!/^0x([0-9a-f]{2})*$/i.test(data)) return JSON.stringify({ error: { code: -32602, message: "expected hex data" } });
        const bytes = Buffer.from(data.slice(2), "hex");
        if (wallet.beforeSign) {
          const hook = wallet.beforeSign;
          wallet.beforeSign = null;
          await hook(bytes);
        }
        return JSON.stringify({ result: await signBytes(wallet.account, bytes, "evm", "personal_sign") });
      }
      default:
        return JSON.stringify({ error: { code: 4200, message: `unsupported method ${method}` } });
    }
  } catch (e) {
    return JSON.stringify({ error: { code: -32603, message: String(e?.message ?? e) } });
  }
}

const INIT_SCRIPT = `(() => {
  try {
    localStorage.setItem("omavote.lang", "en");
    localStorage.setItem("omavote.tipSource", ${JSON.stringify(`${RPC}/`)});
  } catch {}
  document.addEventListener("securitypolicyviolation", (e) => {
    try { window.__e2eCsp(JSON.stringify({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber })); } catch {}
  });
  const listeners = {};
  const provider = {
    isMetaMask: true,
    async request({ method, params }) {
      const r = JSON.parse(await window.__e2eWallet(method, JSON.stringify(params ?? [])));
      if (r.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
      return r.result;
    },
    on(event, fn) { (listeners[event] ??= new Set()).add(fn); },
    removeListener(event, fn) { listeners[event]?.delete(fn); },
  };
  window.__e2eEmit = (event, arg) => { for (const fn of listeners[event] ?? []) fn(arg); };
  window.ethereum = provider;
  const info = { uuid: "e2e-metamask", name: "MetaMask", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "io.metamask" };
  window.addEventListener("eip6963:requestProvider", () => {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  });
})();`;

/** Switch the injected wallet's account (MetaMask emits accountsChanged). */
async function useAccount(page, id) {
  wallet.account = id;
  await page.evaluate((a) => window.__e2eEmit?.("accountsChanged", [a]), id.evm_address).catch(() => {});
}

// ---------------------------------------------------------------------------
// Page helpers

let page;
let context;
let shotN = 0;

async function shot(name) {
  if (!page) return null;
  const file = join(OUT, "shots", `${String(++shotN).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch((e) => log(`screenshot ${name} failed: ${e.message}`));
  return file;
}

/** The page must never be wider than the viewport (phones in particular). */
async function assertNoOverflow(where) {
  if (!page) return;
  const r = await page.evaluate(() => ({ px: document.documentElement.scrollWidth - document.documentElement.clientWidth, route: location.hash })).catch(() => null);
  if (r && r.px > 1) {
    report.overflow.push({ where, route: r.route, px: r.px });
    await shot(`overflow-${where.replace(/[^a-z0-9]+/gi, "-")}`);
    throw new Fail(`horizontal overflow of ${r.px}px at ${r.route} (${where}, ${DEVICE})`);
  }
}

async function goto(hashPath) {
  await assertNoOverflow(`leaving for ${hashPath}`);
  await page.goto(`${BASE}/#${hashPath}`);
  await page.locator("main h1").first().waitFor();
}

/** In-app navigation (no reload): needed while the primary server is down. */
async function navigateInApp(linkName) {
  await assertNoOverflow(`leaving for ${linkName}`);
  const link = page.locator("a", { hasText: new RegExp(`^${linkName}$`) }).first();
  await link.scrollIntoViewIfNeeded();
  await link.click();
}

/** Visible-first polling for one of several outcomes. */
async function waitForAny(what, candidates, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const [key, loc] of Object.entries(candidates)) {
      if (await loc.first().isVisible().catch(() => false)) return key;
    }
    await sleep(300);
  }
  throw new Fail(`timed out waiting for ${what} (${Object.keys(candidates).join(" | ")})`);
}

async function connectWallet(scope, id) {
  await useAccount(page, id);
  const bar = scope.locator(".walletbar").first();
  await bar.getByRole("button", { name: /^(Connect MetaMask|Reconnect)$/ }).click();
  await waitUntil(`wallet connected as ${id.name}`, async () => {
    const txt = (await bar.locator(".walletbar-connected").textContent().catch(() => "")) ?? "";
    return txt.toLowerCase().includes(id.evm_address);
  }, { timeoutMs: 20_000, intervalMs: 250 });
}

/**
 * Click a "prepare" button, handling the before-signing sync check: acknowledge a
 * warning, or retry while signing is blocked (recovery messages), until the exact
 * text to sign is shown.
 */
async function prepare(scope, button) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    await button.click();
    const r = await waitForAny("the text to sign", {
      ready: scope.locator(".signtext"),
      ack: scope.locator("label.ack input"),
      blocked: scope.locator(".notice-bad", { hasText: "Signing is blocked" }),
      error: scope.locator(".notice-bad"),
    });
    if (r === "ready") return;
    if (r === "ack") {
      log("  sync warning shown; acknowledging");
      await scope.locator("label.ack input").first().check();
      continue;
    }
    if (r === "blocked") {
      log("  signing blocked while the server catches up; retrying");
      await sleep(2000);
      continue;
    }
    const msg = await scope.locator(".notice-bad").first().innerText();
    throw new Fail(`prepare failed: ${msg}`);
  }
  throw new Fail("prepare did not succeed after 8 attempts");
}

/** Read the exact bytes the page shows (hex), sign as Neuron, paste and confirm. */
async function neuronSignIn(scope, id, purpose) {
  const hex = (await scope.locator(".signtext-hex pre").first().textContent())?.trim() ?? "";
  check(/^0x[0-9a-f]+$/.test(hex), "the page shows the exact bytes as hex");
  const bytes = Buffer.from(hex.slice(2), "hex");
  const lines = [...(await scope.locator(".signtext-lines li").allTextContents())].map((l) => (l === " " ? "" : l));
  check(lines.join("\n") === bytes.toString("utf8"), "the displayed lines equal the signed bytes");
  const sig = await signBytes(id, bytes, "ckb", purpose);
  check(/0[01]$/.test(sig), "Neuron signatures use v = 00/01");
  await scope.locator(".neuron textarea").first().fill(sig);
  await scope.locator(".neuron button.btn-primary").first().click();
  return { bytes, sig };
}

/** Values of `Key: value` lines of the text shown for signing. */
async function signedField(scope, key) {
  const lines = await scope.locator(".signtext-lines li").allTextContents();
  const l = lines.find((x) => x.startsWith(`${key}: `));
  return l ? l.slice(key.length + 2) : null;
}

async function expectCounts(scope, what, { receipt = true } = {}) {
  const r = await waitForAny(`${what}: the vote to count`, {
    counts: scope.getByText("Your vote counts"),
    rejected: scope.getByText("The relay rejected the submission"),
    resign: scope.getByText("Sign again", { exact: true }),
  });
  if (r !== "counts") throw new Fail(`${what}: ${r}: ${(await scope.innerText()).slice(0, 600)}`);
  if (receipt) {
    check(await scope.getByText("Receipt signature recovers to the server's published receipt key").first().isVisible().catch(() => false), `${what}: receipt signer checked`);
    check(await scope.getByText("Receipt commits to exactly the envelope bytes you sent").first().isVisible().catch(() => false), `${what}: receipt envelope bytes checked`);
  }
}

// ---------------------------------------------------------------------------
// Steps

async function step(name, fn) {
  const s = { name, ok: false, started_s: ((Date.now() - t0) / 1000).toFixed(1), ms: 0, notes: {} };
  report.steps.push(s);
  log(`== ${name}`);
  const start = Date.now();
  try {
    await fn(s.notes);
    await assertNoOverflow(name);
    s.ok = true;
  } finally {
    s.ms = Date.now() - start;
    s.screenshot = await shot(name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
    saveReport();
  }
}

async function apiBallots(pollId, ownerId) {
  return (await get(BASE, `/api/proposals/${pollId}/ballots?owner=${ownerId}`)).ballots;
}

async function ballotStatus(pollId, ownerId, ballotId) {
  return (await apiBallots(pollId, ownerId)).find((b) => b.ballot_id === ballotId)?.status ?? null;
}

async function balances(when) {
  const rows = [];
  for (const [name, addr] of Object.entries(report.identities).flatMap(([n, v]) => (v.check_addresses ?? []).map((a) => [n, a]))) {
    const b = await omavoteJson(["devnet", "balance", "--rpc", RPC, "--address", addr]);
    rows.push({ when, identity: name, address: addr, ordinary_capacity_shannon: b.ordinary_capacity_shannon });
  }
  report.balances.push(...rows);
  const nonzero = rows.filter((r) => r.ordinary_capacity_shannon !== "0");
  check(nonzero.length === 0, `owners and voting keys hold no ordinary capacity (${when}): ${JSON.stringify(nonzero)}`);
  log(`  balances ${when}: ${rows.length} addresses, all 0`);
}

// ---------------------------------------------------------------------------

async function main() {
  // ----- servers, relays, network objects
  await step("servers", async (notes) => {
    check(existsSync(BIN), `omavote binary at ${BIN} (cargo build -p omavote)`);
    check(existsSync(join(ROOT, "web/dist/index.html")), "web/dist is built (npm run build)");
    await primary.init();
    await backup.init();
    await primary.start();
    await backup.start();
    for (const s of [primary, backup]) {
      const f = await omavoteJson(["devnet", "fund", "--rpc", RPC, "--faucet-key", FAUCET, "--to", s.relayAddress, "--ckb", String(RELAY_FUNDS)]);
      notes[`${s.name}_relay_funding_tx`] = f.tx_hash;
    }
    for (const s of [primary, backup]) {
      await waitUntil(`${s.name} relay funded`, async () => BigInt((await get(s.url, "/api/status")).relay.balance_shannon ?? "0") >= BigInt(RELAY_FUNDS) * SHANNON, { timeoutMs: 60_000 });
    }
    const net = await get(BASE, "/api/network");
    notes.network = net.network.name;
    if (!net.authorization_policy.published || !net.current_roles) {
      log("  publishing the authorization policy and process roles");
      if (!net.authorization_policy.published) await post(BASE, "/api/envelopes", net.authorization_policy.object);
      if (!net.current_roles) await post(BASE, "/api/envelopes", readFileSync(join(primary.dir, "roles.json"), "utf8").trim());
      await waitUntil("policy and roles on chain", async () => {
        const n = await get(BASE, "/api/network");
        return n.authorization_policy.published && n.current_roles;
      }, { timeoutMs: 120_000 });
    }
    notes.policy_hash = net.authorization_policy.hash;
    notes.roles_hash = (await get(BASE, "/api/network")).current_roles.roles_hash;
  });

  // ----- identities and deposits
  const net = (await get(BASE, "/api/network")).network;
  const core = (method, params) => post(BASE, `/api/core/${method}`, { network: net, ...params });
  const A = await identity("A", `e2e-${RUN}-owner-a`);
  const B = await identity("B", `e2e-${RUN}-owner-b`);
  const K1 = await identity("K1", `e2e-${RUN}-key-1`);
  const K2 = await identity("K2", `e2e-${RUN}-key-2`);
  const C = EXTENSION ? await identity("C", `e2e-${RUN}-owner-c`) : null;
  const committee = [];
  for (let i = 1; i <= 3; i++) committee.push(await identity(`committee${i}`, `omavote-demo-committee-${i}`));
  const coordinator = await identity("coordinator1", "omavote-demo-coordinator-1");

  await step("identities and deposits", async (notes) => {
    const a = await core("secp256k1_lock", { public_key: A.public_key });
    Object.assign(A, { address: a.address, owner_id: a.owner_id, lock: a.script });
    const bl = (await core("evm_owner_locks", { address: B.evm_address })).locks;
    const b12 = bl.find((l) => l.script.args.startsWith("0x12"));
    check(b12, "an Omnilock 0x12 owner lock for B");
    Object.assign(B, { address: b12.address, owner_id: b12.owner_id, lock: b12.script });
    const evmAddrs = async (id) => (await core("evm_owner_locks", { address: id.evm_address })).locks.map((l) => l.address);
    report.identities = {
      A: { label: A.label, kind: "secp256k1 (Neuron)", address: A.address, owner_id: A.owner_id, check_addresses: [A.address] },
      B: { label: B.label, kind: "Omnilock 0x12 (MetaMask)", evm_address: B.evm_address, address: B.address, owner_id: B.owner_id, check_addresses: await evmAddrs(B) },
      K1: { label: K1.label, kind: "EVM voting key", evm_address: K1.evm_address, check_addresses: await evmAddrs(K1) },
      K2: { label: K2.label, kind: "EVM voting key", evm_address: K2.evm_address, check_addresses: await evmAddrs(K2) },
    };
    if (C) {
      const c = await core("secp256k1_lock", { public_key: C.public_key });
      Object.assign(C, { address: c.address, owner_id: c.owner_id, lock: c.script });
      report.identities.C = { label: C.label, kind: "secp256k1 (Neuron)", address: C.address, owner_id: C.owner_id, check_addresses: [C.address] };
    }
    for (const m of committee) m.address = (await core("secp256k1_lock", { public_key: m.public_key })).address;
    await balances("before any action");
    notes.deposit_a = (await omavoteJson(["devnet", "deposit", "--rpc", RPC, "--faucet-key", FAUCET, "--address", A.address, "--ckb", String(DEPOSIT_A)])).tx_hash;
    notes.deposit_b = (await omavoteJson(["devnet", "deposit", "--rpc", RPC, "--faucet-key", FAUCET, "--address", B.address, "--ckb", String(DEPOSIT_B)])).tx_hash;
    if (C) notes.deposit_c = (await omavoteJson(["devnet", "deposit", "--rpc", RPC, "--faucet-key", FAUCET, "--address", C.address, "--ckb", String(DEPOSIT_B)])).tx_hash;
    for (const s of [primary, backup]) {
      for (const [id, ckb] of [[A, DEPOSIT_A], [B, DEPOSIT_B], ...(C ? [[C, DEPOSIT_B]] : [])]) {
        await waitUntil(`${s.name} indexes the deposit of ${id.name}`, async () => BigInt((await get(s.url, `/api/owners/${id.owner_id}/power`)).total_shannon) >= BigInt(ckb) * SHANNON, { timeoutMs: 60_000, intervalMs: 500 });
      }
    }
    await balances("after deposits");
    saveReport();
  });

  // ----- browser
  let browser = null;
  if (EXTENSION) {
    // The devnet build bakes in this chain's parameters from the primary server.
    await step("extension devnet build", async (notes) => {
      await execFileP(process.execPath, [join(ROOT, "extension/scripts/build.mjs"), "--devnet", "--api", BASE], { cwd: ROOT, timeout: 300_000 });
      check(existsSync(join(EXT_DIR, "manifest.json")), `extension build in ${EXT_DIR}`);
      notes.dir = EXT_DIR;
    });
    // Extensions need a persistent context; channel "chromium" runs the new headless mode.
    context = await chromium.launchPersistentContext(join(OUT, "profile"), {
      channel: "chromium",
      headless: process.env.HEADED !== "1",
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
      locale: "en-US",
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
    });
  } else {
    browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
    const ctxOpts = DEVICE === "mobile" ? { ...devices["Pixel 7"] } : { viewport: { width: 1440, height: 1000 } };
    context = await browser.newContext({ ...ctxOpts, acceptDownloads: true, locale: "en-US" });
  }
  await context.tracing.start({ screenshots: true, snapshots: true });
  await context.exposeFunction("__e2eWallet", walletRequest);
  await context.exposeFunction("__e2eCsp", (j) => {
    report.csp_violations.push(JSON.parse(j));
    log(`  CSP VIOLATION ${j}`);
  });
  await context.addInitScript({ content: INIT_SCRIPT });
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (e) => {
    report.page_errors.push(String(e?.stack ?? e));
    log(`  PAGE ERROR ${e}`);
  });
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const text = m.text();
    if (/Content Security Policy/i.test(text)) {
      report.csp_violations.push({ console: text });
      log(`  CSP VIOLATION ${text}`);
    } else if (m.type() === "error") {
      report.console_errors.push({ t_s: ((Date.now() - t0) / 1000).toFixed(1), text: text.slice(0, 300) });
    }
  });

  try {
    if (EXTENSION) await extensionScenario({ A, C, coordinator });
    else await scenario({ A, B, K1, K2, committee, coordinator });
    check(report.page_errors.length === 0, `no page errors (${report.page_errors.length})`);
    check(report.csp_violations.length === 0, `no CSP violations (${report.csp_violations.length})`);
    report.ok = true;
    await context.tracing.stop();
  } catch (e) {
    report.failure = String(e?.stack ?? e);
    log(`FAILED: ${e?.message ?? e}`);
    await page.screenshot({ path: join(OUT, "shots", "failure.png"), fullPage: true }).catch(() => {});
    await context.tracing.stop({ path: join(OUT, "trace.zip") }).catch(() => {});
    report.trace = join(OUT, "trace.zip");
  } finally {
    await (browser ?? context).close().catch(() => {});
  }
}

// a. Proposal: proposer A (Neuron), recipient A, budget 1000, opening 10, ~8 min period.
async function createProposal(A) {
  let pollId = null;
  await step("a create proposal (Neuron proposer)", async (notes) => {
    await goto("/create");
    await page.getByLabel("Full title").fill(`E2E ${RUN}: fund the explorer`);
    await page.getByLabel("Signing title (shown in wallets)").fill(`E2E ${RUN.slice(9, 15)} grant`);
    await page.getByLabel("Proposal text").fill(`End-to-end test proposal for run ${RUN}.\nDevelopment chain only.`);
    await page.getByLabel("Content locations").fill(`https://example.invalid/omavote-e2e/${RUN}`);
    await page.getByLabel("Forum topic id").fill("1");
    await page.getByLabel("Forum revision").fill("1");
    await page.getByLabel("Budget (CKB)").fill("1000");
    await page.getByLabel("Recipient address").fill(A.address);
    await page.getByLabel("Proposer addresses").fill(A.address);
    await page.getByText("Test-chain options").click();
    await page.getByLabel("Opening confirmations").fill("10");
    await page.getByLabel("Voting period (minutes)").fill(String(PERIOD_MIN));
    await page.getByLabel("Result confirmations (blocks)").fill("5");
    await page.getByLabel("Review window (hours)").fill("1");
    const clock = Number((await get(BASE, "/api/status")).indexed.clock_ms);
    const startMs = Math.ceil((clock + START_LEAD_MS) / 60_000) * 60_000;
    await page.getByLabel("Voting start (UTC, chain time)").fill(new Date(startMs).toISOString().slice(0, 16));
    notes.start_ms = String(startMs);
    await page.getByRole("button", { name: "Build manifest" }).click();
    const idCell = page.locator('.kv-row:has(dt:text-is("poll_id")) dd code').first();
    await idCell.waitFor();
    pollId = (await idCell.textContent()).trim();
    check(/^0x[0-9a-f]{64}$/.test(pollId), "poll id shown");
    report.poll_id = pollId;
    notes.poll_id = pollId;
    const job = page.locator(".job").filter({ hasText: "Proposer" }).first();
    await neuronSignIn(job, A, "proposal");
    await job.getByText("Signature verified locally").waitFor();
    await page.getByRole("button", { name: "Submit to the relay" }).click();
    await waitForAny("the proposal registration", {
      ok: page.getByText("The proposal is registered on chain."),
      rejected: page.getByText("The relay rejected the submission"),
    }).then(async (r) => r === "ok" || Promise.reject(new Fail(`proposal: ${await page.locator("main").innerText()}`)));
    const p = await get(BASE, `/api/proposals/${pollId}`);
    check(p.status === "ANNOUNCED", `proposal ANNOUNCED (got ${p.status})`);
    check(p.manifest_payload.manifest.rules_profile.opening_confirmations === "10", "opening confirmations 10");
    notes.end_ms = p.end_ms;
  });
  return pollId;
}

// b. Coordinator ADMISSION on the records page (EVM coordinator member via MetaMask).
async function admitProposal(pollId, coordinator) {
  await step("b coordinator admission", async () => {
    await goto("/records");
    const discard = page.getByRole("button", { name: "Discard draft" });
    if (await discard.isVisible().catch(() => false)) await discard.click();
    await page.getByLabel("Record type").selectOption("ADMISSION");
    await page.locator("label.field", { hasText: "Proposal" }).locator("select").selectOption(pollId);
    await prepare(page.locator("main"), page.getByRole("button", { name: "Build the record" }));
    await connectWallet(page.locator("main"), coordinator);
    await page.getByRole("button", { name: "Sign with MetaMask" }).first().click();
    await waitUntil("the coordinator signature to verify", async () => (await page.getByRole("button", { name: /^Submit \(1\/1 signatures\)$/ }).isEnabled()), { timeoutMs: 30_000, intervalMs: 300 });
    await page.getByRole("button", { name: /^Submit \(1\/1 signatures\)$/ }).click();
    await page.getByText("The record is on chain and indexed.").waitFor({ timeout: 180_000 });
  });
}

async function scenario({ A, B, K1, K2, committee, coordinator }) {
  const pollId = await createProposal(A);
  await admitProposal(pollId, coordinator);

  // c. Owner A grants K1 on the address page (Neuron).
  let grantK1 = null;
  await step("c owner A grants K1 (Neuron)", async (notes) => {
    await goto(`/address/${A.address}`);
    const panel = page.locator(".control-panel").first();
    await panel.locator("label.mode", { hasText: "GRANT" }).first().click();
    await page.getByRole("textbox", { name: /^Voting key/ }).fill(K1.evm_address);
    await page.getByLabel("30 days").check();
    await prepare(panel, panel.getByRole("button", { name: "Prepare GRANT" }));
    const summary = (await panel.locator(".signtext-summary-text").textContent()).trim();
    check(/^OMAVOTE GRANT 0x[0-9A-Fa-f]{8}\.\.[0-9A-Fa-f]{8} TO \d{4}-\d{2}-\d{2}$/.test(summary), `GRANT summary line (${summary})`);
    grantK1 = await signedField(panel, "Authorization-Hash");
    notes.authorization_id = grantK1;
    await neuronSignIn(panel, A, "GRANT K1");
    await panel.getByText("In effect: the index shows this grant as the owner's current authorization.").waitFor({ timeout: 180_000 });
  });

  // d. Wait until the poll is OPEN and officially admitted.
  await step("d wait for OPEN", async (notes) => {
    const p = await waitUntil("the poll to open", async () => {
      const v = await get(BASE, `/api/proposals/${pollId}`);
      if (["LATE_MANIFEST", "DISPUTED"].includes(v.status)) throw new Fail(`poll became ${v.status}`);
      return v.status === "OPEN" ? v : null;
    }, { timeoutMs: START_LEAD_MS + 180_000, intervalMs: 2000 });
    check(p.admission.state === "ADMITTED", `admission ADMITTED (got ${JSON.stringify(p.admission)})`);
    notes.admission = p.admission.state;
    await goto(`/proposal/${pollId}`);
    await page.locator(".badge", { hasText: "Voting open" }).first().waitFor();
    await page.locator(".badge", { hasText: "Officially admitted" }).first().waitFor();
  });

  const votePanel = () => page.locator("#vote");
  async function openVote(tab, choice) {
    await goto(`/proposal/${pollId}`);
    await votePanel().waitFor();
    await votePanel().getByRole("tab", { name: tab }).click();
    await votePanel().locator(`.choices input[value="${choice}"]`).check();
  }

  async function walletVote(id, tab, choice, what, ownerAddress) {
    await openVote(tab, choice);
    await connectWallet(votePanel(), id);
    if (ownerAddress) {
      const option = votePanel().locator(".owner-option", { hasText: ownerAddress }).locator("input");
      await waitUntil(`${what}: owner option`, async () => option.isChecked(), { timeoutMs: 30_000, intervalMs: 300 });
    }
    await prepare(votePanel(), votePanel().getByRole("button", { name: new RegExp(`^Prepare 1 ballot\\(s\\): ${choice}$`) }));
    const job = votePanel().locator(".job").first();
    const ballotId = await signedField(job, "Ballot-Hash");
    const summary = (await job.locator(".signtext-summary-text").textContent()).trim();
    check(summary === `OMAVOTE VOTE ${choice} #${pollId.slice(2, 18)} 1000CKB`, `${what}: summary line (${summary})`);
    await votePanel().getByRole("button", { name: /^Sign 1 ballot\(s\) in the wallet and submit$/ }).click();
    return { job, ballotId };
  }

  // e. K1 votes YES for A (delegate mode).
  await step("e K1 delegate YES for A", async (notes) => {
    const { job, ballotId } = await walletVote(K1, "MetaMask (voting key)", "YES", "K1 YES", A.address);
    await expectCounts(job, "K1 YES");
    report.ballots.k1_yes = ballotId;
    notes.ballot_id = ballotId;
    check((await ballotStatus(pollId, A.owner_id, ballotId)) === "SELECTED", "K1 YES selected");
  });

  // f. B votes NO, then revotes YES (owner mode, Omnilock 0x12).
  await step("f B votes NO then YES (MetaMask owner)", async (notes) => {
    const no = await walletVote(B, "MetaMask (owner)", "NO", "B NO", B.address);
    await expectCounts(no.job, "B NO");
    report.ballots.b_no = no.ballotId;
    await votePanel().locator('.choices input[value="YES"]').check();
    await prepare(votePanel(), votePanel().getByRole("button", { name: /^Prepare 1 ballot\(s\): YES$/ }));
    const job = votePanel().locator(".job").first();
    const yesId = await signedField(job, "Ballot-Hash");
    await votePanel().getByRole("button", { name: /^Sign 1 ballot\(s\) in the wallet and submit$/ }).click();
    await expectCounts(job, "B YES");
    report.ballots.b_yes = yesId;
    notes.b_no = no.ballotId;
    notes.b_yes = yesId;
    check((await ballotStatus(pollId, B.owner_id, no.ballotId)) === "SUPERSEDED", "B NO superseded by the revote");
    check((await ballotStatus(pollId, B.owner_id, yesId)) === "SELECTED", "B YES selected");
  });

  // g. Key rotation: A signs GRANT+CANCEL to K2; K2 votes NO.
  await step("g A GRANT+CANCEL to K2, K2 votes NO", async (notes) => {
    await goto(`/address/${A.address}`);
    const panel = page.locator(".control-panel").first();
    await panel.locator("label.mode", { hasText: "GRANT + CANCEL" }).click();
    await page.getByRole("textbox", { name: /^Voting key/ }).fill(K2.evm_address);
    await page.getByLabel("30 days").check();
    await prepare(panel, panel.getByRole("button", { name: "Prepare GRANT + CANCEL" }));
    const summary = (await panel.locator(".signtext-summary-text").textContent()).trim();
    check(summary.startsWith("OMAVOTE GRANT+CANCEL 0x"), `GRANT+CANCEL summary (${summary})`);
    notes.authorization_id = await signedField(panel, "Authorization-Hash");
    await neuronSignIn(panel, A, "GRANT+CANCEL K2");
    await panel.getByText("In effect: the index shows this grant as the owner's current authorization.").waitFor({ timeout: 180_000 });
    const { job, ballotId } = await walletVote(K2, "MetaMask (voting key)", "NO", "K2 NO", A.address);
    await expectCounts(job, "K2 NO");
    report.ballots.k2_no = ballotId;
    notes.k2_no = ballotId;
    check((await ballotStatus(pollId, A.owner_id, report.ballots.k1_yes)) === "CANCELLED_BY_CONTROL", "K1 YES cancelled by GRANT+CANCEL");
    check((await ballotStatus(pollId, A.owner_id, ballotId)) === "SELECTED", "K2 NO selected");
  });

  // h. Owner take-over: A's direct CANCEL through Neuron.
  await step("h A direct CANCEL (Neuron)", async (notes) => {
    await openVote("Neuron (copy & paste)", "CANCEL");
    await votePanel().getByLabel("CKB address").fill(A.address);
    await votePanel().getByRole("button", { name: "Use this address" }).click();
    await prepare(votePanel(), votePanel().getByRole("button", { name: /^Prepare 1 ballot\(s\): CANCEL$/ }));
    const job = votePanel().locator(".job").first();
    const ballotId = await signedField(job, "Ballot-Hash");
    check((await signedField(job, "Authority")) === "OWNER (Direct)", "direct ballot");
    await neuronSignIn(job, A, "A CANCEL");
    await expectCounts(job, "A CANCEL");
    report.ballots.a_cancel = ballotId;
    notes.ballot_id = ballotId;
    check((await ballotStatus(pollId, A.owner_id, report.ballots.k2_no)) === "OVERRIDDEN_BY_OWNER", "K2 NO overridden by the owner");
    await balances("after the votes");
  });

  // i. Relay failover: sign B NO, stop the primary before submission, resubmit to the backup.
  await step("i failover to the backup relay", async (notes) => {
    await openVote("MetaMask (owner)", "NO");
    await connectWallet(votePanel(), B);
    const option = votePanel().locator(".owner-option", { hasText: B.address }).locator("input");
    await waitUntil("B owner option", async () => option.isChecked(), { timeoutMs: 30_000, intervalMs: 300 });
    await prepare(votePanel(), votePanel().getByRole("button", { name: /^Prepare 1 ballot\(s\): NO$/ }));
    const job = votePanel().locator(".job").first();
    const ballotId = await signedField(job, "Ballot-Hash");
    notes.ballot_id = ballotId;
    report.ballots.b_no_failover = ballotId;
    wallet.beforeSign = async () => {
      log("  stopping the primary server before the submission");
      await primary.stop();
    };
    await votePanel().getByRole("button", { name: /^Sign 1 ballot\(s\) in the wallet and submit$/ }).click();
    await job.getByText("The relay rejected the submission").waitFor({ timeout: 60_000 });
    const code = (await job.locator(".notice-bad .badge").first().textContent())?.trim();
    check(code === "NETWORK", `submission failed with NETWORK (got ${code})`);
    notes.failed_with = code;
    await shot("failover-submit-failed");
    // Switch the API base to the backup (in-app navigation: the primary is down).
    await navigateInApp("Settings");
    await page.getByLabel("API base URL").fill(BACKUP);
    await page.locator("form", { has: page.getByLabel("API base URL") }).getByRole("button", { name: "Save" }).click();
    await page.getByText("Saved.").first().waitFor();
    await waitUntil("the page to use the backup", async () => (await page.locator(".kv-row", { hasText: "Current" }).first().innerText()).includes(BACKUP), { timeoutMs: 10_000, intervalMs: 250 });
    // Resubmit the kept envelope from the Receipts page.
    await navigateInApp("Receipts");
    await page.locator(`a[href="#/receipt/${ballotId}"]`).first().click();
    const kept = page.locator("section.card", { hasText: "Kept on this device" });
    await kept.waitFor();
    await kept.getByRole("button", { name: "Submit again to the current server" }).click();
    await kept.getByText(/^Submitted: /).waitFor({ timeout: 30_000 });
    notes.resubmitted = (await kept.getByText(/^Submitted: /).textContent()).trim();
    check(await kept.getByText("Receipt signature recovers to the server's published receipt key").first().isVisible(), "backup receipt signer checked");
    check(await kept.getByText("Receipt commits to exactly the envelope bytes you sent").first().isVisible(), "backup receipt commits to the kept envelope");
    await expectCounts(kept, "failover ballot on the backup", { receipt: false });
    const onBackup = (await get(BACKUP, `/api/proposals/${pollId}/ballots?owner=${B.owner_id}`)).ballots.find((b) => b.ballot_id === ballotId);
    check(onBackup?.status === "SELECTED", "backup shows the failover ballot SELECTED");
    const receipt = (await get(BACKUP, `/api/receipts/${ballotId}`)).items[0];
    check(["INCLUDED", "CONFIRMED"].includes(receipt.status), `backup relay included it (${receipt.status})`);
    notes.backup_tx = receipt.tx_hash;
    await shot("failover-backup-selected");
    // Restart the primary: it must show the same ballot as SELECTED.
    await primary.start();
    await waitUntil("the primary to show the failover ballot", async () => (await ballotStatus(pollId, B.owner_id, ballotId)) === "SELECTED", { timeoutMs: 60_000 });
    let primaryReceipt = null;
    try {
      primaryReceipt = (await get(BASE, `/api/receipts/${ballotId}`)).items[0]?.status ?? null;
    } catch (e) {
      primaryReceipt = e.status === 404 ? "unknown to the primary relay" : String(e);
    }
    notes.primary_relay_status = primaryReceipt;
    // Switch back to the same origin and check the UI.
    await navigateInApp("Settings");
    await page.getByRole("button", { name: "Use the same origin" }).click();
    await page.getByText("Using the same origin.").first().waitFor();
    await goto(`/proposal/${pollId}`);
    const row = page.locator("tr", { hasText: ballotId.slice(0, 10) }).first();
    await row.getByText("Selected (counts)").waitFor({ timeout: 60_000 });
  });

  // j. Nobody paid anything.
  await step("j owners and keys hold no ordinary capacity", async () => {
    await balances("after failover");
  });

  // k. Wait until closed and confirmed (AUDITABLE).
  await step("k wait for AUDITABLE", async (notes) => {
    const p = await waitUntil("the poll to become AUDITABLE", async () => {
      const v = await get(BASE, `/api/proposals/${pollId}`);
      if (["FINALIZED_BY_POLICY", "DISPUTED", "EXECUTED"].includes(v.status)) throw new Fail(`unexpected status ${v.status}`);
      return v.status === "AUDITABLE" ? v : null;
    }, { timeoutMs: (PERIOD_MIN + 5) * 60_000, intervalMs: 3000 });
    notes.result_hash = p.result_hash;
    report.result.server_result_hash = p.result_hash;
    await goto(`/proposal/${pollId}`);
    await page.locator(".badge", { hasText: "Closed, in review" }).first().waitFor();
  });

  // l. Committee RESULT_ATTESTATION, 2 of 3 members (Neuron-style key signatures).
  await step("l committee attestation (2 of 3)", async (notes) => {
    await goto("/records");
    const discard = page.getByRole("button", { name: "Discard draft" });
    if (await discard.isVisible().catch(() => false)) await discard.click();
    await page.getByLabel("Record type").selectOption("RESULT_ATTESTATION");
    await page.locator("label.field", { hasText: "Proposal" }).locator("select").selectOption(pollId);
    const resultHash = page.locator("label.field", { hasText: "result_hash" }).locator("input");
    await waitUntil("the result hash prefill", async () => (await resultHash.inputValue()) === report.result.server_result_hash, { timeoutMs: 20_000, intervalMs: 300 });
    notes.outcome = await page.locator("label.field", { hasText: "Outcome" }).locator("select").inputValue();
    await prepare(page.locator("main"), page.getByRole("button", { name: "Build the record" }));
    const draft = page.locator("section.card", { hasText: "Record draft" });
    const hex = (await draft.locator(".signtext-hex pre").first().textContent()).trim();
    const bytes = Buffer.from(hex.slice(2), "hex");
    for (const m of [committee[0], committee[2]]) {
      const sig = await signBytes(m, bytes, "ckb", "RESULT_ATTESTATION");
      const row = page.locator("li.member", { hasText: m.address }).first();
      await row.locator("input.mono").fill(sig);
      await row.getByRole("button", { name: "Verify" }).click();
    }
    const submit = page.getByRole("button", { name: /^Submit \(2\/2 signatures\)$/ });
    await waitUntil("two valid member signatures", async () => submit.isEnabled(), { timeoutMs: 20_000, intervalMs: 300 });
    await submit.click();
    await page.getByText("The record is on chain and indexed.").waitFor({ timeout: 180_000 });
    const p = await waitUntil("the attestation to be confirmed", async () => {
      const v = await get(BASE, `/api/proposals/${pollId}`);
      return v.attestation.state === "CONFIRMED" ? v : null;
    }, { timeoutMs: 60_000 });
    notes.attestation = p.attestation.state;
    await goto(`/proposal/${pollId}`);
    await page.locator(".badge", { hasText: "Committee attested" }).first().waitFor();
  });

  // m. Evidence bundle with chain history, replayed by both verifiers.
  await step("m evidence bundle verified by Rust and TypeScript", async (notes) => {
    await goto(`/proposal/${pollId}`);
    const pageHash = await page.locator('.kv-row:has(dt:text-is("result_hash")) code').first().getAttribute("title");
    check(/^0x[0-9a-f]{64}$/.test(pageHash ?? ""), "result_hash shown on the page");
    const button = page.getByRole("button", { name: "Download with chain history (large)" });
    await button.scrollIntoViewIfNeeded();
    // The history bundle covers every block since genesis: on a dev chain left running
    // for days (170k blocks, 51 MB) building it takes minutes, not seconds.
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 600_000 }), button.click()]);
    const file = join(OUT, "bundle-history.json");
    await download.saveAs(file);
    notes.bundle = file;
    const rust = await omavoteJson(["verify-evidence", "--input", file, "--poll", pollId, "--rpc", RPC], { timeoutMs: 600_000 });
    writeFileSync(join(OUT, "verify-evidence.json"), JSON.stringify(rust, null, 2) + "\n");
    const rustHash = rust.polls.find((x) => x.poll_id === pollId)?.result_hash;
    const { stdout } = await execFileP("node", [join(ROOT, "verifier-ts/dist/cli.js"), "replay", file, "--poll", pollId], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(OUT, "verifier-ts.json"), stdout);
    const tsHash = JSON.parse(stdout).result_hash;
    Object.assign(report.result, { page_result_hash: pageHash, rust_result_hash: rustHash, ts_result_hash: tsHash, completeness: rust.completeness });
    check(rust.recomputed_matches_bundle === true, "verify-evidence: the recomputed result matches the bundle");
    check(/^checked:/.test(rust.completeness), "verify-evidence checked every block against the node");
    check(rustHash === pageHash, `Rust result_hash ${rustHash} = page ${pageHash}`);
    check(tsHash === pageHash, `TypeScript result_hash ${tsHash} = page ${pageHash}`);
    check(pageHash === report.result.server_result_hash, "page result_hash = server result_hash");
  });

  // n. Final per-owner statuses from the API.
  await step("n final statuses", async (notes) => {
    const p = await get(BASE, `/api/proposals/${pollId}`);
    const rows = Object.fromEntries(p.result_core.owners.map((o) => [o.owner_id, o]));
    const a = rows[A.owner_id];
    const b = rows[B.owner_id];
    notes.owner_a = a;
    notes.owner_b = b;
    check(a?.final_status === "CANCEL" && a.ballot_id === report.ballots.a_cancel && a.counted_weight_shannon === "0", "A: direct CANCEL, counted 0");
    check(a.eligible_principal_shannon === String(BigInt(DEPOSIT_A) * SHANNON), "A: eligible principal is the deposit");
    check(b?.final_status === "NO" && b.ballot_id === report.ballots.b_no_failover && b.counted_weight_shannon === String(BigInt(DEPOSIT_B) * SHANNON), "B: failover NO counted with the deposit");
    const statusA = Object.fromEntries((await apiBallots(pollId, A.owner_id)).map((x) => [x.ballot_id, x.status]));
    const statusB = Object.fromEntries((await apiBallots(pollId, B.owner_id)).map((x) => [x.ballot_id, x.status]));
    const expected = {
      [report.ballots.k1_yes]: ["A", "OVERRIDDEN_BY_OWNER"],
      [report.ballots.k2_no]: ["A", "OVERRIDDEN_BY_OWNER"],
      [report.ballots.a_cancel]: ["A", "SELECTED"],
      [report.ballots.b_no]: ["B", "SUPERSEDED"],
      [report.ballots.b_yes]: ["B", "SUPERSEDED"],
      [report.ballots.b_no_failover]: ["B", "SELECTED"],
    };
    notes.ballot_statuses = {};
    for (const [id, [owner, want]] of Object.entries(expected)) {
      const got = (owner === "A" ? statusA : statusB)[id];
      notes.ballot_statuses[id] = got;
      check(got === want, `ballot ${id.slice(0, 12)} of ${owner}: ${want} (got ${got})`);
    }
    check(p.result_core.yes_shannon === "0" && p.result_core.no_shannon === String(BigInt(DEPOSIT_B) * SHANNON), "tally YES 0, NO = B's deposit");
    check(p.result_core.outcome === "FAIL" && p.tally.kind === "FINAL" && p.tally.outcome === "FAIL", "outcome FAIL");
    check(p.admission.state === "ADMITTED" && p.attestation.state === "CONFIRMED", "admitted and attested");
    Object.assign(report.result, { outcome: p.result_core.outcome, yes_shannon: p.result_core.yes_shannon, no_shannon: p.result_core.no_shannon, status: p.status });
    await balances("at the end");
  });
}

// ---------------------------------------------------------------------------
// Signer extension scenario (DEVICE=extension, docs/19 §12)

async function extensionScenario({ A, C, coordinator }) {
  const pollId = await createProposal(A);
  await admitProposal(pollId, coordinator);

  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  const extUrl = (path) => `chrome-extension://${new URL(sw.url()).host}/${path}`;
  const PASSWORD = "e2e password for the signer";
  const EXT_TAB = "Omavote extension (voting key)";
  const votePanel = () => page.locator("#vote");
  const keys = [];

  /** The toolbar popup, opened as a tab (Playwright cannot click the toolbar). */
  async function inPopup(fn) {
    const p = await context.newPage();
    try {
      await p.goto(extUrl("popup.html"));
      await p.locator("header.top").waitFor();
      return await fn(p);
    } finally {
      await p.close();
      await page.bringToFront();
    }
  }

  /** Trigger a request, inspect the extension's confirmation window, approve it. */
  async function approveIn(trigger, inspect) {
    const opened = context.waitForEvent("page", { predicate: (p) => p.url().startsWith(extUrl("confirm.html")), timeout: 30_000 });
    await trigger();
    const win = await opened;
    await win.bringToFront();
    await win.locator(".actions").waitFor();
    await inspect(win);
    await shot(`extension-confirm-${keys.length}`);
    await win.screenshot({ path: join(OUT, "shots", `extension-window-${Date.now()}.png`), fullPage: true }).catch(() => {});
    const approve = win.locator(".actions .btn-primary, .actions .btn.primary").first();
    await waitUntil("the confirm button to arm", async () => approve.isEnabled(), { timeoutMs: 10_000, intervalMs: 200 });
    const closed = win.waitForEvent("close", { timeout: 60_000 });
    await approve.click();
    await closed;
    await page.bringToFront();
  }

  async function createKey(name) {
    const address = await inPopup(async (p) => {
      await p.getByLabel("Password (at least 12 characters)").fill(PASSWORD);
      await p.getByLabel("Repeat the password").fill(PASSWORD);
      await p.getByRole("button", { name: "Create key" }).click();
      await p.getByText("Unlocked for signing").waitFor();
      return (await p.locator(".address").textContent()).trim();
    });
    check(/^ckt1q/.test(address), `the extension shows a CKB address for its key (${address})`);
    keys.push(address);
    report.identities[name] = { kind: "extension voting key (secp256k1)", address, check_addresses: [address] };
    log(`  ${name}: ${address}`);
    return address;
  }

  async function connectSite(address) {
    await goto(`/proposal/${pollId}`);
    await votePanel().getByRole("tab", { name: EXT_TAB }).click();
    const button = votePanel().getByRole("button", { name: "Connect the Omavote extension" });
    await button.waitFor();
    await approveIn(() => button.click(), async (win) => {
      await win.getByText("Connect to this site?").waitFor();
      check(await win.locator(".origin", { hasText: BASE }).isVisible(), "the confirmation shows the requesting origin");
      check(await win.getByText(address).first().isVisible(), "the confirmation shows the key address");
    });
    await votePanel().locator(".walletbar-connected", { hasText: address }).waitFor();
  }

  async function grantToExtension(owner, mode) {
    await goto(`/address/${owner.address}`);
    const panel = page.locator(".control-panel").first();
    if (mode === "GRANT") await panel.getByRole("button", { name: "Use the Omavote extension's key" }).click();
    else await panel.getByRole("button", { name: "New extension key: cancel the old key's ballots" }).click();
    await page.getByLabel("30 days").check();
    await prepare(panel, panel.getByRole("button", { name: mode === "GRANT" ? "Prepare GRANT" : "Prepare GRANT + CANCEL" }));
    const summary = (await panel.locator(".signtext-summary-text").textContent()).trim();
    const word = mode === "GRANT" ? "GRANT" : "GRANT+CANCEL";
    check(new RegExp(`^OMAVOTE ${word.replace("+", "\\+")} ckt1\\.\\.[0-9a-z]{16} TO \\d{4}-\\d{2}-\\d{2}$`).test(summary), `${word} summary names the extension key (${summary})`);
    check(keys.at(-1).endsWith(summary.split(" ")[2].slice(6)), "the GRANT summary matches the key the extension shows");
    const authorizationId = await signedField(panel, "Authorization-Hash");
    await neuronSignIn(panel, owner, `${word} to the extension key`);
    await panel.getByText("In effect: the index shows this grant as the owner's current authorization.").waitFor({ timeout: 180_000 });
    return authorizationId;
  }

  async function extensionVote(choice, owners, what) {
    await goto(`/proposal/${pollId}`);
    await votePanel().getByRole("tab", { name: EXT_TAB }).click();
    await votePanel().locator(`.choices input[value="${choice}"]`).check();
    await votePanel().locator(".walletbar-connected").waitFor();
    for (const o of owners) {
      const option = votePanel().locator(".owner-option", { hasText: o.address }).locator("input");
      await waitUntil(`${what}: owner option for ${o.name}`, async () => option.isChecked(), { timeoutMs: 30_000, intervalMs: 300 });
    }
    check((await votePanel().locator(".owner-option").count()) === owners.length, `${what}: only the owners that authorized this key are listed`);
    await prepare(votePanel(), votePanel().getByRole("button", { name: new RegExp(`^Prepare ${owners.length} ballot\\(s\\): ${choice}$`) }));
    const ids = {};
    for (const o of owners) {
      const job = votePanel().locator(".job", { hasText: o.address });
      ids[o.name] = await signedField(job, "Ballot-Hash");
      check((await signedField(job, "Authority")) === "DELEGATE (Voting key)", `${what}: delegate ballot for ${o.name}`);
    }
    await approveIn(
      () => votePanel().getByRole("button", { name: new RegExp(`^Sign ${owners.length} ballot\\(s\\) in the Omavote extension and submit$`) }).click(),
      async (win) => {
        await win.getByText("Sign delegate ballots").waitFor();
        check(await win.getByText(`#${pollId.slice(2, 18)}`).first().isVisible(), `${what}: the confirmation shows the proposal number`);
        check((await win.locator(".choice").textContent()).startsWith(choice), `${what}: the confirmation shows the choice`);
        check((await win.locator(".owners li").count()) === owners.length, `${what}: the confirmation lists exactly ${owners.length} address(es)`);
        for (const o of owners) check((await win.locator(".owners li", { hasText: o.address }).count()) === 1, `${what}: the confirmation lists ${o.name}`);
      },
    );
    for (const o of owners) await expectCounts(votePanel().locator(".job", { hasText: o.address }), `${what} (${o.name})`);
    return ids;
  }

  await step("x1 extension: create a key", async (notes) => {
    notes.address = await createKey("EXT1");
    await goto(`/proposal/${pollId}`);
    check(await page.evaluate(() => window.omavote?.isOmavoteSigner === true && Object.isFrozen(window.omavote)), "window.omavote is injected and frozen on the official devnet origin");
    check(await page.evaluate(() => typeof chrome === "undefined" || !chrome.runtime?.sendMessage), "the page has no channel to the extension except window.omavote");
  });

  await step("x2 extension: connect the site", async () => {
    await connectSite(keys[0]);
  });

  await step("x3 owners A and C grant the extension key (Neuron)", async (notes) => {
    notes.grant_a = await grantToExtension(A, "GRANT");
    notes.grant_c = await grantToExtension(C, "GRANT");
  });

  await step("x4 wait for OPEN", async () => {
    const p = await waitUntil("the poll to open", async () => {
      const v = await get(BASE, `/api/proposals/${pollId}`);
      if (["LATE_MANIFEST", "DISPUTED"].includes(v.status)) throw new Fail(`poll became ${v.status}`);
      return v.status === "OPEN" ? v : null;
    }, { timeoutMs: START_LEAD_MS + 180_000, intervalMs: 2000 });
    check(p.admission.state === "ADMITTED", `admission ADMITTED (got ${JSON.stringify(p.admission)})`);
  });

  let first;
  await step("x5 extension YES for A and C in one confirmation", async (notes) => {
    first = await extensionVote("YES", [A, C], "extension YES");
    Object.assign(notes, first);
    report.ballots.ext_yes_a = first.A;
    report.ballots.ext_yes_c = first.C;
    check((await ballotStatus(pollId, A.owner_id, first.A)) === "SELECTED", "A's delegate YES selected");
    check((await ballotStatus(pollId, C.owner_id, first.C)) === "SELECTED", "C's delegate YES selected");
  });

  await step("x6 reset the extension key and connect again", async (notes) => {
    await inPopup(async (p) => {
      await p.getByText("Reset key", { exact: true }).click();
      await p.getByLabel("I understand that the current key will be deleted.").check();
      await p.getByRole("button", { name: "Delete the key" }).click();
      await p.getByRole("heading", { name: "Create your voting key" }).waitFor();
    });
    // The reset disconnects every site; the open page learns it from omavote:changed.
    await votePanel().getByRole("button", { name: "Connect the Omavote extension" }).waitFor({ timeout: 20_000 });
    notes.address = await createKey("EXT2");
    check(keys[1] !== keys[0], "the reset produced a new key");
    await connectSite(keys[1]);
  });

  await step("x7 A re-authorizes the new key with GRANT+CANCEL; the new key votes NO", async (notes) => {
    notes.authorization_id = await grantToExtension(A, "GRANT + CANCEL");
    const second = await extensionVote("NO", [A], "new key NO");
    report.ballots.ext2_no_a = second.A;
    notes.ballot_id = second.A;
    check((await ballotStatus(pollId, A.owner_id, first.A)) === "CANCELLED_BY_CONTROL", "the old key's ballot for A was cancelled by GRANT+CANCEL");
    check((await ballotStatus(pollId, A.owner_id, second.A)) === "SELECTED", "the new key's NO for A is selected");
    check((await ballotStatus(pollId, C.owner_id, first.C)) === "SELECTED", "C's ballot (old key, still authorized) is untouched");
    await balances("after the extension votes");
  });
}

// ---------------------------------------------------------------------------

process.on("SIGINT", async () => {
  await primary.stop().catch(() => {});
  await backup.stop().catch(() => {});
  process.exit(130);
});

try {
  log(`run ${RUN} (${DEVICE}) → ${OUT}`);
  await main();
} catch (e) {
  report.failure ??= String(e?.stack ?? e);
  log(`FAILED: ${e?.message ?? e}`);
} finally {
  await primary.stop().catch(() => {});
  await backup.stop().catch(() => {});
  report.finished_at = new Date().toISOString();
  report.duration_s = Math.round((Date.now() - t0) / 1000);
  saveReport();
  log(`${report.ok ? "PASS" : "FAIL"} in ${report.duration_s} s; report ${join(OUT, "report.json")}`);
  runLog.end();
}
process.exit(report.ok ? 0 : 1);
