//! Replay engine (docs/03 §6–§11, docs/11 §5–§6).
//!
//! The engine consumes canonical-chain blocks in order and keeps every piece of
//! protocol state: Nervos DAO deposits, authorization control streams, ballot
//! appearances, process roles/records and poll registrations. It performs no IO;
//! the caller supplies blocks and handles reorgs by restoring a cloned snapshot.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::adapter;
use crate::carrier::{self, Header, Payload};
use crate::error::{Error, Result};
use crate::messages::{
    Action, Authority, BallotEnvelope, ControlAction, ControlEnvelope, KeyDescriptor, ManifestPayload, ProcessEnvelope,
    ProcessRoles, RecordDetail, RecordType,
};
use crate::molecule::{OutPoint, Script};
use crate::network::NetworkParams;
use crate::text;
use crate::types::{AuthPolicy, Manifest, MAX_PROCESS_PUBLICATION_DELAY_MS};
use crate::util::{to_hex, Hash32};

// ---------------------------------------------------------------------------
// Inputs

/// One canonical block, reduced to what the protocol needs. Callers may drop
/// outputs that are neither DAO cells nor carriers, but must keep every input.
#[derive(Clone, Debug)]
pub struct BlockInput {
    pub number: u64,
    pub hash: Hash32,
    pub parent_hash: Hash32,
    /// `clock(b)`: median time of the 37 blocks ending at the parent (docs/13 §4.9).
    pub clock_ms: u64,
    pub transactions: Vec<TxInput>,
}

#[derive(Clone, Debug)]
pub struct TxInput {
    pub hash: Hash32,
    pub inputs: Vec<OutPoint>,
    pub outputs: Vec<OutputInput>,
    pub witnesses: Vec<Vec<u8>>,
}

#[derive(Clone, Debug)]
pub struct OutputInput {
    pub index: u32,
    pub capacity: u64,
    pub lock: Script,
    pub type_: Option<Script>,
    pub data: Vec<u8>,
}

impl OutputInput {
    pub fn is_relevant(&self, net: &NetworkParams) -> bool {
        is_dao_deposit(net, self) || self.data.len() == carrier::HEADER_LEN && self.data.starts_with(carrier::MAGIC)
    }
}

fn is_dao_deposit(net: &NetworkParams, o: &OutputInput) -> bool {
    o.type_.as_ref().map(|t| net.is_dao_type(t)).unwrap_or(false) && o.data == [0u8; 8]
}

/// Canonical position `(height, tx_index, output_index, envelope_index)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Position {
    pub height: u64,
    pub tx_index: u32,
    pub output_index: u32,
    pub envelope_index: u32,
}

impl Position {
    pub fn to_json(&self) -> crate::json::Value {
        use crate::json::{Object, Value};
        Value::Object(
            Object::new()
                .with("height", Value::str(self.height.to_string()))
                .with("tx_index", Value::str(self.tx_index.to_string()))
                .with("output_index", Value::str(self.output_index.to_string()))
                .with("envelope_index", Value::str(self.envelope_index.to_string())),
        )
    }
}

// ---------------------------------------------------------------------------
// Diagnostics

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub position: Position,
    pub tx_hash: Hash32,
    pub kind: &'static str,
    pub id: Option<Hash32>,
    pub poll_id: Option<Hash32>,
    pub owner_id: Option<Hash32>,
    pub code: &'static str,
    pub detail: String,
    /// The rejected signed object when it could be decoded (evidence bundles).
    pub object: Option<crate::json::Value>,
}

// ---------------------------------------------------------------------------
// State

#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub network: NetworkParams,
    /// Initial process roles fixed by the switch proposal (deployment parameter).
    pub initial_roles_hash: Option<Hash32>,
    pub process_publication_delay_ms: u64,
}

impl EngineConfig {
    pub fn new(network: NetworkParams) -> Self {
        EngineConfig { network, initial_roles_hash: None, process_publication_delay_ms: MAX_PROCESS_PUBLICATION_DELAY_MS }
    }
}

#[derive(Clone, Copy, Debug)]
struct BlockMeta {
    number: u64,
    clock_ms: u64,
}

#[derive(Clone, Debug)]
pub struct DaoCell {
    pub owner_id: Hash32,
    pub capacity: u64,
    pub created: Position,
}

#[derive(Clone, Debug)]
pub struct GrantInfo {
    pub authorization_id: Hash32,
    pub policy_hash: Hash32,
    pub owner_id: Hash32,
    pub owner_adapter: String,
    pub key: KeyDescriptor,
    pub key_id: Hash32,
    pub expires_at_ms: u64,
    pub position: Position,
    pub anchor_height: u64,
    pub cancels_open: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Barrier {
    pub position: Position,
    pub clock_ms: u64,
}

#[derive(Clone, Debug)]
pub struct ControlEvent {
    pub authorization_id: Hash32,
    pub position: Position,
    pub tx_hash: Hash32,
    pub anchor_height: u64,
    pub action: ControlAction,
    pub outcome: &'static str,
    /// Full signed control (evidence bundles carry the owner proof).
    pub envelope: ControlEnvelope,
}

#[derive(Clone, Debug, Default)]
pub struct ControlStream {
    pub owner_lock: Option<Script>,
    pub a_max: Option<u64>,
    ids_at_max: Vec<Hash32>,
    pub current: Option<Hash32>,
    pub conflict: bool,
    pub barriers: Vec<Barrier>,
    pub history: Vec<ControlEvent>,
}

#[derive(Clone, Debug)]
pub struct BallotAppearance {
    pub ballot_id: Hash32,
    pub owner_id: Hash32,
    pub authority: Authority,
    pub authorization_id: Option<Hash32>,
    pub grant_anchor_height: u64,
    pub anchor_height: u64,
    pub action: Action,
    pub position: Position,
    pub tx_hash: Hash32,
    pub envelope: BallotEnvelope,
}

#[derive(Clone, Debug)]
pub struct CloseSnapshot {
    pub number: u64,
    pub hash: Hash32,
    /// Live DAO deposits of participating owners at the end of H_close.
    pub cells: BTreeMap<Hash32, Vec<(OutPoint, u64)>>,
    /// Creation positions of those deposits (evidence bundles).
    pub created: BTreeMap<OutPoint, Position>,
}

#[derive(Clone, Debug)]
pub struct PollState {
    pub manifest: Manifest,
    pub payload: ManifestPayload,
    pub registered: Position,
    pub registered_tx: Hash32,
    pub proposer_deposit_shannon: u128,
    pub start_boundary: Option<(u64, Hash32)>,
    pub late_manifest: bool,
    pub close: Option<CloseSnapshot>,
    pub ballots: Vec<BallotAppearance>,
    seen_ballots: HashSet<Hash32>,
    pub owner_locks: BTreeMap<Hash32, Script>,
}

#[derive(Clone, Debug)]
pub struct RecordAppearance {
    pub record_id: Hash32,
    pub record_type: RecordType,
    pub poll_id: Option<Hash32>,
    pub detail: RecordDetail,
    pub anchor_height: u64,
    pub position: Position,
    pub tx_hash: Hash32,
    pub signers: Vec<Hash32>,
    pub envelope: ProcessEnvelope,
}

#[derive(Clone, Debug)]
pub struct Engine {
    pub cfg: EngineConfig,
    blocks: HashMap<Hash32, BlockMeta>,
    pub tip: Option<(u64, Hash32, u64)>,
    pub dao_cells: HashMap<OutPoint, DaoCell>,
    owner_cells: HashMap<Hash32, BTreeSet<OutPoint>>,
    pub owner_locks: HashMap<Hash32, Script>,
    pub policies: BTreeMap<Hash32, (AuthPolicy, Position)>,
    pub streams: BTreeMap<(Hash32, Hash32), ControlStream>,
    pub grants: HashMap<Hash32, GrantInfo>,
    seen_controls: HashSet<Hash32>,
    pub polls: BTreeMap<Hash32, PollState>,
    pub roles_objects: BTreeMap<Hash32, (ProcessRoles, Position)>,
    pub current_roles: Option<Hash32>,
    pub roles_history: Vec<(Position, Hash32)>,
    pub records: Vec<RecordAppearance>,
    seen_records: HashSet<Hash32>,
    pub result_records: Vec<(Position, Hash32, crate::json::Value)>,
    pub diagnostics: Vec<Diagnostic>,
}

struct Ctx {
    pos: Position,
    tx_hash: Hash32,
    clock_ms: u64,
    block_number: u64,
}

impl Engine {
    pub fn new(cfg: EngineConfig) -> Self {
        Engine {
            cfg,
            blocks: HashMap::new(),
            tip: None,
            dao_cells: HashMap::new(),
            owner_cells: HashMap::new(),
            owner_locks: HashMap::new(),
            policies: BTreeMap::new(),
            streams: BTreeMap::new(),
            grants: HashMap::new(),
            seen_controls: HashSet::new(),
            polls: BTreeMap::new(),
            roles_objects: BTreeMap::new(),
            current_roles: None,
            roles_history: Vec::new(),
            records: Vec::new(),
            seen_records: HashSet::new(),
            result_records: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    pub fn network(&self) -> &NetworkParams {
        &self.cfg.network
    }

    pub fn block_clock(&self, hash: &Hash32) -> Option<(u64, u64)> {
        self.blocks.get(hash).map(|m| (m.number, m.clock_ms))
    }

    pub fn owner_balance(&self, owner_id: &Hash32) -> u128 {
        self.owner_cells
            .get(owner_id)
            .map(|set| set.iter().map(|op| self.dao_cells[op].capacity as u128).sum())
            .unwrap_or(0)
    }

    pub fn owner_deposits(&self, owner_id: &Hash32) -> Vec<(OutPoint, u64)> {
        self.owner_cells
            .get(owner_id)
            .map(|set| set.iter().map(|op| (*op, self.dao_cells[op].capacity)).collect())
            .unwrap_or_default()
    }

    fn diag(&mut self, ctx: &Ctx, kind: &'static str, id: Option<Hash32>, poll: Option<Hash32>, owner: Option<Hash32>, code: &'static str, detail: impl Into<String>) {
        self.diag_obj(ctx, kind, id, poll, owner, code, detail, None)
    }

    #[allow(clippy::too_many_arguments)]
    fn diag_obj(
        &mut self,
        ctx: &Ctx,
        kind: &'static str,
        id: Option<Hash32>,
        poll: Option<Hash32>,
        owner: Option<Hash32>,
        code: &'static str,
        detail: impl Into<String>,
        object: Option<crate::json::Value>,
    ) {
        self.diagnostics.push(Diagnostic {
            position: ctx.pos,
            tx_hash: ctx.tx_hash,
            kind,
            id,
            poll_id: poll,
            owner_id: owner,
            code,
            detail: detail.into(),
            object,
        });
    }

    /// Process the next canonical block.
    pub fn process_block(&mut self, b: &BlockInput) -> Result<()> {
        if let Some((tip_n, tip_h, _)) = self.tip {
            if b.number != tip_n + 1 || b.parent_hash != tip_h {
                return Err(Error::rule("block does not extend the current tip"));
            }
        }
        if let Some((_, _, tip_clock)) = self.tip {
            if b.clock_ms < tip_clock {
                return Err(Error::rule("median time decreased"));
            }
        }
        self.blocks.insert(b.hash, BlockMeta { number: b.number, clock_ms: b.clock_ms });
        self.advance_polls(b);

        for (tx_index, tx) in b.transactions.iter().enumerate() {
            let tx_index = tx_index as u32;
            // 1. DAO state transitions of this transaction.
            for input in &tx.inputs {
                if let Some(cell) = self.dao_cells.remove(input) {
                    if let Some(set) = self.owner_cells.get_mut(&cell.owner_id) {
                        set.remove(input);
                    }
                }
            }
            for out in &tx.outputs {
                if is_dao_deposit(&self.cfg.network, out) {
                    let op = OutPoint { tx_hash: tx.hash, index: out.index };
                    let owner_id = out.lock.hash();
                    self.owner_locks.entry(owner_id).or_insert_with(|| out.lock.clone());
                    self.dao_cells.insert(
                        op,
                        DaoCell {
                            owner_id,
                            capacity: out.capacity,
                            created: Position { height: b.number, tx_index, output_index: out.index, envelope_index: 0 },
                        },
                    );
                    self.owner_cells.entry(owner_id).or_default().insert(op);
                }
            }
            // 2. Carriers, in output order.
            let mut outs: Vec<&OutputInput> = tx.outputs.iter().collect();
            outs.sort_by_key(|o| o.index);
            for out in outs {
                let header = match Header::decode(&out.data) {
                    Ok(Some(h)) => h,
                    Ok(None) => continue,
                    Err(e) => {
                        let ctx = Ctx {
                            pos: Position { height: b.number, tx_index, output_index: out.index, envelope_index: 0 },
                            tx_hash: tx.hash,
                            clock_ms: b.clock_ms,
                            block_number: b.number,
                        };
                        self.diag(&ctx, "carrier", None, None, None, "INVALID_FORMAT", e.to_string());
                        continue;
                    }
                };
                self.process_carrier(b, tx_index, tx, out.index, &header);
            }
        }
        self.tip = Some((b.number, b.hash, b.clock_ms));
        Ok(())
    }

    /// Opening boundary and closing snapshot, evaluated before the block's transactions.
    fn advance_polls(&mut self, b: &BlockInput) {
        let ids: Vec<Hash32> = self.polls.keys().copied().collect();
        for id in ids {
            let (needs_start, needs_close, start_ms, end_ms, reg_height, opening) = {
                let p = &self.polls[&id];
                (
                    p.start_boundary.is_none() && !p.late_manifest,
                    p.close.is_none(),
                    p.manifest.start_ms,
                    p.manifest.end_ms,
                    p.registered.height,
                    p.manifest.rules.opening_confirmations,
                )
            };
            if needs_start && b.clock_ms >= start_ms {
                let p = self.polls.get_mut(&id).unwrap();
                p.start_boundary = Some((b.number, b.hash));
                if b.number < reg_height || b.number - reg_height < opening {
                    p.late_manifest = true;
                }
            }
            if needs_close && b.clock_ms >= end_ms {
                let owners: Vec<Hash32> = self.polls[&id].owner_locks.keys().copied().collect();
                let mut cells = BTreeMap::new();
                let mut created = BTreeMap::new();
                for o in owners {
                    let deposits = self.owner_deposits(&o);
                    for (op, _) in &deposits {
                        created.insert(*op, self.dao_cells[op].created);
                    }
                    cells.insert(o, deposits);
                }
                let p = self.polls.get_mut(&id).unwrap();
                p.close = Some(CloseSnapshot { number: b.number - 1, hash: b.parent_hash, cells, created });
            }
        }
    }

    fn process_carrier(&mut self, b: &BlockInput, tx_index: u32, tx: &TxInput, output_index: u32, header: &Header) {
        let base = Position { height: b.number, tx_index, output_index, envelope_index: 0 };
        let ctx = |envelope_index: u32| Ctx {
            pos: Position { envelope_index, ..base },
            tx_hash: tx.hash,
            clock_ms: b.clock_ms,
            block_number: b.number,
        };
        let witness = match tx.witnesses.get(header.witness_index as usize) {
            Some(w) => w,
            None => {
                self.diag(&ctx(0), "carrier", None, None, None, "INVALID_FORMAT", "witness index out of range");
                return;
            }
        };
        let payload = match carrier::decode_payload(header, witness) {
            Ok(p) => p,
            Err(e) => {
                self.diag(&ctx(0), header.kind.as_str(), None, None, None, "INVALID_FORMAT", e.to_string());
                return;
            }
        };
        match payload {
            Payload::AuthorizationPolicy(p) => {
                if p.genesis != self.cfg.network.genesis_hash {
                    self.diag(&ctx(0), "authorization_policy", Some(p.hash()), None, None, "WRONG_NETWORK", "policy for another network");
                } else {
                    let h = p.hash();
                    self.policies.entry(h).or_insert((p, base));
                }
            }
            Payload::Manifest(m) => self.process_manifest(&ctx(0), *m),
            Payload::AuthorizationBatch(entries) => {
                for (i, e) in entries.into_iter().enumerate() {
                    let c = ctx(i as u32);
                    match e {
                        Ok(env) => self.process_control(&c, env),
                        Err(err) => self.diag(&c, "authorization_control", None, None, None, "INVALID_FORMAT", err.to_string()),
                    }
                }
            }
            Payload::BallotBatch(entries) => {
                for (i, e) in entries.into_iter().enumerate() {
                    let c = ctx(i as u32);
                    match e {
                        Ok(env) => self.process_ballot(&c, env),
                        Err(err) => self.diag(&c, "ballot", None, Some(header.scope_id), None, "INVALID_FORMAT", err.to_string()),
                    }
                }
            }
            Payload::ProcessRoles(r) => {
                let h = r.roles_hash();
                if r.genesis != self.cfg.network.genesis_hash {
                    self.diag(&ctx(0), "process_roles", Some(h), None, None, "WRONG_NETWORK", "roles for another network");
                    return;
                }
                self.roles_objects.entry(h).or_insert((r, base));
                if self.current_roles.is_none() && self.cfg.initial_roles_hash == Some(h) {
                    self.current_roles = Some(h);
                    self.roles_history.push((base, h));
                }
            }
            Payload::ProcessBatch(entries) => {
                for (i, e) in entries.into_iter().enumerate() {
                    let c = ctx(i as u32);
                    match e {
                        Ok(env) => self.process_record(&c, env),
                        Err(err) => self.diag(&c, "process_record", None, None, None, "INVALID_FORMAT", err.to_string()),
                    }
                }
            }
            Payload::ResultRecord(v) => self.result_records.push((base, tx.hash, v)),
        }
    }

    // -----------------------------------------------------------------------
    // Manifests

    fn process_manifest(&mut self, ctx: &Ctx, payload: ManifestPayload) {
        let m = payload.manifest.clone();
        let poll_id = m.poll_id();
        let net = self.cfg.network.clone();
        let fail = |s: &mut Self, code: &'static str, d: String| {
            s.diag_obj(ctx, "manifest", Some(poll_id), Some(poll_id), None, code, d, Some(payload.to_json()))
        };
        if m.genesis != net.genesis_hash {
            return fail(self, "WRONG_NETWORK", "manifest for another network".into());
        }
        if self.polls.contains_key(&poll_id) {
            return fail(self, "DUPLICATE", "poll already registered".into());
        }
        if !self.policies.contains_key(&m.auth_policy_hash()) {
            return fail(self, "POLICY_UNPUBLISHED", "authorization policy must be published before the manifest".into());
        }
        // Exactly one valid proposer proof per proposer lock.
        if payload.proposer_proofs.len() != m.proposer_owner_locks.len() {
            return fail(self, "INVALID_SIGNATURE", "one proposer proof per proposer lock is required".into());
        }
        for (lock, proof) in m.proposer_owner_locks.iter().zip(payload.proposer_proofs.iter()) {
            if &proof.owner_lock != lock {
                return fail(self, "INVALID_SIGNATURE", "proposer proofs must follow proposer_owner_locks order".into());
            }
            if !m.auth_registry.accepts_owner(&proof.auth_adapter) {
                return fail(self, "ADAPTER_NOT_ACCEPTED", format!("proposer adapter {}", proof.auth_adapter));
            }
            let text = match text::proposal_text(&m, lock, &net) {
                Ok(t) => t,
                Err(e) => return fail(self, "INVALID_FORMAT", e.to_string()),
            };
            if let Err(e) = adapter::verify_owner_signature(&proof.auth_adapter, &net, lock, &text, &proof.proof.signature) {
                return fail(self, "INVALID_SIGNATURE", e.to_string());
            }
        }
        let proposer_deposit_shannon = m.proposer_owner_locks.iter().map(|l| self.owner_balance(&l.hash())).sum();
        let late = ctx.clock_ms >= m.start_ms;
        self.polls.insert(
            poll_id,
            PollState {
                manifest: m,
                payload,
                registered: ctx.pos,
                registered_tx: ctx.tx_hash,
                proposer_deposit_shannon,
                start_boundary: None,
                late_manifest: late,
                close: None,
                ballots: Vec::new(),
                seen_ballots: HashSet::new(),
                owner_locks: BTreeMap::new(),
            },
        );
        if late {
            self.diag(ctx, "manifest", Some(poll_id), Some(poll_id), None, "LATE_MANIFEST", "manifest included after the poll start");
        }
    }

    /// Anchor must be a known canonical block strictly before the inclusion block.
    fn anchor(&self, ctx: &Ctx, hash: &Hash32) -> Option<BlockMeta> {
        self.blocks.get(hash).copied().filter(|m| m.number < ctx.block_number)
    }

    // -----------------------------------------------------------------------
    // Authorization controls (docs/11 §2, §5)

    fn process_control(&mut self, ctx: &Ctx, env: ControlEnvelope) {
        let c = &env.body;
        let auth_id = c.authorization_id();
        let owner_id = c.owner_id();
        let net = self.cfg.network.clone();
        macro_rules! reject {
            ($code:expr, $detail:expr) => {{
                self.diag_obj(ctx, "authorization_control", Some(auth_id), None, Some(owner_id), $code, $detail, Some(env.to_json()));
                return;
            }};
        }
        if c.genesis != net.genesis_hash {
            reject!("WRONG_NETWORK", "control for another network");
        }
        let policy = match self.policies.get(&c.auth_policy_hash) {
            Some((p, pos)) if *pos < ctx.pos => p.clone(),
            _ => reject!("POLICY_UNPUBLISHED", "authorization policy not published before this control"),
        };
        if !adapter::is_control_adapter(&c.owner_auth_adapter, ctx.block_number) {
            reject!("ADAPTER_NOT_ACCEPTED", format!("{} is not a control adapter", c.owner_auth_adapter));
        }
        let anchor = match self.anchor(ctx, &c.anchor_block_hash) {
            Some(a) => a,
            None => reject!("ANCHOR_INVALID", "anchor is not a canonical ancestor"),
        };
        let t_anchor = anchor.clock_ms;
        if c.publication_deadline_ms != t_anchor + policy.max_control_publication_delay_ms {
            reject!("INVALID_FORMAT", "publication_deadline_ms must equal clock(anchor) + publication delay");
        }
        if ctx.clock_ms < t_anchor || ctx.clock_ms >= c.publication_deadline_ms {
            reject!("PUBLICATION_EXPIRED", "control included outside its publication window");
        }
        if c.action == ControlAction::Grant {
            let exp = c.expires_at_ms.expect("validated");
            if exp <= t_anchor || exp - t_anchor > policy.max_term_ms {
                reject!("INVALID_TERM", "expiry must be within (anchor, anchor + max term]");
            }
            if ctx.clock_ms >= exp {
                reject!("GRANT_EXPIRED", "grant included after its expiry");
            }
        }
        let text = match text::control_text(c, &net) {
            Ok(t) => t,
            Err(e) => reject!("INVALID_FORMAT", e.to_string()),
        };
        if let Err(e) = adapter::verify_owner_signature(&c.owner_auth_adapter, &net, &c.owner_lock, &text, &env.proof.signature) {
            reject!("INVALID_SIGNATURE", e.to_string());
        }
        if !self.seen_controls.insert(auth_id) {
            reject!("DUPLICATE", "authorization already seen");
        }

        let key = (c.auth_policy_hash, owner_id);
        let stream = self.streams.entry(key).or_default();
        stream.owner_lock.get_or_insert_with(|| c.owner_lock.clone());
        let h = anchor.number;
        let outcome: &'static str = match stream.a_max {
            Some(a) if h < a => "STALE_AUTHORIZATION",
            Some(a) if h == a => {
                if stream.ids_at_max.contains(&auth_id) {
                    "DUPLICATE"
                } else {
                    stream.ids_at_max.push(auth_id);
                    stream.current = None;
                    stream.conflict = true;
                    stream.barriers.push(Barrier { position: ctx.pos, clock_ms: ctx.clock_ms });
                    "AUTH_CONFLICT"
                }
            }
            _ => {
                stream.a_max = Some(h);
                stream.ids_at_max = vec![auth_id];
                stream.conflict = false;
                match c.action {
                    ControlAction::Grant => {
                        stream.current = Some(auth_id);
                    }
                    ControlAction::Revoke => {
                        stream.current = None;
                    }
                }
                if c.cancels_open() {
                    stream.barriers.push(Barrier { position: ctx.pos, clock_ms: ctx.clock_ms });
                }
                "EFFECTIVE"
            }
        };
        stream.history.push(ControlEvent {
            authorization_id: auth_id,
            position: ctx.pos,
            tx_hash: ctx.tx_hash,
            anchor_height: h,
            action: c.action,
            outcome,
            envelope: env.clone(),
        });
        if c.action == ControlAction::Grant {
            let k = c.key_descriptor.clone().expect("validated");
            self.grants.insert(
                auth_id,
                GrantInfo {
                    authorization_id: auth_id,
                    policy_hash: c.auth_policy_hash,
                    owner_id,
                    owner_adapter: c.owner_auth_adapter.clone(),
                    key_id: k.key_id(),
                    key: k,
                    expires_at_ms: c.expires_at_ms.expect("validated"),
                    position: ctx.pos,
                    anchor_height: h,
                    cancels_open: c.cancels_open(),
                },
            );
        }
        if outcome != "EFFECTIVE" {
            self.diag(ctx, "authorization_control", Some(auth_id), None, Some(owner_id), outcome, "control did not take effect");
        }
    }

    // -----------------------------------------------------------------------
    // Ballots (docs/03 §6, docs/11 §6)

    fn process_ballot(&mut self, ctx: &Ctx, env: BallotEnvelope) {
        let b = &env.body;
        let ballot_id = b.ballot_id();
        let owner_id = b.owner_id();
        let poll_id = b.poll_id;
        let net = self.cfg.network.clone();
        macro_rules! reject {
            ($code:expr, $detail:expr) => {{
                self.diag_obj(ctx, "ballot", Some(ballot_id), Some(poll_id), Some(owner_id), $code, $detail, Some(env.to_json()));
                return;
            }};
        }
        let poll = match self.polls.get(&poll_id) {
            Some(p) => p,
            None => reject!("UNKNOWN_POLL", "poll not registered"),
        };
        if poll.late_manifest {
            reject!("LATE_MANIFEST", "poll has no valid opening");
        }
        let m = &poll.manifest;
        if b.genesis != net.genesis_hash || b.rules_hash != m.rules_hash() {
            reject!("WRONG_NETWORK", "ballot network or rules do not match the manifest");
        }
        if ctx.clock_ms < m.start_ms || ctx.clock_ms >= m.end_ms {
            reject!("OUT_OF_WINDOW", "ballot included outside [start, end)");
        }
        if b.authority == Authority::Delegate && ctx.clock_ms >= m.delegate_end_ms() {
            reject!("OUT_OF_WINDOW", "delegate ballot included after the delegate cutoff");
        }
        let anchor = match self.anchor(ctx, &b.anchor_block_hash) {
            Some(a) if a.number >= poll.registered.height => a,
            Some(_) => reject!("ANCHOR_INVALID", "ballot anchor is older than the manifest"),
            None => reject!("ANCHOR_INVALID", "anchor is not a canonical ancestor"),
        };
        let text = match text::ballot_text(m, b, &net) {
            Ok(t) => t,
            Err(e) => reject!("INVALID_FORMAT", e.to_string()),
        };
        let mut grant_anchor_height = 0;
        match b.authority {
            Authority::Owner => {
                if !m.auth_registry.accepts_owner(&b.auth_adapter) {
                    reject!("ADAPTER_NOT_ACCEPTED", format!("owner adapter {}", b.auth_adapter));
                }
                if let Err(e) = adapter::verify_owner_signature(&b.auth_adapter, &net, &b.owner_lock, &text, &env.proof.signature) {
                    reject!("INVALID_SIGNATURE", e.to_string());
                }
            }
            Authority::Delegate => {
                let auth_id = b.authorization_id.expect("validated");
                let grant = match self.grants.get(&auth_id) {
                    Some(g) => g.clone(),
                    None => reject!("NO_ACTIVE_GRANT", "authorization_id is not a known grant"),
                };
                if grant.owner_id != owner_id || grant.policy_hash != m.auth_policy_hash() {
                    reject!("WRONG_OWNER", "grant belongs to another owner or policy");
                }
                let current = self.streams.get(&(grant.policy_hash, owner_id)).and_then(|s| s.current);
                if current != Some(auth_id) || grant.position >= ctx.pos {
                    reject!("NO_ACTIVE_GRANT", "grant is not the owner's current grant at this position");
                }
                if ctx.clock_ms >= grant.expires_at_ms {
                    reject!("GRANT_EXPIRED", "grant expired before inclusion");
                }
                if b.signer_key_id != Some(grant.key_id) || b.auth_adapter != grant.key.adapter_id() {
                    reject!("KEY_MISMATCH", "signer key does not match the grant");
                }
                if !m.auth_registry.accepts_owner(&grant.owner_adapter) || !m.auth_registry.accepts_key(grant.key.adapter_id()) {
                    reject!("ADAPTER_NOT_ACCEPTED", "grant adapters are not accepted by this poll");
                }
                if let Err(e) = adapter::verify_key_signature(&grant.key, &text, &env.proof.signature) {
                    reject!("INVALID_SIGNATURE", e.to_string());
                }
                grant_anchor_height = grant.anchor_height;
            }
        }
        if b.action != Action::Cancel && self.owner_balance(&owner_id) == 0 {
            reject!("NO_DEPOSIT_AT_CAST", "owner has no active deposit after this transaction");
        }
        let poll = self.polls.get_mut(&poll_id).unwrap();
        if !poll.seen_ballots.insert(ballot_id) {
            reject!("DUPLICATE", "ballot already counted at an earlier position");
        }
        poll.owner_locks.entry(owner_id).or_insert_with(|| b.owner_lock.clone());
        poll.ballots.push(BallotAppearance {
            ballot_id,
            owner_id,
            authority: b.authority,
            authorization_id: b.authorization_id,
            grant_anchor_height,
            anchor_height: anchor.number,
            action: b.action,
            position: ctx.pos,
            tx_hash: ctx.tx_hash,
            envelope: env,
        });
    }

    // -----------------------------------------------------------------------
    // Process records (docs/03 §3.1)

    fn process_record(&mut self, ctx: &Ctx, env: ProcessEnvelope) {
        let r = &env.body;
        let record_id = r.record_id();
        macro_rules! reject {
            ($code:expr, $detail:expr) => {{
                self.diag_obj(ctx, "process_record", Some(record_id), r.poll_id, None, $code, $detail, Some(env.to_json()));
                return;
            }};
        }
        if r.genesis != self.cfg.network.genesis_hash {
            reject!("WRONG_NETWORK", "record for another network");
        }
        let anchor = match self.anchor(ctx, &r.anchor_block_hash) {
            Some(a) => a,
            None => reject!("ANCHOR_INVALID", "anchor is not a canonical ancestor"),
        };
        if r.publication_deadline_ms != anchor.clock_ms + self.cfg.process_publication_delay_ms {
            reject!("INVALID_FORMAT", "publication_deadline_ms must equal clock(anchor) + process delay");
        }
        if ctx.clock_ms < anchor.clock_ms || ctx.clock_ms >= r.publication_deadline_ms {
            reject!("PUBLICATION_EXPIRED", "record included outside its publication window");
        }
        if self.current_roles != Some(r.roles_hash) {
            reject!("ROLES_MISMATCH", "roles_hash is not the effective process roles");
        }
        let roles = self.roles_objects[&r.roles_hash].0.clone();
        let members = roles.members(r.role);
        let text = match text::process_text(r) {
            Ok(t) => t,
            Err(e) => reject!("INVALID_FORMAT", e.to_string()),
        };
        let mut signers: Vec<Hash32> = Vec::new();
        for (key_id, proof) in &env.proofs {
            if signers.contains(key_id) {
                continue;
            }
            if let Some(key) = members.member(key_id) {
                if adapter::verify_key_signature(key, &text, &proof.signature).is_ok() {
                    signers.push(*key_id);
                }
            }
        }
        if (signers.len() as u64) < members.threshold {
            reject!("INVALID_SIGNATURE", format!("{} valid member signatures, threshold {}", signers.len(), members.threshold));
        }
        if !self.seen_records.insert(record_id) {
            reject!("DUPLICATE", "record already seen");
        }
        if let RecordDetail::RolesUpdate { new_roles_hash } = &r.detail {
            let ok = match self.roles_objects.get(new_roles_hash) {
                Some((new_roles, pos)) => *pos < ctx.pos && new_roles.previous_roles_hash == Some(r.roles_hash),
                None => false,
            };
            if !ok {
                reject!("ROLES_MISMATCH", "new roles must be published earlier and chain to the current roles");
            }
            self.current_roles = Some(*new_roles_hash);
            self.roles_history.push((ctx.pos, *new_roles_hash));
        }
        self.records.push(RecordAppearance {
            record_id,
            record_type: r.record_type(),
            poll_id: r.poll_id,
            detail: r.detail.clone(),
            anchor_height: anchor.number,
            position: ctx.pos,
            tx_hash: ctx.tx_hash,
            signers,
            envelope: env,
        });
    }

    // -----------------------------------------------------------------------
    // Queries

    pub fn current_grant(&self, policy_hash: &Hash32, owner_id: &Hash32) -> Option<&GrantInfo> {
        let s = self.streams.get(&(*policy_hash, *owner_id))?;
        let id = s.current?;
        let g = self.grants.get(&id)?;
        match self.tip {
            Some((_, _, clock)) if clock >= g.expires_at_ms => None,
            _ => Some(g),
        }
    }

    pub fn grants_for_key(&self, key_id: &Hash32) -> Vec<&GrantInfo> {
        let mut v: Vec<&GrantInfo> = self.grants.values().filter(|g| &g.key_id == key_id).collect();
        v.sort_by_key(|g| g.position);
        v
    }
}

// ---------------------------------------------------------------------------
// JSON form of the reduced block data (server cache, replay vectors).

impl BlockInput {
    pub fn to_json(&self) -> crate::json::Value {
        use crate::json::{Object, Value};
        use crate::util::dec;
        let txs = self
            .transactions
            .iter()
            .map(|t| {
                Value::Object(
                    Object::new()
                        .with("hash", Value::str(to_hex(&t.hash)))
                        .with(
                            "inputs",
                            Value::Array(
                                t.inputs
                                    .iter()
                                    .map(|i| {
                                        Value::Object(
                                            Object::new()
                                                .with("tx_hash", Value::str(to_hex(&i.tx_hash)))
                                                .with("index", Value::str(dec(i.index))),
                                        )
                                    })
                                    .collect(),
                            ),
                        )
                        .with(
                            "outputs",
                            Value::Array(
                                t.outputs
                                    .iter()
                                    .map(|o| {
                                        Value::Object(
                                            Object::new()
                                                .with("index", Value::str(dec(o.index)))
                                                .with("capacity", Value::str(dec(o.capacity)))
                                                .with("lock", o.lock.to_json())
                                                .with("type", o.type_.as_ref().map(|s| s.to_json()).unwrap_or(Value::Null))
                                                .with("data", Value::str(to_hex(&o.data))),
                                        )
                                    })
                                    .collect(),
                            ),
                        )
                        .with("witnesses", Value::Array(t.witnesses.iter().map(|w| Value::str(to_hex(w))).collect())),
                )
            })
            .collect();
        Value::Object(
            Object::new()
                .with("number", Value::str(dec(self.number)))
                .with("hash", Value::str(to_hex(&self.hash)))
                .with("parent_hash", Value::str(to_hex(&self.parent_hash)))
                .with("clock_ms", Value::str(dec(self.clock_ms)))
                .with("transactions", Value::Array(txs)),
        )
    }

    pub fn from_json(v: &crate::json::Value) -> Result<Self> {
        use crate::json::Fields;
        use crate::util::{parse_dec_u64, parse_hash, parse_hex};
        let mut f = Fields::new(v, "block")?;
        let number = parse_dec_u64(f.str("number")?, "number")?;
        let hash = parse_hash(f.str("hash")?, "hash")?;
        let parent_hash = parse_hash(f.str("parent_hash")?, "parent_hash")?;
        let clock_ms = parse_dec_u64(f.str("clock_ms")?, "clock_ms")?;
        let mut transactions = Vec::new();
        for t in f.array("transactions")? {
            let mut g = Fields::new(t, "transaction")?;
            let hash = parse_hash(g.str("hash")?, "tx hash")?;
            let mut inputs = Vec::new();
            for i in g.array("inputs")? {
                let mut h = Fields::new(i, "input")?;
                let tx_hash = parse_hash(h.str("tx_hash")?, "input tx_hash")?;
                let index = parse_dec_u64(h.str("index")?, "input index")? as u32;
                h.finish()?;
                inputs.push(OutPoint { tx_hash, index });
            }
            let mut outputs = Vec::new();
            for o in g.array("outputs")? {
                let mut h = Fields::new(o, "output")?;
                let index = parse_dec_u64(h.str("index")?, "output index")? as u32;
                let capacity = parse_dec_u64(h.str("capacity")?, "capacity")?;
                let lock = Script::from_json(h.value("lock")?)?;
                let type_ = match h.value("type")? {
                    crate::json::Value::Null => None,
                    s => Some(Script::from_json(s)?),
                };
                let data = parse_hex(h.str("data")?, "data")?;
                h.finish()?;
                outputs.push(OutputInput { index, capacity, lock, type_, data });
            }
            let witnesses = g
                .array("witnesses")?
                .iter()
                .map(|w| parse_hex(w.as_str().unwrap_or("x"), "witness"))
                .collect::<Result<Vec<_>>>()?;
            g.finish()?;
            transactions.push(TxInput { hash, inputs, outputs, witnesses });
        }
        f.finish()?;
        Ok(BlockInput { number, hash, parent_hash, clock_ms, transactions })
    }
}

impl Engine {
    /// Start from a known chain position with a pre-computed DAO deposit set
    /// (accelerated mode: DAO history from the operator's own node index).
    pub fn bootstrap(&mut self, tip_number: u64, tip_hash: Hash32, tip_clock_ms: u64, cells: Vec<(OutPoint, Script, u64)>) {
        for (op, lock, capacity) in cells {
            let owner_id = lock.hash();
            self.owner_locks.entry(owner_id).or_insert(lock);
            self.dao_cells.insert(op, DaoCell { owner_id, capacity, created: Position { height: 0, tx_index: 0, output_index: op.index, envelope_index: 0 } });
            self.owner_cells.entry(owner_id).or_default().insert(op);
        }
        self.blocks.insert(tip_hash, BlockMeta { number: tip_number, clock_ms: tip_clock_ms });
        self.tip = Some((tip_number, tip_hash, tip_clock_ms));
    }

    /// True when the outpoint is a live DAO deposit (used to filter block inputs).
    pub fn is_tracked(&self, op: &OutPoint) -> bool {
        self.dao_cells.contains_key(op)
    }
}

/// Convenience: build the carrier data and witness for a payload.
pub fn make_carrier(kind: carrier::Kind, scope_id: Hash32, payload: Vec<u8>, witness_index: u32) -> (Vec<u8>, Vec<u8>) {
    let header = Header { kind, scope_id, payload_hash: carrier::payload_hash(kind, &payload), witness_index };
    (header.encode(), payload)
}

pub fn hex(h: &Hash32) -> String {
    to_hex(h)
}
