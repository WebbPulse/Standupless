"""The `inbox` table: one partition per recipient, with a sparse unread index.

A notification is written by the notify consumer and read only by the member it
belongs to. The partition is built from the authorization context rather than from
a route parameter, which is what leaves no path by which one member reads another's
inbox. `unread_at` exists only while a notification is unread, so the badge counts
a short index instead of filtering a whole partition.

Snoozing needs no sweep. A snoozed row carries `snoozed_until` and has `unread_at`
set to the same instant, and every unread read bounds the index's range key at now,
so the row stays out of the badge and the unread list until its time comes and then
counts as unread by itself, with nothing having to wake it.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Page, Repository

from app.common.db.dynamo.base import as_item, build_repository, delete_partition, utc_now
from app.common.db.dynamo.notify_digests import DigestStore
from app.common.db.dynamo.tables import INBOX

NotificationKind = Literal[
    "assigned",
    "mentioned",
    "commented",
    "status_changed",
    "project_update",
    "project_update_due",
    "due_soon",
    "overdue",
    "standup_digest",
    "sla_at_risk",
    "sla_breached",
    "review_requested",
]

NOTIFICATION_KINDS: tuple[str, ...] = (
    "assigned",
    "mentioned",
    "commented",
    "status_changed",
    "project_update",
    "project_update_due",
    "due_soon",
    "overdue",
    "standup_digest",
    "sla_at_risk",
    "sla_breached",
    "review_requested",
)

REVIEW_REQUESTED = "review_requested"
"""The kind a GitHub review request takes in the requested member's inbox, in app only."""

REMINDER_PREFIX = "reminder#"
"""The partition prefix reminder markers live under, which no inbox can name.

Project update reminders and issue due date reminders share it, each subject id
carrying its own shape so the two can never collide.
"""

STANDUP_PREFIX = "standup#"
"""The partition prefix standup digest delivery markers live under, which no inbox can name."""

SWEEP_PARTITION = "sweep#passes"
"""The partition the scheduled sweeps record their last pass in, which no inbox can name."""

RETENTION = timedelta(days=90)

UNREAD_INDEX = "ws_user-unread-index"

COUNT_CAP = 100

SNOOZE_MAX = RETENTION


_ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

_ULID_TIME_CHARS = 10

_ULID_HASH_CHARS = 16


def _ulid_time(moment: datetime) -> str:
    """The time half of a ULID for one moment, so ids still sort chronologically.

    Only the timestamp is taken from the ULID format; the random half is replaced by
    a hash of what the notification is about, which is what makes the id a function
    of the record rather than of when it was handled.
    """
    milliseconds = int(moment.timestamp() * 1000)
    encoded = ""
    for _ in range(_ULID_TIME_CHARS):
        encoded = _ULID_ALPHABET[milliseconds & 0x1F] + encoded
        milliseconds >>= 5
    return encoded


def notification_id(created_at: datetime | None, kind: str, recipient_id: str, source_id: str) -> str:
    """A notification id that is a function of what the notification is about.

    Chronological by its ULID timestamp prefix, so an inbox partition still reads
    newest first, and deterministic in its tail, so a redelivered record produces
    the same key and the conditional put drops it. Truncated because the tail only
    has to separate the notifications of one millisecond, not resist an attacker:
    nothing is authorized by this id.

    `created_at` is the moment the record itself carries, or `None` when it carries
    none. It is never the wall clock: a clock reading would move between the first
    delivery and a replay, and the whole id has to be stable for the conditional put
    to recognise the replay. Without one, the timestamp half falls back to the epoch,
    which sorts such a notification oldest rather than making it a duplicate.
    """
    digest = hashlib.sha256(f"{kind}\x00{recipient_id}\x00{source_id}".encode("utf-8")).digest()
    value = int.from_bytes(digest, "big")
    tail = ""
    for _ in range(_ULID_HASH_CHARS):
        tail = _ULID_ALPHABET[value & 0x1F] + tail
        value >>= 5
    moment = created_at if created_at is not None else datetime.fromtimestamp(0, tz=timezone.utc)
    return _ulid_time(moment) + tail


def instant(moment: datetime) -> str:
    """One moment as the fixed-width UTC string `unread_at` and `snoozed_until` compare as.

    Microseconds are always present, so a string comparison on the index range key
    orders the same way the instants do.
    """
    return moment.astimezone(timezone.utc).isoformat(timespec="microseconds")


def _awake(now: datetime) -> Any:
    """The filter keeping rows whose snooze has not yet run out off a list."""
    return Attr("snoozed_until").not_exists() | Attr("snoozed_until").lte(instant(now))


def _asleep(now: datetime) -> Any:
    """The filter keeping only the rows still snoozed."""
    return Attr("snoozed_until").gt(instant(now))


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
    """One inbox row: what happened, on which issue or project, and who caused it.

    An issue notification carries the issue fields. A project update notification
    carries the project fields instead and leaves the issue fields empty, with
    `team_id` naming one of the project's teams the recipient can see. A standup
    digest carries its team's key in `issue_key`, the team name in `issue_title`
    and the digest's team local date in `standup_date`. A review request carries
    the pull request's `owner/repo#number` in `issue_key`, its title in
    `issue_title` and its GitHub address in `url`.
    """

    ws_user: str
    notification_id: str
    workspace_id: str
    kind: str
    issue_id: str = ""
    issue_key: str = ""
    issue_title: str = ""
    team_id: str
    comment_id: str | None = None
    project_id: str | None = None
    project_name: str | None = None
    project_update_id: str | None = None
    standup_date: str | None = None
    url: str | None = None
    actor_id: str
    actor_name: str
    source: str | None = None
    recipient_id: str
    created_at: datetime = Field(default_factory=utc_now)
    unread_at: str | None = None
    snoozed_until: str | None = None
    expires_at: int = 0

    def snoozed(self, now: datetime | None = None) -> bool:
        """Whether this notification is snoozed and its time has not yet come."""
        return self.snoozed_until is not None and self.snoozed_until > instant(now or utc_now())

    @property
    def unread(self) -> bool:
        """Whether this notification is still unread.

        Derived from the presence of `unread_at` rather than stored as a flag, so
        the sparse index and the reported state cannot drift apart. A row still
        snoozed is not unread yet: it becomes unread when its snooze runs out.
        """
        return self.unread_at is not None and not self.snoozed()


class InboxRepository:
    """Reads and writes `inbox` rows for exactly one recipient at a time.

    `digests` holds the pending notification emails, which share this table under
    partitions no inbox can name.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(INBOX, repository)
        self.digests = DigestStore(self._repository)

    def delete_all(self, workspace_id: str, user_id: str) -> int:
        """Delete one person's whole inbox in one workspace, for the workspace and account purges."""
        return delete_partition(self._repository, INBOX, inbox_partition(workspace_id, user_id))

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
        for sparse in ("unread_at", "snoozed_until"):
            if item.get(sparse) is None:
                item.pop(sparse, None)
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
        snoozed_only: bool = False,
        limit: int = 50,
        start_key: Mapping[str, Any] | None = None,
        now: datetime | None = None,
    ) -> Page:
        """One page of a member's notifications, newest first.

        `unread_only` reads the sparse index, which holds only what is unread, so an
        old inbox does not make the unread filter read a large partition; bounding
        its range key at now leaves out what is still snoozed. The full list filters
        snoozed rows out and `snoozed_only` keeps only them, which is the Snoozed
        view. A filtered page can come back short while still carrying a cursor.
        """
        moment = now or utc_now()
        partition = inbox_partition(workspace_id, user_id)
        if unread_only:
            return self._repository.query(
                Key("ws_user").eq(partition) & Key("unread_at").lte(instant(moment)),
                index_name=UNREAD_INDEX,
                limit=limit,
                start_key=dict(start_key) if start_key else None,
                ascending=False,
            )
        return self._repository.query(
            Key("ws_user").eq(partition),
            filter_expression=_asleep(moment) if snoozed_only else _awake(moment),
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
            Key("ws_user").eq(inbox_partition(workspace_id, user_id)) & Key("unread_at").lte(instant(utc_now())),
            index_name=UNREAD_INDEX,
            limit=COUNT_CAP + 1,
        )
        return min(len(page.items), COUNT_CAP)

    def mark_read(self, workspace_id: str, user_id: str, notification_ids: Iterable[str]) -> int:
        """Mark the named notifications read, reporting how many changed.

        Reading removes `unread_at` rather than setting it null, because a null
        attribute still teams into the sparse index and would keep counting. The
        same write clears any snooze, since a read row has nothing to come back for.
        """
        partition = inbox_partition(workspace_id, user_id)
        updated = 0
        for notification_id in notification_ids:
            key = {"ws_user": partition, "notification_id": notification_id}
            try:
                self._repository.remove_attributes(
                    key, ["unread_at", "snoozed_until"], condition=Attr("unread_at").exists()
                )
            except ConditionFailed:
                continue
            updated += 1
        return updated

    def mark_all_read(self, workspace_id: str, user_id: str) -> int:
        """Mark every unread notification of one member read.

        Walks the sparse index, so the work is proportional to what is unread rather
        than to how much the member has ever been sent. Bounded at now, so a row
        still snoozed keeps its snooze rather than being swept up with the rest.
        """
        partition = inbox_partition(workspace_id, user_id)
        unread = list(
            self._repository.iter_query(
                Key("ws_user").eq(partition) & Key("unread_at").lte(instant(utc_now())),
                index_name=UNREAD_INDEX,
            )
        )
        return self.mark_read(
            workspace_id,
            user_id,
            [str(item["notification_id"]) for item in unread],
        )

    def mark_unread(self, workspace_id: str, user_id: str, notification_ids: Iterable[str]) -> int:
        """Mark the named notifications unread now, reporting how many changed.

        Writing `unread_at` back returns the row to the sparse index, and the same
        write drops any snooze, so marking a snoozed row unread brings it back at
        once. The write is conditional on the row existing in this member's
        partition, so an id from anyone else's inbox creates nothing, and on it
        being read or snoozed, so a row already unread is not counted as changed.
        """
        partition = inbox_partition(workspace_id, user_id)
        stamp = instant(utc_now())
        condition = Attr("notification_id").exists() & (Attr("unread_at").not_exists() | Attr("snoozed_until").exists())
        updated = 0
        for notification_id in notification_ids:
            key = {"ws_user": partition, "notification_id": notification_id}
            try:
                self._repository.update(
                    key,
                    update_expression="SET #unread = :stamp REMOVE #snoozed",
                    expression_names={"#unread": "unread_at", "#snoozed": "snoozed_until"},
                    expression_values={":stamp": stamp},
                    condition=condition,
                )
            except ConditionFailed:
                continue
            updated += 1
        return updated

    def snooze(self, workspace_id: str, user_id: str, notification_ids: Iterable[str], until: datetime) -> int:
        """Snooze the named notifications until one moment, reporting how many changed.

        `unread_at` is set to the same moment, which keeps the row out of every
        unread read until then and makes it unread afterwards with no further
        write. The expiry is pushed past the snooze, so the TTL never drops a
        notification while it is waiting to come back.
        """
        partition = inbox_partition(workspace_id, user_id)
        stamp = instant(until)
        updated = 0
        for notification_id in notification_ids:
            key = {"ws_user": partition, "notification_id": notification_id}
            try:
                self._repository.set_attributes(
                    key,
                    {"unread_at": stamp, "snoozed_until": stamp, "expires_at": expires_at(until)},
                    condition=Attr("notification_id").exists(),
                    return_values="NONE",
                )
            except ConditionFailed:
                continue
            updated += 1
        return updated

    def reminded(self, workspace_id: str, subject_id: str, due_at: datetime) -> bool:
        """Whether the reminder for this subject due at `due_at` has already gone out.

        The subject is a project id for an update reminder, or the kind, issue and
        assignee of an issue due date reminder.
        """
        item = self._repository.get(
            {"ws_user": f"{REMINDER_PREFIX}{workspace_id}", "notification_id": _due_key(subject_id, due_at)}
        )
        return item is not None

    def mark_reminded(self, workspace_id: str, subject_id: str, due_at: datetime, now: datetime) -> bool:
        """Record that this due date's reminder went out, answering false when it already had.

        The marker outlives the notification it guards, so a person who deletes the
        reminder is not sent it again, and the table TTL drops it with the inbox rows.
        """
        try:
            self._repository.put(
                {
                    "ws_user": f"{REMINDER_PREFIX}{workspace_id}",
                    "notification_id": _due_key(subject_id, due_at),
                    "workspace_id": workspace_id,
                    "subject_id": subject_id,
                    "expires_at": expires_at(now),
                },
                condition=Attr("notification_id").not_exists(),
            )
        except ConditionFailed:
            return False
        return True

    def standup_sent(self, workspace_id: str, team_id: str, day: str) -> bool:
        """Whether one team's standup digest for the team local date `day` has already gone out."""
        item = self._repository.get(
            {"ws_user": f"{STANDUP_PREFIX}{workspace_id}", "notification_id": f"{team_id}#{day}"}
        )
        return item is not None

    def mark_standup_sent(self, workspace_id: str, team_id: str, day: str, now: datetime) -> bool:
        """Record that one team's digest for `day` went out, answering false when it already had.

        Like the reminder marker it outlives the rows it guards, so a member who
        deletes the digest is not sent it again, and the table TTL drops it.
        """
        try:
            self._repository.put(
                {
                    "ws_user": f"{STANDUP_PREFIX}{workspace_id}",
                    "notification_id": f"{team_id}#{day}",
                    "workspace_id": workspace_id,
                    "team_id": team_id,
                    "expires_at": expires_at(now),
                },
                condition=Attr("notification_id").not_exists(),
            )
        except ConditionFailed:
            return False
        return True

    def claim_sweep(self, name: str, slot: int, now: datetime) -> bool:
        """Claim one sweep's pass for the window starting at epoch second `slot`.

        Answers true when the last recorded pass is from an earlier window, or there
        is none, and false when this window's pass is already claimed. The put is
        conditional, so two ticks racing on one window cannot both run the sweep,
        and a late tick still claims the window it lands in.
        """
        try:
            self._repository.put(
                {
                    "ws_user": SWEEP_PARTITION,
                    "notification_id": name,
                    "slot": slot,
                    "claimed_at": instant(now),
                    "expires_at": expires_at(now),
                },
                condition=Attr("notification_id").not_exists() | Attr("slot").lt(slot),
            )
        except ConditionFailed:
            return False
        return True

    def last_sweep(self, name: str) -> int | None:
        """The window one sweep last claimed, as its starting epoch second, or `None`."""
        item = self._repository.get({"ws_user": SWEEP_PARTITION, "notification_id": name})
        if item is None:
            return None
        return int(item["slot"])

    def delete(self, workspace_id: str, user_id: str, notification_id: str) -> bool:
        """Remove one notification, reporting whether one was there."""
        if self.get(workspace_id, user_id, notification_id) is None:
            return False
        self._repository.delete({"ws_user": inbox_partition(workspace_id, user_id), "notification_id": notification_id})
        return True


def _due_key(subject_id: str, due_at: datetime) -> str:
    """The sort key one subject's reminder for one due date is recorded under."""
    return f"{subject_id}#{instant(due_at)}"
