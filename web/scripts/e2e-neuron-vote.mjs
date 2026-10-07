// End-to-end browser vote on a development chain, Neuron copy-paste path:
// open the proposal, prepare the ballot for a funded development owner, read the
// exact bytes the page shows, sign them as Neuron would (`omavote sign`), paste the
// signature, submit, and wait until the ballot is included and SELECTED.
//
// Usage: node web/scripts/e2e-neuron-vote.mjs <base-url> <open.json> <out-dir> [omavote-binary]
// <open.json> comes from `omavote demo --open-only` (development keys only).
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const [base, openFile, outDir, bin = "target/debug/omavote"] = process.argv.slice(2);
if (!base || !openFile || !outDir) {
  console.error("usage: e2e-neuron-vote.mjs <base-url> <open.json> <out-dir> [omavote-binary]");
  process.exit(2);
}
const open = JSON.parse(readFileSync(openFile, "utf8"));
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path) => (await fetch(`${base}${path}`)).json();

const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  "chromium",
  ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${outDir}/profile`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1280,2200", "about:blank"],
  { stdio: "ignore" },
);
let target;
for (let i = 0; i < 50 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
  } catch {}
  await sleep(200);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Runtime.exceptionThrown" || (msg.method === "Log.entryAdded" && msg.params.entry.level === "error")) {
    consoleErrors.push(JSON.stringify(msg.params).slice(0, 400));
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.result?.value;
const shot = async (name) => {
  const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(s.result.data, "base64"));
};
const waitFor = async (what, expression, timeoutMs = 30000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await evaluate(expression);
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const helpers = `
  const setValue = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const button = (re) => [...document.querySelectorAll('button')].find(b => re.test(b.textContent));
`;
const steps = [];
const result = { ok: false, poll_id: open.poll_id, owner_id: open.owner.owner_id, steps, console_errors: consoleErrors };
try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url: base });
  await sleep(1500);
  await evaluate(`localStorage.setItem("omavote.lang", "en"); true`);
  await send("Page.navigate", { url: `${base}/#/proposal/${open.poll_id}` });
  await waitFor("the proposal page", `!!document.querySelector('.vote')`);
  await shot("1-proposal");

  steps.push(await evaluate(`(() => { ${helpers} const b = button(/Neuron/); if (!b) return 'no neuron tab'; b.click(); return 'neuron tab'; })()`));
  await sleep(500);
  steps.push(await evaluate(`(() => { ${helpers} const i = document.querySelector('.vote .inline-form input'); if (!i) return 'no address input'; setValue(i, ${JSON.stringify(open.owner.address)}); return 'address typed'; })()`));
  await sleep(300);
  steps.push(await evaluate(`(() => { const b = [...document.querySelectorAll('.vote .inline-form button')][0]; if (!b) return 'no use button'; b.click(); return 'address used'; })()`));
  await waitFor("the prepare button", `!!document.querySelector('.vote .runner > button.btn-primary')`);
  steps.push(await evaluate(`(() => { const b = document.querySelector('.vote .runner > button.btn-primary'); b.click(); return 'prepare: ' + b.textContent.trim(); })()`));
  const hex = await waitFor("the ballot bytes", `document.querySelector('.signtext-hex pre')?.textContent || ''`, 60000);
  const summary = await evaluate(`document.querySelector('.signtext-summary-text')?.textContent ?? null`);
  steps.push(`summary: ${summary}`);
  await shot("2-ballot-text");

  // Sign exactly the bytes shown, as Neuron's Sign/Verify Message would.
  const bytes = Buffer.from(hex.replace(/^0x/, "").replace(/\s+/g, ""), "hex");
  const textFile = join(outDir, "ballot.txt");
  writeFileSync(textFile, bytes);
  const keyFile = join(outDir, "owner.key");
  writeFileSync(keyFile, `${open.owner.dev_secret}\n`);
  chmodSync(keyFile, 0o600);
  const signature = execFileSync(bin, ["sign", "--key", keyFile, "--format", "ckb", "--text-file", textFile]).toString().trim();
  steps.push(`signed ${bytes.length} bytes`);

  await waitFor("the signature box", `!!document.querySelector('.neuron textarea')`);
  steps.push(await evaluate(`(() => { ${helpers} const t = document.querySelector('.neuron textarea'); setValue(t, ${JSON.stringify(signature)}); return 'signature pasted'; })()`));
  await sleep(300);
  steps.push(await evaluate(`(() => { const b = document.querySelector('.neuron button.btn-primary'); if (!b || b.disabled) return 'submit disabled'; b.click(); return 'submitted: ' + b.textContent.trim(); })()`));
  await sleep(3000);
  await shot("3-submitted");

  // The ballot must become the owner's current selection in the indexed state.
  const end = Date.now() + 120000;
  let selected = null;
  while (Date.now() < end && !selected) {
    const v = await api(`/api/proposals/${open.poll_id}/ballots?owner=${open.owner.owner_id}`);
    selected = (v.ballots ?? []).find((b) => b.status === "SELECTED") ?? null;
    if (!selected) await sleep(1500);
  }
  if (!selected) throw new Error("ballot not SELECTED within 120 s");
  result.ballot_id = selected.ballot_id;
  result.tx_hash = selected.tx_hash;
  steps.push(`SELECTED in tx ${selected.tx_hash}`);
  // Let the page's own tracker catch up, then record what it shows.
  await sleep(8000);
  result.page_tracker = await evaluate(`(document.querySelector('.tracker') || document.querySelector('.vote'))?.innerText.slice(0, 1200) ?? null`);
  await shot("4-tracked");
  result.ok = consoleErrors.length === 0;
} catch (e) {
  result.error = String(e);
  await shot("error").catch(() => {});
}
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
ws.close();
chrome.kill();
process.exit(result.ok ? 0 : 1);
