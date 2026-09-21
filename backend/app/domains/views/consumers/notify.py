"""The notify consumer: turns issue and comment stream records into inbox rows.

It reads two streams on one route, the `issues` table's and the `comments` table's,
and tells them apart by `eventSourceARN` rather than by guessing from the
attributes present, because a filtered record carries no marker of its own.

Every recipient is filtered through team visibility before a row is written, so
a guest who is no longer in a team stops receiving its notifications without
anything having to be cleaned up. A recipient with no membership is dropped
silently: a notification is not an authorization decision worth surfacing.

Idempotency is the notification id. It is derived from the record rather than
minted fresh, so a record redelivered by the event source mapping's partial-batch
retry writes the same key and the conditional put makes the second attempt a no-op
rather than a duplicate badge.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Mapping

from fastapi import APIRouter
from webbpulse.dynamodb import table_name
from webbpulse.events import deserialize_image, register_stream_consumer, source_table

from app.common.api.dependencies.repositories import Repositories, build_bundle
from app.common.core.config import settings
from app.common.db.dynamo.inbox import Notification, expires_at, inbox_partition
from app.common.email import deliver
from app.domains.views.email import render_notification

_log = logging.getLogger(__name__)

ASSIGNED = "assigned"

MENTIONED = "mentioned"

COMMENTED = "commented"

STATUS_CHANGED = "status_changed"

ANCESTOR_DEPTH = 16
"""How far up a comment thread an ancestor author is still notified.

A reply chain is one level deep by contract, so this only bounds a malformed or
future-deeper thread rather than cutting a legitimate one short.
"""

_ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

_ULID_TIME_CHARS = 10

_ULID_HASH_CHARS = 16


def _text(image: Mapping[str, Any], name: str) -> str:
    """One attribute of a stream image as a string, empty when absent or null."""
    value = image.get(name)
    return str(value).strip() if value is not None else ""


def _strings(image: Mapping[str, Any], name: str) -> list[str]:
    """One list-valued attribute of a stream image, as strings."""
    value = image.get(name)
    if not isinstance(value, (list, tuple, set)):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


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


def _stamped_at(image: Mapping[str, Any]) -> datetime | None:
    """When the record's own row says it changed, or `None` when it does not say.

    Read off the image rather than taken from the clock, because this is what the
    notification id's timestamp half is built from and a replay months later has to
    compute the id the first delivery did. `None` rather than a clock reading, so a
    caller cannot accidentally make an id that is stable only within one invocation.
    """
    for name in ("updated_at", "created_at"):
        raw = _text(image, name)
        if raw:
            try:
                parsed = datetime.fromisoformat(raw)
            except ValueError:
                continue
            return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)
    return None


def can_receive(repositories: Repositories, workspace_id: str, team_id: str, user_id: str) -> bool:
    """Whether one member may still see the team a notification is about.

    The same fail-closed shape the routes use, made here without a request: a
    workspace membership is required, and a guest additionally needs a membership in
    that team.
    """
    if not user_id or not workspace_id or not team_id:
        return False
    membership = repositories.memberships.get(workspace_id, user_id)
    if membership is None:
        return False
    if membership.role != "guest":
        return True
    return repositories.memberships.get_team_membership(workspace_id, team_id, user_id) is not None


def actor_name(repositories: Repositories, actor_id: str) -> str:
    """The display name a notification renders the actor with.

    Denormalised onto the row at write time, so the inbox renders without a read per
    notification and still renders after the account is gone.
    """
    if not actor_id:
        return ""
    user = repositories.users.get(actor_id)
    if user is None:
        return ""
    return user.display_name or user.email


def send_notification_email(
    repositories: Repositories,
    *,
    workspace_id: str,
    recipient_id: str,
    kind: str,
    issue: Any,
    actor_display: str,
    comment_excerpt: str,
) -> None:
    """Mail one notification that was just written, or quietly do nothing.

    Every reason not to send is ordinary: the recipient turned email off, their row
    or their address is gone, or this environment cannot reach the address. None of
    them is worth failing the record over, and the inbox row already carries the
    notification either way.
    """
    recipient = repositories.users.get(recipient_id)
    if recipient is None or not recipient.email_notifications or recipient.disabled:
        return

    workspace = repositories.workspaces.get(workspace_id)
    deliver(
        render_notification(
            kind=kind,
            to=str(recipient.email),
            actor_name=actor_display,
            issue_key=issue.key,
            issue_title=issue.title,
            workspace_slug=workspace.slug if workspace is not None else "",
            comment_excerpt=comment_excerpt,
        ),
        event=f"views.notify.email.{kind}",
    )


def write_notification(
    repositories: Repositories,
    *,
    workspace_id: str,
    recipient_id: str,
    kind: str,
    issue: Any,
    comment_id: str | None,
    actor_id: str,
    actor_display: str,
    created_at: datetime | None,
    source_id: str,
    comment_excerpt: str = "",
) -> bool:
    """Write one inbox row, unless the recipient is the actor or cannot see it.

    The row's own `created_at` falls back to the clock so the inbox renders a
    sensible time, while the id keeps the record's stamp alone, so a record carrying
    no timestamp is still written once rather than once per delivery.

    The email hangs off the conditional put answering true, not off reaching this
    function, which is what makes the mail as idempotent as the badge: a redelivered
    record writes no row and so sends no second copy.
    """
    if not recipient_id or recipient_id == actor_id:
        return False
    if not can_receive(repositories, workspace_id, issue.team_id, recipient_id):
        return False

    stamped = created_at if created_at is not None else datetime.now(timezone.utc)
    row = Notification(
        ws_user=inbox_partition(workspace_id, recipient_id),
        notification_id=notification_id(created_at, kind, recipient_id, source_id),
        workspace_id=workspace_id,
        kind=kind,
        issue_id=issue.issue_id,
        issue_key=issue.key,
        issue_title=issue.title,
        team_id=issue.team_id,
        comment_id=comment_id,
        actor_id=actor_id,
        actor_name=actor_display,
        recipient_id=recipient_id,
        created_at=stamped,
        unread_at=stamped.isoformat(),
        expires_at=expires_at(stamped),
    )
    if not repositories.inbox.create(row):
        return False

    send_notification_email(
        repositories,
        workspace_id=workspace_id,
        recipient_id=recipient_id,
        kind=kind,
        issue=issue,
        actor_display=actor_display,
        comment_excerpt=comment_excerpt,
    )
    return True


def handle_issue_record(repositories: Repositories, record: Mapping[str, Any]) -> int:
    """Notify from one `issues` record, answering how many rows were written.

    An assignment notifies only the new assignee, never the one it moved away from:
    losing an issue is not news the contract sends.
    """
    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    if not new_image:
        return 0

    workspace_id = _text(new_image, "workspace_id")
    issue_id = _text(new_image, "issue_id")
    if not workspace_id or not issue_id:
        return 0

    issue = repositories.issues.get(workspace_id, issue_id)
    if issue is None:
        return 0

    actor_id = _text(new_image, "updated_by") or _text(new_image, "created_by")
    display = actor_name(repositories, actor_id)
    created_at = _stamped_at(new_image)

    new_assignee = _text(new_image, "assignee_id")
    old_assignee = _text(old_image, "assignee_id")
    written = 0

    if new_assignee and new_assignee != old_assignee:
        written += int(
            write_notification(
                repositories,
                workspace_id=workspace_id,
                recipient_id=new_assignee,
                kind=ASSIGNED,
                issue=issue,
                comment_id=None,
                actor_id=actor_id,
                actor_display=display,
                created_at=created_at,
                source_id=f"{issue_id}#assignee#{new_assignee}",
            )
        )

    new_status = _text(new_image, "status_id")
    old_status = _text(old_image, "status_id")
    if old_image and new_status and new_status != old_status and new_assignee:
        written += int(
            write_notification(
                repositories,
                workspace_id=workspace_id,
                recipient_id=new_assignee,
                kind=STATUS_CHANGED,
                issue=issue,
                comment_id=None,
                actor_id=actor_id,
                actor_display=display,
                created_at=created_at,
                source_id=f"{issue_id}#status#{new_status}",
            )
        )

    return written


def handle_comment_record(repositories: Repositories, record: Mapping[str, Any]) -> int:
    """Notify from one `comments` record, answering how many rows were written.

    A member who would earn both a mention and a comment notification gets only the
    mention, which is the stronger signal, so the mentions are written first and the
    commented set has them removed.

    The thread is walked from the record's own `parent_comment_id` rather than from
    the new comment's id. The record is the comment's insert, so at this point the
    row may not be readable yet, and walking from it would find no ancestors and
    quietly notify nobody who was being replied to.
    """
    if str(record.get("eventName", "")).upper() != "INSERT":
        return 0

    new_image = deserialize_image(record, "NewImage")
    if not new_image:
        return 0

    workspace_id = _text(new_image, "workspace_id")
    issue_id = _text(new_image, "issue_id")
    comment_id = _text(new_image, "comment_id")
    if not workspace_id or not issue_id or not comment_id:
        return 0

    issue = repositories.issues.get(workspace_id, issue_id)
    if issue is None:
        return 0

    actor_id = _text(new_image, "author_id") or _text(new_image, "created_by")
    display = actor_name(repositories, actor_id)
    created_at = _stamped_at(new_image)

    body = _text(new_image, "body")

    mentioned = {user_id for user_id in _strings(new_image, "mentions") if user_id}

    commented: set[str] = set()
    assignee = issue.assignee_id or ""
    if assignee:
        commented.add(assignee)

    parent_id = _text(new_image, "parent_comment_id")
    if parent_id:
        parent = repositories.comments.get(workspace_id, issue_id, parent_id)
        if parent is not None:
            if parent.author_id:
                commented.add(parent.author_id)
            for ancestor in repositories.comments.ancestors(workspace_id, issue_id, parent_id, depth=ANCESTOR_DEPTH):
                if ancestor.author_id:
                    commented.add(ancestor.author_id)
    commented -= mentioned

    written = 0
    for recipient_id in sorted(mentioned):
        written += int(
            write_notification(
                repositories,
                workspace_id=workspace_id,
                recipient_id=recipient_id,
                kind=MENTIONED,
                issue=issue,
                comment_id=comment_id,
                actor_id=actor_id,
                actor_display=display,
                created_at=created_at,
                source_id=comment_id,
                comment_excerpt=body,
            )
        )
    for recipient_id in sorted(commented):
        written += int(
            write_notification(
                repositories,
                workspace_id=workspace_id,
                recipient_id=recipient_id,
                kind=COMMENTED,
                issue=issue,
                comment_id=comment_id,
                actor_id=actor_id,
                actor_display=display,
                created_at=created_at,
                source_id=comment_id,
                comment_excerpt=body,
            )
        )
    return written


def handle_record(repositories: Repositories, record: Mapping[str, Any]) -> None:
    """Route one record to the handler for the table it came from.

    A record whose ARN names neither table is ignored rather than raised on: a
    mapping pointed at a third stream is a deployment mistake, and failing every
    such record would retry it until the stream aged out.
    """
    physical = source_table(record)
    prefix = settings.dynamodb_table_prefix

    if physical == table_name("issues", prefix):
        written = handle_issue_record(repositories, record)
    elif physical == table_name("comments", prefix):
        written = handle_comment_record(repositories, record)
    else:
        _log.warning(
            "Ignored a stream record from an unexpected table.",
            extra={"event": "views.notify.unknown_source", "table": physical},
        )
        return

    if written:
        _log.info(
            "Wrote notifications.",
            extra={"event": "views.notify", "table": physical, "written": written},
        )


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """The notify consumer's router, mounted at the root with no API prefix.

    Unprefixed because the Lambda Web Adapter posts the invocation to its own
    pass-through path, which is not under `/api`. The bundle is closed over rather
    than taken as a dependency, because the route is registered by the shared
    package and its signature is not this domain's to extend; passing one in is what
    lets a test drive the consumer against moto's tables.
    """
    from app.common.composition.domains import DOMAINS

    bundle = repositories if repositories is not None else build_bundle(DOMAINS["views"].all_repositories, name="views")
    router = APIRouter()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against this domain's bundle."""
        handle_record(bundle, record)

    register_stream_consumer(router, consume, log_event="views.notify.batch")
    return router
