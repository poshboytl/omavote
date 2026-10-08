//! Property tests for the ordering and conservation guarantees in docs/03 §6 and docs/11 §5.

use std::collections::HashSet;

use omavote_core::messages::*;
use omavote_core::tally::{self, FinalStatus};
use omavote_core::testkit::*;
use omavote_core::types::*;
use proptest::prelude::*;

const T0: u64 = 1_800_000_000_000;
const HOUR: u64 = 3_600_000;

fn setup(owners: usize) -> (TestChain, Vec<TestOwner>) {
    let mut c = TestChain::new(T0);
    let os: Vec<TestOwner> = (0..owners).map(|i| TestOwner::ckb(&format!("owner-{i}"), &c.net)).collect();
    for (i, o) in os.iter().enumerate() {
        c.deposit(&o.lock, 100_000 + 10_000 * i as u64);
    }
    c.publish_policy();
    c.mine(HOUR);
    (c, os)
}

fn open_poll(c: &mut TestChain, proposer: &TestOwner) -> Manifest {
    let start = c.clock_ms + 4 * HOUR;
    let p = c.manifest(
        &[proposer],
        start,
        TestChain::default_registry(),
        RulesParams { opening_confirmations: 2, ..RulesParams::default() },
        1000,
    );
    c.publish_manifest(&p);
    c.mine(HOUR);
    while c.clock_ms < p.manifest.start_ms {
        c.mine(HOUR);
    }
    p.manifest
}

fn close(c: &mut TestChain, m: &Manifest) {
    while c.engine.polls[&m.poll_id()].close.is_none() {
        c.mine(HOUR);
    }
}

fn action(i: u8) -> Action {
    match i % 3 {
        0 => Action::Yes,
        1 => Action::No,
        _ => Action::Cancel,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// The ballot with the highest anchor wins whatever order the relays publish in.
    #[test]
    fn latest_anchor_wins_regardless_of_publication_order(
        actions in prop::collection::vec(0u8..3, 1..6),
        order_seed in prop::collection::vec(any::<u16>(), 6),
    ) {
        let (mut c, os) = setup(1);
        let owner = os[0].clone();
        let m = open_poll(&mut c, &owner);
        let mut ballots = Vec::new();
        for a in &actions {
            let anchor = c.tip_hash;
            ballots.push(c.direct_ballot(&m, &owner, action(*a), anchor));
            c.mine(HOUR);
        }
        let expected = action(*actions.last().unwrap());
        let mut order: Vec<usize> = (0..ballots.len()).collect();
        order.sort_by_key(|i| order_seed[*i]);
        for i in order {
            c.publish_ballots(m.poll_id(), &[ballots[i].clone()]);
            c.mine(HOUR);
        }
        close(&mut c, &m);
        let rc = tally::result_core(&c.engine, &m.poll_id()).unwrap().unwrap();
        let got = rc.tally.rows[0].selection.status;
        let want = match expected { Action::Yes => FinalStatus::Yes, Action::No => FinalStatus::No, Action::Cancel => FinalStatus::Cancel };
        prop_assert_eq!(got, want);
    }

    /// After all controls are published within their deadlines, the effective state is
    /// the control with the highest anchor, independent of publication order.
    #[test]
    fn effective_control_is_highest_anchor(
        kinds in prop::collection::vec(any::<bool>(), 1..6),
        order_seed in prop::collection::vec(any::<u16>(), 6),
    ) {
        let (mut c, os) = setup(1);
        let owner = os[0].clone();
        let keys: Vec<TestKey> = (0..kinds.len()).map(|i| TestKey::evm(&format!("k{i}"))).collect();
        let mut controls = Vec::new();
        for (i, is_grant) in kinds.iter().enumerate() {
            let anchor = c.tip_hash;
            controls.push(if *is_grant { c.grant(&owner, &keys[i], 365 * DAY, anchor) } else { c.revoke(&owner, RevokeMode::StopOnly, anchor) });
            c.mine(HOUR);
        }
        let mut order: Vec<usize> = (0..controls.len()).collect();
        order.sort_by_key(|i| order_seed[*i]);
        for i in order {
            c.publish_controls(&[controls[i].clone()]);
            c.mine(HOUR);
        }
        let last = controls.last().unwrap();
        let current = c.engine.current_grant(&c.policy.hash(), &owner.id()).map(|g| g.authorization_id);
        if *kinds.last().unwrap() {
            prop_assert_eq!(current, Some(last.body.authorization_id()));
        } else {
            prop_assert_eq!(current, None);
        }
    }

    /// Publishing the same ballots several times never changes the result, and every
    /// counted outpoint appears once with total weight bounded by deposits.
    #[test]
    fn duplicates_are_idempotent_and_principal_is_conserved(
        actions in prop::collection::vec(0u8..3, 3),
        repeats in prop::collection::vec(1usize..3, 3),
    ) {
        let (mut c1, os) = setup(3);
        let m = open_poll(&mut c1, &os[0]);
        let anchor = c1.tip_hash;
        let ballots: Vec<BallotEnvelope> = os.iter().zip(&actions).map(|(o, a)| c1.direct_ballot(&m, o, action(*a), anchor)).collect();
        let mut c2_blocks = c1.blocks.clone();
        // Chain 1 publishes each ballot once.
        c1.publish_ballots(m.poll_id(), &ballots);
        c1.mine(HOUR);
        close(&mut c1, &m);
        let r1 = tally::result_core(&c1.engine, &m.poll_id()).unwrap().unwrap();

        // Chain 2 replays the same prefix, then publishes duplicates.
        let mut c2 = TestChain::new(T0);
        c2_blocks.remove(0);
        for b in &c2_blocks {
            c2.engine.process_block(b).unwrap();
        }
        c2.tip_number = c2_blocks.last().unwrap().number;
        c2.tip_hash = c2_blocks.last().unwrap().hash;
        c2.clock_ms = c2_blocks.last().unwrap().clock_ms;
        let mut dup = Vec::new();
        for (b, n) in ballots.iter().zip(&repeats) {
            for _ in 0..*n { dup.push(b.clone()); }
        }
        c2.publish_ballots(m.poll_id(), &dup);
        c2.mine(HOUR);
        c2.publish_ballots(m.poll_id(), &ballots);
        c2.mine(HOUR);
        close(&mut c2, &m);
        let r2 = tally::result_core(&c2.engine, &m.poll_id()).unwrap().unwrap();
        prop_assert_eq!(r1.tally.yes, r2.tally.yes);
        prop_assert_eq!(r1.tally.no, r2.tally.no);

        let total: u128 = os.iter().map(|o| c2.engine.owner_balance(&o.id())).sum();
        prop_assert!(r2.tally.yes + r2.tally.no <= total);
        let mut seen = HashSet::new();
        for (op, _, _) in &r2.tally.counted_cells {
            prop_assert!(seen.insert(*op));
        }
    }
}
