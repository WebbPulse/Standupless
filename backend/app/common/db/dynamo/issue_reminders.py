"""Issue reminders a member set for themselves, held in the `inbox` table until they are due.

A member asks to be reminded about one issue at one moment. The reminder is one
pending row in that member's own reminder partition, keyed by the issue, so a
member holds at most one reminder per issue and setting another replaces it. Each
pending row also writes a due marker into one shared partition, keyed by the
moment it is due, so the scheduled tick reads only what is due rather than every
member's reminders.

The rows live under partitions no member's inbox can name, like the digest rows,
which keeps the pending state inside the grant the views image and the notify
consumer already hold. The table's TTL drops a reminder nothing ever delivered.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, utc_now

DUE_PARTITION = "issue_reminder#due"

_PENDING_PREFIX = "issue_reminder#"

REMINDER_GRACE = timedelta(days=7)
"""How long a reminder survives past its moment before the table TTL drops it unsent."""


def reminder_partition(workspace_id: str, user_id: str) -> str:
    """The partition one member's pending reminders in one workspace live in."""
    return f"{_PENDING_PREFIX}{workspace_id}#{user_id}"


def _stamp(moment: datetime) -> str:
    """One moment as the fixed-width UTC string the due markers sort and compare by."""
    return moment.astimezone(timezone.utc).isoformat(timespec="microseconds")


def _marker(reminder: "IssueReminder") -> str:
    """The due partition sort key one reminder is filed under."""
    return f"{_stamp(reminder.remind_at)}#{reminder.workspace_id}#{reminder.user_id}#{reminder.issue_id}"


def _expiry(remind_at: datetime) -> int:
    """The TTL stamp for a reminder due at `remind_at`."""
    return int((remind_at + REMINDER_GRACE).timestamp())


class IssueReminder(BaseModel):
    """One pending reminder: who asked, about which issue, and when it is due."""

    workspace_id: str
    user_id: str
    issue_id: str
    remind_at: datetime
    created_at: datetime


class DueReminder(BaseModel):
    """One due marker the scheduled tick hands to delivery."""

    workspace_id: str
    user_id: str
    issue_id: str
    remind_at: datetime
    marker: str


class IssueReminderStore:
    """Writes, lists and cancels issue reminders, and hands due ones to the tick."""

    def __init__(self, repository: Repository) -> None:
        """Share the `inbox` table's package repository."""
        self._repository = repository

    def get(self, workspace_id: str, user_id: str, issue_id: str) -> IssueReminder | None:
        """One member's pending reminder on one issue, or `None`."""
        if not workspace_id or not user_id or not issue_id:
            return None
        item = self._repository.get(
            {"ws_user": reminder_partition(workspace_id, user_id), "notification_id": issue_id},
            consistent=True,
        )
        return IssueReminder.model_validate(dict(item)) if item is not None else None

    def list(self, workspace_id: str, user_id: str) -> list[IssueReminder]:
        """Every pending reminder of one member in one workspace, soonest first."""
        items: Iterable[Any] = self._repository.iter_query(
            Key("ws_user").eq(reminder_partition(workspace_id, user_id)), consistent=True
        )
        reminders = [IssueReminder.model_validate(dict(item)) for item in items]
        return sorted(reminders, key=lambda reminder: (reminder.remind_at, reminder.issue_id))

    def set(
        self,
        workspace_id: str,
        user_id: str,
        issue_id: str,
        remind_at: datetime,
        now: datetime | None = None,
    ) -> IssueReminder:
        """Set one member's reminder on one issue, replacing any reminder already there.

        The due marker is written before the pending row, so a reminder that is
        listed always has a marker to be delivered by. A replaced reminder's old
        marker is deleted after, and a marker left behind by a failure part way is
        dropped at delivery because its moment no longer matches the pending row.
        """
        previous = self.get(workspace_id, user_id, issue_id)
        reminder = IssueReminder(
            workspace_id=workspace_id,
            user_id=user_id,
            issue_id=issue_id,
            remind_at=remind_at,
            created_at=now or utc_now(),
        )
        expiry = _expiry(remind_at)
        marker = _marker(reminder)
        self._repository.put(
            {
                "ws_user": DUE_PARTITION,
                "notification_id": marker,
                "workspace_id": workspace_id,
                "user_id": user_id,
                "issue_id": issue_id,
                "remind_at": _stamp(remind_at),
                "expires_at": expiry,
            }
        )
        self._repository.put(
            as_item(
                reminder,
                ws_user=reminder_partition(workspace_id, user_id),
                notification_id=issue_id,
                remind_at=_stamp(remind_at),
                expires_at=expiry,
            )
        )
        if previous is not None and _marker(previous) != marker:
            self._repository.delete({"ws_user": DUE_PARTITION, "notification_id": _marker(previous)})
        return reminder

    def cancel(self, workspace_id: str, user_id: str, issue_id: str) -> bool:
        """Cancel one member's reminder on one issue, reporting whether one was pending."""
        reminder = self.get(workspace_id, user_id, issue_id)
        if reminder is None:
            return False
        self._repository.delete({"ws_user": DUE_PARTITION, "notification_id": _marker(reminder)})
        self._repository.delete({"ws_user": reminder_partition(workspace_id, user_id), "notification_id": issue_id})
        return True

    def due(self, cutoff: datetime, *, limit: int) -> list[DueReminder]:
        """The oldest reminders due at or before `cutoff`, at most `limit` of them."""
        page = self._repository.query(
            Key("ws_user").eq(DUE_PARTITION) & Key("notification_id").lte(f"{_stamp(cutoff)}~"),
            limit=limit,
            consistent=True,
        )
        return [
            DueReminder(
                workspace_id=str(item["workspace_id"]),
                user_id=str(item["user_id"]),
                issue_id=str(item["issue_id"]),
                remind_at=datetime.fromisoformat(str(item["remind_at"])),
                marker=str(item["notification_id"]),
            )
            for item in page.items
        ]

    def claim(self, due: DueReminder) -> bool:
        """Take one due marker for this tick, answering whether it was still there.

        The conditional delete keeps two overlapping ticks from delivering the
        same reminder twice.
        """
        try:
            self._repository.delete(
                {"ws_user": DUE_PARTITION, "notification_id": due.marker},
                condition=Attr("notification_id").exists(),
            )
        except ConditionFailed:
            return False
        return True

    def release(self, due: DueReminder) -> None:
        """Put a claimed marker back, so a delivery that failed is retried on the next tick."""
        self._repository.put(
            {
                "ws_user": DUE_PARTITION,
                "notification_id": due.marker,
                "workspace_id": due.workspace_id,
                "user_id": due.user_id,
                "issue_id": due.issue_id,
                "remind_at": _stamp(due.remind_at),
                "expires_at": _expiry(due.remind_at),
            }
        )

    def finish(self, due: DueReminder) -> bool:
        """Drop the pending row a delivered marker stood for, unless it was reset meanwhile.

        The delete is conditional on the row still being due at the delivered
        moment, so a member who moved the reminder while it was being delivered
        keeps the new one.
        """
        try:
            self._repository.delete(
                {"ws_user": reminder_partition(due.workspace_id, due.user_id), "notification_id": due.issue_id},
                condition=Attr("remind_at").eq(_stamp(due.remind_at)),
            )
        except ConditionFailed:
            return False
        return True

    def delete_all(self, workspace_id: str, user_id: str) -> int:
        """Delete every reminder of one member in one workspace, markers included, for the purges."""
        reminders = self.list(workspace_id, user_id)
        if not reminders:
            return 0
        self._repository.delete_many(
            [{"ws_user": DUE_PARTITION, "notification_id": _marker(reminder)} for reminder in reminders]
        )
        return self._repository.delete_many(
            [
                {"ws_user": reminder_partition(workspace_id, user_id), "notification_id": reminder.issue_id}
                for reminder in reminders
            ]
        )
