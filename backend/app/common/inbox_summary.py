"""The one line an inbox row reads, built from the stored row with no model call.

Kept apart from the schemas so both the API shape and any digest can share it
without importing each other. The text names who acted and, where the row knows
it, what the subject became, and falls back to a plain label when a row predates
the field or the actor is unknown.
"""

from __future__ import annotations

from typing import Callable, Optional

from app.common.db.dynamo.inbox import Notification

_FIXED: dict[str, str] = {
    "project_update_due": "Update due",
    "due_soon": "Due soon",
    "overdue": "Overdue",
    "standup_digest": "Standup ready",
    "sla_at_risk": "SLA at risk",
    "sla_breached": "SLA breached",
    "reminder": "Reminder",
    "triage_new": "New in triage",
    "channel_disabled": "Channel turned off",
    "export_ready": "Export ready",
    "export_failed": "Export failed",
    "import_ready": "Import finished",
    "import_failed": "Import failed",
}

_ACTED: dict[str, tuple[str, str]] = {
    "assigned": ("{actor} assigned you", "Assigned to you"),
    "mentioned": ("{actor} mentioned you", "Mentioned you"),
    "commented": ("{actor} commented", "New comment"),
    "subscribed": ("{actor} subscribed you", "Subscribed you"),
    "project_update": ("{actor} posted an update", "Project update"),
    "project_update_comment": ("{actor} replied to an update", "Reply on update"),
    "review_requested": ("{actor} requested your review", "Review requested"),
}


def _status_changed(actor: str, value: Optional[str]) -> str:
    """Say where the issue moved, or only that it moved when the row has no value."""
    if value:
        return f"{actor} moved to {value}" if actor else f"Moved to {value}"
    return f"{actor} changed the status" if actor else "Status changed"


def _initiative_update_due(notification: Notification) -> str:
    """Say whether the initiative update is due or already overdue."""
    return "Initiative update overdue" if notification.due_state == "overdue" else "Initiative update due"


def _view_issue_added(view_name: Optional[str]) -> str:
    """Name the followed view an issue entered, or only that it entered one when the row has no name."""
    return f"Added to {view_name}" if view_name else "Added to a view you follow"


_SPECIAL: dict[str, Callable[[Notification, str], str]] = {
    "status_changed": lambda row, actor: _status_changed(actor, row.new_value),
    "initiative_update_due": lambda row, actor: _initiative_update_due(row),
    "view_issue_added": lambda row, actor: _view_issue_added(row.new_value),
}


def notification_summary(notification: Notification) -> str:
    """The deterministic line a row reads, such as "Olive moved to Done"."""
    actor = notification.actor_name.strip()
    kind = notification.kind
    if kind in _SPECIAL:
        return _SPECIAL[kind](notification, actor)
    if kind in _FIXED:
        return _FIXED[kind]
    if kind in _ACTED:
        acted, plain = _ACTED[kind]
        return acted.format(actor=actor) if actor else plain
    return "Update"
