import random
import unittest
from dataclasses import replace

from model import (
    Cell, IncompleteHistory, MAX_SEQUENCE, SHANNON,
    Transaction as Tx, VerifiedBallot as Vote, passes, tally,
)


class AccountingTests(unittest.TestCase):
    def run_tally(self, txs):
        return tally(txs, start=10, end=20)

    def base(self, capacity=100):
        return Tx(1, creates=(Cell("A:0", "A", capacity),))

    def vote(self, sequence=1, action="YES", owner="A"):
        return Vote(owner, sequence, action)

    def test_same_owner_repeated_through_multiple_relays_counts_once(self):
        vote = self.vote()
        result = self.run_tally([self.base(), Tx(10, ballots=(vote, vote)), Tx(11, ballots=(vote,))])
        self.assertEqual((result.yes, len(result.counted_cells)), (100, 1))

    def test_distinct_deposits_same_owner_add_exactly(self):
        result = self.run_tally([
            self.base(), Tx(2, creates=(Cell("A:1", "A", 37),)),
            Tx(10, ballots=(self.vote(),)),
        ])
        self.assertEqual(result.yes, 137)

    def test_separate_owners_have_separate_choices(self):
        result = self.run_tally([
            self.base(), Tx(2, creates=(Cell("B:0", "B", 70),)),
            Tx(10, ballots=(self.vote(), self.vote(action="NO", owner="B"))),
        ])
        self.assertEqual((result.yes, result.no), (100, 70))

    def test_withdraw_transfer_redeposit_cannot_double_count(self):
        result = self.run_tally([
            self.base(), Tx(10, ballots=(self.vote(),)),
            Tx(12, spends=("A:0",), creates=(Cell("withdraw:0", "A", 100, data=b"\x01" + bytes(7)),)),
            Tx(14, spends=("withdraw:0",), creates=(Cell("B:0", "B", 100),)),
            Tx(15, ballots=(self.vote(action="NO", owner="B"),)),
        ])
        # Timing is abstract: real DAO maturity is a consensus precondition.
        self.assertEqual((result.yes, result.no), (0, 100))

    def test_phase_one_alone_removes_weight(self):
        result = self.run_tally([
            self.base(), Tx(10, ballots=(self.vote(),)),
            Tx(12, spends=("A:0",), creates=(Cell("w:0", "A", 100, data=b"\x01" + bytes(7)),)),
        ])
        self.assertEqual(result.quorum, 0)

    def test_partial_withdrawal_preserves_other_deposit(self):
        result = self.run_tally([
            self.base(), Tx(2, creates=(Cell("A:1", "A", 70),)),
            Tx(10, ballots=(self.vote(),)), Tx(12, spends=("A:0",)),
        ])
        self.assertEqual(result.yes, 70)

    def test_new_deposit_during_window_is_eligible(self):
        result = self.run_tally([
            Tx(14, creates=(Cell("A:0", "A", 100),)), Tx(15, ballots=(self.vote(),)),
        ])
        self.assertEqual(result.yes, 100)

    def test_new_deposit_after_valid_vote_updates_final_weight(self):
        result = self.run_tally([
            self.base(), Tx(10, ballots=(self.vote(),)),
            Tx(18, creates=(Cell("A:1", "A", 35),)),
        ])
        self.assertEqual(result.yes, 135)

    def test_deposit_and_ballot_in_same_transaction(self):
        result = self.run_tally([Tx(14, creates=(Cell("A:0", "A", 100),), ballots=(self.vote(),))])
        self.assertEqual(result.yes, 100)

    def test_ineligible_vote_does_not_become_valid_from_later_deposit(self):
        result = self.run_tally([
            Tx(10, ballots=(self.vote(),)), Tx(15, creates=(Cell("A:0", "A", 100),)),
        ])
        self.assertEqual(result.yes, 0)

    def test_republication_after_eligibility_not_poisoned_by_earlier_copy(self):
        vote = self.vote()
        result = self.run_tally([
            Tx(10, ballots=(vote,)), Tx(15, creates=(Cell("A:0", "A", 100),)),
            Tx(16, ballots=(vote,)),
        ])
        self.assertEqual(result.yes, 100)

    def test_higher_sequence_replaces_vote(self):
        result = self.run_tally([
            self.base(), Tx(10, ballots=(self.vote(),)),
            Tx(12, ballots=(self.vote(2, "NO"),)),
        ])
        self.assertEqual((result.yes, result.no), (0, 100))

    def test_delayed_old_vote_cannot_override_newer_sequence(self):
        result = self.run_tally([
            self.base(), Tx(11, ballots=(self.vote(2, "NO"),)),
            Tx(18, ballots=(self.vote(),)),
        ])
        self.assertEqual((result.yes, result.no), (0, 100))

    def test_cancel_excluded_from_quorum(self):
        result = self.run_tally([
            self.base(), Tx(10, ballots=(self.vote(),)),
            Tx(15, ballots=(self.vote(2, "CANCEL"),)),
        ])
        self.assertEqual(result.quorum, 0)

    def test_cancel_at_zero_weight_prevents_later_reactivation(self):
        result = self.run_tally([
            self.base(), Tx(10, ballots=(self.vote(),)), Tx(12, spends=("A:0",)),
            Tx(13, ballots=(self.vote(2, "CANCEL"),)),
            Tx(17, creates=(Cell("new:0", "A", 100),)),
        ])
        self.assertEqual(result.quorum, 0)
        self.assertEqual(result.selected["A"], (2, "CANCEL"))

    def test_same_sequence_conflict_not_decided_by_relayer_order(self):
        result = self.run_tally([
            self.base(), Tx(10, ballots=(self.vote(),)),
            Tx(11, ballots=(self.vote(action="NO"),)),
        ])
        self.assertEqual(result.selected["A"], (1, "CONFLICT"))
        self.assertEqual(result.quorum, 0)

    def test_higher_sequence_resolves_conflict(self):
        result = self.run_tally([
            self.base(), Tx(10, ballots=(self.vote(), self.vote(action="NO"))),
            Tx(11, ballots=(self.vote(2),)),
        ])
        self.assertEqual(result.yes, 100)

    def test_invalid_higher_sequence_does_not_erase_valid_vote(self):
        result = self.run_tally([
            self.base(), Tx(10, ballots=(self.vote(),)),
            Tx(11, ballots=(self.vote(999, "INVALID"),)),
        ])
        self.assertEqual(result.yes, 100)

    def test_cross_network_poll_and_rule_replay_ignored(self):
        for change in ({"network": "testnet"}, {"poll": "another"}, {"rules": "another"}):
            with self.subTest(change=change):
                result = self.run_tally([self.base(), Tx(10, ballots=(replace(self.vote(), **change),))])
                self.assertEqual(result.quorum, 0)

    def test_window_start_inclusive_end_exclusive(self):
        for height, expected in ((9, 0), (10, 100), (19, 100), (20, 0)):
            with self.subTest(height=height):
                self.assertEqual(self.run_tally([self.base(), Tx(height, ballots=(self.vote(),))]).yes, expected)

    def test_after_close_spend_does_not_change_historical_tally(self):
        result = self.run_tally([self.base(), Tx(10, ballots=(self.vote(),)), Tx(20, spends=("A:0",))])
        self.assertEqual(result.yes, 100)

    def test_late_cancel_does_not_change_result(self):
        result = self.run_tally([
            self.base(), Tx(10, ballots=(self.vote(),)),
            Tx(20, ballots=(self.vote(2, "CANCEL"),)),
        ])
        self.assertEqual(result.yes, 100)

    def test_same_final_block_later_withdrawal_changes_weight(self):
        result = self.run_tally([
            self.base(), Tx(19, 0, ballots=(self.vote(),)), Tx(19, 1, spends=("A:0",)),
        ])
        self.assertEqual(result.yes, 0)

    def test_fake_dao_and_wrong_data_excluded(self):
        bad_cells = (
            Cell("fake:0", "A", 100, exact_dao_type=False),
            Cell("short:0", "A", 100, data=bytes(7)),
            Cell("long:0", "A", 100, data=bytes(9)),
            Cell("withdraw:0", "A", 100, data=b"\x01" + bytes(7)),
        )
        result = self.run_tally([Tx(1, creates=bad_cells), Tx(10, ballots=(self.vote(),))])
        self.assertEqual(result.quorum, 0)

    def test_shannon_precision_not_truncated_per_cell(self):
        result = self.run_tally([
            Tx(1, creates=(Cell("a:0", "A", SHANNON - 1), Cell("a:1", "A", 1))),
            Tx(10, ballots=(self.vote(),)),
        ])
        self.assertEqual(result.yes, SHANNON)

    def test_incomplete_history_fails(self):
        with self.assertRaises(IncompleteHistory):
            tally([], start=10, end=20, complete=False)

    def test_duplicate_outpoint_and_chain_position_fail(self):
        for txs in ([self.base(), Tx(2, creates=(Cell("A:0", "B", 100),))], [self.base(), self.base()]):
            with self.subTest(txs=txs), self.assertRaises(ValueError):
                self.run_tally(txs)

    def test_reorg_rebuild_removes_orphan_vote(self):
        fork_yes = [self.base(), Tx(12, ballots=(self.vote(),))]
        fork_no = [self.base(), Tx(12, ballots=(self.vote(action="NO"),))]
        self.assertEqual(self.run_tally(fork_yes).yes, 100)
        self.assertEqual(self.run_tally(fork_no).yes, 0)
        self.assertEqual(self.run_tally(fork_no).no, 100)

    def test_reorg_rebuild_removes_orphan_deposit(self):
        old = [self.base(), Tx(12, ballots=(self.vote(),))]
        new = [Tx(12, ballots=(self.vote(),))]
        self.assertEqual(self.run_tally(old).yes, 100)
        self.assertEqual(self.run_tally(new).yes, 0)

    def test_invalid_sequence_bounds(self):
        for sequence in (0, -1, MAX_SEQUENCE + 1, 1.5, True):
            with self.subTest(sequence=sequence):
                result = self.run_tally([self.base(), Tx(10, ballots=(self.vote(sequence),))])
                self.assertEqual(result.quorum, 0)

    def test_two_proposals_can_use_same_principal_independently(self):
        txs = [self.base(), Tx(10, ballots=(self.vote(), replace(self.vote(), poll="poll-2")))]
        first = self.run_tally(txs)
        second = tally(txs, start=10, end=20, poll="poll-2")
        self.assertEqual((first.yes, second.yes), (100, 100))


class ThresholdTests(unittest.TestCase):
    def test_exact_51_percent_and_one_unit_below(self):
        self.assertTrue(passes(51, 49, 100, 51))
        self.assertFalse(passes(50, 50, 100, 51))

    def test_exact_67_percent_inclusive_and_strict(self):
        self.assertTrue(passes(67, 33, 100, 67))
        self.assertFalse(passes(67, 33, 100, 67, inclusive=False))

    def test_two_thirds_is_not_67_percent(self):
        self.assertFalse(passes(2, 1, 3, 67))

    def test_quorum_boundary(self):
        self.assertTrue(passes(300 * SHANNON, 0, 3 * 100 * SHANNON, 51))
        self.assertFalse(passes(300 * SHANNON - 1, 0, 3 * 100 * SHANNON, 51))

    def test_zero_turnout_never_passes_even_zero_quorum(self):
        self.assertFalse(passes(0, 0, 0, 51))

    def test_large_integer_one_shannon_boundary(self):
        unit = 10**18
        self.assertTrue(passes(67 * unit, 33 * unit, 100 * unit, 67))
        self.assertFalse(passes(67 * unit - 1, 33 * unit + 1, 100 * unit, 67))

    def test_reject_float_and_negative_amount(self):
        for yes in (1.0, -1, True):
            with self.subTest(yes=yes), self.assertRaises(ValueError):
                passes(yes, 0, 0, 51)


class RandomizedProperties(unittest.TestCase):
    def test_conservation_rebroadcast_and_fetch_order_for_1000_histories(self):
        for seed in range(1000):
            rng = random.Random(seed)
            owners = ["A", "B", "C", "D"]
            initial = tuple(Cell(f"init:{i}", owner, rng.randrange(1, 10**12)) for i, owner in enumerate(owners))
            history = [Tx(1, creates=initial)]
            live = {cell.outpoint: cell for cell in initial}
            for height in range(10, 20):
                spends, creates = (), ()
                if live and rng.random() < 0.5:
                    key = rng.choice(sorted(live))
                    cell = live.pop(key)
                    spends = (key,)
                    # Abstract final-state transfer; consensus maturity is assumed.
                    created = Cell(f"move:{height}", rng.choice(owners), cell.capacity)
                    creates = (created,)
                    live[created.outpoint] = created
                ballot = Vote(rng.choice(owners), rng.randrange(1, 6), rng.choice(["YES", "NO", "CANCEL"]))
                history.append(Tx(height, spends=spends, creates=creates, ballots=(ballot,)))
            result = tally(history, start=10, end=20)
            self.assertLessEqual(result.quorum, sum(cell.capacity for cell in live.values()), seed)
            self.assertEqual(result.quorum, sum(live[outpoint].capacity for outpoint in result.counted_cells), seed)
            duplicated = [replace(tx, ballots=tx.ballots * 3) for tx in history]
            self.assertEqual(result, tally(duplicated, start=10, end=20), seed)
            shuffled = list(history)
            rng.shuffle(shuffled)
            self.assertEqual(result, tally(shuffled, start=10, end=20), seed)


if __name__ == "__main__":
    unittest.main()
