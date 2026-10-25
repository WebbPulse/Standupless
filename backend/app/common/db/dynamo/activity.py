"""The `activity` table: what happened to one issue, newest first.

Partitioned per issue rather than per team, because an issue's history is what
grows without bound and the MVP exposes only the newest page. `ws_team-created_at-index`
is the team feed a later project reads; nothing in M2 queries it, which leaves
it correct and unused rather than absent and needing a backfill.
`ws_actor-created_at-index` is one person's history across every issue, which
the member page reads; only rows a person made carry its attribute.

Rows are written by the request handler in the same call as the change they record,
never by the stream consumer, so a failed write cannot leave history behind a change
that never landed.

A change to a team rather than an issue, such as GitHub sync dropping to one way
when a repository turns public, is written to one per-workspace partition the way
deletion tombstones are, with an empty `issue_id` and the team feed attribute
set, so the team feed carries it and the purges clear it with one key read.

Earlier versions of an issue's description live in a partition of their own,
`<workspace>#<issue>#description`, so the history page never reads them and
deleting the issue's history clears them with it.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Page, Repository, new_ulid

from app.common.change_source import source_for
from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import ACTIVITY

TEAM_FEED_INDEX = "ws_team-created_at-index"

ACTOR_FEED_INDEX = "ws_actor-created_at-index"

ActorKindField = Literal["user", "system", "github"]

ACTOR_KINDS: tuple[str, ...] = ("user", "system", "github")

ActivityKind = Literal[
    "created",
    "field_changed",
    "link_added",
    "link_removed",
    "child_added",
    "child_removed",
    "archived",
    "unarchived",
    "subscriber_added",
    "subscriber_removed",
    "mentioned",
    "thread_resolved",
    "thread_unresolved",
]

ACTIVITY_KINDS: tuple[str, ...] = (
    "created",
    "field_changed",
    "link_added",
    "link_removed",
    "child_added",
    "child_removed",
    "archived",
    "unarchived",
    "subscriber_added",
    "subscriber_removed",
    "mentioned",
    "thread_resolved",
    "thread_unresolved",
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


def ws_actor(workspace_id: str, actor_id: str) -> str:
    """The actor feed index's hash key: one person's history inside one workspace."""
    return f"{workspace_id}#{actor_id}"


def index_attributes(row: "Activity") -> dict[str, str]:
    """The feed index attributes one issue row is stored with.

    Every issue row joins its team's feed. Only a person's own change joins the
    actor feed, so system and GitHub rows never pile into one shared hot partition
    and the index stays as sparse as the member page needs.
    """
    attributes = {"ws_team": ws_team(row.workspace_id, row.team_id)}
    if row.actor_kind == "user" and row.issue_id and row.actor_id:
        attributes["ws_actor"] = ws_actor(row.workspace_id, row.actor_id)
    return attributes


TOMBSTONE_KIND = "deleted"

TOMBSTONE_RETENTION = timedelta(days=1)
"""How long a deleted issue's tombstone is kept for list delta polling.

A client resyncs its whole list far more often than this, and a delta asked for
from before the retention window is told to resync rather than trusted, so an
older tombstone could never be read.
"""

TOMBSTONE_PRUNE_BATCH = 25

DESCRIPTION_VERSION_KIND = "description_version"

DESCRIPTION_VERSIONS_KEPT = 50
"""How many versions one issue's description keeps; the oldest goes when another is taken."""


def description_partition(workspace_id: str, issue_id: str) -> str:
    """The partition one issue's description versions share, apart from its history."""
    return f"{workspace_id}#{issue_id}#description"


def team_events_partition(workspace_id: str) -> str:
    """The one partition a workspace's team level activity shares."""
    return f"{workspace_id}#teamevents"


def tombstone_partition(workspace_id: str) -> str:
    """The one partition a workspace's deletion tombstones share.

    A ULID never holds `#`, so the suffix cannot collide with an issue's history
    partition, and one partition per workspace is what lets the workspace purge
    clear every tombstone with one key read.
    """
    return f"{workspace_id}#tombstones"


def ulid_floor(moment: datetime) -> str:
    """The ten character time prefix of every ULID minted at or after `moment`."""
    return new_ulid(moment)[:10]


class Activity(BaseModel):
    """One recorded change to an issue.

    `from_value` and `to_value` are named apart from the wire's `from` and `to`
    because `from` is a Python keyword; the schema renames them back, so the stored
    attribute and the response field are both what the contract says.

    `source` is the client the change came through, absent on rows written before
    it was recorded, which render unattributed. `release_id` names the release whose
    stage automation made the change, on those rows alone.
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
    source: str | None = None
    release_id: str | None = None
    created_at: datetime = Field(default_factory=utc_now)


class DescriptionVersion(BaseModel):
    """One saved state of an issue's description: the text, who wrote it and when."""

    ws_issue: str
    activity_id: str = Field(default_factory=new_activity_id)
    workspace_id: str
    issue_id: str
    kind: str = DESCRIPTION_VERSION_KIND
    body: str = ""
    edited_by: str
    edited_at: datetime = Field(default_factory=utc_now)
    source: str | None = None
    sealed: bool = False

    @property
    def version_id(self) -> str:
        """The version's id, which is its sort key."""
        return self.activity_id


def build_description_version(
    workspace_id: str,
    issue_id: str,
    body: str,
    edited_by: str,
    *,
    edited_at: datetime,
    source: str | None = None,
    sealed: bool = False,
) -> DescriptionVersion:
    """One description version with its partition key composed."""
    return DescriptionVersion(
        ws_issue=description_partition(workspace_id, issue_id),
        workspace_id=workspace_id,
        issue_id=issue_id,
        body=body,
        edited_by=edited_by,
        edited_at=edited_at,
        source=source,
        sealed=sealed,
    )


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
    source: str | None = None,
    release_id: str | None = None,
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
        source=source_for(source, actor_kind),
        release_id=release_id,
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
        self._repository.put(as_item(activity, **index_attributes(activity)))
        return activity

    def record_many(self, rows: list[Activity]) -> list[Activity]:
        """Store several activity rows in one batch.

        A patch changing five fields writes five rows, and one `BatchWriteItem` is
        what keeps that a single round trip rather than five.
        """
        if not rows:
            return []
        self._repository.put_many([as_item(row, **index_attributes(row)) for row in rows])
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

    def list_for_actor(
        self,
        workspace_id: str,
        actor_id: str,
        *,
        before: datetime | None = None,
        max_items: int = 50,
    ) -> list[Activity]:
        """One person's issue rows in one workspace, newest first, from `before` back.

        `before` is padded by a second because stored stamps drop a zero fraction,
        so the caller cuts the exact boundary from the parsed rows. An index still
        being built answers nothing rather than failing the read.
        """
        if not workspace_id or not actor_id:
            return []
        condition = Key("ws_actor").eq(ws_actor(workspace_id, actor_id))
        if before is not None:
            upper = (before + timedelta(seconds=1)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")
            condition = condition & Key("created_at").lte(upper)
        try:
            items = list(
                self._repository.iter_query(
                    condition,
                    index_name=ACTOR_FEED_INDEX,
                    ascending=False,
                    max_items=max_items,
                    page_size=max_items,
                )
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in ("ValidationException", "ResourceNotFoundException"):
                return []
            raise
        return [as_activity(item) for item in items]

    def stamp_actor_index(self, item: Mapping[str, Any]) -> bool:
        """Give one stored row its actor feed attribute, for the backfill.

        Returns whether the row needed it, so a second run writes nothing. A row
        deleted since the scan read it stays deleted.
        """
        row = as_activity(item)
        wanted = index_attributes(row).get("ws_actor")
        if wanted is None or item.get("ws_actor") == wanted:
            return False
        try:
            self._repository.update(
                {"ws_issue": row.ws_issue, "activity_id": row.activity_id},
                update_expression="SET ws_actor = :actor",
                expression_values={":actor": wanted},
                condition=Attr("activity_id").exists(),
            )
        except ConditionFailed:
            return False
        return True

    def delete_for_issue(self, workspace_id: str, issue_id: str) -> int:
        """Remove one issue's whole history, returning how many rows went.

        Called when the issue is deleted, because the partition would otherwise be
        unreachable: nothing but the issue's own id names it.
        """
        removed = 0
        for partition in (ws_issue(workspace_id, issue_id), description_partition(workspace_id, issue_id)):
            items = list(self._repository.iter_query(Key("ws_issue").eq(partition), max_items=1000))
            if items:
                removed += self._repository.delete_many(
                    [{"ws_issue": partition, "activity_id": item["activity_id"]} for item in items]
                )
        return removed

    def list_description_versions(
        self, workspace_id: str, issue_id: str, *, limit: int = DESCRIPTION_VERSIONS_KEPT
    ) -> list[DescriptionVersion]:
        """One issue's description versions, newest first."""
        if not workspace_id or not issue_id:
            return []
        page = self._repository.query(
            Key("ws_issue").eq(description_partition(workspace_id, issue_id)),
            limit=limit,
            ascending=False,
        )
        return [
            DescriptionVersion.model_validate(dict(item))
            for item in page.items
            if item.get("kind") == DESCRIPTION_VERSION_KIND
        ]

    def latest_description_version(self, workspace_id: str, issue_id: str) -> DescriptionVersion | None:
        """The newest description version of one issue, read consistently, or `None`."""
        if not workspace_id or not issue_id:
            return None
        page = self._repository.query(
            Key("ws_issue").eq(description_partition(workspace_id, issue_id)),
            limit=1,
            ascending=False,
            consistent=True,
        )
        rows = [item for item in page.items if item.get("kind") == DESCRIPTION_VERSION_KIND]
        return DescriptionVersion.model_validate(dict(rows[0])) if rows else None

    def get_description_version(self, workspace_id: str, issue_id: str, version_id: str) -> DescriptionVersion | None:
        """One description version of one issue, or `None`."""
        if not workspace_id or not issue_id or not version_id:
            return None
        item = self._repository.get(
            {"ws_issue": description_partition(workspace_id, issue_id), "activity_id": version_id}
        )
        if item is None or item.get("kind") != DESCRIPTION_VERSION_KIND:
            return None
        return DescriptionVersion.model_validate(dict(item))

    def save_description_version(self, version: DescriptionVersion) -> DescriptionVersion:
        """Store one description version, new or rewritten in place, dropping versions past the cap."""
        self._repository.put(as_item(version))
        keys = list(
            self._repository.iter_query(
                Key("ws_issue").eq(version.ws_issue),
                projection="activity_id",
                ascending=False,
                max_items=DESCRIPTION_VERSIONS_KEPT * 2,
            )
        )
        dropped = keys[DESCRIPTION_VERSIONS_KEPT:]
        if dropped:
            self._repository.delete_many(
                [{"ws_issue": version.ws_issue, "activity_id": item["activity_id"]} for item in dropped]
            )
        return version

    def record_tombstone(self, workspace_id: str, team_id: str, issue_id: str, actor_id: str) -> Activity:
        """Record that one issue was deleted, for list delta polling, and prune expired tombstones.

        Written without the team feed attribute, because the delta reads the
        tombstone partition by key and a deleted issue is not a team feed entry.
        """
        row = Activity(
            ws_issue=tombstone_partition(workspace_id),
            workspace_id=workspace_id,
            team_id=team_id,
            issue_id=issue_id,
            actor_id=actor_id,
            kind=TOMBSTONE_KIND,
        )
        self._repository.put(as_item(row))
        self._prune_tombstones(workspace_id, row.created_at - TOMBSTONE_RETENTION)
        return row

    def tombstones_since(self, workspace_id: str, since: datetime, *, max_items: int = 1000) -> list[Activity]:
        """The deletion tombstones of one workspace minted at or after `since`, oldest first.

        A key condition on the ULID sort key, so a poll with no deletions reads
        nothing but an empty page.
        """
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("ws_issue").eq(tombstone_partition(workspace_id)) & Key("activity_id").gte(ulid_floor(since)),
            ascending=True,
            max_items=max_items,
        )
        return [as_activity(item) for item in items]

    def delete_tombstones(self, workspace_id: str, team_id: str | None = None) -> int:
        """Remove a workspace's tombstones, or one team's of them, for the purges."""
        partition = tombstone_partition(workspace_id)
        items = list(self._repository.iter_query(Key("ws_issue").eq(partition), max_items=10000))
        doomed = [item for item in items if team_id is None or item.get("team_id") == team_id]
        if not doomed:
            return 0
        return self._repository.delete_many(
            [{"ws_issue": partition, "activity_id": item["activity_id"]} for item in doomed]
        )

    def record_team_event(
        self,
        workspace_id: str,
        team_id: str,
        *,
        field: str,
        from_value: Any,
        to_value: Any,
        actor_id: str = "system",
        actor_kind: str = "system",
        source: str | None = None,
    ) -> Activity:
        """Record a change to a team's own settings on the team feed."""
        row = Activity(
            ws_issue=team_events_partition(workspace_id),
            workspace_id=workspace_id,
            team_id=team_id,
            issue_id="",
            actor_id=actor_id,
            actor_kind=actor_kind,
            kind="field_changed",
            field=field,
            from_value=from_value,
            to_value=to_value,
            source=source_for(source, actor_kind),
        )
        self._repository.put(as_item(row, ws_team=ws_team(workspace_id, team_id)))
        return row

    def list_team_events(self, workspace_id: str, team_id: str, *, max_items: int = 100) -> list[Activity]:
        """One team's team level activity, newest first."""
        if not workspace_id or not team_id:
            return []
        items = self._repository.iter_query(
            Key("ws_issue").eq(team_events_partition(workspace_id)), ascending=False, max_items=1000
        )
        return [as_activity(item) for item in items if item.get("team_id") == team_id][:max_items]

    def iter_team_feed(
        self, workspace_id: str, team_id: str, since: datetime, until: datetime, *, max_items: int = 5000
    ) -> list[Activity]:
        """One team's issue activity written in `[since, until)`, oldest first.

        A key condition on the team feed index padded by a second on each side,
        because stored stamps drop a zero fraction and so do not sort strictly by
        time; the exact window is then applied to the parsed rows. Team level
        events carry no issue and are left out.
        """
        if not workspace_id or not team_id or since >= until:
            return []
        lower = (since - timedelta(seconds=1)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")
        upper = (until + timedelta(seconds=1)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")
        items = self._repository.iter_query(
            Key("ws_team").eq(ws_team(workspace_id, team_id)) & Key("created_at").between(lower, upper),
            index_name=TEAM_FEED_INDEX,
            ascending=True,
            max_items=max_items,
        )
        rows = [as_activity(item) for item in items if item.get("issue_id")]
        return [row for row in rows if since <= row.created_at < until]

    def delete_team_events(self, workspace_id: str, team_id: str | None = None) -> int:
        """Remove a workspace's team level activity, or one team's of it, for the purges."""
        partition = team_events_partition(workspace_id)
        items = list(self._repository.iter_query(Key("ws_issue").eq(partition), max_items=10000))
        doomed = [item for item in items if team_id is None or item.get("team_id") == team_id]
        if not doomed:
            return 0
        return self._repository.delete_many(
            [{"ws_issue": partition, "activity_id": item["activity_id"]} for item in doomed]
        )

    def _prune_tombstones(self, workspace_id: str, cutoff: datetime) -> None:
        """Delete up to one batch of tombstones older than `cutoff`, oldest first."""
        partition = tombstone_partition(workspace_id)
        items = self._repository.iter_query(
            Key("ws_issue").eq(partition) & Key("activity_id").lt(ulid_floor(cutoff)),
            ascending=True,
            max_items=TOMBSTONE_PRUNE_BATCH,
        )
        keys = [{"ws_issue": partition, "activity_id": item["activity_id"]} for item in items]
        if keys:
            self._repository.delete_many(keys)


def as_activity(item: Mapping[str, Any]) -> Activity:
    """One stored item as an `Activity`, ignoring the feed indexes' attributes."""
    fields = {key: value for key, value in item.items() if key not in ("ws_team", "ws_actor")}
    return Activity.model_validate(fields)
