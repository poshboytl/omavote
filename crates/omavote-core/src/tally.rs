//! Final selection per owner, `result_core` and governance/officiality views
//! (docs/03 §3.1, §6, §11; docs/11 §6).

use std::collections::BTreeMap;

use crate::engine::{BallotAppearance, Engine, PollState};
use crate::error::{Error, Result};
use crate::hash::{domain, domain_hash};
use crate::json::{jcs_bytes, Object, Value};
use crate::messages::{Action, Authority, GovStatus, RecordDetail, RecordType};
use crate::molecule::OutPoint;
use crate::types::PROTOCOL_VERSION;
use crate::util::{dec, to_hex, Hash32};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FinalStatus {
    Yes,
    No,
    Cancel,
    Conflict,
    CancelledByControl,
}

impl FinalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            FinalStatus::Yes => "YES",
            FinalStatus::No => "NO",
            FinalStatus::Cancel => "CANCEL",
            FinalStatus::Conflict => "CONFLICT",
            FinalStatus::CancelledByControl => "CANCELLED_BY_CONTROL",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Selection {
    pub owner_id: Hash32,
    pub status: FinalStatus,
    pub ballot_id: Option<Hash32>,
    pub authorization_id: Option<Hash32>,
    pub authority: Option<Authority>,
}

/// Apply direct priority, barriers and anchor ordering for every participating owner.
pub fn select(engine: &Engine, poll: &PollState) -> Vec<Selection> {
    let m = &poll.manifest;
    let policy = m.auth_policy_hash();
    let mut by_owner: BTreeMap<Hash32, Vec<&BallotAppearance>> = BTreeMap::new();
    for b in &poll.ballots {
        by_owner.entry(b.owner_id).or_default().push(b);
    }
    let mut out = Vec::new();
    for (owner_id, ballots) in by_owner {
        let direct: Vec<&&BallotAppearance> = ballots.iter().filter(|b| b.authority == Authority::Owner).collect();
        let sel = if !direct.is_empty() {
            pick(owner_id, direct.into_iter().map(|b| ((0, b.anchor_height), *b)).collect())
        } else {
            let barriers: Vec<_> = engine
                .streams
                .get(&(policy, owner_id))
                .map(|s| s.barriers.iter().filter(|bar| bar.clock_ms >= m.start_ms && bar.clock_ms < m.end_ms).copied().collect())
                .unwrap_or_default();
            let remaining: Vec<&&BallotAppearance> =
                ballots.iter().filter(|b| !barriers.iter().any(|bar: &crate::engine::Barrier| b.position <= bar.position)).collect();
            if remaining.is_empty() {
                Selection {
                    owner_id,
                    status: FinalStatus::CancelledByControl,
                    ballot_id: None,
                    authorization_id: None,
                    authority: Some(Authority::Delegate),
                }
            } else {
                pick(owner_id, remaining.into_iter().map(|b| ((b.grant_anchor_height, b.anchor_height), *b)).collect())
            }
        };
        out.push(sel);
    }
    out
}

fn pick(owner_id: Hash32, ballots: Vec<((u64, u64), &BallotAppearance)>) -> Selection {
    let max = ballots.iter().map(|(k, _)| *k).max().expect("non-empty");
    let top: Vec<&BallotAppearance> = ballots.iter().filter(|(k, _)| *k == max).map(|(_, b)| *b).collect();
    let first = top[0];
    if top.iter().any(|b| b.ballot_id != first.ballot_id) {
        return Selection {
            owner_id,
            status: FinalStatus::Conflict,
            ballot_id: None,
            authorization_id: None,
            authority: Some(first.authority),
        };
    }
    let status = match first.action {
        Action::Yes => FinalStatus::Yes,
        Action::No => FinalStatus::No,
        Action::Cancel => FinalStatus::Cancel,
    };
    Selection {
        owner_id,
        status,
        ballot_id: Some(first.ballot_id),
        authorization_id: first.authorization_id,
        authority: Some(first.authority),
    }
}

#[derive(Clone, Debug)]
pub struct OwnerRow {
    pub selection: Selection,
    pub eligible_principal_shannon: u128,
    pub counted_weight_shannon: u128,
}

#[derive(Clone, Debug)]
pub struct Tally {
    pub rows: Vec<OwnerRow>,
    pub counted_cells: Vec<(OutPoint, Hash32, u64)>,
    pub yes: u128,
    pub no: u128,
    pub quorum_required: u128,
    pub passed: bool,
}

/// Tally with the given deposit view (close snapshot or current state for previews).
pub fn tally_with(engine: &Engine, poll: &PollState, deposits: &dyn Fn(&Hash32) -> Vec<(OutPoint, u64)>) -> Tally {
    let m = &poll.manifest;
    let mut rows = Vec::new();
    let mut counted_cells = Vec::new();
    let (mut yes, mut no) = (0u128, 0u128);
    for sel in select(engine, poll) {
        let cells = deposits(&sel.owner_id);
        let eligible: u128 = cells.iter().map(|(_, c)| *c as u128).sum();
        let counted = match sel.status {
            FinalStatus::Yes | FinalStatus::No => eligible,
            _ => 0,
        };
        match sel.status {
            FinalStatus::Yes => yes += counted,
            FinalStatus::No => no += counted,
            _ => {}
        }
        if counted > 0 {
            for (op, cap) in &cells {
                counted_cells.push((*op, sel.owner_id, *cap));
            }
        }
        rows.push(OwnerRow { selection: sel, eligible_principal_shannon: eligible, counted_weight_shannon: counted });
    }
    counted_cells.sort_by(|a, b| a.0.tx_hash.cmp(&b.0.tx_hash).then(a.0.index.cmp(&b.0.index)));
    let q = yes + no;
    let quorum_required = m.quorum_required();
    let r = m.approval();
    let approval_ok =
        if m.rules.threshold_inclusive { yes * r.denominator >= r.numerator * q } else { yes * r.denominator > r.numerator * q };
    let passed = q > 0 && q >= quorum_required && approval_ok;
    Tally { rows, counted_cells, yes, no, quorum_required, passed }
}

#[derive(Clone, Debug)]
pub struct ResultCore {
    pub value: Value,
    pub tally: Tally,
}

impl ResultCore {
    pub fn result_hash(&self) -> Hash32 {
        domain_hash(domain::RESULT, &jcs_bytes(&self.value))
    }
}

/// Canonical `result_core` for a closed poll; `None` while the poll is still open.
pub fn result_core(engine: &Engine, poll_id: &Hash32) -> Result<Option<ResultCore>> {
    let poll = engine.polls.get(poll_id).ok_or_else(|| Error::rule("unknown poll"))?;
    if poll.late_manifest {
        return Err(Error::rule("LATE_MANIFEST: poll has no valid opening and no result"));
    }
    let close = match &poll.close {
        Some(c) => c,
        None => return Ok(None),
    };
    let (start_n, start_h) = poll.start_boundary.expect("closed polls have a start boundary");
    let _ = start_n;
    let snapshot = |o: &Hash32| close.cells.get(o).cloned().unwrap_or_default();
    let t = tally_with(engine, poll, &snapshot);
    let m = &poll.manifest;
    let opt = |h: Option<Hash32>| Value::opt_str(h.map(|x| to_hex(&x)));
    let owners: Vec<Value> = t
        .rows
        .iter()
        .map(|r| {
            Value::Object(
                Object::new()
                    .with("owner_id", Value::str(to_hex(&r.selection.owner_id)))
                    .with("final_status", Value::str(r.selection.status.as_str()))
                    .with("ballot_id", opt(r.selection.ballot_id))
                    .with("authorization_id", opt(r.selection.authorization_id))
                    .with("eligible_principal_shannon", Value::str(dec(r.eligible_principal_shannon)))
                    .with("counted_weight_shannon", Value::str(dec(r.counted_weight_shannon))),
            )
        })
        .collect();
    let cells: Vec<Value> = t
        .counted_cells
        .iter()
        .map(|(op, owner, cap)| {
            Value::Object(
                Object::new()
                    .with("tx_hash", Value::str(to_hex(&op.tx_hash)))
                    .with("index", Value::str(dec(op.index)))
                    .with("owner_id", Value::str(to_hex(owner)))
                    .with("capacity_shannon", Value::str(dec(*cap))),
            )
        })
        .collect();
    let r = m.approval();
    let value = Value::Object(
        Object::new()
            .with("protocol_version", Value::str(PROTOCOL_VERSION))
            .with("network_genesis_hash", Value::str(to_hex(&m.genesis)))
            .with("poll_id", Value::str(to_hex(poll_id)))
            .with("rules_hash", Value::str(to_hex(&m.rules_hash())))
            .with("auth_policy_hash", Value::str(to_hex(&m.auth_policy_hash())))
            .with("auth_registry_hash", Value::str(to_hex(&m.auth_registry_hash())))
            .with("start_boundary_block_hash", Value::str(to_hex(&start_h)))
            .with("close_block_hash", Value::str(to_hex(&close.hash)))
            .with("close_block_number", Value::str(dec(close.number)))
            .with("owners", Value::Array(owners))
            .with("counted_cells", Value::Array(cells))
            .with("yes_shannon", Value::str(dec(t.yes)))
            .with("no_shannon", Value::str(dec(t.no)))
            .with("participation_shannon", Value::str(dec(t.yes + t.no)))
            .with("quorum_required_shannon", Value::str(dec(t.quorum_required)))
            .with("approval_numerator", Value::str(dec(r.numerator)))
            .with("approval_denominator", Value::str(dec(r.denominator)))
            .with("threshold_comparison", Value::str(if m.rules.threshold_inclusive { "inclusive" } else { "strict" }))
            .with("outcome", Value::str(if t.passed { "PASS" } else { "FAIL" })),
    );
    Ok(Some(ResultCore { value, tally: t }))
}

/// Owners whose selected YES/NO ballot carries zero final principal: the choice is
/// kept in result_core and ZERO_FINAL_WEIGHT is reported as an extra diagnostic
/// (docs/03 §11), in owner_id order.
pub fn zero_final_weight_owners(rc: &ResultCore) -> Vec<Hash32> {
    rc.tally
        .rows
        .iter()
        .filter(|r| matches!(r.selection.status, FinalStatus::Yes | FinalStatus::No) && r.counted_weight_shannon == 0)
        .map(|r| r.selection.owner_id)
        .collect()
}

// ---------------------------------------------------------------------------
// Officiality and governance views (never part of result_core)

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdmissionView {
    Pending,
    Admitted(Hash32),
    Rejected(Hash32),
    Missing,
    Conflict,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernanceView {
    None,
    Status(GovStatus, Hash32),
    /// Conflicting records at the highest anchor: treated as HOLD_EXECUTION.
    Conflict,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttestationView {
    None,
    Confirmed(Hash32),
    /// Attested hash or outcome differs from the independently computed result.
    Disputed(String),
    Conflict,
}

/// Records of one type for a poll, reduced to the highest anchor.
/// Records at that anchor with different details conflict.
fn top_records(engine: &Engine, poll_id: &Hash32, t: RecordType, max_height: Option<u64>) -> Option<Vec<(Hash32, RecordDetail)>> {
    let recs: Vec<_> = engine
        .records
        .iter()
        .filter(|r| r.record_type == t && r.poll_id.as_ref() == Some(poll_id))
        .filter(|r| max_height.map(|h| r.position.height <= h).unwrap_or(true))
        .collect();
    let max = recs.iter().map(|r| r.anchor_height).max()?;
    Some(recs.iter().filter(|r| r.anchor_height == max).map(|r| (r.record_id, r.detail.clone())).collect())
}

fn single<T: Clone + PartialEq>(v: Vec<(Hash32, T)>) -> Result<(Hash32, T)> {
    let first = v[0].clone();
    if v.iter().any(|(_, d)| d != &first.1) {
        return Err(Error::rule("RECORD_CONFLICT"));
    }
    Ok(first)
}

pub fn admission(engine: &Engine, poll: &PollState) -> AdmissionView {
    let poll_id = poll.manifest.poll_id();
    let (b_s, _) = match poll.start_boundary {
        Some(s) => s,
        None => return AdmissionView::Pending,
    };
    let limit = b_s.checked_sub(poll.manifest.rules.opening_confirmations);
    let limit = match limit {
        Some(l) => l,
        None => return AdmissionView::Missing,
    };
    match top_records(engine, &poll_id, RecordType::Admission, Some(limit)) {
        None => AdmissionView::Missing,
        Some(v) => match single(v) {
            Err(_) => AdmissionView::Conflict,
            Ok((id, RecordDetail::Admission { admitted: true })) => AdmissionView::Admitted(id),
            Ok((id, _)) => AdmissionView::Rejected(id),
        },
    }
}

pub fn governance(engine: &Engine, poll_id: &Hash32) -> GovernanceView {
    match top_records(engine, poll_id, RecordType::GovernanceStatus, None) {
        None => GovernanceView::None,
        Some(v) => match single(v) {
            Err(_) => GovernanceView::Conflict,
            Ok((id, RecordDetail::GovernanceStatus { status })) => GovernanceView::Status(status, id),
            Ok(_) => GovernanceView::Conflict,
        },
    }
}

pub fn attestation(engine: &Engine, poll_id: &Hash32, computed: Option<&ResultCore>) -> AttestationView {
    match top_records(engine, poll_id, RecordType::ResultAttestation, None) {
        None => AttestationView::None,
        Some(v) => match single(v) {
            Err(_) => AttestationView::Conflict,
            Ok((id, RecordDetail::ResultAttestation { result_hash, pass })) => match computed {
                None => AttestationView::Disputed("poll has no computed result yet".into()),
                Some(rc) if rc.result_hash() != result_hash => {
                    AttestationView::Disputed("attested result_hash differs from the recomputed result".into())
                }
                Some(rc) if rc.tally.passed != pass => {
                    AttestationView::Disputed("attested outcome contradicts the conclusion of result_hash".into())
                }
                Some(_) => AttestationView::Confirmed(id),
            },
            Ok(_) => AttestationView::Conflict,
        },
    }
}

/// Proposer deposit requirement (checked after the manifest transaction).
pub fn proposer_eligible(poll: &PollState) -> bool {
    poll.proposer_deposit_shannon >= poll.manifest.rules.proposer_min_deposit_shannon
}
