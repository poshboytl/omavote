import { Api } from "../../src/lib/api";
import type { Core } from "../../src/lib/core";
import { ADAPTER_CKB, ADAPTER_EVM, manifestDraft } from "../../src/lib/flow";
import type { Manifest, NetworkParams, Script } from "../../src/lib/types";
import { compressedPubkey, testSecret } from "./keys";
import { MockServer } from "./mock-server";
import { loadCoreForNode } from "./wasm";

export interface Fixture {
  core: Core;
  network: NetworkParams;
  server: MockServer;
  api: Api;
  manifest: Manifest;
  pollId: string;
  proposerSecret: Uint8Array;
  proposerLock: Script;
}

/** No-wait sleep for polling loops in tests. */
export const noSleep = async () => {};

export function secpLock(core: Core, network: NetworkParams, secret: Uint8Array): { script: Script; address: string; owner_id: string } {
  return core.secp256k1Lock(network, compressedPubkey(secret));
}

export function buildManifest(core: Core, network: NetworkParams, proposer: Script, startMs: string, overrides: Partial<Parameters<typeof manifestDraft>[0]> = {}): Manifest {
  const policy = core.authPolicy(network.genesis_hash);
  const rules = core.defaultRules().rules_profile;
  const draft = manifestDraft({
    genesis: network.genesis_hash,
    nonce: core.nonce(),
    proposalType: "grant",
    title: "Fund the independent explorer 资助区块浏览器",
    signingTitle: "Explorer grant 浏览器资助",
    contentHash: core.ckbHashText("proposal body"),
    contentLocations: ["https://example.invalid/p/1"],
    forumTopicId: "42",
    forumRevision: "3",
    discussionEvidenceHash: null,
    budgetShannon: "100000000000000",
    quorumBaseShannon: "100000000000000",
    paymentTermsHash: null,
    recipientLock: proposer,
    proposerLocks: [proposer],
    rules,
    registry: { owner_adapters: [ADAPTER_CKB, ADAPTER_EVM], key_adapters: [ADAPTER_CKB, ADAPTER_EVM] },
    policy: policy.policy,
    startMs,
    resultConfirmations: "100",
    reviewWindowMs: "86400000",
    ...overrides,
  });
  return core.manifestFromDraft(draft, network).manifest;
}

export function makeFixture(): Fixture {
  const core = loadCoreForNode();
  const network = core.knownNetwork("testnet");
  const server = new MockServer(core, network);
  const api = new Api("", server.fetch);
  const proposerSecret = testSecret("proposer");
  const proposerLock = secpLock(core, network, proposerSecret).script;
  const manifest = buildManifest(core, network, proposerLock, server.tip().clock.toString());
  const pollId = server.addPoll(manifest);
  return { core, network, server, api, manifest, pollId, proposerSecret, proposerLock };
}
