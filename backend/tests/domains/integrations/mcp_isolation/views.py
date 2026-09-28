"""Isolation arguments for the saved view and inbox MCP tools.

The inbox mark tools take ids but answer how many rows they changed, as the inbox
routes do, so a foreign id answers zero from the key's own inbox rather than a
refusal. They are listed in `ANSWERS_AT_HOME`, and `test_mcp_views` holds that the
foreign row they named is left untouched.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from app.common.db.dynamo.inbox import Notification, expires_at, inbox_partition
from app.common.db.dynamo.views import SavedView, personal_view_key
from tests.domains.helpers import OWNER

FOREIGN_NOTIFICATION = "01N00000000000000000FOREIGN"

ANSWERS_AT_HOME: frozenset[str] = frozenset(
    {
        "list_notifications",
        "mark_notification_read",
        "mark_notification_unread",
        "mark_all_notifications_read",
        "snooze_notification",
    }
)


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """An unread notification and a personal view for the owner in the other workspace."""
    created_at = datetime.now(timezone.utc)
    repositories.inbox.create(
        Notification(
            ws_user=inbox_partition(workspace_id, OWNER),
            notification_id=FOREIGN_NOTIFICATION,
            workspace_id=workspace_id,
            kind="assigned",
            issue_id="01JB0000000000000000000IS9",
            issue_key="OTH-1",
            issue_title="Classified notification",
            team_id=team_id,
            actor_id=OWNER,
            actor_name="Olive Owner",
            recipient_id=OWNER,
            created_at=created_at,
            unread_at=created_at.isoformat(),
            expires_at=expires_at(created_at),
        )
    )
    view = SavedView(workspace_id=workspace_id, view_key="", name="Classified personal view", owner_id=OWNER)
    view.view_key = personal_view_key(OWNER, view.view_id)
    repositories.views.create(view)
    return {"notification_id": FOREIGN_NOTIFICATION, "personal_view_id": view.view_id}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    notification = foreign["notification_id"]
    until = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    return {
        "create_view": {"name": "Should not land", "team_id": foreign["team_id"]},
        "update_view": {"view_id": foreign["view_id"], "name": "Should not land"},
        "delete_view": {"view_id": foreign["personal_view_id"]},
        "list_notifications": {},
        "mark_notification_read": {"notification_ids": [notification]},
        "mark_notification_unread": {"notification_ids": [notification]},
        "mark_all_notifications_read": {},
        "snooze_notification": {"notification_ids": [notification], "until": until},
        "delete_notification": {"notification_id": notification},
    }
