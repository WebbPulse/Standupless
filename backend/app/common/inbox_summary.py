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
    "document_comment": ("{actor} commented on a document", "Comment on document"),
    "review_requested": ("{actor} requested your review", "Review requested"),
    "priority_urgent": ("{actor} marked as urgent", "Marked as urgent"),
    "team_issue_created": ("{actor} created an issue", "New issue"),
}


def _status_changed(actor: str, value: Optional[str]) -> str:
    """Say where the issue moved, or only that it moved when the row has no value."""
    if value:
        return f"{actor} moved to {value}" if actor else f"Moved to {value}"
    return f"{actor} changed the status" if actor else "Status changed"


def _initiative_update_due(notification: Notification) -> str:
    """Say whether the initiative update is due or already overdue."""
    return "Initiative update overdue" if notification.due_state == "overdue" else "Initiative update due"


def _project_update_due(notification: Notification) -> str:
    """Say whether the project update is due or already overdue."""
    return "Update overdue" if notification.due_state == "overdue" else "Update due"


def _view_issue_added(view_name: Optional[str]) -> str:
    """Name the followed view an issue entered, or only that it entered one when the row has no name."""
    return f"New issue in {view_name}" if view_name else "New issue in a view you follow"


def _view_project_added(view_name: Optional[str]) -> str:
    """Name the followed view a project entered, or only that it entered one when the row has no name."""
    return f"New project in {view_name}" if view_name else "New project in a view you follow"


def _reaction(actor: str, emoji: Optional[str]) -> str:
    """Say who reacted to the reader's comment, with the emoji when the row names one."""
    who = actor or "Someone"
    return f"{who} reacted {emoji} to your comment" if emoji else f"{who} reacted to your comment"


def _closed(actor: str, value: Optional[str], verb: str) -> str:
    """Say the issue was completed or canceled, naming the status it moved to when the row has one."""
    who = actor or "Someone"
    return f"{who} marked as {value}" if value else f"{who} {verb} the issue"


BLOCKING_PHRASES: dict[str, str] = {
    "blocked_by": "Blocked by {key}",
    "blocking": "Blocking {key}",
    "unblocked_by": "No longer blocked by {key}",
    "no_longer_blocking": "No longer blocking {key}",
    "blocker_resolved": "Blocker {key} resolved",
}
"""How each blocking change reads, keyed by the change half of a `blocking_changed` row's `new_value`."""


def _blocking_changed(value: Optional[str]) -> str:
    """Say how the issue's blocking changed and which other issue it names."""
    change, _, key = (value or "").partition(":")
    phrase = BLOCKING_PHRASES.get(change)
    return phrase.format(key=key) if phrase is not None and key else "Blocking changed"


def _app_approval_requested(actor: str, app: Optional[str]) -> str:
    """Say who asked an admin to approve which third-party app."""
    who = actor or "A member"
    return f"{who} requested access to {app}" if app else f"{who} requested access to an app"


def _app_approval_decided(actor: str, app: Optional[str], decision: Optional[str]) -> str:
    """Say whether the requested app was approved or denied, and by whom."""
    verb = "approved" if decision == "approved" else "denied"
    who = actor or "An admin"
    return f"{who} {verb} {app}" if app else f"{who} {verb} your app request"


_SPECIAL: dict[str, Callable[[Notification, str], str]] = {
    "app_approval_requested": lambda row, actor: _app_approval_requested(actor, row.issue_title),
    "app_approval_decided": lambda row, actor: _app_approval_decided(actor, row.issue_title, row.new_value),
    "reaction": lambda row, actor: _reaction(actor, row.new_value),
    "issue_completed": lambda row, actor: _closed(actor, row.new_value, "completed"),
    "issue_cancelled": lambda row, actor: _closed(actor, row.new_value, "canceled"),
    "blocking_changed": lambda row, actor: _blocking_changed(row.new_value),
    "status_changed": lambda row, actor: _status_changed(actor, row.new_value),
    "initiative_update_due": lambda row, actor: _initiative_update_due(row),
    "project_update_due": lambda row, actor: _project_update_due(row),
    "view_issue_added": lambda row, actor: _view_issue_added(row.new_value),
    "view_project_added": lambda row, actor: _view_project_added(row.new_value),
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
