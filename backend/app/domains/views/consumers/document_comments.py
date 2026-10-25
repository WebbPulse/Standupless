"""Inbox rows for comments on documents, written off the `comments` stream by the notify consumer.

A document's thread reaches its subscribers, the authors up the thread being
replied to and anyone the comment mentions, never the commenter, as in Linear.
An edit reaches only the people it newly mentions. Every recipient must still be
able to read the document's parent, decided the way the document routes decide
it, and the rows land in the inbox only: a document comment is never mailed or
posted to chat.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from webbpulse.events import deserialize_image

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.documents import Document
from app.common.db.dynamo.inbox import DOCUMENT_COMMENTED, Notification, expires_at, inbox_partition, notification_id
from app.common.team_privacy import person_can_see_team


def _text(image: Mapping[str, Any], name: str) -> str:
    """One string attribute of a stream image, empty when absent."""
    value = image.get(name)
    return str(value) if value is not None else ""


def _mentions(image: Mapping[str, Any]) -> list[str]:
    """The user ids a stream image's `mentions` names."""
    return [str(user_id) for user_id in image.get("mentions") or [] if user_id]


def _stamped(image: Mapping[str, Any], name: str) -> datetime | None:
    """One timestamp attribute of a stream image, `None` when absent or unreadable."""
    raw = _text(image, name)
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def can_read_document(repositories: Repositories, document: Document, user_id: str) -> bool:
    """Whether one person may still read a document, judged against its parent without a request."""
    workspace_id = document.workspace_id
    membership = repositories.memberships.get(workspace_id, user_id) if user_id else None
    if membership is None:
        return False
    if document.parent_kind == "initiative":
        return membership.role != "guest"
    if document.parent_kind == "team":
        return person_can_see_team(repositories, workspace_id, document.parent_id, user_id)
    project = repositories.planning.get_project(workspace_id, document.parent_id)
    if project is None:
        return False
    return any(person_can_see_team(repositories, workspace_id, team_id, user_id) for team_id in project.team_ids)


def _write(
    repositories: Repositories,
    document: Document,
    *,
    recipient_id: str,
    comment_id: str,
    actor_id: str,
    actor_display: str,
    created_at: datetime | None,
    source_id: str,
    source: str | None,
) -> bool:
    """Write one inbox row about a document comment, when the recipient may read it and wants it."""
    if not recipient_id or recipient_id == actor_id:
        return False
    if not can_read_document(repositories, document, recipient_id):
        return False
    recipient = repositories.users.get(recipient_id)
    if recipient is not None and not recipient.wants_notification(DOCUMENT_COMMENTED, "in_app"):
        return False
    stamped = created_at if created_at is not None else datetime.now(timezone.utc)
    row = Notification(
        ws_user=inbox_partition(document.workspace_id, recipient_id),
        notification_id=notification_id(created_at, DOCUMENT_COMMENTED, recipient_id, source_id),
        workspace_id=document.workspace_id,
        kind=DOCUMENT_COMMENTED,
        team_id="",
        comment_id=comment_id,
        document_id=document.document_id,
        document_title=document.title,
        actor_id=actor_id,
        actor_name=actor_display,
        source=source,
        recipient_id=recipient_id,
        created_at=stamped,
        unread_at=stamped.isoformat(),
        expires_at=expires_at(stamped),
    )
    return repositories.inbox.create(row)


def _actor_name(repositories: Repositories, actor_id: str) -> str:
    """The name a row renders its actor with, denormalised so the inbox needs no read per row."""
    user = repositories.users.get(actor_id) if actor_id else None
    if user is None:
        return ""
    return user.display_name or user.email


def handle_document_comment(repositories: Repositories, record: Mapping[str, Any], *, limit: int) -> int:
    """Notify from one `comments` record on a document, answering how many rows were written.

    An insert reaches the mentioned, the authors up the thread and every
    subscriber. A modify that stamps a new `edited_at` reaches only the people the
    edit adds to the mentions, keyed by the edit time so a redelivery writes
    nothing new. At most `limit` people hear about one record.
    """
    event = str(record.get("eventName", "")).upper()
    new_image = deserialize_image(record, "NewImage")
    if not new_image or event not in ("INSERT", "MODIFY"):
        return 0
    workspace_id = _text(new_image, "workspace_id")
    document_id = _text(new_image, "document_id")
    comment_id = _text(new_image, "comment_id")
    if not workspace_id or not document_id or not comment_id:
        return 0
    found = repositories.documents.get(workspace_id, document_id)
    if found is None:
        return 0
    document = found[0]
    actor_id = _text(new_image, "author_id")

    if event == "MODIFY":
        old_image = deserialize_image(record, "OldImage") or {}
        edited_raw = _text(new_image, "edited_at")
        if not edited_raw or edited_raw == _text(old_image, "edited_at"):
            return 0
        before = set(_mentions(old_image))
        audience = [user_id for user_id in _mentions(new_image) if user_id not in before]
        created_at = _stamped(new_image, "edited_at")
        source_id = f"{comment_id}#edit#{edited_raw}"
    else:
        audience = list(_mentions(new_image))
        parent_id = _text(new_image, "parent_comment_id")
        if parent_id:
            parent = repositories.comments.get(workspace_id, document_id, parent_id)
            if parent is not None and parent.author_id:
                audience.append(parent.author_id)
        audience.extend(sorted(repositories.subscriptions.user_ids(workspace_id, document_id)))
        created_at = _stamped(new_image, "created_at")
        source_id = comment_id

    display = _actor_name(repositories, actor_id)
    recipients = [user_id for user_id in dict.fromkeys(audience) if user_id and user_id != actor_id][:limit]
    written = 0
    for recipient_id in recipients:
        written += int(
            _write(
                repositories,
                document,
                recipient_id=recipient_id,
                comment_id=comment_id,
                actor_id=actor_id,
                actor_display=display,
                created_at=created_at,
                source_id=source_id,
                source=_text(new_image, "source") or None,
            )
        )
    return written
