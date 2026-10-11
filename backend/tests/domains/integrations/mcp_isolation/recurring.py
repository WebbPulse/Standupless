"""Isolation arguments for the recurring issue tools."""

from __future__ import annotations

from datetime import date
from typing import Any

from app.common.db.dynamo.team_recurring import RecurringIssue, recurring_key

ANSWERS_AT_HOME: frozenset[str] = frozenset()

FOREIGN_RECURRING = "01JB0000000000000000000RC1"


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """A paused recurring issue in the other workspace, by id."""
    repositories.team_config.create_recurring(
        RecurringIssue(
            workspace_id=workspace_id,
            config_key=recurring_key(team_id, FOREIGN_RECURRING),
            recurring_id=FOREIGN_RECURRING,
            team_id=team_id,
            template_id="01JB0000000000000000000TP1",
            frequency="daily",
            starts_on=date(2026, 1, 1),
            paused=True,
            created_by="foreign-user",
        )
    )
    return {"recurring_id": FOREIGN_RECURRING}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    team = foreign["team_id"]
    recurring = foreign["recurring_id"]
    return {
        "list_recurring_issues": {"team_id": team},
        "create_recurring_issue": {"team_id": team, "template": "Foreign template", "frequency": "daily"},
        "update_recurring_issue": {"team_id": team, "recurring_id": recurring, "paused": False},
        "delete_recurring_issue": {"team_id": team, "recurring_id": recurring},
    }
