"""Executable accounting model, NOT a CKB client or a production verifier.

Assumptions: caller supplies a complete, canonical transaction history, normalized
owner identifiers, and ballots whose owner authorization has already been verified.
The time oracle is reduced to a half-open block interval [start, end). No signatures,
Molecule decoding, consensus validation, MTP calculation, or network I/O occur here.
The model selects the proposed exact-shannon / end-state policy, not an assertion
that all legacy Metaforo behavior matches it.
"""

from dataclasses import dataclass
from typing import Iterable

SHANNON = 100_000_000
DEPOSIT_DATA = bytes(8)
MAX_SEQUENCE = (1 << 64) - 1


class IncompleteHistory(ValueError):
    pass


@dataclass(frozen=True)
class Cell:
    outpoint: str
    owner: str
    capacity: int
    # This means exact, network-specific DAO type equality has been checked.
    exact_dao_type: bool = True
    data: bytes = DEPOSIT_DATA

    def __post_init__(self):
        if type(self.capacity) is not int or self.capacity < 0:
            raise ValueError("capacity must be a non-negative integer")

    @property
    def is_deposit(self):
        return self.exact_dao_type and self.data == DEPOSIT_DATA


@dataclass(frozen=True)
class VerifiedBallot:
    """Input boundary: an external adapter already authenticated this owner.

    This type is a modeling precondition, NOT a cryptographic security boundary.
    Do not construct it from an untrusted HTTP/JSON request in production.
    """

    owner: str
    sequence: int
    action: str
    poll: str = "poll-1"
    network: str = "mainnet-genesis"
    rules: str = "principal-exact-end-v1"
    adapter: str = "model-preverified"

    @property
    def identity(self):
        # Tuple equality substitutes for canonical body hashing in this model.
        return (
            self.owner, self.sequence, self.action, self.poll,
            self.network, self.rules, self.adapter,
        )


@dataclass(frozen=True)
class Transaction:
    height: int
    index: int = 0
    spends: tuple[str, ...] = ()
    creates: tuple[Cell, ...] = ()
    ballots: tuple[VerifiedBallot, ...] = ()


@dataclass(frozen=True)
class Result:
    yes: int
    no: int
    final_weights: dict[str, int]
    selected: dict[str, tuple[int, str]]
    counted_cells: dict[str, str]

    @property
    def quorum(self):
        return self.yes + self.no


def weights(live: dict[str, Cell]) -> dict[str, int]:
    result = {}
    for cell in live.values():
        result[cell.owner] = result.get(cell.owner, 0) + cell.capacity
    return result


def tally(
    history: Iterable[Transaction],
    *,
    start: int,
    end: int,
    complete: bool = True,
    poll: str = "poll-1",
    network: str = "mainnet-genesis",
    rules: str = "principal-exact-end-v1",
) -> Result:
    if not complete:
        raise IncompleteHistory("Missing chain data must never become zero weight")
    if type(start) is not int or type(end) is not int or not 0 <= start < end:
        raise ValueError("invalid half-open voting window")

    ordered = sorted(history, key=lambda tx: (tx.height, tx.index))
    positions = [(tx.height, tx.index) for tx in ordered]
    if len(set(positions)) != len(positions):
        raise ValueError("ambiguous transaction position")
    live = {}
    created = set()
    accepted = {}
    for tx in ordered:
        if tx.height < 0 or tx.index < 0:
            raise ValueError("negative chain position")
        if tx.height >= end:
            break
        if len(set(tx.spends)) != len(tx.spends):
            raise ValueError("duplicate inputs are not canonical chain data")
        for outpoint in tx.spends:
            # Ordinary/non-DAO inputs are intentionally not tracked.
            live.pop(outpoint, None)
        for cell in tx.creates:
            if cell.outpoint in created:
                raise ValueError("an outpoint cannot be created twice")
            created.add(cell.outpoint)
            if cell.is_deposit:
                live[cell.outpoint] = cell
        if tx.height < start:
            continue
        cast_weights = weights(live)
        for ballot in tx.ballots:
            if (ballot.poll, ballot.network, ballot.rules) != (poll, network, rules):
                continue
            if type(ballot.sequence) is not int or not 1 <= ballot.sequence <= MAX_SEQUENCE:
                continue
            if ballot.action not in {"YES", "NO", "CANCEL"}:
                continue
            if ballot.action != "CANCEL" and cast_weights.get(ballot.owner, 0) == 0:
                continue
            # Invalid/early occurrences never poison the first VALID appearance.
            accepted.setdefault(ballot.identity, ballot)

    by_owner = {}
    for ballot in accepted.values():
        by_owner.setdefault(ballot.owner, []).append(ballot)
    selected = {}
    for owner, ballots in by_owner.items():
        highest = max(ballot.sequence for ballot in ballots)
        at_highest = [ballot for ballot in ballots if ballot.sequence == highest]
        action = at_highest[0].action if len(at_highest) == 1 else "CONFLICT"
        selected[owner] = (highest, action)

    final_weights = weights(live)
    yes = no = 0
    counted_cells = {}
    for outpoint, cell in live.items():
        action = selected.get(cell.owner, (0, "NONE"))[1]
        if action == "YES":
            yes += cell.capacity
        elif action == "NO":
            no += cell.capacity
        else:
            continue
        counted_cells[outpoint] = cell.owner
    return Result(yes, no, final_weights, selected, counted_cells)


def passes(yes: int, no: int, quorum_required: int, approval_percent: int, *, inclusive=True):
    for value in (yes, no, quorum_required, approval_percent):
        if type(value) is not int or value < 0:
            raise ValueError("threshold arithmetic requires non-negative integers")
    if not 0 < approval_percent <= 100:
        raise ValueError("invalid approval threshold")
    quorum = yes + no
    if quorum == 0 or quorum < quorum_required:
        return False
    left, right = 100 * yes, approval_percent * quorum
    return left >= right if inclusive else left > right
