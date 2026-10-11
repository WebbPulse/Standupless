"""The notify consumer: turns issue, comment, subscription and project update stream records into inbox rows.

It reads four streams on one route, the `issues` table's, the `comments` table's,
the `subscriptions` table's, filtered to inserted rows one member made for
another, and the `planning` table's, filtered to inserted project updates, and
tells them apart by `eventSourceARN` rather than by guessing from the attributes present,
because a filtered record carries no marker of its own.

A project has no subscriptions of its own, so a project update reaches the
project's lead and members, never its author.

Who hears about an issue is its subscribers, as in Linear: a comment or a status
change reaches everyone following the issue except the person who made it, while
an assignment and a mention go to the one person they name. Subscriptions are
written by the domains that own the writes, so this consumer only reads them.

Every recipient is filtered through team visibility before a row is written, so
a guest who is no longer in a team stops receiving its notifications without
anything having to be cleaned up. A recipient with no membership is dropped
silently: a notification is not an authorization decision worth surfacing. Each
recipient's own per kind preferences then decide whether the row lands unread in
the inbox, whether it is mailed, or both.

The inbox row is written at once. The email is held as a digest entry and mailed
by the flush in `digest`, one message per recipient per five minute window, so a
burst of activity on an issue becomes one email rather than one per change. The
flush rides this consumer's own function, triggered by a scheduled synthetic
record. One record reaches at most `MAX_RECIPIENTS_PER_EVENT` people.

Idempotency is the notification id. It is derived from the record rather than
minted fresh, so a record redelivered by the event source mapping's partial-batch
retry writes the same key and the conditional put makes the second attempt a no-op
rather than a duplicate badge.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Mapping

from fastapi import APIRouter
from webbpulse.dynamodb import table_name
from webbpulse.events import deserialize_image, register_stream_consumer, source_table

from app.common.api.dependencies.repositories import Repositories
from app.common.bulk_import import from_bulk_import
from app.common.composition.consumers import CONSUMERS
from app.common.core.config import settings
from app.common.db.dynamo.inbox import Notification, expires_at, inbox_partition, notification_id
from app.common.db.dynamo.notify_digests import DigestEntry
from app.common.db.dynamo.planning import PROJECT_UPDATE, Project
from app.common.issue_keys import display_key
from app.common.team_privacy import person_can_see_team
from app.domains.views.consumers.digest import flush_due, is_digest_flush
from app.domains.views.email import excerpt

_log = logging.getLogger(__name__)

_GRANT = CONSUMERS["views-notify-consumer"]
"""The tables this consumer's function is granted, which every record is handled within."""

ASSIGNED = "assigned"

MENTIONED = "mentioned"

COMMENTED = "commented"

STATUS_CHANGED = "status_changed"

SUBSCRIBED = "subscribed"

PROJECT_UPDATED = "project_update"

ANCESTOR_DEPTH = 16
"""How far up a comment thread an ancestor author is still notified.

A reply chain is one level deep by contract, so this only bounds a malformed or
future-deeper thread rather than cutting a legitimate one short.
"""

MAX_RECIPIENTS_PER_EVENT = 100
"""The most people one stream record notifies.

Each recipient costs three reads and a conditional put, and possibly an email,
so without a bound a bulk edit of an issue with a large following fans out
without limit. Direct recipients come first: the assignee and the people named
in a mention or replied to, then subscribers in id order. Whoever falls past the
cap gets neither an inbox row nor an email for that record, and the overflow is
logged as `views.notify.recipients_capped` with the number dropped.
"""


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
    workspace membership is required, and a guest or anyone on a private team
    additionally needs a membership in that team.
    """
    return person_can_see_team(repositories, workspace_id, team_id, user_id)


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


def cap_recipients(recipients: list[str], *, workspace_id: str, source: str) -> list[str]:
    """The first `MAX_RECIPIENTS_PER_EVENT` of an ordered audience, logging any overflow."""
    if len(recipients) <= MAX_RECIPIENTS_PER_EVENT:
        return recipients
    _log.warning(
        "Capped the recipients of one notification event.",
        extra={
            "event": "views.notify.recipients_capped",
            "workspace_id": workspace_id,
            "source": source,
            "recipients": len(recipients),
            "dropped": len(recipients) - MAX_RECIPIENTS_PER_EVENT,
        },
    )
    return recipients[:MAX_RECIPIENTS_PER_EVENT]


def hold_for_digest(repositories: Repositories, row: Notification, **fields: Any) -> None:
    """Hold the email for one inbox row that was just written until its digest is flushed.

    Everything the email line needs is captured off the row now, so the flush reads
    only the recipient and the workspace.
    """
    repositories.inbox.digests.add(
        DigestEntry(
            workspace_id=row.workspace_id,
            recipient_id=row.recipient_id,
            notification_id=row.notification_id,
            kind=row.kind,
            team_id=row.team_id,
            actor_name=row.actor_name,
            issue_id=row.issue_id,
            issue_key=row.issue_key,
            issue_title=row.issue_title,
            project_id=row.project_id or "",
            project_name=row.project_name or "",
            created_at=row.created_at,
            **fields,
        )
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
    headline_key: str | None = None,
    source: str | None = None,
) -> bool:
    """Write one inbox row, unless the recipient is the actor or cannot see it.

    The recipient's preferences for this kind decide the rest. With the inbox off
    the row is still written but already read, so it never raises the badge and
    still guards the email against a redelivery; with both channels off nothing is
    written at all.

    The row's own `created_at` falls back to the clock so the inbox renders a
    sensible time, while the id keeps the record's stamp alone, so a record carrying
    no timestamp is still written once rather than once per delivery.

    The email hangs off the conditional put answering true, not off reaching this
    function, which is what makes the mail as idempotent as the badge: a redelivered
    record writes no row and so holds no second copy. It is held for the recipient's
    next digest rather than sent here, so a burst of activity becomes one email.
    """
    if not recipient_id or recipient_id == actor_id:
        return False
    if not can_receive(repositories, workspace_id, issue.team_id, recipient_id):
        return False
    recipient = repositories.users.get(recipient_id)
    in_app = recipient.wants_notification(kind, "in_app") if recipient is not None else True
    email = recipient is not None and recipient.wants_notification(kind, "email")
    if not in_app and not email:
        return False

    stamped = created_at if created_at is not None else datetime.now(timezone.utc)
    row = Notification(
        ws_user=inbox_partition(workspace_id, recipient_id),
        notification_id=notification_id(created_at, kind, recipient_id, source_id),
        workspace_id=workspace_id,
        kind=kind,
        issue_id=issue.issue_id,
        issue_key=display_key(repositories.teams, workspace_id, issue.team_id, issue.key),
        issue_title=issue.title,
        team_id=issue.team_id,
        comment_id=comment_id,
        actor_id=actor_id,
        actor_name=actor_display,
        source=source,
        recipient_id=recipient_id,
        created_at=stamped,
        unread_at=stamped.isoformat() if in_app else None,
        expires_at=expires_at(stamped),
    )
    if not repositories.inbox.create(row):
        return False

    if email:
        hold_for_digest(repositories, row, headline_key=headline_key, excerpt=excerpt(comment_excerpt))
    return True


def handle_issue_record(repositories: Repositories, record: Mapping[str, Any]) -> int:
    """Notify from one `issues` record, answering how many rows were written.

    An assignment notifies only the new assignee, never the one it moved away from:
    losing an issue is not news the contract sends. A description mention notifies
    only the people the description names now and did not before, so editing a
    description that already mentions someone does not ping them again. A status
    change reaches every subscriber and the assignee. Nobody hears about the same
    record twice, so a person assigned and mentioned in one write gets the
    assignment alone.

    The actor is `updated_by`, or on an insert the creator. A modify without an
    `updated_by`, such as a GitHub transition, has no human actor to leave out.
    A row a bulk import wrote notifies nobody.
    """
    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    if not new_image or from_bulk_import(record):
        return 0

    workspace_id = _text(new_image, "workspace_id")
    issue_id = _text(new_image, "issue_id")
    if not workspace_id or not issue_id:
        return 0

    issue = repositories.issues.get(workspace_id, issue_id)
    if issue is None:
        return 0

    actor_id = _text(new_image, "updated_by") or ("" if old_image else _text(new_image, "created_by"))
    display = actor_name(repositories, actor_id)
    created_at = _stamped_at(new_image)

    new_assignee = _text(new_image, "assignee_id")
    old_assignee = _text(old_image, "assignee_id")
    planned: dict[str, tuple[str, str, dict[str, Any]]] = {}

    def plan(recipient_id: str, kind: str, source_id: str, **extra: Any) -> None:
        """Queue one notification for this record, keeping the first kind a person earns."""
        if recipient_id and recipient_id != actor_id and recipient_id not in planned:
            planned[recipient_id] = (kind, source_id, extra)

    if new_assignee and new_assignee != old_assignee:
        plan(new_assignee, ASSIGNED, f"{issue_id}#assignee#{new_assignee}")

    previously_mentioned = set(_strings(old_image, "mentioned_user_ids"))
    for user_id in _strings(new_image, "mentioned_user_ids"):
        if user_id not in previously_mentioned:
            plan(
                user_id,
                MENTIONED,
                f"{issue_id}#mention#{user_id}",
                comment_excerpt=_text(new_image, "body"),
                headline_key="mentioned_in_description",
            )

    new_status = _text(new_image, "status_id")
    old_status = _text(old_image, "status_id")
    if old_image and new_status and new_status != old_status:
        if new_assignee:
            plan(new_assignee, STATUS_CHANGED, f"{issue_id}#status#{new_status}")
        for recipient_id in sorted(set(repositories.subscriptions.user_ids(workspace_id, issue_id))):
            plan(recipient_id, STATUS_CHANGED, f"{issue_id}#status#{new_status}")

    written = 0
    for recipient_id in cap_recipients(list(planned), workspace_id=workspace_id, source=f"issue#{issue_id}"):
        kind, source_id, extra = planned[recipient_id]
        written += int(
            write_notification(
                repositories,
                workspace_id=workspace_id,
                recipient_id=recipient_id,
                kind=kind,
                issue=issue,
                comment_id=None,
                actor_id=actor_id,
                actor_display=display,
                created_at=created_at,
                source_id=source_id,
                source=_text(new_image, "updated_source") or None,
                **extra,
            )
        )
    return written


def handle_comment_record(repositories: Repositories, record: Mapping[str, Any]) -> int:
    """Notify from one `comments` record, answering how many rows were written.

    A comment reaches every subscriber of the issue, its assignee and the authors
    up the thread it replies to, never the commenter themselves. A member who would
    earn both a mention and a comment notification gets only the mention, which is
    the stronger signal, so the mentions are written first and the commented set has
    them removed.

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

    direct: set[str] = set()
    assignee = issue.assignee_id or ""
    if assignee:
        direct.add(assignee)

    parent_id = _text(new_image, "parent_comment_id")
    if parent_id:
        parent = repositories.comments.get(workspace_id, issue_id, parent_id)
        if parent is not None:
            if parent.author_id:
                direct.add(parent.author_id)
            for ancestor in repositories.comments.ancestors(workspace_id, issue_id, parent_id, depth=ANCESTOR_DEPTH):
                if ancestor.author_id:
                    direct.add(ancestor.author_id)
    direct -= mentioned
    subscribers = set(repositories.subscriptions.user_ids(workspace_id, issue_id)) - mentioned - direct

    ordered = [
        *((user_id, MENTIONED) for user_id in sorted(mentioned)),
        *((user_id, COMMENTED) for user_id in sorted(direct)),
        *((user_id, COMMENTED) for user_id in sorted(subscribers)),
    ]
    kinds = {user_id: kind for user_id, kind in ordered if user_id and user_id != actor_id}

    written = 0
    for recipient_id in cap_recipients(list(kinds), workspace_id=workspace_id, source=f"comment#{comment_id}"):
        written += int(
            write_notification(
                repositories,
                workspace_id=workspace_id,
                recipient_id=recipient_id,
                kind=kinds[recipient_id],
                issue=issue,
                comment_id=comment_id,
                actor_id=actor_id,
                actor_display=display,
                created_at=created_at,
                source_id=comment_id,
                comment_excerpt=body,
                source=_text(new_image, "source") or None,
            )
        )
    return written


def handle_subscription_record(repositories: Repositories, record: Mapping[str, Any]) -> int:
    """Notify from one `subscriptions` record, answering how many rows were written.

    Only an insert carrying `added_by` notifies, which is a member subscribing
    someone else: the person subscribed hears who added them. A row someone made
    for themselves, or one an automatic subscription wrote, carries no `added_by`
    and is skipped, as is any removal.
    """
    if str(record.get("eventName", "")).upper() != "INSERT":
        return 0
    new_image = deserialize_image(record, "NewImage")
    if not new_image:
        return 0

    workspace_id = _text(new_image, "workspace_id")
    issue_id = _text(new_image, "issue_id")
    recipient_id = _text(new_image, "user_id")
    actor_id = _text(new_image, "added_by")
    if not workspace_id or not issue_id or not recipient_id or not actor_id:
        return 0

    issue = repositories.issues.get(workspace_id, issue_id)
    if issue is None:
        return 0

    return int(
        write_notification(
            repositories,
            workspace_id=workspace_id,
            recipient_id=recipient_id,
            kind=SUBSCRIBED,
            issue=issue,
            comment_id=None,
            actor_id=actor_id,
            actor_display=actor_name(repositories, actor_id),
            created_at=_stamped_at(new_image),
            source_id=f"{issue_id}#subscribed#{recipient_id}",
        )
    )


def receiving_team(repositories: Repositories, project: Project, user_id: str) -> str:
    """The first of a project's teams one member can see, or empty when they see none."""
    for team_id in project.team_ids:
        if can_receive(repositories, project.workspace_id, team_id, user_id):
            return team_id
    return ""


def write_project_update_notification(
    repositories: Repositories,
    *,
    project: Project,
    recipient_id: str,
    update_id: str,
    health: str,
    body: str,
    actor_id: str,
    actor_display: str,
    created_at: datetime | None,
    source: str | None = None,
) -> bool:
    """Write one project update inbox row, and mail it, under the same rules an issue row follows.

    The recipient must still see at least one of the project's teams, and that
    team is the one the row carries, so the inbox's visibility checks read it as
    they read an issue's team.
    """
    if not recipient_id or recipient_id == actor_id:
        return False
    team_id = receiving_team(repositories, project, recipient_id)
    if not team_id:
        return False
    recipient = repositories.users.get(recipient_id)
    in_app = recipient.wants_notification(PROJECT_UPDATED, "in_app") if recipient is not None else True
    email = recipient is not None and recipient.wants_notification(PROJECT_UPDATED, "email")
    if not in_app and not email:
        return False

    stamped = created_at if created_at is not None else datetime.now(timezone.utc)
    row = Notification(
        ws_user=inbox_partition(project.workspace_id, recipient_id),
        notification_id=notification_id(created_at, PROJECT_UPDATED, recipient_id, update_id),
        workspace_id=project.workspace_id,
        kind=PROJECT_UPDATED,
        team_id=team_id,
        project_id=project.project_id,
        project_name=project.name,
        project_update_id=update_id,
        actor_id=actor_id,
        actor_name=actor_display,
        source=source,
        recipient_id=recipient_id,
        created_at=stamped,
        unread_at=stamped.isoformat() if in_app else None,
        expires_at=expires_at(stamped),
    )
    if not repositories.inbox.create(row):
        return False

    if email:
        hold_for_digest(repositories, row, health=health, excerpt=excerpt(body))
    return True


def handle_planning_record(repositories: Repositories, record: Mapping[str, Any]) -> int:
    """Notify from one `planning` record, answering how many rows were written.

    Only a newly posted project update is news. It reaches the project's lead and
    members, each once, except its author; an edit or a delete notifies nobody.
    """
    if str(record.get("eventName", "")).upper() != "INSERT":
        return 0
    new_image = deserialize_image(record, "NewImage")
    if not new_image or _text(new_image, "kind") != PROJECT_UPDATE:
        return 0

    workspace_id = _text(new_image, "workspace_id")
    project_id = _text(new_image, "project_id")
    update_id = _text(new_image, "update_id")
    if not workspace_id or not project_id or not update_id:
        return 0

    project = repositories.planning.get_project(workspace_id, project_id)
    if project is None:
        return 0

    actor_id = _text(new_image, "author_id")
    display = actor_name(repositories, actor_id)
    created_at = _stamped_at(new_image)
    audience = [user_id for user_id in dict.fromkeys([project.lead_id or "", *project.member_ids]) if user_id]
    written = 0
    for recipient_id in cap_recipients(
        [user_id for user_id in audience if user_id != actor_id],
        workspace_id=workspace_id,
        source=f"project_update#{update_id}",
    ):
        written += int(
            write_project_update_notification(
                repositories,
                project=project,
                recipient_id=recipient_id,
                update_id=update_id,
                health=_text(new_image, "health"),
                body=_text(new_image, "body"),
                actor_id=actor_id,
                actor_display=display,
                created_at=created_at,
                source=_text(new_image, "source") or None,
            )
        )
    return written


def handle_record(repositories: Repositories, record: Mapping[str, Any]) -> None:
    """Route one record to the handler for the table it came from.

    The digest flush schedule's synthetic record runs the flush, the project
    update reminder sweep every quarter hour, the standup digest sweep every five
    minutes and the issue due date sweep every hour, and nothing else. Each sweep
    runs on the first tick of its window, so a late tick does not skip a pass. The sweeps
    are imported here rather than at the top because they build on this module's
    writers.

    A record whose ARN names none of the four tables is ignored rather than raised on: a
    mapping pointed at a third stream is a deployment mistake, and failing every
    such record would retry it until the stream aged out.
    """
    repositories = _GRANT.narrow(repositories)
    if is_digest_flush(record):
        flush_due(repositories)
        from app.domains.views.consumers import due_reminders, standups
        from app.domains.views.consumers.project_reminders import run_reminders, sweep_due

        now = datetime.now(timezone.utc)
        if sweep_due(repositories, now):
            run_reminders(repositories, now)
        if standups.sweep_due(repositories, now):
            standups.run_standups(repositories, now)
        if due_reminders.sweep_due(repositories, now):
            due_reminders.run_due_reminders(repositories, now)
        return

    physical = source_table(record)
    prefix = settings.dynamodb_table_prefix

    if physical == table_name("issues", prefix):
        written = handle_issue_record(repositories, record)
    elif physical == table_name("comments", prefix):
        written = handle_comment_record(repositories, record)
    elif physical == table_name("subscriptions", prefix):
        written = handle_subscription_record(repositories, record)
    elif physical == table_name("planning", prefix):
        written = handle_planning_record(repositories, record)
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
    bundle = repositories if repositories is not None else _GRANT.bundle()
    router = APIRouter()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against this domain's bundle."""
        handle_record(bundle, record)

    register_stream_consumer(router, consume, log_event="views.notify.batch")
    return router
