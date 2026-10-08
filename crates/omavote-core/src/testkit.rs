//! Deterministic simulated chain and message builders for tests, vectors and demos.
//! Secrets here are derived from public labels: never use them for real funds.

use crate::adapter::{self, test_secret};
use crate::carrier::Kind;
use crate::engine::{make_carrier, BlockInput, Engine, EngineConfig, OutputInput, TxInput};
use crate::hash::ckb_hash;
use crate::messages::*;
use crate::molecule::{HashType, OutPoint, Script};
use crate::network::{NetworkParams, ScriptId};
use crate::text;
use crate::types::*;
use crate::util::Hash32;

pub const DAY: u64 = DAY_MS;

pub fn test_network() -> NetworkParams {
    let mut n =
        NetworkParams::devnet(ckb_hash(b"omavote-testkit-genesis"), NetworkParams::mainnet().secp256k1, NetworkParams::mainnet().dao);
    n.name = "testkit".into();
    n.omnilock = Some(ScriptId { code_hash: ckb_hash(b"testkit-omnilock"), hash_type: HashType::Type });
    n.pw_lock = Some(ScriptId { code_hash: ckb_hash(b"testkit-pw-lock"), hash_type: HashType::Type });
    n
}

#[derive(Clone, Debug)]
pub struct TestOwner {
    pub secret: [u8; 32],
    pub lock: Script,
    pub adapter: &'static str,
}

impl TestOwner {
    /// Standard secp256k1 owner signing with Neuron's message format.
    pub fn ckb(label: &str, net: &NetworkParams) -> Self {
        let secret = test_secret(label);
        let lock = net.secp256k1.with_args(adapter::secp256k1_lock_args(&secret).unwrap().to_vec());
        TestOwner { secret, lock, adapter: adapter::CKB_SECP256K1_MESSAGE_V1 }
    }

    /// EVM owner using an Omnilock in plain Ethereum mode.
    pub fn evm_omnilock(label: &str, net: &NetworkParams) -> Self {
        let secret = test_secret(label);
        let addr = adapter::evm_address(&secret).unwrap();
        let lock = adapter::evm_owner_scripts(net, &addr).remove(0);
        TestOwner { secret, lock, adapter: adapter::EVM_PERSONAL_MESSAGE_V1 }
    }

    /// EVM owner using an Omnilock with auth flag 0x12 (CCC's default for new addresses).
    pub fn evm_omnilock_displaying(label: &str, net: &NetworkParams) -> Self {
        let secret = test_secret(label);
        let addr = adapter::evm_address(&secret).unwrap();
        let mut args = vec![adapter::OMNILOCK_AUTH_ETHEREUM_DISPLAYING];
        args.extend_from_slice(&addr);
        args.push(0x00);
        let lock = net.omnilock.expect("omnilock identity").with_args(args);
        TestOwner { secret, lock, adapter: adapter::EVM_PERSONAL_MESSAGE_V1 }
    }

    pub fn id(&self) -> Hash32 {
        self.lock.hash()
    }

    pub fn sign(&self, text: &str) -> Proof {
        let signature = match self.adapter {
            adapter::CKB_SECP256K1_MESSAGE_V1 => adapter::ckb_sign_message(&self.secret, text).unwrap(),
            _ => adapter::evm_sign_message(&self.secret, text).unwrap(),
        };
        Proof { signature }
    }
}

#[derive(Clone, Debug)]
pub struct TestKey {
    pub secret: [u8; 32],
    pub descriptor: KeyDescriptor,
}

impl TestKey {
    pub fn evm(label: &str) -> Self {
        let secret = test_secret(label);
        TestKey { secret, descriptor: KeyDescriptor::EvmEoa { address: adapter::evm_address(&secret).unwrap() } }
    }

    pub fn secp(label: &str) -> Self {
        let secret = test_secret(label);
        TestKey { secret, descriptor: KeyDescriptor::Secp256k1 { public_key: adapter::secp256k1_pubkey(&secret).unwrap() } }
    }

    pub fn id(&self) -> Hash32 {
        self.descriptor.key_id()
    }

    pub fn sign(&self, text: &str) -> Proof {
        let signature = match self.descriptor {
            KeyDescriptor::Secp256k1 { .. } => adapter::ckb_sign_message(&self.secret, text).unwrap(),
            KeyDescriptor::EvmEoa { .. } => adapter::evm_sign_message(&self.secret, text).unwrap(),
        };
        Proof { signature }
    }
}

pub struct TestChain {
    pub engine: Engine,
    pub net: NetworkParams,
    pub tip_number: u64,
    pub tip_hash: Hash32,
    pub clock_ms: u64,
    pending: Vec<TxInput>,
    counter: u64,
    pub policy: AuthPolicy,
    pub blocks: Vec<BlockInput>,
}

impl TestChain {
    pub fn new(genesis_clock_ms: u64) -> Self {
        Self::with_config(genesis_clock_ms, |_| {})
    }

    pub fn with_config(genesis_clock_ms: u64, tweak: impl FnOnce(&mut EngineConfig)) -> Self {
        let net = test_network();
        let mut cfg = EngineConfig::new(net.clone());
        tweak(&mut cfg);
        let mut c = TestChain {
            engine: Engine::new(cfg),
            policy: AuthPolicy::build(net.genesis_hash),
            net,
            tip_number: 0,
            tip_hash: [0; 32],
            clock_ms: genesis_clock_ms,
            pending: Vec::new(),
            counter: 0,
            blocks: Vec::new(),
        };
        let genesis =
            BlockInput { number: 0, hash: c.net.genesis_hash, parent_hash: [0; 32], clock_ms: genesis_clock_ms, transactions: Vec::new() };
        c.engine.process_block(&genesis).unwrap();
        c.blocks.push(genesis);
        c.tip_hash = c.net.genesis_hash;
        c
    }

    pub fn fresh_hash(&mut self, label: &str) -> Hash32 {
        self.counter += 1;
        ckb_hash(format!("{label}/{}", self.counter).as_bytes())
    }

    /// Mine the pending transactions into a block whose clock is `clock_ms`.
    pub fn mine_at(&mut self, clock_ms: u64) -> Hash32 {
        assert!(clock_ms >= self.clock_ms, "clock must not decrease");
        let number = self.tip_number + 1;
        let hash = self.fresh_hash("block");
        let block = BlockInput { number, hash, parent_hash: self.tip_hash, clock_ms, transactions: std::mem::take(&mut self.pending) };
        self.engine.process_block(&block).unwrap();
        self.blocks.push(block);
        self.tip_number = number;
        self.tip_hash = hash;
        self.clock_ms = clock_ms;
        hash
    }

    pub fn mine(&mut self, step_ms: u64) -> Hash32 {
        self.mine_at(self.clock_ms + step_ms)
    }

    pub fn mine_n(&mut self, n: usize, step_ms: u64) -> Hash32 {
        let mut h = self.tip_hash;
        for _ in 0..n {
            h = self.mine(step_ms);
        }
        h
    }

    pub fn deposit(&mut self, owner: &Script, ckb: u64) -> OutPoint {
        let tx_hash = self.fresh_hash("tx");
        let funding = self.fresh_hash("funding");
        self.pending.push(TxInput {
            hash: tx_hash,
            inputs: vec![OutPoint { tx_hash: funding, index: 0 }],
            outputs: vec![OutputInput {
                index: 0,
                capacity: ckb * 100_000_000,
                lock: owner.clone(),
                type_: Some(self.net.dao_script()),
                data: vec![0; 8],
            }],
            witnesses: vec![vec![]],
        });
        OutPoint { tx_hash, index: 0 }
    }

    /// Spend a deposit (e.g. phase-1 withdrawal); the new withdrawing cell is not a deposit.
    pub fn withdraw(&mut self, op: OutPoint, owner: &Script, capacity: u64) {
        let tx_hash = self.fresh_hash("tx");
        self.pending.push(TxInput {
            hash: tx_hash,
            inputs: vec![op],
            outputs: vec![OutputInput {
                index: 0,
                capacity,
                lock: owner.clone(),
                type_: Some(self.net.dao_script()),
                data: self.tip_number.to_le_bytes().to_vec(),
            }],
            witnesses: vec![vec![]],
        });
    }

    /// One transaction carrying several carriers, in the given output order.
    pub fn carriers(&mut self, items: Vec<(Kind, Hash32, Vec<u8>)>) -> Hash32 {
        let tx_hash = self.fresh_hash("tx");
        let relay_lock = self.net.secp256k1.with_args(vec![0xaa; 20]);
        let mut outputs = Vec::new();
        let mut witnesses = vec![Vec::new()];
        for (i, (kind, scope, payload)) in items.into_iter().enumerate() {
            let witness_index = witnesses.len() as u32;
            let (data, witness) = make_carrier(kind, scope, payload, witness_index);
            witnesses.push(witness);
            outputs.push(OutputInput { index: i as u32, capacity: 139 * 100_000_000, lock: relay_lock.clone(), type_: None, data });
        }
        let funds = self.fresh_hash("relay-funds");
        self.pending.push(TxInput { hash: tx_hash, inputs: vec![OutPoint { tx_hash: funds, index: 0 }], outputs, witnesses });
        tx_hash
    }

    pub fn policy_item(&self) -> (Kind, Hash32, Vec<u8>) {
        (Kind::AuthorizationPolicy, self.policy.hash(), crate::json::jcs_bytes(self.policy.to_json()))
    }

    pub fn publish_policy(&mut self) {
        let item = self.policy_item();
        self.carriers(vec![item]);
    }

    pub fn manifest_item(p: &ManifestPayload) -> (Kind, Hash32, Vec<u8>) {
        (Kind::Manifest, p.manifest.poll_id(), crate::json::jcs_bytes(&p.to_json()))
    }

    pub fn control_item(&self, envs: &[ControlEnvelope]) -> (Kind, Hash32, Vec<u8>) {
        (Kind::AuthorizationBatch, self.policy.hash(), crate::carrier::batch_payload(envs.iter().map(|e| e.to_json()).collect()))
    }

    pub fn ballot_item(poll_id: Hash32, envs: &[BallotEnvelope]) -> (Kind, Hash32, Vec<u8>) {
        (Kind::BallotBatch, poll_id, crate::carrier::batch_payload(envs.iter().map(|e| e.to_json()).collect()))
    }

    pub fn publish_manifest(&mut self, p: &ManifestPayload) {
        self.carriers(vec![Self::manifest_item(p)]);
    }

    pub fn publish_controls(&mut self, envs: &[ControlEnvelope]) {
        let item = self.control_item(envs);
        self.carriers(vec![item]);
    }

    pub fn publish_ballots(&mut self, poll_id: Hash32, envs: &[BallotEnvelope]) {
        self.carriers(vec![Self::ballot_item(poll_id, envs)]);
    }

    pub fn publish_roles(&mut self, roles: &ProcessRoles) {
        self.carriers(vec![(Kind::ProcessRoles, roles.roles_hash(), crate::json::jcs_bytes(roles.to_json()))]);
    }

    pub fn publish_records(&mut self, scope: Hash32, envs: &[ProcessEnvelope]) {
        self.carriers(vec![(Kind::ProcessBatch, scope, crate::carrier::batch_payload(envs.iter().map(|e| e.to_json()).collect()))]);
    }

    pub fn anchor_clock(&self, anchor: &Hash32) -> u64 {
        self.engine.block_clock(anchor).expect("known anchor").1
    }

    pub fn default_registry() -> AuthRegistry {
        AuthRegistry::new(
            vec![adapter::CKB_SECP256K1_MESSAGE_V1.into(), adapter::EVM_PERSONAL_MESSAGE_V1.into()],
            vec![adapter::CKB_SECP256K1_MESSAGE_V1.into(), adapter::EVM_PERSONAL_MESSAGE_V1.into()],
        )
    }

    /// Signed grant-type manifest starting at `start_ms`.
    pub fn manifest(
        &mut self,
        proposers: &[&TestOwner],
        start_ms: u64,
        registry: AuthRegistry,
        rules: RulesParams,
        budget_ckb: u128,
    ) -> ManifestPayload {
        let recipient = self.net.secp256k1.with_args(vec![0x42; 20]);
        let draft = ManifestDraft {
            genesis: self.net.genesis_hash,
            nonce: self.fresh_hash("poll-nonce"),
            proposal_type: if budget_ckb == 0 { ProposalType::MetaRule } else { ProposalType::Grant },
            title: "Fund an independent block explorer for CKB".into(),
            signing_title: "Fund block explorer".into(),
            content_hash: ckb_hash(b"proposal body"),
            content_locations: vec!["https://talk.nervos.org/t/example/1".into()],
            forum_topic_id: "1".into(),
            forum_revision: "1".into(),
            discussion_evidence_hash: None,
            budget_ckb_shannon: budget_ckb * SHANNON_PER_CKB,
            quorum_base_shannon: budget_ckb * SHANNON_PER_CKB,
            payment_terms_hash: None,
            recipient_lock_script: if budget_ckb == 0 { None } else { Some(recipient) },
            proposer_owner_locks: proposers.iter().map(|o| o.lock.clone()).collect(),
            rules: RulesProfile::build(&rules),
            auth_registry: registry,
            auth_policy: self.policy.clone(),
            start_ms,
            confirmation: ConfirmationPolicy { result_confirmations: 100, review_window_ms: DAY },
        };
        let manifest = draft.build().unwrap();
        let mut proposer_proofs = Vec::new();
        for lock in &manifest.proposer_owner_locks {
            let owner = proposers.iter().find(|o| &o.lock == lock).unwrap();
            let text = text::proposal_text(&manifest, lock, &self.net).unwrap();
            proposer_proofs.push(ProposerProof { owner_lock: lock.clone(), auth_adapter: owner.adapter.into(), proof: owner.sign(&text) });
        }
        ManifestPayload { manifest, proposer_proofs }
    }

    pub fn direct_ballot(&mut self, m: &Manifest, owner: &TestOwner, action: Action, anchor: Hash32) -> BallotEnvelope {
        let body = BallotDraft {
            action,
            authority: Authority::Owner,
            authorization_id: None,
            signer_key_id: None,
            nonce: self.fresh_hash("ballot-nonce"),
            anchor_block_hash: anchor,
            auth_adapter: owner.adapter.into(),
            genesis: self.net.genesis_hash,
            owner_lock: owner.lock.clone(),
            poll_id: m.poll_id(),
            rules_hash: m.rules_hash(),
        }
        .build()
        .unwrap();
        let text = text::ballot_text(m, &body, &self.net).unwrap();
        BallotEnvelope { proof: owner.sign(&text), body }
    }

    pub fn delegate_ballot(
        &mut self,
        m: &Manifest,
        owner: &TestOwner,
        grant: &ControlEnvelope,
        key: &TestKey,
        action: Action,
        anchor: Hash32,
    ) -> BallotEnvelope {
        let body = BallotDraft {
            action,
            authority: Authority::Delegate,
            authorization_id: Some(grant.body.authorization_id()),
            signer_key_id: Some(key.id()),
            nonce: self.fresh_hash("ballot-nonce"),
            anchor_block_hash: anchor,
            auth_adapter: key.descriptor.adapter_id().into(),
            genesis: self.net.genesis_hash,
            owner_lock: owner.lock.clone(),
            poll_id: m.poll_id(),
            rules_hash: m.rules_hash(),
        }
        .build()
        .unwrap();
        let text = text::ballot_text(m, &body, &self.net).unwrap();
        BallotEnvelope { proof: key.sign(&text), body }
    }

    fn control(
        &mut self,
        owner: &TestOwner,
        action: ControlAction,
        key: Option<&TestKey>,
        term_ms: Option<u64>,
        mode: Option<RevokeMode>,
        anchor: Hash32,
    ) -> ControlEnvelope {
        let t_anchor = self.anchor_clock(&anchor);
        let body = ControlDraft {
            genesis: self.net.genesis_hash,
            auth_policy_hash: self.policy.hash(),
            owner_lock: owner.lock.clone(),
            owner_auth_adapter: owner.adapter.into(),
            action,
            key_descriptor: key.map(|k| k.descriptor.clone()),
            expires_at_ms: term_ms.map(|t| t_anchor + t),
            revoke_mode: mode,
            anchor_block_hash: anchor,
            publication_deadline_ms: t_anchor + MAX_CONTROL_PUBLICATION_DELAY_MS,
            nonce: self.fresh_hash("control-nonce"),
        }
        .build()
        .unwrap();
        let text = text::control_text(&body, &self.net).unwrap();
        ControlEnvelope { proof: owner.sign(&text), body }
    }

    pub fn grant(&mut self, owner: &TestOwner, key: &TestKey, term_ms: u64, anchor: Hash32) -> ControlEnvelope {
        self.control(owner, ControlAction::Grant, Some(key), Some(term_ms), None, anchor)
    }

    pub fn grant_cancel(&mut self, owner: &TestOwner, key: &TestKey, term_ms: u64, anchor: Hash32) -> ControlEnvelope {
        self.control(owner, ControlAction::Grant, Some(key), Some(term_ms), Some(RevokeMode::StopAndCancelOpen), anchor)
    }

    pub fn revoke(&mut self, owner: &TestOwner, mode: RevokeMode, anchor: Hash32) -> ControlEnvelope {
        self.control(owner, ControlAction::Revoke, None, None, Some(mode), anchor)
    }

    pub fn record(
        &mut self,
        roles: &ProcessRoles,
        role: Role,
        signers: &[&TestKey],
        poll_id: Option<Hash32>,
        detail: RecordDetail,
        anchor: Hash32,
    ) -> ProcessEnvelope {
        let t_anchor = self.anchor_clock(&anchor);
        let body = RecordDraft {
            genesis: self.net.genesis_hash,
            roles_hash: roles.roles_hash(),
            role,
            poll_id,
            detail,
            evidence_hash: None,
            anchor_block_hash: anchor,
            publication_deadline_ms: t_anchor + self.engine.cfg.process_publication_delay_ms,
            nonce: self.fresh_hash("record-nonce"),
        }
        .build()
        .unwrap();
        let text = text::process_text(&body).unwrap();
        ProcessEnvelope { proofs: signers.iter().map(|k| (k.id(), k.sign(&text))).collect(), body }
    }
}
