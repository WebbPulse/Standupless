"""The `counters` table: per-team issue keys, and the plan usage of each workspace.

Allocation is a single `ADD next_number :one` through `Repository.increment`, which
is atomic and needs no transaction. A crash between allocation and the issue write
leaves a gap, which design section 3 accepts: nothing renumbers to close one.

Plan usage is one row per workspace and capped resource, `plan#<resource>`. Every
create adds to it in the same transaction as its row, conditional on the total
staying within the plan, and every path that frees a slot subtracts from it, so
two racing creates at the last slot cannot both land.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from boto3.dynamodb.conditions import Attr, Key
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import build_repository, delete_partition
from app.common.db.dynamo.tables import COUNTERS

NEXT_NUMBER_ATTRIBUTE = "next_number"


def issue_counter_key(team_id: str) -> str:
    """The sort key of one team's issue number counter."""
    return f"team#{team_id}#issue"


MOVED_ISSUE_ATTRIBUTE = "issue_id"


def moved_prefix(team_id: str) -> str:
    """The sort key prefix every retired number of one team shares."""
    return f"moved#{team_id}#"


def moved_key(team_id: str, number: int) -> str:
    """The sort key recording which issue a number of one team now names after a move."""
    return f"{moved_prefix(team_id)}{number}"


PLAN_USAGE_PREFIX = "plan#"

USED_ATTRIBUTE = "used"

GUESTS_ATTRIBUTE = "guests"

VERSION_ATTRIBUTE = "version"

CHANGED_AT_ATTRIBUTE = "changed_at"


def plan_usage_key(resource: str) -> str:
    """The sort key of one capped resource's usage row."""
    return f"{PLAN_USAGE_PREFIX}{resource}"


@dataclass(frozen=True)
class PlanUsage:
    """How much of one capped resource a workspace holds, as its usage row reads now.

    `guests` is the guest share of `used`: guest members on the members row and
    guest invites on the invites row, zero elsewhere. `version` grows on every
    change, so a write can be pinned to the row it read. `changed_at` is the epoch
    second of the last change.
    """

    used: int
    guests: int
    version: int
    changed_at: int


def _as_usage(item: Mapping[str, Any]) -> PlanUsage:
    """One stored usage row as a `PlanUsage`."""
    return PlanUsage(
        used=int(item.get(USED_ATTRIBUTE, 0) or 0),
        guests=int(item.get(GUESTS_ATTRIBUTE, 0) or 0),
        version=int(item.get(VERSION_ATTRIBUTE, 0) or 0),
        changed_at=int(item.get(CHANGED_AT_ATTRIBUTE, 0) or 0),
    )


class CounterRepository:
    """Allocates and reads the per-team counters, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(COUNTERS, repository)

    def delete_workspace_rows(self, workspace_id: str) -> int:
        """Delete every row this table holds for one workspace, for the workspace purge."""
        return delete_partition(self._repository, COUNTERS, workspace_id)

    def allocate_issue_number(self, workspace_id: str, team_id: str) -> int:
        """The next issue number for this team, allocated to this caller alone.

        One atomic `ADD`, so two concurrent callers never receive the same number.
        The row is created by the increment itself, which is why nothing seeds it.
        """
        return self._repository.increment(
            {"workspace_id": workspace_id, "counter_key": issue_counter_key(team_id)},
            NEXT_NUMBER_ATTRIBUTE,
        )

    def peek_issue_number(self, workspace_id: str, team_id: str) -> int:
        """How many issue numbers this team has allocated, without allocating one.

        Zero when nothing has been allocated yet, which is a team with no issues.
        """
        if not workspace_id or not team_id:
            return 0
        item = self._repository.get({"workspace_id": workspace_id, "counter_key": issue_counter_key(team_id)})
        if item is None:
            return 0
        return int(item.get(NEXT_NUMBER_ATTRIBUTE, 0))

    def list_for_workspace(self, workspace_id: str, *, limit: int = 200) -> list[Mapping[str, Any]]:
        """Every counter row of this workspace, for an administrative read."""
        if not workspace_id:
            return []
        return list(self._repository.iter_query(Key("workspace_id").eq(workspace_id), max_items=limit))

    def record_moved_issue(self, workspace_id: str, team_id: str, number: int, issue_id: str) -> None:
        """Remember that a number one team allocated now belongs to an issue that moved away.

        Kept beside the counter because the number can never be handed out again,
        so the row is a permanent fact about the team's key space, and every image
        that allocates keys already holds a grant on this table.
        """
        self._repository.put(
            {
                "workspace_id": workspace_id,
                "counter_key": moved_key(team_id, number),
                MOVED_ISSUE_ATTRIBUTE: issue_id,
            }
        )

    def moved_issue_id(self, workspace_id: str, team_id: str, number: int) -> str | None:
        """The issue a retired number of one team now names, or `None` when it never moved."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "counter_key": moved_key(team_id, number)})
        if item is None:
            return None
        value = item.get(MOVED_ISSUE_ATTRIBUTE)
        return str(value) if value else None

    def delete_for_team(self, workspace_id: str, team_id: str) -> bool:
        """Remove one team's counter and its retired numbers, reporting whether a counter was there.

        Deleting it is deliberate: a team that is gone cannot have its numbers
        reused, because the team id is never reissued either. The retired numbers
        go too, since the prefix that spelled them no longer names the team.
        """
        retired = list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("counter_key").begins_with(moved_prefix(team_id))
            )
        )
        if retired:
            self._repository.delete_many(
                [{"workspace_id": workspace_id, "counter_key": item["counter_key"]} for item in retired]
            )
        key = {"workspace_id": workspace_id, "counter_key": issue_counter_key(team_id)}
        if self._repository.get(key) is None:
            return False
        self._repository.delete(key)
        return True

    def transact_write(self, actions: Sequence[Mapping[str, Any]]) -> None:
        """Apply `actions` as one all-or-nothing write, which may name other tables."""
        self._repository.transact_write(actions)

    def _usage_key(self, workspace_id: str, resource: str) -> dict[str, str]:
        """The primary key of one resource's usage row."""
        return {"workspace_id": workspace_id, "counter_key": plan_usage_key(resource)}

    def plan_usage(self, workspace_id: str, resource: str) -> PlanUsage | None:
        """One resource's usage row read strongly consistently, or `None` before it is seeded."""
        item = self._repository.get(self._usage_key(workspace_id, resource), consistent=True)
        return _as_usage(item) if item is not None else None

    def seed_plan_usage(self, workspace_id: str, resource: str, used: int, guests: int = 0) -> bool:
        """Write the first usage row from a row count, answering whether this call wrote it.

        Conditional on no row existing, so the backfill is idempotent and a racing
        seed, or one landing after creates began counting, never overwrites a count.
        """
        try:
            self._repository.put(
                {
                    **self._usage_key(workspace_id, resource),
                    USED_ATTRIBUTE: max(0, used),
                    GUESTS_ATTRIBUTE: max(0, guests),
                    VERSION_ATTRIBUTE: 0,
                    CHANGED_AT_ATTRIBUTE: int(time.time()),
                },
                condition=Attr("counter_key").not_exists(),
            )
        except ConditionFailed:
            return False
        return True

    def reconcile_plan_usage(self, workspace_id: str, resource: str, seen: PlanUsage, used: int, guests: int) -> bool:
        """Replace a usage row with a fresh row count, only if nothing changed it since `seen`.

        The version pin is what makes the recount safe: a create or a release
        between the read and this write moves the version and the recount is dropped.
        """
        try:
            self._repository.put(
                {
                    **self._usage_key(workspace_id, resource),
                    USED_ATTRIBUTE: max(0, used),
                    GUESTS_ATTRIBUTE: max(0, guests),
                    VERSION_ATTRIBUTE: seen.version + 1,
                    CHANGED_AT_ATTRIBUTE: int(time.time()),
                },
                condition=Attr(VERSION_ATTRIBUTE).eq(seen.version),
            )
        except ConditionFailed:
            return False
        return True

    def plan_usage_action(
        self,
        workspace_id: str,
        resource: str,
        *,
        used: int,
        guests: int = 0,
        ceiling: int | None = None,
        version: int | None = None,
    ) -> dict[str, Any]:
        """A transaction Update moving one usage row by `used` and `guests`.

        Conditional on the row existing, on `used` staying at or under `ceiling`
        once added, on neither total going below zero, and on `version` when given.
        """
        names = {"#used": USED_ATTRIBUTE, "#version": VERSION_ATTRIBUTE, "#changed": CHANGED_AT_ATTRIBUTE}
        values: dict[str, Any] = {":used": used, ":one": 1, ":now": int(time.time())}
        additions = ["#used :used", "#version :one"]
        if guests:
            names["#guests"] = GUESTS_ATTRIBUTE
            values[":guests"] = guests
            additions.append("#guests :guests")
        condition = Attr(USED_ATTRIBUTE).exists()
        if ceiling is not None and used > 0:
            condition = condition & Attr(USED_ATTRIBUTE).lte(ceiling - used)
        if used < 0:
            condition = condition & Attr(USED_ATTRIBUTE).gte(-used)
        if guests < 0:
            condition = condition & Attr(GUESTS_ATTRIBUTE).gte(-guests)
        if version is not None:
            condition = condition & Attr(VERSION_ATTRIBUTE).eq(version)
        return self._repository.update_action(
            self._usage_key(workspace_id, resource),
            update_expression=f"ADD {', '.join(additions)} SET #changed = :now",
            expression_names=names,
            expression_values=values,
            condition=condition,
        )

    def plan_usage_check(self, workspace_id: str, resource: str, version: int) -> dict[str, Any]:
        """A transaction ConditionCheck pinning one usage row to the version a caller read."""
        return self._repository.condition_check(
            self._usage_key(workspace_id, resource),
            condition=Attr(VERSION_ATTRIBUTE).eq(version),
        )
