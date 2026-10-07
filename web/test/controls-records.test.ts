import { describe, expect, it } from "vitest";
import {
  ADAPTER_CKB,
  ADAPTER_EVM,
  anchorAbove,
  controlAnchorFloor,
  controlBody,
  controlEnvelope,
  fetchControlFloor,
  grantExpiry,
  lookupControl,
  manifestPayload,
  parseKeyInput,
  prepareControl,
  prepareRecord,
  processEnvelope,
  recordBody,
  recordDetail,
  roleMembers,
  signingTitleProblem,
  signRequest,
  submitEnvelope,
  validMemberSignatures,
  verifyOwnerSig,
  waitForControl,
  waitForPoll,
  waitForRecord,
  waitForRelay,
  walletSigner,
  FlowError,
  type ProposerSignature,
} from "../src/lib/flow";
import type { ProcessRoles } from "../src/lib/types";
import { buildManifest, makeFixture, noSleep, secpLock } from "./helpers/fixture";
import { compressedPubkey, MockEip1193, neuronSign, testSecret } from "./helpers/keys";
import { CONTROL_FIELDS, RECORD_FIELDS, sortedKeys } from "./helpers/mock-server";

const fast = { intervalMs: 0, sleep: noSleep, timeoutMs: 5_000 };

describe("authorization controls (GRANT, GRANT+CANCEL, REVOKE)", () => {
  it("builds a GRANT with expires = anchor clock + term, signs it with an EVM owner and confirms it in effect", async () => {
    const f = makeFixture();
    const owner = new MockEip1193(testSecret("grant-owner"));
    const lock = f.core.evmOwnerLocks(f.network, owner.address)[0]!;
    const keyWallet = new MockEip1193(testSecret("online-key"));
    const descriptor = parseKeyInput(keyWallet.address.toUpperCase().replace("0X", "0x"))!;
    expect(descriptor).toEqual({ kind: "evm_eoa", address: keyWallet.address, adapter: ADAPTER_EVM });
    const key = f.core.key(descriptor, f.network);

    const { floor, stream } = await fetchControlFloor(f.api, lock.owner_id, f.server.policy.hash, null);
    expect(floor).toBeNull();
    expect(stream.history).toEqual([]);
    const anchor = await anchorAbove(f.api, floor, fast);
    const body = controlBody({
      genesis: f.network.genesis_hash,
      policyHash: f.server.policy.hash,
      ownerLock: lock.script,
      ownerAdapter: ADAPTER_EVM,
      action: "GRANT",
      keyDescriptor: descriptor,
      expiresAtMs: grantExpiry(anchor.clock_ms, 365),
      revokeMode: null,
      anchorHash: anchor.hash,
      publicationDeadlineMs: anchor.control_publication_deadline_ms,
      nonce: f.core.nonce(),
    });
    expect(sortedKeys(body)).toEqual(CONTROL_FIELDS);
    expect(BigInt(body.expires_at_ms!) - BigInt(anchor.clock_ms)).toBe(365n * 86_400_000n);
    const p = prepareControl(f.core, f.network, body);
    const date = new Date(Number(body.expires_at_ms)).toISOString().slice(0, 10);
    expect(p.summary).toBe(`OMAVOTE GRANT ${key.key_short} TO ${date}`);
    expect(p.summary.length).toBeLessThanOrEqual(60);
    expect(p.text.split("\n")[1]).toBe("OMAVOTE V2 - VOTING AUTHORIZATION ONLY, NO ASSET TRANSFER");
    expect(p.text).toContain(`Key-Address: ${key.key_display}`);
    expect(p.text).toContain(`Authorization-Hash: ${p.authorizationId}`);

    const sig = await walletSigner(owner, owner.address)(p);
    expect(verifyOwnerSig(f.core, f.network, ADAPTER_EVM, lock.script, p.text, sig).ok).toBe(true);
    const env = controlEnvelope(p.body, sig);
    expect(sortedKeys(env)).toEqual(["body", "proof"]);
    const out = await submitEnvelope(f.core, f.api, env);
    expect(out.ok).toBe(true);
    await waitForRelay(f.api, p.authorizationId, fast);
    const look = await waitForControl(f.api, lock.owner_id, f.server.policy.hash, p.authorizationId, fast);
    expect(look.outcome).toBe("EFFECTIVE");

    // The next control must anchor strictly above this one.
    const again = await fetchControlFloor(f.api, lock.owner_id, f.server.policy.hash, null);
    expect(again.floor).toBe(BigInt(anchor.number));
    expect(controlAnchorFloor(again.stream, { number: (BigInt(anchor.number) + 5n).toString() })).toBe(BigInt(anchor.number) + 5n);
  });

  it("renders GRANT+CANCEL and both REVOKE modes, signed with Neuron", async () => {
    const f = makeFixture();
    const secret = testSecret("neuron-owner");
    const lock = secpLock(f.core, f.network, secret);
    const anchor = await anchorAbove(f.api, null, fast);
    const base = {
      genesis: f.network.genesis_hash,
      policyHash: f.server.policy.hash,
      ownerLock: lock.script,
      ownerAdapter: ADAPTER_CKB,
      anchorHash: anchor.hash,
      publicationDeadlineMs: anchor.control_publication_deadline_ms,
      nonce: f.core.nonce(),
    };
    const pubkey = compressedPubkey(testSecret("secp-voting-key"));
    const desc = parseKeyInput(pubkey)!;
    expect(desc).toEqual({ kind: "secp256k1", public_key: pubkey, adapter: ADAPTER_CKB });
    const grantCancel = prepareControl(
      f.core,
      f.network,
      controlBody({ ...base, action: "GRANT", keyDescriptor: desc, expiresAtMs: grantExpiry(anchor.clock_ms, 30), revokeMode: "STOP_AND_CANCEL_OPEN" }),
    );
    expect(grantCancel.summary).toMatch(/^OMAVOTE GRANT\+CANCEL ckt1\.\.[a-z0-9]{16} TO \d{4}-\d{2}-\d{2}$/);
    const stopOnly = prepareControl(f.core, f.network, controlBody({ ...base, action: "REVOKE", keyDescriptor: desc, expiresAtMs: "1", revokeMode: "STOP_ONLY" }));
    // REVOKE carries no key and no expiry even if the caller passed them.
    expect(stopOnly.body.key_descriptor).toBeNull();
    expect(stopOnly.body.expires_at_ms).toBeNull();
    expect(stopOnly.summary).toBe("OMAVOTE REVOKE STOP-ONLY");
    const cancel = prepareControl(f.core, f.network, controlBody({ ...base, action: "REVOKE", keyDescriptor: null, expiresAtMs: null, revokeMode: "STOP_AND_CANCEL_OPEN" }));
    expect(cancel.summary).toBe("OMAVOTE REVOKE STOP+CANCEL-OPEN");
    for (const p of [grantCancel, stopOnly, cancel]) {
      const sig = neuronSign(p.text, secret);
      expect(verifyOwnerSig(f.core, f.network, ADAPTER_CKB, lock.script, p.text, sig).ok).toBe(true);
    }
    // The core refuses invalid combinations (GRANT with STOP_ONLY).
    expect(() =>
      prepareControl(f.core, f.network, controlBody({ ...base, action: "GRANT", keyDescriptor: desc, expiresAtMs: grantExpiry(anchor.clock_ms, 30), revokeMode: "STOP_ONLY" })),
    ).toThrow();
  });

  it("validates the term and key inputs", () => {
    expect(grantExpiry("1000", 1)).toBe(String(1000 + 86_400_000));
    expect(() => grantExpiry("1000", 0)).toThrow(FlowError);
    expect(() => grantExpiry("1000", 366)).toThrow(FlowError);
    expect(() => grantExpiry("1000", 1.5)).toThrow(FlowError);
    expect(parseKeyInput("hello")).toBeNull();
    expect(parseKeyInput("0x04" + "11".repeat(32))).toBeNull();
    expect(parseKeyInput("0x" + "ab".repeat(20))?.kind).toBe("evm_eoa");
  });

  it("looks up controls by id (null when unknown)", async () => {
    const f = makeFixture();
    expect(await lookupControl(f.api, "0x" + "00".repeat(32), f.server.policy.hash, "0x" + "11".repeat(32))).toBeNull();
  });
});

describe("process records (multi-member signatures)", () => {
  function withRoles(f: ReturnType<typeof makeFixture>) {
    const c1 = testSecret("committee-1");
    const c2 = testSecret("committee-2");
    const evmMember = new MockEip1193(testSecret("committee-evm"));
    const coord = testSecret("coordinator-1");
    const sortById = (ds: ReturnType<typeof f.core.key>["descriptor"][]) => ds.map((d) => ({ d, id: f.core.key(d).key_id })).sort((a, b) => (a.id < b.id ? -1 : 1)).map((x) => x.d);
    const roles: ProcessRoles = {
      message_kind: "process_roles",
      protocol_version: "2",
      network_genesis_hash: f.network.genesis_hash,
      dao_namespace: "ckb-community-fund-dao",
      previous_roles_hash: null,
      roles: {
        committee: {
          threshold: "2",
          members: sortById([
            { kind: "secp256k1", public_key: compressedPubkey(c1), adapter: ADAPTER_CKB },
            { kind: "secp256k1", public_key: compressedPubkey(c2), adapter: ADAPTER_CKB },
            { kind: "evm_eoa", address: evmMember.address, adapter: ADAPTER_EVM },
          ]),
        },
        coordinator: { threshold: "1", members: [{ kind: "secp256k1", public_key: compressedPubkey(coord), adapter: ADAPTER_CKB }] },
      },
      nonce: "0x" + "42".repeat(32),
    };
    f.server.roles = { roles_hash: "0x" + "99".repeat(32), object: roles };
    return { c1, c2, evmMember, coord, roles };
  }

  it("collects threshold signatures (Neuron + MetaMask) on the identical body and submits", async () => {
    const f = makeFixture();
    const { c1, evmMember } = withRoles(f);
    const roles = f.server.roles!;
    const anchor = await anchorAbove(f.api, null, fast);
    const body = recordBody({
      genesis: f.network.genesis_hash,
      rolesHash: roles.roles_hash,
      role: "committee",
      recordType: "RESULT_ATTESTATION",
      pollId: f.pollId,
      detail: recordDetail("RESULT_ATTESTATION", { resultHash: "0x" + "77".repeat(32), outcome: "PASS" }),
      evidenceHash: null,
      anchorHash: anchor.hash,
      publicationDeadlineMs: anchor.process_publication_deadline_ms,
      nonce: f.core.nonce(),
    });
    expect(sortedKeys(body)).toEqual(RECORD_FIELDS);
    const p = prepareRecord(f.core, body);
    expect(p.summary).toBe(`OMAVOTE RESULT #${f.pollId.slice(2, 18)} PASS`);
    expect(p.text.split("\n")[1]).toBe("OMAVOTE V2 - PROCESS RECORD, NO ASSET TRANSFER");
    // Another member importing the shared draft gets the identical text and id.
    const imported = prepareRecord(f.core, JSON.parse(JSON.stringify(body)));
    expect(imported.text).toBe(p.text);
    expect(imported.recordId).toBe(p.recordId);

    const members = roleMembers(f.core, roles.object, "committee", f.network);
    const m1 = members.find((m) => m.descriptor.kind === "secp256k1" && m.descriptor.public_key === compressedPubkey(c1))!;
    const me = members.find((m) => m.descriptor.kind === "evm_eoa")!;
    const sigs = [
      { signer_key_id: m1.keyId, signature: neuronSign(p.text, c1) },
      { signer_key_id: m1.keyId, signature: neuronSign(p.text, c1) },
      { signer_key_id: me.keyId, signature: await walletSigner(evmMember, evmMember.address)(signRequest(p.text)) },
      { signer_key_id: me.keyId.replace(/.$/, "0"), signature: neuronSign(p.text, c1) },
    ];
    const valid = validMemberSignatures(f.core, members, p.text, sigs);
    expect([...valid].sort()).toEqual([m1.keyId, me.keyId].sort());
    const env = processEnvelope(p.body, sigs.filter((s) => valid.has(s.signer_key_id)));
    expect(sortedKeys(env)).toEqual(["body", "proofs"]);
    expect(env.proofs).toHaveLength(2);
    expect(sortedKeys(env.proofs[0])).toEqual(["proof", "signer_key_id"]);
    const out = await submitEnvelope(f.core, f.api, env);
    expect(out.ok).toBe(true);
    await waitForRelay(f.api, p.recordId, fast);
    expect((await waitForRecord(f.api, { pollId: f.pollId, recordId: p.recordId }, fast)).found).toBe(true);
  });

  it("rejects bodies the core does not accept (wrong role, bad notice code)", () => {
    const f = makeFixture();
    withRoles(f);
    const roles = f.server.roles!;
    const common = {
      genesis: f.network.genesis_hash,
      rolesHash: roles.roles_hash,
      pollId: f.pollId,
      evidenceHash: null,
      anchorHash: "0x" + "12".repeat(32),
      publicationDeadlineMs: "1",
      nonce: "0x" + "34".repeat(32),
    };
    expect(() => prepareRecord(f.core, recordBody({ ...common, role: "committee", recordType: "ADMISSION", detail: recordDetail("ADMISSION", {}) }))).toThrow();
    expect(() => prepareRecord(f.core, recordBody({ ...common, role: "coordinator", recordType: "NOTICE", detail: recordDetail("NOTICE", { code: "bad code" }) }))).toThrow();
    const ok = prepareRecord(f.core, recordBody({ ...common, role: "coordinator", recordType: "ADMISSION", detail: recordDetail("ADMISSION", { decision: "ADMITTED" }) }));
    expect(ok.summary).toBe(`OMAVOTE ADMIT #${f.pollId.slice(2, 18)} ADMITTED`);
    const roleUpdate = recordBody({ ...common, role: "committee", recordType: "ROLES_UPDATE", detail: recordDetail("ROLES_UPDATE", { newRolesHash: "0x" + "56".repeat(32) }) });
    expect(roleUpdate.poll_id).toBeNull();
    expect(prepareRecord(f.core, roleUpdate).summary).toBe(`OMAVOTE ROLES-UPDATE #${"56".repeat(8)}`);
  });
});

describe("proposal creation", () => {
  it("signs the proposal text for every proposer and builds the payload in manifest order", async () => {
    const f = makeFixture();
    const s1 = testSecret("proposer-1");
    const l1 = secpLock(f.core, f.network, s1);
    const evm = new MockEip1193(testSecret("proposer-evm"));
    const l2 = f.core.evmOwnerLocks(f.network, evm.address)[0]!;
    const start = (f.server.tip().clock + 7n * 86_400_000n).toString();
    const manifest = buildManifest(f.core, f.network, l1.script, start, { proposerLocks: [l2.script, l1.script, l1.script] });
    // The core sorts and deduplicates proposer locks by owner_id.
    expect(manifest.proposer_owner_locks).toHaveLength(2);
    const ids = manifest.proposer_owner_locks.map((l) => f.core.scriptHash(l));
    expect([...ids].sort()).toEqual(ids);
    const info = f.core.manifestInfo(manifest, f.network);
    expect(info.start_ms).toBe(start);
    expect(BigInt(info.end_ms) - BigInt(start)).toBe(7n * 86_400_000n);
    expect(info.quorum_required_shannon).toBe("300000000000000");

    const sigs: ProposerSignature[] = [];
    for (const lock of manifest.proposer_owner_locks) {
      const text = f.core.proposalText(f.network, manifest, lock);
      expect(text.split("\n")[0]).toBe(`OMAVOTE PROPOSE #${info.poll_id.slice(2, 18)} 1000000CKB`);
      expect(text).toContain(`Proposer: ${f.core.address(f.network, lock)}`);
      const evmLock = lock.code_hash === l2.script.code_hash;
      const signature = evmLock ? await walletSigner(evm, evm.address)(signRequest(text)) : neuronSign(text, s1);
      const adapter = evmLock ? ADAPTER_EVM : ADAPTER_CKB;
      expect(verifyOwnerSig(f.core, f.network, adapter, lock, text, signature).ok).toBe(true);
      sigs.push({ owner_lock: lock, auth_adapter: adapter, signature });
    }
    const payload = manifestPayload(manifest, [...sigs].reverse());
    expect(sortedKeys(payload)).toEqual(["manifest", "proposer_proofs", "protocol_version"]);
    expect(payload.protocol_version).toBe("2");
    expect(payload.proposer_proofs.map((p) => p.owner_lock)).toEqual(manifest.proposer_owner_locks);
    expect(sortedKeys(payload.proposer_proofs[0])).toEqual(["auth_adapter", "owner_lock", "proof"]);
    expect(() => manifestPayload(manifest, sigs.slice(0, 1))).toThrow(FlowError);

    const out = await submitEnvelope(f.core, f.api, payload);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.item.object_id).toBe(info.poll_id);
    await waitForRelay(f.api, info.poll_id, fast);
    // The mock registers polls only via addPoll; registration lookups go through /api/proposals/{id}.
    f.server.addPoll(manifest);
    expect((await waitForPoll(f.api, info.poll_id, fast)).registered).toBe(true);
  });

  it("checks the signing title like the core", () => {
    expect(signingTitleProblem("Fund the explorer")).toBeNull();
    expect(signingTitleProblem("资助浏览器开发")).toBeNull();
    expect(signingTitleProblem("")).toBe("err.signingTitleLength");
    expect(signingTitleProblem("x".repeat(81))).toBe("err.signingTitleLength");
    expect(signingTitleProblem("字".repeat(80))).toBeNull();
    expect(signingTitleProblem(" lead")).toBe("err.signingTitleSpace");
    expect(signingTitleProblem("bidi‮x")).toBe("err.signingTitleChar");
    expect(signingTitleProblem("tab\tx")).toBe("err.signingTitleChar");
  });
});
