"""Native push: who hears about an inbox row on their phone, and what the app icon says.

Everything hangs off an inbox row that was just written, so a redelivered record
writes no row and sends nothing twice. The person's per kind `push` switch, a pause
and their working hours decide whether an alert shows; while any of them says no the
badge still moves and nothing appears, as the desktop app does. A held alert is not
sent later, because the inbox already holds it and the badge already counts it.

The badge is the server's number on every device, summed over the workspaces opened
on it, and each workspace counts as its sidebar badge does: unread rows, or the
Priority tab alone while the priority inbox is on. A snoozed row is not unread until
its time comes, and nothing runs at that moment, so it raises the badge at the next
send rather than on the dot.

Nothing here may fail the work that called it, so every entry point swallows and
logs, and the log carries no token.
"""

from __future__ import annotations

import logging
from urllib.parse import quote

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.inbox import Notification
from app.common.db.dynamo.push_devices import PushDevice
from app.common.db.dynamo.users import User
from app.common.inbox import INBOX_KINDS
from app.common.inbox_summary import notification_summary
from app.common.notification_pause import bypasses_hold, held_until
from app.common.push_senders import PushAlert, PushMessage, PushOutcome, sender_for

_log = logging.getLogger(__name__)

TITLE_LIMIT = 120
"""The most title text an alert carries, which keeps a long issue title inside Apple's payload limit."""

BODY_LIMIT = 240
"""The most body text an alert carries."""


def _clip(text: str, limit: int) -> str:
    """`text` shortened to `limit` characters."""
    return text if len(text) <= limit else f"{text[: limit - 3].rstrip()}..."


def wants_push(repositories: Repositories, recipient: User | None, kind: str) -> bool:
    """Whether this person could get an alert for one kind: the switch is on and a device is registered."""
    if recipient is None or not recipient.wants_notification(kind, "push"):
        return False
    try:
        return bool(repositories.inbox.push_devices.for_user(recipient.id))
    except Exception as exc:
        _log.warning("Could not read push devices", extra={"error_type": type(exc).__name__})
        return False


def _workspace_badge(repositories: Repositories, workspace_id: str, user: User) -> int:
    """One workspace's contribution to the badge, the number its sidebar shows."""
    if not user.priority_inbox:
        return repositories.inbox.unread_count(workspace_id, user.id)
    priority = frozenset(kind for kind in INBOX_KINDS if user.is_priority(kind))
    return repositories.inbox.split_unread_counts(workspace_id, user.id, lambda kind: kind in priority)[0]


def _badge(repositories: Repositories, device: PushDevice, user: User, counts: dict[str, int]) -> int:
    """One device's badge, reading each workspace at most once across a person's devices."""
    total = 0
    for workspace_id in device.workspace_ids:
        if workspace_id not in counts:
            counts[workspace_id] = _workspace_badge(repositories, workspace_id, user)
        total += counts[workspace_id]
    return total


def _alert(repositories: Repositories, row: Notification) -> PushAlert:
    """What a row shows, and the page a tap opens: its issue, else the row in the inbox."""
    workspace = repositories.workspaces.get(row.workspace_id)
    slug = quote(workspace.slug, safe="") if workspace is not None else ""
    if row.issue_id and row.issue_key:
        path = f"/w/{slug}/issues/{quote(row.issue_key, safe='')}"
    else:
        path = f"/w/{slug}/inbox?n={quote(row.notification_id, safe='')}"
    subject = row.project_name or (f"{row.issue_key} {row.issue_title}".strip()) or settings.PROJECT_NAME
    return PushAlert(
        title=_clip(subject, TITLE_LIMIT),
        body=_clip(notification_summary(row), BODY_LIMIT),
        path=path if slug else "/",
        collapse_id=row.notification_id,
        thread_id=row.issue_id or row.workspace_id,
    )


def _send(repositories: Repositories, device: PushDevice, message: PushMessage) -> None:
    """Send to one device, and remove it when the provider says its token is finished."""
    sender = sender_for(device.platform)
    if sender is None:
        return
    if sender.send(device.token, message) is PushOutcome.GONE:
        repositories.inbox.push_devices.remove(device.user_id, device.device_id)


def _deliver(repositories: Repositories, row: Notification, recipient: User | None, urgent: bool) -> None:
    """Send one row to each of its recipient's devices, as an alert or as a badge alone."""
    user = recipient if recipient is not None else repositories.users.get(row.recipient_id)
    if user is None or user.disabled:
        return
    devices = repositories.inbox.push_devices.for_user(user.id)
    if not devices:
        return
    held = held_until(user) is not None and not bypasses_hold(user, row.kind, urgent)
    shows = user.wants_notification(row.kind, "push") and not held
    if not shows and row.unread_at is None:
        return
    alert = _alert(repositories, row) if shows else None
    counts: dict[str, int] = {}
    for device in devices:
        known = repositories.inbox.push_devices.add_workspace(device, row.workspace_id)
        _send(repositories, known, PushMessage(badge=_badge(repositories, known, user, counts), alert=alert))


def deliver_push(
    repositories: Repositories, row: Notification, *, recipient: User | None = None, urgent: bool = False
) -> None:
    """Push one inbox row that was just written. `recipient` saves a read when the caller has the row."""
    try:
        _deliver(repositories, row, recipient, urgent)
    except Exception as exc:
        _log.warning("Could not push a notification", extra={"error_type": type(exc).__name__})


def drop_push_device(repositories: Repositories, user_id: str, device_id: str) -> None:
    """Zero a phone's badge and remove it, so a person signing out leaves no count behind.

    Only the caller's own devices can match. The removal still happens when the send
    fails, because a stale badge matters far less than a phone that keeps hearing.
    """
    store = repositories.inbox.push_devices
    try:
        for device in store.for_user(user_id):
            if device.device_id == device_id:
                _send(repositories, device, PushMessage(badge=0))
    except Exception as exc:
        _log.warning("Could not clear the push badge", extra={"error_type": type(exc).__name__})
    store.remove(user_id, device_id)


def sync_push_badge(repositories: Repositories, user_id: str) -> None:
    """Set the badge on a person's devices after their inbox changed, showing nothing.

    Reading on any device clears the icon on all of them. It costs one read for
    someone with no device, which is everyone outside the mobile app.
    """
    try:
        devices = repositories.inbox.push_devices.for_user(user_id)
        if not devices:
            return
        user = repositories.users.get(user_id)
        if user is None:
            return
        counts: dict[str, int] = {}
        for device in devices:
            _send(repositories, device, PushMessage(badge=_badge(repositories, device, user, counts)))
    except Exception as exc:
        _log.warning("Could not sync the push badge", extra={"error_type": type(exc).__name__})
