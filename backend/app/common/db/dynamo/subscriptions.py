"""The `subscriptions` table: who follows one issue and why.

Partitioned per issue and sorted by user id, so the notify consumer reads an
issue's whole audience in one query and a subscribe is a put on a key the caller
already knows. A row is its own fact: its presence is the subscription, and
removing it is the unsubscribe.

Kept out of the issue row on purpose. An attribute on the issue would turn every
subscribe into an issue write, which every issue stream consumer would then read,
and would give the discussion domain a write grant on issues it has no other use for.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import SUBSCRIPTIONS

SubscriptionReason = Literal["creator", "assignee", "commenter", "mentioned", "manual"]

SUBSCRIPTION_REASONS: tuple[str, ...] = ("creator", "assignee", "commenter", "mentioned", "manual")


def ws_issue(workspace_id: str, issue_id: str) -> str:
    """The partition key of one issue's subscribers."""
    return f"{workspace_id}#{issue_id}"


class Subscription(BaseModel):
    """One user following one issue, with the reason they first followed it."""

    ws_issue: str
    user_id: str
    workspace_id: str
    issue_id: str
    team_id: str
    reason: str
    created_at: datetime = Field(default_factory=utc_now)


def build_subscription(workspace_id: str, issue_id: str, team_id: str, user_id: str, reason: str) -> Subscription:
    """One subscription with its partition key already composed."""
    return Subscription(
        ws_issue=ws_issue(workspace_id, issue_id),
        user_id=user_id,
        workspace_id=workspace_id,
        issue_id=issue_id,
        team_id=team_id,
        reason=reason,
    )


class SubscriptionRepository:
    """Reads and writes `subscriptions` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(SUBSCRIPTIONS, repository)

    def get(self, workspace_id: str, issue_id: str, user_id: str) -> Subscription | None:
        """One user's subscription to one issue, or `None`."""
        if not workspace_id or not issue_id or not user_id:
            return None
        item = self._repository.get({"ws_issue": ws_issue(workspace_id, issue_id), "user_id": user_id})
        return Subscription.model_validate(item) if item is not None else None

    def subscribe(self, workspace_id: str, issue_id: str, team_id: str, user_id: str, reason: str) -> bool:
        """Follow the issue, reporting whether the row is new.

        A second subscribe keeps the first row, so the reason stays the one the user
        first followed for rather than the latest thing that touched them.
        """
        if not user_id:
            return False
        row = build_subscription(workspace_id, issue_id, team_id, user_id, reason)
        try:
            self._repository.put(as_item(row), condition=Attr("user_id").not_exists())
        except ConditionFailed:
            return False
        return True

    def subscribe_many(
        self, workspace_id: str, issue_id: str, team_id: str, user_ids: Iterable[str], reason: str
    ) -> list[str]:
        """Follow the issue for each user, returning the ones newly subscribed."""
        added = []
        for user_id in dict.fromkeys(user_ids):
            if self.subscribe(workspace_id, issue_id, team_id, user_id, reason):
                added.append(user_id)
        return added

    def unsubscribe(self, workspace_id: str, issue_id: str, user_id: str) -> None:
        """Stop following the issue. Unsubscribing twice is not an error."""
        if not user_id:
            return
        self._repository.delete({"ws_issue": ws_issue(workspace_id, issue_id), "user_id": user_id})

    def list_for_issue(self, workspace_id: str, issue_id: str, *, max_items: int = 1000) -> list[Subscription]:
        """Every subscriber of one issue, in user id order."""
        if not workspace_id or not issue_id:
            return []
        items = self._repository.iter_query(
            Key("ws_issue").eq(ws_issue(workspace_id, issue_id)),
            max_items=max_items,
        )
        return [as_subscription(item) for item in items]

    def user_ids(self, workspace_id: str, issue_id: str) -> list[str]:
        """The ids of every subscriber of one issue, which is what a fan-out reads."""
        return [row.user_id for row in self.list_for_issue(workspace_id, issue_id)]

    def delete_for_issue(self, workspace_id: str, issue_id: str) -> int:
        """Remove every subscription of one issue, returning how many rows went.

        Called when the issue is deleted, because nothing but the issue's own id
        names the partition afterwards.
        """
        partition = ws_issue(workspace_id, issue_id)
        items = list(self._repository.iter_query(Key("ws_issue").eq(partition), max_items=1000))
        if not items:
            return 0
        return self._repository.delete_many([{"ws_issue": partition, "user_id": item["user_id"]} for item in items])


def as_subscription(item: Mapping[str, Any]) -> Subscription:
    """One stored item as a `Subscription`."""
    return Subscription.model_validate(dict(item))
