#!/usr/bin/env node
/**
 * omavote-verifier-ts CLI
 *
 *   node dist/cli.js replay <file.json> [--poll <poll_id>] [--verbose]
 *   node dist/cli.js check-vectors <vectors_dir> [--quiet]
 */
import { readFileSync } from "node:fs";
import { InputError } from "./errors.js";
import { jcs, type JsonValue } from "./json.js";
import { buildReport, runReplay } from "./replay.js";
import { parseReplayInput } from "./replay-input.js";
import { checkVectorsDir } from "./vectors.js";

const USAGE = `usage:
  node dist/cli.js replay <file.json | -> [--poll <poll_id>] [--verbose] [--canonical]
  node dist/cli.js check-vectors <vectors_dir> [--quiet]

replay         replays a block dump shaped like vectors/replay.json (without "expected")
               and prints result_core, result_hash, admission, attestation per poll
  --poll       print only that poll (same shape as vectors/replay.json "expected")
  --verbose    add positions and messages to diagnostics
  --canonical  print RFC 8785 JCS instead of indented JSON
check-vectors  verifies every *.json file in the directory; exits 1 on any mismatch`;

/** Pretty JSON with the key order of the report objects (the result_core itself is hashed in JCS form). */
function print(v: JsonValue, canonical: boolean): void {
  process.stdout.write(`${canonical ? jcs(v) : JSON.stringify(v, null, 2)}\n`);
}

function replayCommand(args: string[]): number {
  let file: string | undefined;
  let pollId: string | undefined;
  let verbose = false;
  let canonical = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--poll") pollId = args[++i];
    else if (a === "--verbose") verbose = true;
    else if (a === "--canonical") canonical = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    } else if (!file) file = a;
    else {
      process.stderr.write(`unexpected argument ${a}\n${USAGE}\n`);
      return 2;
    }
  }
  if (!file || (pollId !== undefined && !/^0x[0-9a-f]{64}$/.test(pollId))) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const input = parseReplayInput(readFileSync(file === "-" ? 0 : file, "utf8"));
    const engine = runReplay(input);
    const report = buildReport(engine, pollId === undefined ? { verbose } : { pollId, verbose });
    if (report === null) {
      process.stderr.write(`poll ${pollId} is not registered in this history\n`);
      return 1;
    }
    print(report, canonical);
    return 0;
  } catch (e) {
    if (e instanceof InputError) {
      process.stderr.write(`input error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

function checkVectorsCommand(args: string[]): number {
  const quiet = args.includes("--quiet");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const results = checkVectorsDir(dir);
  const byFile = new Map<string, { pass: number; fail: number }>();
  for (const r of results) {
    const s = byFile.get(r.file) ?? { pass: 0, fail: 0 };
    if (r.ok) s.pass++;
    else s.fail++;
    byFile.set(r.file, s);
    if (!r.ok) process.stdout.write(`FAIL ${r.file} :: ${r.name}: ${r.detail ?? ""}\n`);
    else if (!quiet) process.stdout.write(`ok   ${r.file} :: ${r.name}\n`);
  }
  let failures = 0;
  for (const [file, s] of byFile) {
    process.stdout.write(`${file}: ${s.pass} passed, ${s.fail} failed\n`);
    failures += s.fail;
  }
  process.stdout.write(failures === 0 ? `all ${results.length} vector checks passed\n` : `${failures} of ${results.length} vector checks FAILED\n`);
  return failures === 0 ? 0 : 1;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "replay") return replayCommand(rest);
  if (cmd === "check-vectors") return checkVectorsCommand(rest);
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
