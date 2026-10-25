"""Inbox rows for replies on initiative updates, written off the `planning` stream by the notify consumer.

The audience follows the project update rule, widened by the initiative's owner:
the update's author, the owner, everyone who replied before and anyone the reply
mentions, never the replier. Each recipient must still be able to read the
initiative. The row reuses the project update reply kind, so one preference
covers replies on both, and carries the initiative fields with an empty team, as
an initiative update reminder does. It lands in the inbox only, never in mail
or chat.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.inbox import (
    PROJECT_UPDATE_REPLIED,
    Notification,
    expires_at,
    inbox_partition,
    notification_id,
)
from app.common.db.dynamo.planning import Initiative
from app.common.team_privacy import person_can_see_initiative


def _text(image: Mapping[str, Any], name: str) -> str:
    """One string attribute of a stream image, empty when absent."""
    value = image.get(name)
    return str(value).strip() if value is not None else ""


def _stamped(image: Mapping[str, Any]) -> datetime | None:
    """When the reply was written, read off its row so a replayed record makes the same id."""
    raw = _text(image, "created_at")
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _actor_name(repositories: Repositories, actor_id: str) -> str:
    """The display name the row renders the replier with, denormalised at write time."""
    user = repositories.users.get(actor_id) if actor_id else None
    if user is None:
        return ""
    return user.display_name or user.email


def write_initiative_reply_notification(
    repositories: Repositories,
    *,
    initiative: Initiative,
    recipient_id: str,
    update_id: str,
    comment_id: str,
    actor_id: str,
    actor_display: str,
    created_at: datetime | None,
    source: str | None,
) -> bool:
    """Write one inbox row for a reply on an initiative update, when the recipient may read it and wants it."""
    if not recipient_id or recipient_id == actor_id:
        return False
    if not person_can_see_initiative(repositories, initiative, recipient_id):
        return False
    recipient = repositories.users.get(recipient_id)
    if recipient is not None and not recipient.wants_notification(PROJECT_UPDATE_REPLIED, "in_app"):
        return False
    stamped = created_at if created_at is not None else datetime.now(timezone.utc)
    row = Notification(
        ws_user=inbox_partition(initiative.workspace_id, recipient_id),
        notification_id=notification_id(created_at, PROJECT_UPDATE_REPLIED, recipient_id, comment_id),
        workspace_id=initiative.workspace_id,
        kind=PROJECT_UPDATE_REPLIED,
        team_id="",
        comment_id=comment_id,
        initiative_id=initiative.initiative_id,
        initiative_name=initiative.name,
        project_update_id=update_id,
        actor_id=actor_id,
        actor_name=actor_display,
        source=source,
        recipient_id=recipient_id,
        created_at=stamped,
        unread_at=stamped.isoformat(),
        expires_at=expires_at(stamped),
    )
    return repositories.inbox.create(row)


def handle_initiative_update_reply(repositories: Repositories, new_image: Mapping[str, Any], *, limit: int) -> int:
    """Notify from one new reply on an initiative update, answering how many rows were written."""
    workspace_id = _text(new_image, "workspace_id")
    initiative_id = _text(new_image, "initiative_id")
    update_id = _text(new_image, "update_id")
    comment_id = _text(new_image, "comment_id")
    if not workspace_id or not initiative_id or not update_id or not comment_id:
        return 0
    initiative = repositories.planning.get_initiative(workspace_id, initiative_id)
    update = repositories.planning.get_initiative_update(workspace_id, initiative_id, update_id)
    if initiative is None or update is None:
        return 0

    actor_id = _text(new_image, "author_id")
    thread = repositories.planning.initiative_update_threads.read(workspace_id, initiative_id, update_id)
    mentions = [str(user_id) for user_id in new_image.get("mentions") or [] if user_id]
    audience = dict.fromkeys(
        [
            update.author_id,
            initiative.owner_id or "",
            *(comment.author_id for comment in thread.comments),
            *mentions,
        ]
    )
    recipients = [user_id for user_id in audience if user_id and user_id != actor_id][:limit]
    display = _actor_name(repositories, actor_id)
    created_at = _stamped(new_image)
    return sum(
        int(
            write_initiative_reply_notification(
                repositories,
                initiative=initiative,
                recipient_id=recipient_id,
                update_id=update_id,
                comment_id=comment_id,
                actor_id=actor_id,
                actor_display=display,
                created_at=created_at,
                source=_text(new_image, "source") or None,
            )
        )
        for recipient_id in recipients
    )
