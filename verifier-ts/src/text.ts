/**
 * Readable signing texts (docs/03 §3.1, §5; docs/11 §3–§4.1).
 *
 * All texts: UTF-8, LF line endings, no trailing newline, first line an
 * ASCII summary of at most 60 bytes, second line a fixed title, then exactly
 * one empty line, then `Field: value` lines with no further empty lines.
 */
import { eip55 } from "./adapter.js";
import { bytesToHex } from "./bytes.js";
import { SchemaError } from "./errors.js";
import { blake160 } from "./hash.js";
import { jcs } from "./json.js";
import { fullAddress, type ScriptJson } from "./molecule.js";
import type { Network } from "./network.js";
import { MAX_RENDERABLE_MS, type BallotBody, type ControlBody, type KeyDescriptor, type Manifest, type ProcessRecord } from "./schema.js";

const SHANNON_PER_CKB = 100_000_000n;

/** Exact decimal CKB: integer part without leading zeros, up to 8 fraction digits, trailing zeros removed. */
export function renderCkbExact(shannon: bigint): string {
  if (shannon < 0n) throw new Error("negative amount");
  const intPart = shannon / SHANNON_PER_CKB;
  const frac = shannon % SHANNON_PER_CKB;
  if (frac === 0n) return intPart.toString();
  return `${intPart}.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
}

/** UTC rendering `YYYY-MM-DDTHH:mm:ss.SSSZ`, years 0001–9999 (docs/03 §5 rule 5). */
export function renderUtc(ms: bigint): string {
  if (ms < 0n || ms > MAX_RENDERABLE_MS) throw new SchemaError(`time ${ms} is outside the renderable range`);
  const s = new Date(Number(ms)).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) throw new SchemaError(`time ${ms} is not renderable`);
  return s;
}

export function renderUtcDate(ms: bigint): string {
  return renderUtc(ms).slice(0, 10);
}

function budgetLine(m: Manifest): string {
  return m.proposalType === "meta_rule" ? "none" : renderCkbExact(m.budgetShannon);
}

function recipientLine(m: Manifest, network: Network): string {
  return m.proposalType === "meta_rule" || m.recipient === null ? "none" : fullAddress(m.recipient, network.hrp);
}

/** Budget summary for first lines: integer CKB + "CKB" (0CKB below 1 CKB), or META-RULE. */
export function budgetSummary(m: Manifest): string {
  return m.proposalType === "meta_rule" ? "META-RULE" : `${m.budgetShannon / SHANNON_PER_CKB}CKB`;
}

function short16(hash: string): string {
  return hash.slice(2, 18);
}

function checkSummary(line: string): string {
  if (Buffer.byteLength(line, "utf8") > 60 || !/^[\x20-\x7e]*$/.test(line)) {
    throw new SchemaError(`first line ${JSON.stringify(line)} is not printable ASCII of at most 60 bytes`);
  }
  return line;
}

function assemble(summary: string, title: string, fields: Array<[string, string]>): string {
  const lines = [checkSummary(summary), title, ""];
  for (const [k, v] of fields) {
    if (/[\r\n]/.test(v)) throw new SchemaError(`field ${k} would span several lines`);
    lines.push(`${k}: ${v}`);
  }
  return lines.join("\n");
}

/** Ballot text, format omavote-readable-v2 (docs/03 §5). */
export function ballotText(m: Manifest, b: BallotBody, network: Network): string {
  const choice = { YES: "YES (Approve)", NO: "NO (Reject)", CANCEL: "CANCEL (Withdraw vote)" }[b.action];
  return assemble(`OMAVOTE VOTE ${b.action} #${short16(m.pollId)} ${budgetSummary(m)}`, "OMAVOTE V2 - VOTE ONLY, NO ASSET TRANSFER", [
    ["Format", "omavote-readable-v2"],
    ["DAO", m.daoNamespace],
    ["Network-Genesis", m.genesisHash],
    ["Proposal", m.pollId],
    ["Title", m.signingTitle],
    ["Budget-CKB", budgetLine(m)],
    ["Recipient", recipientLine(m, network)],
    ["Choice", choice],
    ["Owner", fullAddress(b.ownerLock, network.hrp)],
    ["Authority", b.authority === "owner" ? "OWNER (Direct)" : "DELEGATE (Voting key)"],
    ["Authorization", b.authorizationId ?? "none"],
    ["Signer-Key", b.signerKeyId ?? "none"],
    ["Anchor-Block", b.anchor],
    ["Clock", "ckb-parent-mtp-v1"],
    ["End-Chain-Time-UTC", renderUtc(m.endMs)],
    ["Rules-Hash", m.rulesHash],
    ["Ballot-Hash", b.ballotId],
  ]);
}

/** Proposal text for one proposer lock, format omavote-proposal-v2 (docs/03 §3.1). */
export function proposalText(m: Manifest, proposer: ScriptJson, network: Network): string {
  return assemble(`OMAVOTE PROPOSE #${short16(m.pollId)} ${budgetSummary(m)}`, "OMAVOTE V2 - PROPOSAL SUBMISSION, NO ASSET TRANSFER", [
    ["Format", "omavote-proposal-v2"],
    ["DAO", m.daoNamespace],
    ["Network-Genesis", m.genesisHash],
    ["Proposal", m.pollId],
    ["Type", m.proposalType === "grant" ? "FUNDING" : "META-RULE"],
    ["Title", m.signingTitle],
    ["Budget-CKB", budgetLine(m)],
    ["Recipient", recipientLine(m, network)],
    ["Start-Chain-Time-UTC", renderUtc(m.startMs)],
    ["End-Chain-Time-UTC", renderUtc(m.endMs)],
    ["Proposer", fullAddress(proposer, network.hrp)],
    ["Rules-Hash", m.rulesHash],
  ]);
}

/** Wallet-visible key address (docs/11 §4.1 table, column key_display). */
export function keyDisplay(k: KeyDescriptor, network: Network): string {
  if (k.kind === "secp256k1") {
    const lock: ScriptJson = {
      code_hash: network.secp256k1.code_hash,
      hash_type: network.secp256k1.hash_type,
      args: bytesToHex(blake160(k.publicKey as Uint8Array)),
    };
    return fullAddress(lock, network.hrp);
  }
  if (k.kind === "evm_eoa") return eip55(k.address as string);
  return `passkey ${k.keyId}`;
}

/** short() of docs/11 §4.1. */
export function shortKeyDisplay(k: KeyDescriptor, network: Network): string {
  const d = keyDisplay(k, network);
  if (k.kind === "secp256k1") return `${d.slice(0, 4)}..${d.slice(-16)}`;
  if (k.kind === "evm_eoa") return `${d.slice(0, 10)}..${d.slice(-8)}`;
  return `PASSKEY ${k.keyId.slice(2, 18)}`;
}

/** Authorization control text, format omavote-authorization-v2 (docs/11 §3). */
export function controlText(c: ControlBody, network: Network): string {
  let summary: string;
  if (c.action === "GRANT") {
    const k = c.keyDescriptor as KeyDescriptor;
    const verb = c.revokeMode === "STOP_AND_CANCEL_OPEN" ? "GRANT+CANCEL" : "GRANT";
    summary = `OMAVOTE ${verb} ${shortKeyDisplay(k, network)} TO ${renderUtcDate(c.expiresAtMs as bigint)}`;
  } else {
    summary = c.revokeMode === "STOP_ONLY" ? "OMAVOTE REVOKE STOP-ONLY" : "OMAVOTE REVOKE STOP+CANCEL-OPEN";
  }
  const k = c.keyDescriptor;
  return assemble(summary, "OMAVOTE V2 - VOTING AUTHORIZATION ONLY, NO ASSET TRANSFER", [
    ["Format", "omavote-authorization-v2"],
    ["DAO", c.raw["dao_namespace"] as string],
    ["Network-Genesis", c.raw["network_genesis_hash"] as string],
    ["Owner", fullAddress(c.ownerLock, network.hrp)],
    ["Action", c.action],
    ["Key-Address", k ? keyDisplay(k, network) : "none"],
    ["Key-Descriptor", k ? jcs(k.raw) : "none"],
    ["Key-ID", k ? k.keyId : "none"],
    ["Expires-Chain-Time-UTC", c.expiresAtMs === null ? "none" : renderUtc(c.expiresAtMs)],
    ["Revoke-Mode", c.revokeMode ?? "none"],
    ["Anchor-Block", c.anchor],
    ["Publish-Before-Chain-Time-UTC", renderUtc(c.deadlineMs)],
    ["Policy-Hash", c.policyHash],
    ["Authorization-Hash", c.authorizationId],
  ]);
}

const RECORD_WORD: Record<string, string> = {
  ADMISSION: "ADMIT",
  NOTICE: "NOTICE",
  GOVERNANCE_STATUS: "STATUS",
  RESULT_ATTESTATION: "RESULT",
  EXECUTION: "EXECUTION",
  ROLES_UPDATE: "ROLES-UPDATE",
};

/** Process record text, format omavote-process-v2 (docs/03 §3.1). */
export function processText(r: ProcessRecord): string {
  const value = r.summaryValue === null ? "" : ` ${r.summaryValue}`;
  return assemble(`OMAVOTE ${RECORD_WORD[r.recordType]} #${short16(r.scopeId)}${value}`, "OMAVOTE V2 - PROCESS RECORD, NO ASSET TRANSFER", [
    ["Format", "omavote-process-v2"],
    ["DAO", r.raw["dao_namespace"] as string],
    ["Network-Genesis", r.raw["network_genesis_hash"] as string],
    ["Record-Type", r.recordType],
    ["Role", r.role === "coordinator" ? "COORDINATOR" : "COMMITTEE"],
    ["Proposal", r.pollId ?? "none"],
    ["Detail", jcs(r.detail)],
    ["Evidence-Hash", r.evidenceHash ?? "none"],
    ["Anchor-Block", r.anchor],
    ["Publish-Before-Chain-Time-UTC", renderUtc(r.deadlineMs)],
    ["Roles-Hash", r.rolesHash],
    ["Record-Hash", r.recordId],
  ]);
}
