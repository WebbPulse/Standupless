"""Triage responsibility and the require-priority rule, read off a team's triage settings.

Held apart from `issue_triage` because the create and patch paths in
`issue_writes` run it as an issue enters or leaves the inbox, and `issue_triage`
already imports those paths. Responsibility either assigns the waiting issue to
one member on duty, round robin by who holds the fewest waiting issues, or
leaves the issue alone and lets the notify consumer tell everyone on duty.
"""

from __future__ import annotations

from typing import Optional

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.team_config import TriageSettings
from app.common.issue_rules import unprocessable
from app.common.team_privacy import person_can_see_team

TRIAGE_READ_CAP = 1000
"""The most waiting issues one round robin counts, the cap the inbox itself reads."""

PRIORITY_REQUIRED = "This team requires a priority before an issue leaves triage"


def stored_settings(repositories: Repositories, workspace_id: str, team_id: str) -> Optional[TriageSettings]:
    """A team's saved triage settings, or `None` when it never saved any."""
    return repositories.team_config.get_triage_settings(workspace_id, team_id)


def can_be_on_duty(repositories: Repositories, workspace_id: str, team_id: str, user_id: str) -> bool:
    """Whether one person may hold triage duty: a workspace member other than a guest who can see the team."""
    membership = repositories.memberships.get(workspace_id, user_id)
    if membership is None or membership.role == "guest":
        return False
    return person_can_see_team(repositories, workspace_id, team_id, user_id)


def on_duty(repositories: Repositories, settings: TriageSettings) -> list[str]:
    """The responsible members who may still hold duty, sorted by id.

    Someone who left the workspace or lost sight of the team since the settings
    were saved is skipped rather than assigned an issue they cannot open.
    """
    return sorted(
        user_id
        for user_id in settings.responsible_user_ids
        if can_be_on_duty(repositories, settings.workspace_id, settings.team_id, user_id)
    )


def round_robin(repositories: Repositories, workspace_id: str, team_id: str, members: list[str]) -> Optional[str]:
    """The member holding the fewest waiting issues in the team's inbox, the lowest id on a tie."""
    if not members:
        return None
    counts = dict.fromkeys(members, 0)
    for issue in repositories.issues.iter_triage(workspace_id, team_id, max_items=TRIAGE_READ_CAP):
        if issue.assignee_id in counts:
            counts[issue.assignee_id] += 1
    return min(members, key=lambda user_id: (counts[user_id], user_id))


def duty_assignee(repositories: Repositories, workspace_id: str, team_id: str) -> Optional[str]:
    """Who an issue entering the team's inbox is assigned to, or `None` when the team assigns nobody."""
    settings = stored_settings(repositories, workspace_id, team_id)
    if settings is None or not settings.enabled or settings.responsibility_action != "assign":
        return None
    return round_robin(repositories, workspace_id, team_id, on_duty(repositories, settings))


def duty_notified(repositories: Repositories, workspace_id: str, team_id: str) -> list[str]:
    """Who hears that an issue entered the team's inbox, empty unless the team notifies."""
    settings = stored_settings(repositories, workspace_id, team_id)
    if settings is None or not settings.enabled or settings.responsibility_action != "notify":
        return []
    return on_duty(repositories, settings)


def require_priority(repositories: Repositories, workspace_id: str, team_id: str, priority: str) -> None:
    """Hold an issue leaving triage to having a priority when its team asks for one, or a 422."""
    if priority != "none":
        return
    settings = stored_settings(repositories, workspace_id, team_id)
    if settings is not None and settings.require_priority:
        raise unprocessable(PRIORITY_REQUIRED)
