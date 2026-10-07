// Fixed sample texts for wallet acceptance tests (docs/13 §12 M2). Every value is
// deterministic, so the same text is shown on every device and the recorded
// signatures are comparable. The samples are built for testnet parameters and do
// not belong to any real proposal.

import type { Core } from "./core";
import { ballotBody, controlBody, manifestDraft, ADAPTER_CKB, ADAPTER_EVM, signRequest, type SignRequest } from "./flow";
import type { NetworkParams, Script } from "./types";

export type SampleKind = "ballot" | "grant" | "hexlike";

export interface Sample extends SignRequest {
  kind: SampleKind;
  network: NetworkParams;
}

const START_MS = "1798761600000"; // 2027-01-01T00:00:00.000Z

function fixedLock(network: NetworkParams, byte: string): Script {
  return { code_hash: network.secp256k1.code_hash, hash_type: network.secp256k1.hash_type, args: "0x" + byte.repeat(20) };
}

export function buildSample(core: Core, kind: SampleKind): Sample {
  const network = core.knownNetwork("testnet");
  if (kind === "hexlike") {
    // A text made only of hex digits: wallets must sign these UTF-8 characters,
    // which is why requests always carry hex(utf8(text)).
    return { kind, network, ...signRequest("0xdeadbeef") };
  }
  const genesis = network.genesis_hash;
  const policy = core.authPolicy(genesis);
  if (kind === "grant") {
    const body = controlBody({
      genesis,
      policyHash: policy.hash,
      ownerLock: fixedLock(network, "22"),
      ownerAdapter: ADAPTER_CKB,
      action: "GRANT",
      keyDescriptor: { kind: "evm_eoa", address: "0x" + "11".repeat(20), adapter: ADAPTER_EVM },
      expiresAtMs: "1830297600000", // 2028-01-01
      revokeMode: null,
      anchorHash: core.ckbHashText("omavote-wallet-check-anchor"),
      publicationDeadlineMs: "1798848000000",
      nonce: core.ckbHashText("omavote-wallet-check-control-nonce"),
    });
    const out = core.control(network, body);
    return { kind, network, ...signRequest(out.text, out.summary) };
  }
  const rules = core.defaultRules().rules_profile;
  const registry = { owner_adapters: [ADAPTER_CKB, ADAPTER_EVM], key_adapters: [ADAPTER_CKB, ADAPTER_EVM] };
  const { manifest, info } = core.manifestFromDraft(
    manifestDraft({
      genesis,
      nonce: core.ckbHashText("omavote-wallet-check-manifest-nonce"),
      proposalType: "grant",
      title: "钱包验收样票 Wallet check sample — not a real proposal",
      signingTitle: "钱包验收样票 Wallet check sample",
      contentHash: core.ckbHashText("Omavote wallet check sample body"),
      contentLocations: [],
      forumTopicId: "0",
      forumRevision: "0",
      discussionEvidenceHash: null,
      budgetShannon: "100000000000000",
      quorumBaseShannon: "100000000000000",
      paymentTermsHash: null,
      recipientLock: fixedLock(network, "33"),
      proposerLocks: [fixedLock(network, "33")],
      rules,
      registry,
      policy: policy.policy,
      startMs: START_MS,
      resultConfirmations: "100",
      reviewWindowMs: "86400000",
    }),
    network,
  );
  const body = ballotBody({
    pollId: info.poll_id,
    rulesHash: info.rules_hash,
    genesis,
    ownerLock: fixedLock(network, "22"),
    action: "YES",
    authority: "owner",
    authorizationId: null,
    signerKeyId: null,
    authAdapter: ADAPTER_CKB,
    anchorHash: core.ckbHashText("omavote-wallet-check-anchor"),
    nonce: core.ckbHashText("omavote-wallet-check-ballot-nonce"),
  });
  const out = core.ballot(network, manifest, body);
  return { kind, network, ...signRequest(out.text, out.summary) };
}
