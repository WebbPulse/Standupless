"""The `inbox` table: one partition per recipient, with a sparse unread index.

A notification is written by the notify consumer and read only by the member it
belongs to. The partition is built from the authorization context rather than from
a route parameter, which is what leaves no path by which one member reads another's
inbox. `unread_at` exists only while a notification is unread, so the badge counts
a short index instead of filtering a whole partition.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Iterable, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Page, Repository

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import INBOX

NotificationKind = Literal["assigned", "mentioned", "commented", "status_changed"]

NOTIFICATION_KINDS: tuple[str, ...] = ("assigned", "mentioned", "commented", "status_changed")

RETENTION = timedelta(days=90)

UNREAD_INDEX = "ws_user-unread-index"

COUNT_CAP = 100


def inbox_partition(workspace_id: str, user_id: str) -> str:
    """The partition one member's notifications live in, workspace first."""
    return f"{workspace_id}#{user_id}"


def expires_at(created_at: datetime) -> int:
    """The epoch second DynamoDB drops this notification at, 90 days out.

    Retention is a table TTL rather than a cleanup job because an inbox row has no
    value once it has aged out and nothing else references it.
    """
    return int((created_at + RETENTION).timestamp())


class Notification(BaseModel):
    """One inbox row: what happened, on which issue, and who caused it."""

    ws_user: str
    notification_id: str
    workspace_id: str
    kind: str
    issue_id: str
    issue_key: str
    issue_title: str
    project_id: str
    comment_id: str | None = None
    actor_id: str
    actor_name: str
    recipient_id: str
    created_at: datetime = Field(default_factory=utc_now)
    unread_at: str | None = None
    expires_at: int = 0

    @property
    def unread(self) -> bool:
        """Whether this notification is still unread.

        Derived from the presence of `unread_at` rather than stored as a flag, so
        the sparse index and the reported state cannot drift apart.
        """
        return self.unread_at is not None


class InboxRepository:
    """Reads and writes `inbox` rows for exactly one recipient at a time."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(INBOX, repository)

    def get(self, workspace_id: str, user_id: str, notification_id: str) -> Notification | None:
        """One notification of one member, or `None`."""
        if not workspace_id or not user_id or not notification_id:
            return None
        item = self._repository.get(
            {"ws_user": inbox_partition(workspace_id, user_id), "notification_id": notification_id}
        )
        return Notification.model_validate(dict(item)) if item is not None else None

    def create(self, notification: Notification) -> bool:
        """Store a notification unless its id is already there.

        The consumer derives the id from the record it is handling, so a replayed
        stream record puts the same id and this condition turns the second attempt
        into a no-op rather than a duplicate badge.

        An absent `unread_at` is dropped rather than written as a null, because it is
        the sparse index's sort key and DynamoDB rejects a null there outright. That
        is the same shape `mark_read` leaves behind, so a notification stored read and
        one marked read afterwards are indistinguishable.
        """
        item = as_item(notification)
        item["expires_at"] = notification.expires_at or expires_at(notification.created_at)
        if item.get("unread_at") is None:
            item.pop("unread_at", None)
        try:
            self._repository.put(item, condition=Attr("notification_id").not_exists())
        except ConditionFailed:
            return False
        return True

    def list(
        self,
        workspace_id: str,
        user_id: str,
        *,
        unread_only: bool = False,
        limit: int = 50,
        start_key: Mapping[str, Any] | None = None,
    ) -> Page:
        """One page of a member's notifications, newest first.

        `unread_only` reads the sparse index, which holds only what is unread, so an
        old inbox does not make the unread filter read a large partition.
        """
        partition = inbox_partition(workspace_id, user_id)
        if unread_only:
            return self._repository.query(
                Key("ws_user").eq(partition),
                index_name=UNREAD_INDEX,
                limit=limit,
                start_key=dict(start_key) if start_key else None,
                ascending=False,
            )
        return self._repository.query(
            Key("ws_user").eq(partition),
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=False,
        )

    def unread_count(self, workspace_id: str, user_id: str) -> int:
        """How many notifications are unread, counted no further than the cap.

        The contract reports anything above the cap as the cap, so reading one item
        past it is enough and a very busy inbox costs the same as a quiet one.
        """
        page = self._repository.query(
            Key("ws_user").eq(inbox_partition(workspace_id, user_id)),
            index_name=UNREAD_INDEX,
            limit=COUNT_CAP + 1,
        )
        return min(len(page.items), COUNT_CAP)

    def mark_read(self, workspace_id: str, user_id: str, notification_ids: Iterable[str]) -> int:
        """Mark the named notifications read, reporting how many changed.

        Reading removes `unread_at` rather than setting it null, because a null
        attribute still projects into the sparse index and would keep counting.
        """
        partition = inbox_partition(workspace_id, user_id)
        updated = 0
        for notification_id in notification_ids:
            key = {"ws_user": partition, "notification_id": notification_id}
            try:
                self._repository.remove_attributes(key, ["unread_at"], condition=Attr("unread_at").exists())
            except ConditionFailed:
                continue
            updated += 1
        return updated

    def mark_all_read(self, workspace_id: str, user_id: str) -> int:
        """Mark every unread notification of one member read.

        Walks the sparse index, so the work is proportional to what is unread rather
        than to how much the member has ever been sent.
        """
        partition = inbox_partition(workspace_id, user_id)
        unread = list(
            self._repository.iter_query(
                Key("ws_user").eq(partition),
                index_name=UNREAD_INDEX,
            )
        )
        return self.mark_read(
            workspace_id,
            user_id,
            [str(item["notification_id"]) for item in unread],
        )

    def delete(self, workspace_id: str, user_id: str, notification_id: str) -> bool:
        """Remove one notification, reporting whether one was there."""
        if self.get(workspace_id, user_id, notification_id) is None:
            return False
        self._repository.delete({"ws_user": inbox_partition(workspace_id, user_id), "notification_id": notification_id})
        return True
