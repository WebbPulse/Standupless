"""The `counters` table: one row per team, allocating issue keys.

Allocation is a single `ADD next_number :one` through `Repository.increment`, which
is atomic and needs no transaction. A crash between allocation and the issue write
leaves a gap, which design section 3 accepts: nothing renumbers to close one.

The issue writer arrives with M2. M1 owns the table because the team create path
is what seeds a team's counter key.
"""

from __future__ import annotations

from typing import Any, Mapping

from boto3.dynamodb.conditions import Key
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import build_repository
from app.common.db.dynamo.tables import COUNTERS

NEXT_NUMBER_ATTRIBUTE = "next_number"


def issue_counter_key(team_id: str) -> str:
    """The sort key of one team's issue number counter."""
    return f"team#{team_id}#issue"


class CounterRepository:
    """Allocates and reads the per-team counters, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(COUNTERS, repository)

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

    def delete_for_team(self, workspace_id: str, team_id: str) -> bool:
        """Remove one team's counter, reporting whether one was there.

        Deleting it is deliberate: a team that is gone cannot have its numbers
        reused, because the team id is never reissued either.
        """
        key = {"workspace_id": workspace_id, "counter_key": issue_counter_key(team_id)}
        if self._repository.get(key) is None:
            return False
        self._repository.delete(key)
        return True
