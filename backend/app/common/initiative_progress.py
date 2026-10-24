"""An initiative's progress graph, read off the issues of every visible project in its subtree.

Held in `common` so the route and the MCP tool draw the same series. Nothing
keeps a history of an initiative's scope, so the series is derived the way a
project's graph is: an issue joins the scope on the day it was created and
counts as started or completed from the day it last moved, when its status sits
in that category now. Cancelled and archived issues are out of scope, and only
the teams the caller can see are read, so the graph never reveals hidden work.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.planning import InitiativeProgressPointRead, InitiativeProgressRead
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.estimates import issue_weight
from app.common.initiative_writes import (
    initiative_tree,
    load_initiative,
    rollup_projects,
    visible_projects_by_initiative,
)
from app.common.planning_rules import visible_team_ids

MAX_GRAPH_DAYS = 366
"""The most days of history the graph reaches back, so an old initiative stays one bounded read."""


@dataclass(frozen=True)
class _Counted:
    """One issue as the graph counts it: when it entered scope, moved, and what it weighs."""

    created: date
    started: Optional[date]
    completed: Optional[date]
    weight: int


class _TeamRules:
    """Each team's status categories and estimate settings, read once per graph."""

    def __init__(self, repositories: Repositories, workspace_id: str) -> None:
        """Start an empty cache over one workspace's teams."""
        self._repositories = repositories
        self._workspace_id = workspace_id
        self._categories: dict[str, dict[str, str]] = {}
        self._scales: dict[str, tuple[str, bool]] = {}

    def category(self, team_id: str, status_id: str) -> str:
        """The category of one of a team's statuses, empty when the team has no such status."""
        if team_id not in self._categories:
            self._categories[team_id] = {
                row.status_id: row.category
                for row in self._repositories.team_config.list_statuses(self._workspace_id, team_id)
            }
        return self._categories[team_id].get(status_id, "")

    def weight(self, team_id: str, estimate: Optional[str]) -> int:
        """What one issue of a team adds to the point series."""
        if team_id not in self._scales:
            team = self._repositories.teams.get(self._workspace_id, team_id)
            self._scales[team_id] = (
                ("off", False) if team is None else (team.estimate_scale, bool(team.estimate_count_unestimated))
            )
        scale, count_unestimated = self._scales[team_id]
        return issue_weight((estimate or "").strip(), scale, count_unestimated=count_unestimated)


def _counted(issue: Issue, rules: _TeamRules, points: bool) -> Optional[_Counted]:
    """How one issue enters the graph, or `None` when it is archived or cancelled."""
    if issue.archived_at is not None:
        return None
    category = rules.category(issue.team_id, issue.status_id)
    if category == "cancelled":
        return None
    moved = issue.updated_at.date()
    completed = (issue.completed_at or issue.updated_at).date() if category == "completed" else None
    started = moved if category == "started" else completed
    return _Counted(
        created=issue.created_at.date(),
        started=started,
        completed=completed,
        weight=rules.weight(issue.team_id, issue.estimate) if points else 1,
    )


def initiative_progress(
    repositories: Repositories, context: AuthzContext, initiative_id: str, *, today: Optional[date] = None
) -> InitiativeProgressRead:
    """Scope, started and completed work per day for an initiative and every sub-initiative below it."""
    initiative = load_initiative(repositories, context, initiative_id)
    tree = initiative_tree(repositories, context.workspace_id, initiative)
    projects = rollup_projects(tree, visible_projects_by_initiative(repositories, context), initiative.initiative_id)
    points = any(project.measure == "points" for project in projects)
    rules = _TeamRules(repositories, context.workspace_id)
    seen: set[str] = set()
    counted: list[_Counted] = []
    for team_id in visible_team_ids(repositories, context):
        for project in projects:
            for issue in repositories.issues.iter_for_project(context.workspace_id, team_id, project.project_id):
                if issue.issue_id in seen:
                    continue
                seen.add(issue.issue_id)
                row = _counted(issue, rules, points)
                if row is not None:
                    counted.append(row)

    current = today or utc_now().date()
    earliest = min([initiative.created_at.date(), *(row.created for row in counted)])
    start = max(min(earliest, current), current - timedelta(days=MAX_GRAPH_DAYS - 1))
    target = _parse_date(initiative.target_date)
    end = target if target is not None and target > current else current
    days: list[InitiativeProgressPointRead] = []
    day = start
    while day <= current:
        scope = started = completed = 0
        for row in counted:
            if row.created > day:
                continue
            scope += row.weight
            if row.started is not None and row.started <= day:
                started += row.weight
            if row.completed is not None and row.completed <= day:
                completed += row.weight
        days.append(
            InitiativeProgressPointRead(date=day.isoformat(), scope=scope, started=started, completed=completed)
        )
        day += timedelta(days=1)
    return InitiativeProgressRead(
        initiative_id=initiative.initiative_id,
        measure="points" if points else "issues",
        start_date=start.isoformat(),
        end_date=end.isoformat(),
        days=days,
    )


def _parse_date(value: Optional[str]) -> Optional[date]:
    """A stored `YYYY-MM-DD` date, or `None` when it is absent or unreadable."""
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None
