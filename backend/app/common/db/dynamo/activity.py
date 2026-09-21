"""The `activity` table: what happened to one issue, newest first.

Partitioned per issue rather than per team, because an issue's history is what
grows without bound and the MVP exposes only the newest page. `ws_team-created_at-index`
is the team feed a later project reads; nothing in M2 queries it, which leaves
it correct and unused rather than absent and needing a backfill.

Rows are written by the request handler in the same call as the change they record,
never by the stream consumer, so a failed write cannot leave history behind a change
that never landed.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Page, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import ACTIVITY

TEAM_FEED_INDEX = "ws_team-created_at-index"

ActorKindField = Literal["user", "system", "github"]

ACTOR_KINDS: tuple[str, ...] = ("user", "system", "github")

ActivityKind = Literal["created", "field_changed", "link_added", "link_removed", "child_added", "child_removed"]

ACTIVITY_KINDS: tuple[str, ...] = (
    "created",
    "field_changed",
    "link_added",
    "link_removed",
    "child_added",
    "child_removed",
)


def new_activity_id() -> str:
    """A fresh activity id, a ULID so the sort key is time ordered.

    Descending reads then give newest first with no secondary sort, which is what
    the contract's activity list answers with.
    """
    return new_ulid()


def ws_issue(workspace_id: str, issue_id: str) -> str:
    """The partition key of one issue's history."""
    return f"{workspace_id}#{issue_id}"


def ws_team(workspace_id: str, team_id: str) -> str:
    """The team feed index's hash key, scoped to one workspace."""
    return f"{workspace_id}#{team_id}"


class Activity(BaseModel):
    """One recorded change to an issue.

    `from_value` and `to_value` are named apart from the wire's `from` and `to`
    because `from` is a Python keyword; the schema renames them back, so the stored
    attribute and the response field are both what the contract says.
    """

    ws_issue: str
    activity_id: str = Field(default_factory=new_activity_id)
    workspace_id: str
    team_id: str
    issue_id: str
    actor_id: str
    actor_kind: str = "user"
    kind: str
    field: str | None = None
    from_value: Any = None
    to_value: Any = None
    created_at: datetime = Field(default_factory=utc_now)


def build_activity(
    workspace_id: str,
    team_id: str,
    issue_id: str,
    actor_id: str,
    kind: str,
    *,
    actor_kind: str = "user",
    field: str | None = None,
    from_value: Any = None,
    to_value: Any = None,
) -> Activity:
    """One activity row with its partition key already composed.

    A helper rather than a bare constructor because every caller would otherwise
    rebuild `ws_issue` by hand, and a row written under the wrong partition would be
    invisible rather than wrong.
    """
    return Activity(
        ws_issue=ws_issue(workspace_id, issue_id),
        workspace_id=workspace_id,
        team_id=team_id,
        issue_id=issue_id,
        actor_id=actor_id,
        actor_kind=actor_kind,
        kind=kind,
        field=field,
        from_value=from_value,
        to_value=to_value,
    )


class ActivityRepository:
    """Writes and reads `activity` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(ACTIVITY, repository)

    def record(self, activity: Activity) -> Activity:
        """Store one activity row.

        An unconditional put: the sort key is a fresh ULID, so there is nothing to
        collide with and a condition would only add a failure mode to a write that
        sits in the request path.
        """
        self._repository.put(as_item(activity, ws_team=ws_team(activity.workspace_id, activity.team_id)))
        return activity

    def record_many(self, rows: list[Activity]) -> list[Activity]:
        """Store several activity rows in one batch.

        A patch changing five fields writes five rows, and one `BatchWriteItem` is
        what keeps that a single round trip rather than five.
        """
        if not rows:
            return []
        self._repository.put_many(
            [as_item(row, ws_team=ws_team(row.workspace_id, row.team_id)) for row in rows]
        )
        return rows

    def list_for_issue(
        self,
        workspace_id: str,
        issue_id: str,
        *,
        limit: int = 50,
        start_key: Mapping[str, Any] | None = None,
    ) -> Page:
        """One page of an issue's history, newest first.

        Descending on the ULID sort key, so no sort happens after the read and the
        page boundary is DynamoDB's own cursor rather than an offset.
        """
        return self._repository.query(
            Key("ws_issue").eq(ws_issue(workspace_id, issue_id)),
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=False,
        )

    def delete_for_issue(self, workspace_id: str, issue_id: str) -> int:
        """Remove one issue's whole history, returning how many rows went.

        Called when the issue is deleted, because the partition would otherwise be
        unreachable: nothing but the issue's own id names it.
        """
        partition = ws_issue(workspace_id, issue_id)
        items = list(self._repository.iter_query(Key("ws_issue").eq(partition), max_items=1000))
        if not items:
            return 0
        return self._repository.delete_many(
            [{"ws_issue": partition, "activity_id": item["activity_id"]} for item in items]
        )


def as_activity(item: Mapping[str, Any]) -> Activity:
    """One stored item as an `Activity`, ignoring the team feed's index attribute."""
    fields = {key: value for key, value in item.items() if key != "ws_team"}
    return Activity.model_validate(fields)
