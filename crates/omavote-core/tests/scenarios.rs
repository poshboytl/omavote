//! Executable versions of the expected results in docs/11 §8 (rows S1–S31),
//! plus the process-record, opening and tally rules from docs/03.

use omavote_core::carrier::Kind;
use omavote_core::engine::Engine;
use omavote_core::messages::*;
use omavote_core::tally::{self, AdmissionView, AttestationView, FinalStatus, GovernanceView, ResultCore};
use omavote_core::testkit::*;
use omavote_core::types::*;
use omavote_core::util::Hash32;

const T0: u64 = 1_800_000_000_000;
const HOUR: u64 = 3_600_000;

struct S {
    c: TestChain,
    a: TestOwner,
    b: TestOwner,
    k: TestKey,
}

fn rules() -> RulesParams {
    RulesParams { opening_confirmations: 2, ..RulesParams::default() }
}

fn setup() -> S {
    let mut c = TestChain::new(T0);
    let a = TestOwner::ckb("alice", &c.net);
    let b = TestOwner::ckb("bob", &c.net);
    c.deposit(&a.lock, 100_000);
    c.deposit(&a.lock, 200_000);
    c.deposit(&b.lock, 300_000);
    c.publish_policy();
    c.mine(HOUR);
    S { c, a, b, k: TestKey::evm("voting-key") }
}

fn poll_with(s: &mut S, start_offset: u64, rules: RulesParams, registry: AuthRegistry) -> Manifest {
    let start = s.c.clock_ms + start_offset;
    let p = s.c.manifest(&[&s.a], start, registry, rules, 1000);
    s.c.publish_manifest(&p);
    s.c.mine(HOUR);
    p.manifest
}

fn poll(s: &mut S) -> Manifest {
    poll_with(s, 5 * HOUR, rules(), TestChain::default_registry())
}

fn open(s: &mut S, m: &Manifest) {
    while s.c.clock_ms < m.start_ms {
        s.c.mine(HOUR);
    }
}

fn close(s: &mut S, m: &Manifest) {
    while s.c.engine.polls[&m.poll_id()].close.is_none() {
        s.c.mine(HOUR);
    }
}

fn result(s: &S, m: &Manifest) -> ResultCore {
    tally::result_core(&s.c.engine, &m.poll_id()).unwrap().expect("closed")
}

fn status(rc: &ResultCore, o: &TestOwner) -> FinalStatus {
    rc.tally.rows.iter().find(|r| r.selection.owner_id == o.id()).map(|r| r.selection.status).expect("owner row")
}

fn codes(s: &S, id: &Hash32) -> Vec<&'static str> {
    s.c.engine.diagnostics.iter().filter(|d| d.id.as_ref() == Some(id)).map(|d| d.code).collect()
}

fn ballot_id(e: &BallotEnvelope) -> Hash32 {
    e.body.ballot_id()
}

fn auth_id(e: &ControlEnvelope) -> Hash32 {
    e.body.authorization_id()
}

const YEAR: u64 = 365 * DAY;

/// Grant `key` for `owner` anchored at the current tip and publish it.
fn grant_now(s: &mut S, owner: &TestOwner, key: &TestKey) -> ControlEnvelope {
    let anchor = s.c.tip_hash;
    let g = s.c.grant(owner, key, YEAR, anchor);
    s.c.publish_controls(std::slice::from_ref(&g));
    s.c.mine(HOUR);
    g
}

// S1: two owners grant the same key; three deposits, each counted once.
#[test]
fn s01_two_owners_one_key() {
    let mut s = setup();
    let (a, b, k) = (s.a.clone(), s.b.clone(), s.k.clone());
    let ga = grant_now(&mut s, &a, &k);
    let gb = grant_now(&mut s, &b, &k);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let va = s.c.delegate_ballot(&m, &a, &ga, &k, Action::Yes, anchor);
    let vb = s.c.delegate_ballot(&m, &b, &gb, &k, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[va, vb]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    let rc = result(&s, &m);
    assert_eq!(status(&rc, &a), FinalStatus::Yes);
    assert_eq!(status(&rc, &b), FinalStatus::Yes);
    assert_eq!(rc.tally.yes, 600_000 * 100_000_000);
    assert_eq!(rc.tally.counted_cells.len(), 3);
    assert!(rc.tally.passed);
}

// S2: A's grant expires on day 10, B's on day 30; K votes Yes on day 5 and No on day 12.
#[test]
fn s02_per_owner_expiry() {
    let mut s = setup();
    let (a, b, k) = (s.a.clone(), s.b.clone(), s.k.clone());
    let anchor = s.c.tip_hash;
    let ga = s.c.grant(&a, &k, 10 * DAY, anchor);
    let gb = s.c.grant(&b, &k, 30 * DAY, anchor);
    s.c.publish_controls(&[ga.clone(), gb.clone()]);
    s.c.mine(HOUR);
    let m = poll_with(&mut s, 5 * HOUR, RulesParams { voting_period_ms: 30 * DAY, ..rules() }, TestChain::default_registry());
    open(&mut s, &m);
    while s.c.clock_ms < T0 + 5 * DAY {
        s.c.mine(6 * HOUR);
    }
    let anchor = s.c.tip_hash;
    let y = [s.c.delegate_ballot(&m, &a, &ga, &k, Action::Yes, anchor), s.c.delegate_ballot(&m, &b, &gb, &k, Action::Yes, anchor)];
    s.c.publish_ballots(m.poll_id(), &y);
    s.c.mine(HOUR);
    while s.c.clock_ms < T0 + 12 * DAY {
        s.c.mine(6 * HOUR);
    }
    let anchor = s.c.tip_hash;
    let na = s.c.delegate_ballot(&m, &a, &ga, &k, Action::No, anchor);
    let nb = s.c.delegate_ballot(&m, &b, &gb, &k, Action::No, anchor);
    s.c.publish_ballots(m.poll_id(), &[na.clone(), nb]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    let rc = result(&s, &m);
    assert_eq!(status(&rc, &a), FinalStatus::Yes);
    assert_eq!(status(&rc, &b), FinalStatus::No);
    assert!(codes(&s, &ballot_id(&na)).contains(&"GRANT_EXPIRED"));
}

// S3: the key signs many delegate ballots; the owner's direct No takes priority.
#[test]
fn s03_direct_priority_over_many_delegate_ballots() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let g = grant_now(&mut s, &a, &k);
    let m = poll(&mut s);
    open(&mut s, &m);
    for _ in 0..5 {
        let anchor = s.c.tip_hash;
        let v = s.c.delegate_ballot(&m, &a, &g, &k, Action::Yes, anchor);
        s.c.publish_ballots(m.poll_id(), &[v]);
        s.c.mine(HOUR);
    }
    let anchor = s.c.tip_hash;
    let d = s.c.direct_ballot(&m, &a, Action::No, anchor);
    s.c.publish_ballots(m.poll_id(), &[d]);
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let late = s.c.delegate_ballot(&m, &a, &g, &k, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[late]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &a), FinalStatus::No);
}

// S4: ballot 2 is never published by the first relay; ballot 3 goes through a backup relay.
#[test]
fn s04_latest_revision_published_alone() {
    let mut s = setup();
    let a = s.a.clone();
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v1 = s.c.direct_ballot(&m, &a, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[v1]);
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let v2 = s.c.direct_ballot(&m, &a, Action::No, anchor);
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let v3 = s.c.direct_ballot(&m, &a, Action::Cancel, anchor);
    s.c.publish_ballots(m.poll_id(), &[v3]);
    s.c.mine(HOUR);
    s.c.publish_ballots(m.poll_id(), &[v2]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &a), FinalStatus::Cancel);
}

// S5: a ballot obtained by another website is withheld and published at the end.
#[test]
fn s05_withheld_phished_ballot_loses_to_later_revision() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let g = grant_now(&mut s, &a, &k);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let phished = s.c.delegate_ballot(&m, &a, &g, &k, Action::No, anchor);
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let honest = s.c.delegate_ballot(&m, &a, &g, &k, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[honest]);
    s.c.mine(HOUR);
    while s.c.clock_ms + HOUR < m.end_ms {
        s.c.mine(HOUR);
    }
    s.c.publish_ballots(m.poll_id(), &[phished]);
    s.c.mine(HOUR / 2);
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &a), FinalStatus::Yes);
}

// S6: withheld ballot anchored at H; a revision anchored at H+1 wins, one anchored at H-1 loses.
#[test]
fn s06_revision_anchor_must_be_newest_block() {
    for (offset, expected) in [(1i64, FinalStatus::Yes), (-1, FinalStatus::No)] {
        let mut s = setup();
        let a = s.a.clone();
        let m = poll(&mut s);
        open(&mut s, &m);
        let h_minus_1 = s.c.tip_hash;
        s.c.mine(HOUR);
        let h = s.c.tip_hash;
        let withheld = s.c.direct_ballot(&m, &a, Action::No, h);
        s.c.mine(HOUR);
        let h_plus_1 = s.c.tip_hash;
        let anchor = if offset > 0 { h_plus_1 } else { h_minus_1 };
        let revision = s.c.direct_ballot(&m, &a, Action::Yes, anchor);
        s.c.publish_ballots(m.poll_id(), &[revision]);
        s.c.mine(HOUR);
        s.c.publish_ballots(m.poll_id(), &[withheld]);
        s.c.mine(HOUR);
        close(&mut s, &m);
        assert_eq!(status(&result(&s, &m), &a), expected, "revision anchor offset {offset}");
    }
}

// S7: two different ballots at the same anchor conflict; a newer ballot resolves it.
#[test]
fn s07_same_anchor_conflict_then_recovery() {
    let mut s = setup();
    let a = s.a.clone();
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let x = s.c.direct_ballot(&m, &a, Action::Yes, anchor);
    let y = s.c.direct_ballot(&m, &a, Action::No, anchor);
    s.c.publish_ballots(m.poll_id(), &[x, y]);
    s.c.mine(HOUR);
    let mut early = s.c.engine.clone();
    early
        .process_block(&omavote_core::engine::BlockInput {
            number: s.c.tip_number + 1,
            hash: [9; 32],
            parent_hash: s.c.tip_hash,
            clock_ms: m.end_ms + 1,
            transactions: vec![],
        })
        .unwrap();
    let conflicted = tally::result_core(&early, &m.poll_id()).unwrap().unwrap();
    assert_eq!(status(&conflicted, &a), FinalStatus::Conflict);
    assert_eq!(conflicted.tally.yes + conflicted.tally.no, 0);

    let anchor = s.c.tip_hash;
    let z = s.c.direct_ballot(&m, &a, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[z]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &a), FinalStatus::Yes);
}

// S8: control processing never depends on a poll's adapter list.
#[test]
fn s08_narrow_registry_cannot_revive_revoked_grant() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let g = grant_now(&mut s, &a, &k);
    let anchor = s.c.tip_hash;
    let r = s.c.revoke(&a, RevokeMode::StopOnly, anchor);
    s.c.publish_controls(&[r]);
    s.c.mine(HOUR);
    let narrow = AuthRegistry::new(
        vec![omavote_core::adapter::EVM_PERSONAL_MESSAGE_V1.into()],
        vec![omavote_core::adapter::EVM_PERSONAL_MESSAGE_V1.into()],
    );
    // The proposer must use an adapter the poll accepts, so an EVM owner proposes.
    let proposer = TestOwner::evm_omnilock("evm-proposer", &s.c.net);
    let start = s.c.clock_ms + 5 * HOUR;
    let p = s.c.manifest(&[&proposer], start, narrow, rules(), 1000);
    s.c.publish_manifest(&p);
    s.c.mine(HOUR);
    let m = p.manifest;
    assert!(s.c.engine.polls.contains_key(&m.poll_id()));
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v = s.c.delegate_ballot(&m, &a, &g, &k, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), std::slice::from_ref(&v));
    s.c.mine(HOUR);
    assert!(codes(&s, &ballot_id(&v)).contains(&"NO_ACTIVE_GRANT"));
    assert!(s.c.engine.current_grant(&s.c.policy.hash(), &a.id()).is_none());
}

// S9: a lagging recovery page anchors its REVOKE below the attacker's GRANT; re-signing fixes it.
#[test]
fn s09_lagging_revoke_is_stale_until_resigned() {
    let mut s = setup();
    let a = s.a.clone();
    let attacker = TestKey::evm("attacker");
    let lagging_anchor = s.c.tip_hash;
    s.c.mine(HOUR);
    let att_anchor = s.c.tip_hash;
    let phished = s.c.grant(&a, &attacker, YEAR, att_anchor);
    s.c.publish_controls(std::slice::from_ref(&phished));
    s.c.mine(HOUR);
    let stale = s.c.revoke(&a, RevokeMode::StopAndCancelOpen, lagging_anchor);
    s.c.publish_controls(std::slice::from_ref(&stale));
    s.c.mine(HOUR);
    assert!(codes(&s, &auth_id(&stale)).contains(&"STALE_AUTHORIZATION"));
    assert_eq!(s.c.engine.current_grant(&s.c.policy.hash(), &a.id()).map(|g| g.key_id), Some(attacker.id()));
    let anchor = s.c.tip_hash;
    let fresh = s.c.revoke(&a, RevokeMode::StopAndCancelOpen, anchor);
    s.c.publish_controls(&[fresh]);
    s.c.mine(HOUR);
    assert!(s.c.engine.current_grant(&s.c.policy.hash(), &a.id()).is_none());
}

// S10: a phished, withheld GRANT loses to the owner's later GRANT.
#[test]
fn s10_withheld_phished_grant_is_stale() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let attacker = TestKey::evm("attacker");
    let anchor = s.c.tip_hash;
    let phished = s.c.grant(&a, &attacker, YEAR, anchor);
    s.c.mine(HOUR);
    let honest = grant_now(&mut s, &a, &k);
    s.c.publish_controls(std::slice::from_ref(&phished));
    s.c.mine(HOUR);
    assert!(codes(&s, &auth_id(&phished)).contains(&"STALE_AUTHORIZATION"));
    assert_eq!(s.c.engine.current_grant(&s.c.policy.hash(), &a.id()).map(|g| g.authorization_id), Some(auth_id(&honest)));
}

// S11: REVOKE(200) and GRANT(205) land out of order: the revoke is stale and old votes stay.
#[test]
fn s11_revoke_then_grant_out_of_order_keeps_old_votes() {
    let mut s = setup();
    let (a, k1) = (s.a.clone(), s.k.clone());
    let k2 = TestKey::evm("new-key");
    let g1 = grant_now(&mut s, &a, &k1);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v = s.c.delegate_ballot(&m, &a, &g1, &k1, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[v]);
    s.c.mine(HOUR);
    let anchor_r = s.c.tip_hash;
    let revoke = s.c.revoke(&a, RevokeMode::StopAndCancelOpen, anchor_r);
    s.c.mine(HOUR);
    let anchor_g = s.c.tip_hash;
    let g2 = s.c.grant(&a, &k2, YEAR, anchor_g);
    s.c.publish_controls(&[g2]);
    s.c.mine(HOUR);
    s.c.publish_controls(std::slice::from_ref(&revoke));
    s.c.mine(HOUR);
    assert!(codes(&s, &auth_id(&revoke)).contains(&"STALE_AUTHORIZATION"));
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &a), FinalStatus::Yes, "documented hazard: old delegate vote survives");
}

// S12: GRANT with STOP_AND_CANCEL_OPEN replaces the key and cancels old votes in one step.
#[test]
fn s12_grant_cancel_replaces_key_and_cancels_open_votes() {
    let mut s = setup();
    let (a, b, k1) = (s.a.clone(), s.b.clone(), s.k.clone());
    let k2 = TestKey::evm("new-key");
    let g1 = grant_now(&mut s, &a, &k1);
    let gb = grant_now(&mut s, &b, &k1);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let va = s.c.delegate_ballot(&m, &a, &g1, &k1, Action::Yes, anchor);
    let vb = s.c.delegate_ballot(&m, &b, &gb, &k1, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[va, vb]);
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let g2 = s.c.grant_cancel(&a, &k2, YEAR, anchor);
    s.c.publish_controls(std::slice::from_ref(&g2));
    s.c.mine(HOUR);
    let mut snap = s.c.engine.clone();
    snap.process_block(&omavote_core::engine::BlockInput {
        number: s.c.tip_number + 1,
        hash: [8; 32],
        parent_hash: s.c.tip_hash,
        clock_ms: m.end_ms,
        transactions: vec![],
    })
    .unwrap();
    let rc = tally::result_core(&snap, &m.poll_id()).unwrap().unwrap();
    assert_eq!(status(&rc, &a), FinalStatus::CancelledByControl);
    assert_eq!(status(&rc, &b), FinalStatus::Yes, "barriers are per owner");
    let anchor = s.c.tip_hash;
    let v2 = s.c.delegate_ballot(&m, &a, &g2, &k2, Action::No, anchor);
    s.c.publish_ballots(m.poll_id(), &[v2]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &a), FinalStatus::No);
}

// S13: switching keys keeps the old vote until the new key votes.
#[test]
fn s13_new_key_overrides_only_after_it_votes() {
    let mut s = setup();
    let (a, k1) = (s.a.clone(), s.k.clone());
    let k2 = TestKey::secp("phone-key");
    let g1 = grant_now(&mut s, &a, &k1);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v1 = s.c.delegate_ballot(&m, &a, &g1, &k1, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[v1]);
    s.c.mine(HOUR);
    let g2 = grant_now(&mut s, &a, &k2);
    let mut snap = s.c.engine.clone();
    snap.process_block(&omavote_core::engine::BlockInput {
        number: s.c.tip_number + 1,
        hash: [7; 32],
        parent_hash: s.c.tip_hash,
        clock_ms: m.end_ms,
        transactions: vec![],
    })
    .unwrap();
    assert_eq!(status(&tally::result_core(&snap, &m.poll_id()).unwrap().unwrap(), &a), FinalStatus::Yes);
    // The new grant's ballot ranks higher even though its ballot anchor is older than nothing else.
    let anchor = s.c.tip_hash;
    let v2 = s.c.delegate_ballot(&m, &a, &g2, &k2, Action::No, anchor);
    s.c.publish_ballots(m.poll_id(), &[v2]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &a), FinalStatus::No);
}

// S14: an older-anchored GRANT published after a newer REVOKE does not restore authority.
#[test]
fn s14_older_grant_after_newer_revoke() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let anchor = s.c.tip_hash;
    let g = s.c.grant(&a, &k, YEAR, anchor);
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let r = s.c.revoke(&a, RevokeMode::StopOnly, anchor);
    s.c.publish_controls(&[r]);
    s.c.mine(HOUR);
    s.c.publish_controls(std::slice::from_ref(&g));
    s.c.mine(HOUR);
    assert!(codes(&s, &auth_id(&g)).contains(&"STALE_AUTHORIZATION"));
    assert!(s.c.engine.current_grant(&s.c.policy.hash(), &a.id()).is_none());
}

// S15: a phished GRANT is live; the owner's later safe revoke cancels the attacker's open votes.
#[test]
fn s15_safe_revoke_after_phished_grant() {
    let mut s = setup();
    let a = s.a.clone();
    let attacker = TestKey::evm("attacker");
    let g = grant_now(&mut s, &a, &attacker);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v = s.c.delegate_ballot(&m, &a, &g, &attacker, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[v]);
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let r = s.c.revoke(&a, RevokeMode::StopAndCancelOpen, anchor);
    s.c.publish_controls(&[r]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &a), FinalStatus::CancelledByControl);
}

// S16: a withheld earlier GRANT published within 24 hours after the revoke is stale.
#[test]
fn s16_withheld_grant_after_revoke() {
    let mut s = setup();
    let a = s.a.clone();
    let attacker = TestKey::evm("attacker");
    let anchor = s.c.tip_hash;
    let withheld = s.c.grant(&a, &attacker, YEAR, anchor);
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let r = s.c.revoke(&a, RevokeMode::StopAndCancelOpen, anchor);
    s.c.publish_controls(&[r]);
    s.c.mine(HOUR);
    s.c.publish_controls(std::slice::from_ref(&withheld));
    s.c.mine(HOUR);
    assert!(codes(&s, &auth_id(&withheld)).contains(&"STALE_AUTHORIZATION"));
}

// S17: natural expiry and STOP_ONLY keep the earlier Yes; later delegate ballots are invalid.
#[test]
fn s17_expiry_and_stop_only_keep_votes() {
    for use_revoke in [false, true] {
        let mut s = setup();
        let (a, k) = (s.a.clone(), s.k.clone());
        let anchor = s.c.tip_hash;
        let g = s.c.grant(&a, &k, 2 * DAY, anchor);
        s.c.publish_controls(std::slice::from_ref(&g));
        s.c.mine(HOUR);
        let m = poll(&mut s);
        open(&mut s, &m);
        let anchor = s.c.tip_hash;
        let v = s.c.delegate_ballot(&m, &a, &g, &k, Action::Yes, anchor);
        s.c.publish_ballots(m.poll_id(), &[v]);
        s.c.mine(HOUR);
        if use_revoke {
            let anchor = s.c.tip_hash;
            let r = s.c.revoke(&a, RevokeMode::StopOnly, anchor);
            s.c.publish_controls(&[r]);
            s.c.mine(HOUR);
        } else {
            s.c.mine(2 * DAY);
        }
        let anchor = s.c.tip_hash;
        let late = s.c.delegate_ballot(&m, &a, &g, &k, Action::No, anchor);
        s.c.publish_ballots(m.poll_id(), std::slice::from_ref(&late));
        s.c.mine(HOUR);
        close(&mut s, &m);
        assert_eq!(status(&result(&s, &m), &a), FinalStatus::Yes);
        let c = codes(&s, &ballot_id(&late));
        assert!(c.contains(&"GRANT_EXPIRED") || c.contains(&"NO_ACTIVE_GRANT"), "{c:?}");
    }
}

// S18: a safe revoke inside the window removes all earlier delegate ballots, not direct ones.
#[test]
fn s18_safe_revoke_inside_window() {
    let mut s = setup();
    let (a, b, k) = (s.a.clone(), s.b.clone(), s.k.clone());
    let ga = grant_now(&mut s, &a, &k);
    let m = poll(&mut s);
    open(&mut s, &m);
    for action in [Action::Yes, Action::No] {
        let anchor = s.c.tip_hash;
        let v = s.c.delegate_ballot(&m, &a, &ga, &k, action, anchor);
        s.c.publish_ballots(m.poll_id(), &[v]);
        s.c.mine(HOUR);
    }
    let anchor = s.c.tip_hash;
    let db = s.c.direct_ballot(&m, &b, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[db]);
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let r = s.c.revoke(&a, RevokeMode::StopAndCancelOpen, anchor);
    s.c.publish_controls(&[r]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    let rc = result(&s, &m);
    assert_eq!(status(&rc, &a), FinalStatus::CancelledByControl, "no fallback to the older Yes");
    assert_eq!(status(&rc, &b), FinalStatus::Yes);
}

// S19: a safe revoke after the window does not change the closed poll; the old key cannot vote later.
#[test]
fn s19_safe_revoke_after_window() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let g = grant_now(&mut s, &a, &k);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v = s.c.delegate_ballot(&m, &a, &g, &k, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[v]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    let before = result(&s, &m).result_hash();
    let anchor = s.c.tip_hash;
    let r = s.c.revoke(&a, RevokeMode::StopAndCancelOpen, anchor);
    s.c.publish_controls(&[r]);
    s.c.mine(HOUR);
    assert_eq!(result(&s, &m).result_hash(), before);
    let m2 = poll(&mut s);
    open(&mut s, &m2);
    let anchor = s.c.tip_hash;
    let v2 = s.c.delegate_ballot(&m2, &a, &g, &k, Action::Yes, anchor);
    s.c.publish_ballots(m2.poll_id(), std::slice::from_ref(&v2));
    s.c.mine(HOUR);
    assert!(codes(&s, &ballot_id(&v2)).contains(&"NO_ACTIVE_GRANT"));
}

// S20: two different controls at the same anchor conflict, stop delegation and set a barrier.
#[test]
fn s20_control_conflict_and_recovery() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let k2 = TestKey::evm("second");
    let g = grant_now(&mut s, &a, &k);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v = s.c.delegate_ballot(&m, &a, &g, &k, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[v]);
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let x = s.c.grant(&a, &k, YEAR, anchor);
    let y = s.c.grant(&a, &k2, YEAR, anchor);
    s.c.publish_controls(&[x, y.clone()]);
    s.c.mine(HOUR);
    assert!(codes(&s, &auth_id(&y)).contains(&"AUTH_CONFLICT"));
    assert!(s.c.engine.current_grant(&s.c.policy.hash(), &a.id()).is_none());
    let g3 = grant_now(&mut s, &a, &k2);
    let anchor = s.c.tip_hash;
    let v3 = s.c.delegate_ballot(&m, &a, &g3, &k2, Action::No, anchor);
    s.c.publish_ballots(m.poll_id(), &[v3]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &a), FinalStatus::No);
}

// S21: two different delegate ballots at the same anchor conflict only for that owner and poll.
#[test]
fn s21_delegate_same_anchor_conflict() {
    let mut s = setup();
    let (a, b, k) = (s.a.clone(), s.b.clone(), s.k.clone());
    let ga = grant_now(&mut s, &a, &k);
    let gb = grant_now(&mut s, &b, &k);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let x = s.c.delegate_ballot(&m, &a, &ga, &k, Action::Yes, anchor);
    let y = s.c.delegate_ballot(&m, &a, &ga, &k, Action::No, anchor);
    let z = s.c.delegate_ballot(&m, &b, &gb, &k, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[x, y, z]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    let rc = result(&s, &m);
    assert_eq!(status(&rc, &a), FinalStatus::Conflict);
    assert_eq!(status(&rc, &b), FinalStatus::Yes);
}

// S22: a delegate CANCEL as the latest ballot removes the owner from both sides and quorum.
#[test]
fn s22_delegate_cancel_is_final() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let g = grant_now(&mut s, &a, &k);
    let m = poll(&mut s);
    open(&mut s, &m);
    for action in [Action::Yes, Action::Cancel] {
        let anchor = s.c.tip_hash;
        let v = s.c.delegate_ballot(&m, &a, &g, &k, action, anchor);
        s.c.publish_ballots(m.poll_id(), &[v]);
        s.c.mine(HOUR);
    }
    close(&mut s, &m);
    let rc = result(&s, &m);
    assert_eq!(status(&rc, &a), FinalStatus::Cancel);
    assert_eq!(rc.tally.yes + rc.tally.no, 0);
}

// S23: a direct CANCEL takes over; later delegate ballots do not revive the delegate layer.
#[test]
fn s23_direct_cancel_takes_over() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let g = grant_now(&mut s, &a, &k);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let d = s.c.direct_ballot(&m, &a, Action::Cancel, anchor);
    s.c.publish_ballots(m.poll_id(), &[d]);
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let v = s.c.delegate_ballot(&m, &a, &g, &k, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[v]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &a), FinalStatus::Cancel);
}

// S24: grant and ballot in the same transaction: output order decides; the reverse order does not occupy.
#[test]
fn s24_same_transaction_order() {
    for grant_first in [true, false] {
        let mut s = setup();
        let (a, k) = (s.a.clone(), s.k.clone());
        let m = poll(&mut s);
        open(&mut s, &m);
        let anchor = s.c.tip_hash;
        let g = s.c.grant(&a, &k, YEAR, anchor);
        let v = s.c.delegate_ballot(&m, &a, &g, &k, Action::Yes, anchor);
        let gi = s.c.control_item(std::slice::from_ref(&g));
        let vi = TestChain::ballot_item(m.poll_id(), std::slice::from_ref(&v));
        s.c.carriers(if grant_first { vec![gi, vi] } else { vec![vi, gi] });
        s.c.mine(HOUR);
        if !grant_first {
            assert!(codes(&s, &ballot_id(&v)).contains(&"NO_ACTIVE_GRANT"));
            // The rejected appearance did not occupy the ballot id: republishing counts.
            s.c.publish_ballots(m.poll_id(), std::slice::from_ref(&v));
            s.c.mine(HOUR);
        }
        close(&mut s, &m);
        assert_eq!(status(&result(&s, &m), &a), FinalStatus::Yes);
    }
}

// S25: expired publication window, non-canonical anchors and out-of-window ballots are rejected.
#[test]
fn s25_rejections_do_not_occupy() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let anchor = s.c.tip_hash;
    let late_grant = s.c.grant(&a, &k, YEAR, anchor);
    s.c.mine(DAY + HOUR);
    s.c.publish_controls(std::slice::from_ref(&late_grant));
    s.c.mine(HOUR);
    assert!(codes(&s, &auth_id(&late_grant)).contains(&"PUBLICATION_EXPIRED"));

    let g = grant_now(&mut s, &a, &k);
    let m = poll(&mut s);
    // Before the window opens.
    let anchor = s.c.tip_hash;
    let early = s.c.delegate_ballot(&m, &a, &g, &k, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), std::slice::from_ref(&early));
    s.c.mine(HOUR);
    assert!(codes(&s, &ballot_id(&early)).contains(&"OUT_OF_WINDOW"));
    open(&mut s, &m);
    // Unknown (non-canonical) anchor.
    let orphan = s.c.direct_ballot(&m, &a, Action::No, [0x55; 32]);
    s.c.publish_ballots(m.poll_id(), std::slice::from_ref(&orphan));
    s.c.mine(HOUR);
    assert!(codes(&s, &ballot_id(&orphan)).contains(&"ANCHOR_INVALID"));
    // The early ballot can be republished inside the window and then counts.
    s.c.publish_ballots(m.poll_id(), &[early]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &a), FinalStatus::Yes);
    // After the window.
    let anchor = s.c.tip_hash;
    let after = s.c.direct_ballot(&m, &a, Action::No, anchor);
    s.c.publish_ballots(m.poll_id(), std::slice::from_ref(&after));
    s.c.mine(HOUR);
    assert!(codes(&s, &ballot_id(&after)).contains(&"OUT_OF_WINDOW"));
}

// S26: the voting key holds no CKB at all; the owner's deposits are counted.
#[test]
fn s26_zero_balance_key() {
    let mut s = setup();
    let (b, k) = (s.b.clone(), s.k.clone());
    let g = grant_now(&mut s, &b, &k);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v = s.c.delegate_ballot(&m, &b, &g, &k, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[v]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    let rc = result(&s, &m);
    assert_eq!(rc.tally.yes, 300_000 * 100_000_000);
}

// S27: keys cannot sign controls, re-delegate, move a grant to another owner or replay across policies.
#[test]
fn s27_no_second_level_delegation() {
    let mut s = setup();
    let (a, b, k) = (s.a.clone(), s.b.clone(), s.k.clone());
    let g = grant_now(&mut s, &a, &k);
    // A control "signed" by the voting key instead of the owner.
    let anchor = s.c.tip_hash;
    let mut forged = s.c.grant(&a, &TestKey::evm("other"), YEAR, anchor);
    let text = omavote_core::text::control_text(&forged.body, &s.c.net).unwrap();
    forged.proof = k.sign(&text);
    s.c.publish_controls(&[forged.clone()]);
    s.c.mine(HOUR);
    assert!(codes(&s, &auth_id(&forged)).contains(&"INVALID_SIGNATURE"));
    // A delegate ballot for another owner using A's grant.
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let wrong = s.c.delegate_ballot(&m, &b, &g, &k, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), std::slice::from_ref(&wrong));
    s.c.mine(HOUR);
    assert!(codes(&s, &ballot_id(&wrong)).contains(&"WRONG_OWNER"));
    // A control for an unpublished policy.
    let anchor = s.c.tip_hash;
    let t_anchor = s.c.anchor_clock(&anchor);
    let other_policy = ControlDraft {
        genesis: s.c.net.genesis_hash,
        auth_policy_hash: [0x77; 32],
        owner_lock: a.lock.clone(),
        owner_auth_adapter: a.adapter.into(),
        action: ControlAction::Revoke,
        key_descriptor: None,
        expires_at_ms: None,
        revoke_mode: Some(RevokeMode::StopOnly),
        anchor_block_hash: anchor,
        publication_deadline_ms: t_anchor + DAY,
        nonce: [1; 32],
    }
    .build()
    .unwrap();
    let text = omavote_core::text::control_text(&other_policy, &s.c.net).unwrap();
    let env = ControlEnvelope { proof: a.sign(&text), body: other_policy };
    let id = auth_id(&env);
    s.c.carriers(vec![(Kind::AuthorizationBatch, [0x77; 32], omavote_core::carrier::batch_payload(vec![env.to_json()]))]);
    s.c.mine(HOUR);
    assert!(codes(&s, &id).contains(&"POLICY_UNPUBLISHED"));
}

// S28: everything can be rebuilt from chain history alone.
#[test]
fn s28_rebuild_from_history() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let g = grant_now(&mut s, &a, &k);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v = s.c.delegate_ballot(&m, &a, &g, &k, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[v]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    let original = result(&s, &m).result_hash();
    let mut fresh = Engine::new(s.c.engine.cfg.clone());
    for b in &s.c.blocks {
        fresh.process_block(b).unwrap();
    }
    assert_eq!(tally::result_core(&fresh, &m.poll_id()).unwrap().unwrap().result_hash(), original);
}

// S29: generic passkeys are not part of the first release.
#[test]
fn s29_passkey_descriptor_unsupported() {
    let v = omavote_core::json::parse(br#"{"kind":"webauthn_es256","cose_key":"x","credential_id":"y","rp_id":"vote.example","allowed_origins":["https://vote.example"],"adapter":"webauthn-es256-v2"}"#).unwrap();
    assert!(matches!(KeyDescriptor::from_json(&v), Err(omavote_core::Error::Unsupported(_))));
}

// S30: a later poll accepting a new key adapter needs no re-grant; a poll without it rejects those ballots.
#[test]
fn s30_new_key_adapter_without_regrant() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let policy_before = s.c.policy.hash();
    let g = grant_now(&mut s, &a, &k);
    let ckb_only = AuthRegistry::new(
        vec![omavote_core::adapter::CKB_SECP256K1_MESSAGE_V1.into()],
        vec![omavote_core::adapter::CKB_SECP256K1_MESSAGE_V1.into()],
    );
    let m1 = poll_with(&mut s, 5 * HOUR, rules(), ckb_only);
    let m2 = poll(&mut s);
    open(&mut s, &m1);
    open(&mut s, &m2);
    let anchor = s.c.tip_hash;
    let v1 = s.c.delegate_ballot(&m1, &a, &g, &k, Action::Yes, anchor);
    let v2 = s.c.delegate_ballot(&m2, &a, &g, &k, Action::Yes, anchor);
    s.c.publish_ballots(m1.poll_id(), std::slice::from_ref(&v1));
    s.c.publish_ballots(m2.poll_id(), &[v2]);
    s.c.mine(HOUR);
    assert!(codes(&s, &ballot_id(&v1)).contains(&"ADAPTER_NOT_ACCEPTED"));
    close(&mut s, &m2);
    assert_eq!(status(&result(&s, &m2), &a), FinalStatus::Yes);
    assert_eq!(s.c.policy.hash(), policy_before);
}

// S31: Ledger summary lines for GRANT and GRANT+CANCEL.
#[test]
fn s31_grant_summary_lines() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let anchor = s.c.tip_hash;
    let g = s.c.grant(&a, &k, YEAR, anchor);
    let gc = s.c.grant_cancel(&a, &k, YEAR, anchor);
    let t = omavote_core::text::control_text(&g.body, &s.c.net).unwrap();
    let tc = omavote_core::text::control_text(&gc.body, &s.c.net).unwrap();
    let first = t.lines().next().unwrap();
    let first_c = tc.lines().next().unwrap();
    assert!(first.starts_with("OMAVOTE GRANT 0x") && first.contains(" TO "), "{first}");
    assert!(first_c.starts_with("OMAVOTE GRANT+CANCEL 0x"), "{first_c}");
    assert!(first.len() <= 60 && first_c.len() <= 60);
    let key_display = k.descriptor.key_display(&s.c.net).unwrap();
    assert!(first.contains(&key_display[..10]) && first.contains(&key_display[key_display.len() - 8..]));
}

// ---------------------------------------------------------------------------
// docs/03 rules beyond the authorization table

#[test]
fn e01_late_manifest_has_no_result() {
    let mut s = setup();
    let a = s.a.clone();
    let m = poll_with(&mut s, HOUR / 2, rules(), TestChain::default_registry());
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v = s.c.direct_ballot(&m, &a, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), std::slice::from_ref(&v));
    s.c.mine(HOUR);
    assert!(s.c.engine.polls[&m.poll_id()].late_manifest);
    assert!(codes(&s, &ballot_id(&v)).contains(&"LATE_MANIFEST"));
    assert!(tally::result_core(&s.c.engine, &m.poll_id()).is_err());
}

#[test]
fn e02_manifest_needs_valid_proposer_signature() {
    let mut s = setup();
    let a = s.a.clone();
    let start = s.c.clock_ms + 5 * HOUR;
    let mut p = s.c.manifest(&[&a], start, TestChain::default_registry(), rules(), 1000);
    p.proposer_proofs[0].proof.signature[5] ^= 1;
    s.c.publish_manifest(&p);
    s.c.mine(HOUR);
    assert!(!s.c.engine.polls.contains_key(&p.manifest.poll_id()));
    assert!(codes(&s, &p.manifest.poll_id()).contains(&"INVALID_SIGNATURE"));
}

#[test]
fn e03_deposit_rules() {
    let mut s = setup();
    let (a, b) = (s.a.clone(), s.b.clone());
    let carol = TestOwner::ckb("carol", &s.c.net);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let no_deposit = s.c.direct_ballot(&m, &carol, Action::Yes, anchor);
    let cancel_ok = s.c.direct_ballot(&m, &carol, Action::Cancel, anchor);
    s.c.publish_ballots(m.poll_id(), std::slice::from_ref(&no_deposit));
    s.c.mine(HOUR);
    s.c.publish_ballots(m.poll_id(), &[cancel_ok]);
    s.c.mine(HOUR);
    assert!(codes(&s, &ballot_id(&no_deposit)).contains(&"NO_DEPOSIT_AT_CAST"));
    let anchor = s.c.tip_hash;
    let va = s.c.direct_ballot(&m, &a, Action::Yes, anchor);
    let vb = s.c.direct_ballot(&m, &b, Action::No, anchor);
    s.c.publish_ballots(m.poll_id(), &[va, vb]);
    s.c.mine(HOUR);
    // A adds a deposit after voting; B withdraws everything before the close.
    s.c.deposit(&a.lock, 50_000);
    let b_cell = *s.c.engine.owner_deposits(&b.id()).first().map(|(op, _)| op).unwrap();
    s.c.withdraw(b_cell, &b.lock, 300_000 * 100_000_000);
    s.c.mine(HOUR);
    close(&mut s, &m);
    let rc = result(&s, &m);
    assert_eq!(rc.tally.yes, 350_000 * 100_000_000);
    assert_eq!(rc.tally.no, 0);
    assert_eq!(status(&rc, &b), FinalStatus::No, "choice is kept even with zero final weight");
}

#[test]
fn e04_threshold_boundary() {
    // 51 YES vs 49 NO is exactly 51%: passes when inclusive, fails when strict.
    for (inclusive, expected) in [(true, true), (false, false)] {
        let mut c = TestChain::new(T0);
        let y = TestOwner::ckb("y", &c.net);
        let n = TestOwner::ckb("n", &c.net);
        c.deposit(&y.lock, 510_000);
        c.deposit(&n.lock, 490_000);
        c.publish_policy();
        c.mine(HOUR);
        let r = RulesParams { threshold_inclusive: inclusive, ..rules() };
        let start = c.clock_ms + 5 * HOUR;
        let p = c.manifest(&[&y], start, TestChain::default_registry(), r, 1000);
        c.publish_manifest(&p);
        c.mine(HOUR);
        let m = p.manifest;
        while c.clock_ms < m.start_ms {
            c.mine(HOUR);
        }
        let anchor = c.tip_hash;
        let vy = c.direct_ballot(&m, &y, Action::Yes, anchor);
        let vn = c.direct_ballot(&m, &n, Action::No, anchor);
        c.publish_ballots(m.poll_id(), &[vy, vn]);
        c.mine(HOUR);
        while c.engine.polls[&m.poll_id()].close.is_none() {
            c.mine(HOUR);
        }
        let rc = tally::result_core(&c.engine, &m.poll_id()).unwrap().unwrap();
        assert_eq!(rc.tally.passed, expected, "inclusive={inclusive}");
    }
}

#[test]
fn e05_duplicate_publication_is_idempotent() {
    let mut s = setup();
    let a = s.a.clone();
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v = s.c.direct_ballot(&m, &a, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[v.clone(), v.clone()]);
    s.c.mine(HOUR);
    s.c.publish_ballots(m.poll_id(), std::slice::from_ref(&v));
    s.c.mine(HOUR);
    close(&mut s, &m);
    let rc = result(&s, &m);
    assert_eq!(rc.tally.rows.len(), 1);
    assert_eq!(rc.tally.yes, 300_000 * 100_000_000);
    assert_eq!(codes(&s, &ballot_id(&v)).iter().filter(|c| **c == "DUPLICATE").count(), 2);
}

#[test]
fn e06_ballot_anchor_must_not_predate_manifest() {
    let mut s = setup();
    let a = s.a.clone();
    let old_anchor = s.c.tip_hash;
    let m = poll(&mut s);
    open(&mut s, &m);
    let v = s.c.direct_ballot(&m, &a, Action::Yes, old_anchor);
    s.c.publish_ballots(m.poll_id(), std::slice::from_ref(&v));
    s.c.mine(HOUR);
    assert!(codes(&s, &ballot_id(&v)).contains(&"ANCHOR_INVALID"));
}

#[test]
fn e07_delegate_cutoff() {
    let mut s = setup();
    let (a, k) = (s.a.clone(), s.k.clone());
    let g = grant_now(&mut s, &a, &k);
    let m = poll_with(&mut s, 5 * HOUR, RulesParams { delegate_cutoff_ms: DAY, ..rules() }, TestChain::default_registry());
    open(&mut s, &m);
    while s.c.clock_ms < m.end_ms - DAY {
        s.c.mine(HOUR);
    }
    let anchor = s.c.tip_hash;
    let delegate = s.c.delegate_ballot(&m, &a, &g, &k, Action::Yes, anchor);
    let direct = s.c.direct_ballot(&m, &a, Action::No, anchor);
    s.c.publish_ballots(m.poll_id(), std::slice::from_ref(&delegate));
    s.c.mine(HOUR);
    assert!(codes(&s, &ballot_id(&delegate)).contains(&"OUT_OF_WINDOW"));
    s.c.publish_ballots(m.poll_id(), &[direct]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &a), FinalStatus::No);
}

// ---------------------------------------------------------------------------
// Process roles and records (docs/03 §3.1)

struct Gov {
    roles: ProcessRoles,
    committee: Vec<TestKey>,
    coordinator: TestKey,
}

fn gov_setup() -> (S, Gov) {
    let committee: Vec<TestKey> = (0..3).map(|i| TestKey::evm(&format!("committee-{i}"))).collect();
    let coordinator = TestKey::secp("coordinator");
    let net = test_network();
    let roles = ProcessRoles::build(
        net.genesis_hash,
        None,
        (2, committee.iter().map(|k| k.descriptor.clone()).collect()),
        (1, vec![coordinator.descriptor.clone()]),
        [3; 32],
    )
    .unwrap();
    let roles_hash = roles.roles_hash();
    let mut c = TestChain::with_config(T0, |cfg| cfg.initial_roles_hash = Some(roles_hash));
    let a = TestOwner::ckb("alice", &c.net);
    let b = TestOwner::ckb("bob", &c.net);
    c.deposit(&a.lock, 300_000);
    c.deposit(&b.lock, 300_000);
    c.publish_policy();
    c.publish_roles(&roles);
    c.mine(HOUR);
    (S { c, a, b, k: TestKey::evm("voting-key") }, Gov { roles, committee, coordinator })
}

#[test]
fn e08_admission_timing_and_conflicts() {
    let (mut s, gov) = gov_setup();
    let m = poll_with(&mut s, 10 * HOUR, rules(), TestChain::default_registry());
    let anchor = s.c.tip_hash;
    let admit = s.c.record(
        &gov.roles,
        Role::Coordinator,
        &[&gov.coordinator],
        Some(m.poll_id()),
        RecordDetail::Admission { admitted: true },
        anchor,
    );
    s.c.publish_records(m.poll_id(), &[admit]);
    s.c.mine(HOUR);
    open(&mut s, &m);
    let poll = &s.c.engine.polls[&m.poll_id()];
    assert!(matches!(tally::admission(&s.c.engine, poll), AdmissionView::Admitted(_)));
    assert!(tally::proposer_eligible(poll));

    // A second poll whose admission lands too close to the opening is not official.
    let m2 = poll_with(&mut s, 3 * HOUR, rules(), TestChain::default_registry());
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let admit2 = s.c.record(
        &gov.roles,
        Role::Coordinator,
        &[&gov.coordinator],
        Some(m2.poll_id()),
        RecordDetail::Admission { admitted: true },
        anchor,
    );
    s.c.publish_records(m2.poll_id(), &[admit2]);
    s.c.mine(HOUR);
    open(&mut s, &m2);
    assert_eq!(tally::admission(&s.c.engine, &s.c.engine.polls[&m2.poll_id()]), AdmissionView::Missing);
}

#[test]
fn e09_old_records_cannot_override_new_status() {
    let (mut s, gov) = gov_setup();
    let m = poll(&mut s);
    let c = &gov.committee;
    let anchor_old = s.c.tip_hash;
    let cleared = s.c.record(
        &gov.roles,
        Role::Committee,
        &[&c[0], &c[1]],
        Some(m.poll_id()),
        RecordDetail::GovernanceStatus { status: GovStatus::Cleared },
        anchor_old,
    );
    let withheld_cleared = s.c.record(
        &gov.roles,
        Role::Committee,
        &[&c[1], &c[2]],
        Some(m.poll_id()),
        RecordDetail::GovernanceStatus { status: GovStatus::Cleared },
        anchor_old,
    );
    s.c.publish_records(m.poll_id(), std::slice::from_ref(&cleared));
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let hold = s.c.record(
        &gov.roles,
        Role::Committee,
        &[&c[0], &c[2]],
        Some(m.poll_id()),
        RecordDetail::GovernanceStatus { status: GovStatus::HoldExecution },
        anchor,
    );
    s.c.publish_records(m.poll_id(), &[hold]);
    s.c.mine(HOUR);
    // Replay of the old CLEARED, and first publication of a withheld older CLEARED.
    s.c.publish_records(m.poll_id(), std::slice::from_ref(&cleared));
    s.c.publish_records(m.poll_id(), &[withheld_cleared]);
    s.c.mine(HOUR);
    assert!(matches!(tally::governance(&s.c.engine, &m.poll_id()), GovernanceView::Status(GovStatus::HoldExecution, _)));
    assert!(codes(&s, &cleared.body.record_id()).contains(&"DUPLICATE"));
    // Below threshold and expired records are rejected.
    let anchor = s.c.tip_hash;
    let weak = s.c.record(
        &gov.roles,
        Role::Committee,
        &[&c[0]],
        Some(m.poll_id()),
        RecordDetail::GovernanceStatus { status: GovStatus::Cleared },
        anchor,
    );
    s.c.mine(4 * DAY);
    s.c.publish_records(m.poll_id(), std::slice::from_ref(&weak));
    s.c.mine(HOUR);
    let wc = codes(&s, &weak.body.record_id());
    assert!(wc.contains(&"INVALID_SIGNATURE") || wc.contains(&"PUBLICATION_EXPIRED"), "{wc:?}");
}

#[test]
fn e10_result_attestation_checks_hash_and_outcome() {
    let (mut s, gov) = gov_setup();
    let a = s.a.clone();
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v = s.c.direct_ballot(&m, &a, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[v]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    let rc = result(&s, &m);
    assert!(rc.tally.passed);
    let c = &gov.committee;
    let anchor = s.c.tip_hash;
    let wrong = s.c.record(
        &gov.roles,
        Role::Committee,
        &[&c[0], &c[1]],
        Some(m.poll_id()),
        RecordDetail::ResultAttestation { result_hash: rc.result_hash(), pass: false },
        anchor,
    );
    s.c.publish_records(m.poll_id(), &[wrong]);
    s.c.mine(HOUR);
    assert!(matches!(tally::attestation(&s.c.engine, &m.poll_id(), Some(&rc)), AttestationView::Disputed(_)));
    let anchor = s.c.tip_hash;
    let right = s.c.record(
        &gov.roles,
        Role::Committee,
        &[&c[0], &c[1]],
        Some(m.poll_id()),
        RecordDetail::ResultAttestation { result_hash: rc.result_hash(), pass: true },
        anchor,
    );
    s.c.publish_records(m.poll_id(), &[right]);
    s.c.mine(HOUR);
    assert!(matches!(tally::attestation(&s.c.engine, &m.poll_id(), Some(&rc)), AttestationView::Confirmed(_)));
}

#[test]
fn e11_roles_update_chain() {
    let (mut s, gov) = gov_setup();
    let c = &gov.committee;
    let new_member = TestKey::evm("committee-new");
    let new_roles = ProcessRoles::build(
        s.c.net.genesis_hash,
        Some(gov.roles.roles_hash()),
        (2, vec![c[0].descriptor.clone(), c[1].descriptor.clone(), new_member.descriptor.clone()]),
        (1, vec![gov.coordinator.descriptor.clone()]),
        [4; 32],
    )
    .unwrap();
    s.c.publish_roles(&new_roles);
    s.c.mine(HOUR);
    let anchor = s.c.tip_hash;
    let upd = s.c.record(
        &gov.roles,
        Role::Committee,
        &[&c[0], &c[2]],
        None,
        RecordDetail::RolesUpdate { new_roles_hash: new_roles.roles_hash() },
        anchor,
    );
    s.c.publish_records(new_roles.roles_hash(), &[upd]);
    s.c.mine(HOUR);
    assert_eq!(s.c.engine.current_roles, Some(new_roles.roles_hash()));
    // Records signed under the superseded roles are rejected.
    let m = poll(&mut s);
    let anchor = s.c.tip_hash;
    let stale = s.c.record(
        &gov.roles,
        Role::Committee,
        &[&c[0], &c[1]],
        Some(m.poll_id()),
        RecordDetail::GovernanceStatus { status: GovStatus::HoldExecution },
        anchor,
    );
    s.c.publish_records(m.poll_id(), std::slice::from_ref(&stale));
    s.c.mine(HOUR);
    assert!(codes(&s, &stale.body.record_id()).contains(&"ROLES_MISMATCH"));
    let fresh = s.c.record(
        &new_roles,
        Role::Committee,
        &[&new_member, &c[1]],
        Some(m.poll_id()),
        RecordDetail::GovernanceStatus { status: GovStatus::HoldExecution },
        anchor,
    );
    s.c.publish_records(m.poll_id(), &[fresh]);
    s.c.mine(HOUR);
    assert!(matches!(tally::governance(&s.c.engine, &m.poll_id()), GovernanceView::Status(GovStatus::HoldExecution, _)));
}

#[test]
fn e12_evm_owner_direct_vote() {
    let mut s = setup();
    let e = TestOwner::evm_omnilock("evm-owner", &s.c.net);
    s.c.deposit(&e.lock, 123_000);
    s.c.mine(HOUR);
    let m = poll(&mut s);
    open(&mut s, &m);
    let anchor = s.c.tip_hash;
    let v = s.c.direct_ballot(&m, &e, Action::Yes, anchor);
    s.c.publish_ballots(m.poll_id(), &[v]);
    s.c.mine(HOUR);
    close(&mut s, &m);
    assert_eq!(status(&result(&s, &m), &e), FinalStatus::Yes);
}
