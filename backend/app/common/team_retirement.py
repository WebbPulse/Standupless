"""Retired teams: kept readable, refused every write.

A retired team leaves the sidebar and the team pickers, but its issues,
projects and cycles stay where they were so history and search still find them.
Every write path checks here, so the REST routes, the MCP tools, the CLI and
the GitHub sync agree on what a retired team refuses.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import HTTPException, status

from app.common.db.dynamo.team_config import FINISHED_CATEGORIES

if TYPE_CHECKING:
    from app.common.api.dependencies.repositories import Repositories
    from app.common.db.dynamo.teams import Team, TeamRepository

TEAM_RETIRED_CODE = "TEAM_RETIRED"

TEAM_NOT_RETIRABLE_CODE = "TEAM_NOT_RETIRABLE"

TEAM_HAS_OPEN_ISSUES_CODE = "TEAM_HAS_OPEN_ISSUES"


def is_retired(team: "Team | None") -> bool:
    """Whether a team row is marked retired."""
    return team is not None and team.retired_at is not None


def is_active(team: "Team | None") -> bool:
    """Whether a team exists and still takes writes, which is what the sweeps act on."""
    return team is not None and team.retired_at is None


def team_retired(team: "Team") -> HTTPException:
    """The 409 a write into a retired team answers."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "error_code": TEAM_RETIRED_CODE,
            "message": f"Team {team.key_prefix} is retired and read-only. Un-retire it to make changes.",
        },
    )


def refuse_if_retired(team: "Team | None") -> None:
    """Raise the retired-team 409 when this team is retired, otherwise do nothing."""
    if team is not None and team.retired_at is not None:
        raise team_retired(team)


def refuse_retired_team(teams: "TeamRepository", workspace_id: str, team_id: str) -> None:
    """Read one team and refuse a write into it when it is retired."""
    refuse_if_retired(teams.get(workspace_id, team_id))


def not_retirable(message: str) -> HTTPException:
    """The 409 a retire or un-retire that the team hierarchy forbids answers."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error_code": TEAM_NOT_RETIRABLE_CODE, "message": message},
    )


def check_retirable(teams: "TeamRepository", team: "Team") -> None:
    """Refuse retiring a parent team while any of its sub-teams is still active."""
    active = [child for child in teams.list_sub_teams(team.workspace_id, team.team_id) if is_active(child)]
    if active:
        names = ", ".join(child.key_prefix for child in active)
        raise not_retirable(f"Retire or move its sub-teams first: {names}")


def check_unretirable(teams: "TeamRepository", team: "Team") -> None:
    """Refuse bringing back a sub-team while its parent team is still retired."""
    if team.parent_team_id is None:
        return
    parent = teams.get(team.workspace_id, team.parent_team_id)
    if parent is not None and parent.retired_at is not None:
        raise not_retirable(f"Un-retire its parent team {parent.key_prefix} first")


def open_issue_count(repositories: "Repositories", team: "Team") -> int:
    """How many live issues of a team are neither completed nor cancelled, triage included."""
    open_ids = [
        row.status_id
        for row in repositories.team_config.list_statuses(team.workspace_id, team.team_id)
        if row.category not in FINISHED_CATEGORIES
    ]
    return repositories.issues.count_open(team.workspace_id, team.team_id, open_ids)


def has_open_issues(count: int, key_prefix: str) -> HTTPException:
    """The 409 a retire of a team still holding open issues answers, carrying the count."""
    noun = "issue" if count == 1 else "issues"
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "error_code": TEAM_HAS_OPEN_ISSUES_CODE,
            "message": (
                f"Team {key_prefix} still has {count} open {noun}. Complete, cancel or move them before retiring it."
            ),
            "details": {"open_issue_count": count},
        },
    )


def check_no_open_issues(repositories: "Repositories", team: "Team") -> None:
    """Refuse retiring a team while any of its live issues is still open."""
    count = open_issue_count(repositories, team)
    if count:
        raise has_open_issues(count, team.key_prefix)
