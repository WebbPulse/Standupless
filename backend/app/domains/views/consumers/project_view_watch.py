"""Which project view subscribers a project write newly brings a project to, for the notify consumer.

A member who subscribes to a saved project view hears about each project that
starts matching it: a project created into the view, or changed so that it now
meets the filter. A project that already matched before the write, or that
matches neither before nor after, says nothing, so subscribing to a full view is
quiet. Unlike an issue view, no sent notice is remembered: a project that leaves
the view and comes back notifies again, as Linear does for project views.

The view is judged with the projects page's own rules, so the inbox and the page
agree on what a view holds: the team filter rolled up to the team's sub-teams
unless the view turns that off, the status, lead, label, customer and dependency
filters, the health, priority, member, date and update age filters, the
closed projects window, the lead team choice, and archived projects always
left out. A guest never filters by customer, as the page ignores that
filter for them. Only a write that changes a property the view reads is judged,
so the rollup counters a project row takes on every issue change cost nothing.

The work per write is bounded. The workspace's subscriptions are one query, a
team view on a team the project is not on, nor a parent of one, is skipped
without a read, and the customer requests and project dependencies are read once
per write and only when a subscribed view filters by them.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from fastapi import HTTPException

from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.projects_display import stored_projects_display
from app.common.customer_index import CustomerIndex, customer_match, load_customer_index
from app.common.db.dynamo.planning import PROJECT, Project, as_project, normalise_project_status
from app.common.db.dynamo.views import SavedView, ViewSubscription
from app.common.project_filters import ProjectPropertyFilter, stored_property_filter
from app.common.project_labels import label_match, label_values
from app.common.project_relations import Dependencies, dependency_map
from app.common.project_statuses import project_in_filter, status_filter_match, workspace_project_statuses
from app.common.project_writes import customer_values
from app.common.sub_teams import sub_team_ids
from app.domains.views.consumers.view_watch import ViewEntry, _ViewLookup, subscriber_can_read

_log = logging.getLogger(__name__)

CLOSED_STATUSES: frozenset[str] = frozenset({"completed", "canceled"})
"""The project status categories the closed projects window governs."""

CLOSED_WINDOW_DAYS: Mapping[str, int] = {"fortnight": 14, "month": 30}
"""How many days after closing a completed project still shows under each window, as the page counts them."""

WATCHED_FIELDS: tuple[str, ...] = (
    "team_ids",
    "status",
    "status_id",
    "lead_id",
    "label_ids",
    "archived_at",
    "completed_at",
    "health",
    "priority",
    "member_ids",
    "start_date",
    "target_date",
    "last_update_at",
)
"""The project properties a project view reads, the only changes worth judging."""

NO_VALUE = "none"
"""The filter value standing for a project with no lead."""


def image_project(image: Mapping[str, Any]) -> Optional[Project]:
    """One stream image as a `Project`, or `None` when it is not a whole project row."""
    if not image or str(image.get("kind", "")) != PROJECT:
        return None
    try:
        return as_project(image)
    except ValueError:
        return None


def view_fields_changed(before: Optional[Project], after: Optional[Project]) -> bool:
    """Whether a write changed anything a project view reads, always true for a created project."""
    if after is None:
        return False
    if before is None:
        return True
    return any(getattr(before, name) != getattr(after, name) for name in WATCHED_FIELDS)


def _values(raw: Any) -> list[str]:
    """A stored filter value that may be one text or a list of them, as a list of texts."""
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        return [str(value).strip() for value in raw if str(value).strip()]
    text = str(raw).strip()
    return [text] if text else []


def _flag(raw: Any) -> Optional[bool]:
    """A stored `true` or `false` filter, or `None` when unset."""
    text = str(raw).strip().lower() if raw is not None else ""
    if text == "true":
        return True
    if text == "false":
        return False
    return None


@dataclass
class _Workspace:
    """The workspace wide reads a project view may need, each made at most once per write."""

    repositories: Repositories
    workspace_id: str
    _statuses: Optional[list[Any]] = None
    _customers: Optional[CustomerIndex] = None
    _dependencies: Optional[Dependencies] = None
    _closed: set[str] = field(default_factory=set)
    _sub_teams: dict[str, list[str]] = field(default_factory=dict)

    def statuses(self) -> list[Any]:
        """The workspace's project statuses."""
        if self._statuses is None:
            self._statuses = workspace_project_statuses(self.repositories, self.workspace_id)
        return self._statuses

    def customers(self) -> CustomerIndex:
        """Which customers asked for each project."""
        if self._customers is None:
            self._customers = load_customer_index(self.repositories, self.workspace_id)
        return self._customers

    def dependencies(self) -> tuple[Dependencies, set[str]]:
        """Every project's blockers and blocked projects, and which projects are closed."""
        if self._dependencies is None:
            projects = self.repositories.planning.list_projects(self.workspace_id)
            self._closed = {
                row.project_id for row in projects if normalise_project_status(row.status) in CLOSED_STATUSES
            }
            relations = self.repositories.planning.list_project_relations(self.workspace_id)
            self._dependencies = dependency_map(relations, {row.project_id for row in projects})
        return self._dependencies, self._closed

    def sub_teams(self, team_id: str) -> list[str]:
        """The live teams directly under one team."""
        if team_id not in self._sub_teams:
            self._sub_teams[team_id] = sub_team_ids(self.repositories, self.workspace_id, team_id)
        return self._sub_teams[team_id]


@dataclass(frozen=True)
class ProjectViewFilter:
    """One project view's filter and arrangement, parsed once per write."""

    teams: Optional[frozenset[str]]
    statuses: tuple[tuple[str, str], ...]
    leads: frozenset[Optional[str]]
    labels: frozenset[Optional[str]]
    customers: frozenset[Optional[str]]
    customers_not: frozenset[Optional[str]]
    is_blocked: Optional[bool]
    is_blocking: Optional[bool]
    closed: str
    lead_team: str
    properties: ProjectPropertyFilter = field(default_factory=ProjectPropertyFilter)


def parse_view(view: SavedView, workspace: _Workspace) -> ProjectViewFilter:
    """The filter a project view runs, a 422 raised for a status the workspace no longer has."""
    stored = view.filter
    team_id = next(iter(_values(stored.get("team_id"))), "") or (view.team_id or "")
    teams: Optional[frozenset[str]] = None
    if team_id:
        rolled = [] if _flag(stored.get("sub_teams")) is False else workspace.sub_teams(team_id)
        teams = frozenset({team_id, *rolled})
    raw_statuses = _values(stored.get("status"))
    statuses = tuple(status_filter_match(workspace.statuses(), value) for value in raw_statuses)
    leads = frozenset(None if value == NO_VALUE else value for value in _values(stored.get("lead_id")))
    display = stored_projects_display(view.projects_display)
    return ProjectViewFilter(
        teams=teams,
        statuses=statuses,
        leads=leads,
        labels=label_values(_values(stored.get("label_id"))),
        customers=customer_values(_values(stored.get("customer_id"))),
        customers_not=customer_values(_values(stored.get("customer_id_not"))),
        is_blocked=_flag(stored.get("is_blocked")),
        is_blocking=_flag(stored.get("is_blocking")),
        closed=display.closed,
        lead_team=display.lead_team,
        properties=stored_property_filter(stored),
    )


def _within_closed_window(project: Project, closed: str, now: datetime) -> bool:
    """Whether a project stays under the view's closed projects window, by the page's own rule."""
    category = normalise_project_status(project.status)
    if category not in CLOSED_STATUSES or closed == "all":
        return True
    if closed == "none" or category == "canceled":
        return False
    days = CLOSED_WINDOW_DAYS.get(closed)
    if days is None:
        return True
    closed_at = project.completed_at or project.updated_at
    if closed_at.tzinfo is None:
        closed_at = closed_at.replace(tzinfo=timezone.utc)
    return now - closed_at <= timedelta(days=days)


def project_in_view(
    wanted: ProjectViewFilter,
    project: Optional[Project],
    workspace: _Workspace,
    *,
    now: datetime,
    guest: bool = False,
) -> bool:
    """Whether one project state shows in a project view, its display switches included.

    A guest is never filtered by customer, since the page ignores that filter for them.
    """
    if project is None or project.archived_at is not None:
        return False
    if wanted.teams is not None and wanted.teams.isdisjoint(project.team_ids):
        return False
    if wanted.teams is not None and wanted.lead_team == "lead" and project.team_ids[0] not in wanted.teams:
        return False
    if wanted.statuses and not any(
        project_in_filter(workspace.statuses(), project, status) for status in wanted.statuses
    ):
        return False
    if wanted.leads and project.lead_id not in wanted.leads:
        return False
    if not label_match(wanted.labels, project.label_ids):
        return False
    if wanted.properties.active and not wanted.properties.matches(project, now):
        return False
    if not guest and (wanted.customers or wanted.customers_not):
        index = workspace.customers()
        if not customer_match(
            wanted.customers,
            wanted.customers_not,
            index.customer_ids("project", project.project_id),
            index.important_count("project", project.project_id),
        ):
            return False
    if wanted.is_blocked is not None or wanted.is_blocking is not None:
        dependencies, closed = workspace.dependencies()
        blockers, held_up = dependencies.get(project.project_id, ([], []))
        own_closed = normalise_project_status(project.status) in CLOSED_STATUSES
        blocked = any(blocker not in closed for blocker in blockers)
        blocking = not own_closed and bool(held_up)
        if wanted.is_blocked is not None and blocked != wanted.is_blocked:
            return False
        if wanted.is_blocking is not None and blocking != wanted.is_blocking:
            return False
    return _within_closed_window(project, wanted.closed, now)


def _project_teams(repositories: Repositories, workspace_id: str, projects: list[Project]) -> list[str]:
    """The teams the written project is or was on, and the parent of each, whose views could roll it up."""
    teams: list[str] = []
    for project in projects:
        teams.extend(project.team_ids)
    for team_id in list(dict.fromkeys(teams)):
        team = repositories.teams.get(workspace_id, team_id)
        if team is not None and team.parent_team_id:
            teams.append(team.parent_team_id)
    return list(dict.fromkeys(teams))


def _is_guest(repositories: Repositories, workspace_id: str, user_id: str) -> bool:
    """Whether one subscriber is a workspace guest, who never filters by customer."""
    membership = repositories.memberships.get(workspace_id, user_id)
    return membership is not None and membership.role == "guest"


def newly_entered_projects(
    repositories: Repositories,
    workspace_id: str,
    before: Optional[Project],
    after: Optional[Project],
) -> list[ViewEntry]:
    """Each subscriber whose subscribed project view `after` matches and `before` did not, one entry per view.

    `before` is `None` for a created project, which matched nothing until now. A
    view whose filter no longer runs, such as one naming a deleted status, is
    skipped and logged rather than failing the whole record.
    """
    if not view_fields_changed(before, after) or after is None:
        return []
    subscriptions = repositories.views.list_subscriptions(workspace_id)
    if not subscriptions:
        return []
    by_view: dict[str, list[ViewSubscription]] = {}
    for row in subscriptions:
        by_view.setdefault(row.view_id, []).append(row)

    projects = [after, *([before] if before is not None else [])]
    lookup = _ViewLookup(repositories, workspace_id, _project_teams(repositories, workspace_id, projects))
    workspace = _Workspace(repositories, workspace_id)
    now = after.updated_at if after.updated_at.tzinfo is not None else after.updated_at.replace(tzinfo=timezone.utc)
    entries: list[ViewEntry] = []
    for view_id, rows in by_view.items():
        view = lookup.find(rows[0])
        if view is None or not view.lists_projects:
            continue
        try:
            wanted = parse_view(view, workspace)
        except (HTTPException, TypeError, ValueError):
            _log.info(
                "Skipped a project view subscription whose filter does not run.",
                extra={"event": "views.notify.view_filter_skipped", "workspace_id": workspace_id, "view_id": view_id},
            )
            continue
        judged: dict[bool, bool] = {}
        for row in sorted(rows, key=lambda item: item.created_at):
            guest = bool(wanted.customers or wanted.customers_not) and _is_guest(
                repositories, workspace_id, row.user_id
            )
            if guest not in judged:
                judged[guest] = project_in_view(wanted, after, workspace, now=now, guest=guest) and not (
                    project_in_view(wanted, before, workspace, now=now, guest=guest)
                )
            if judged[guest] and subscriber_can_read(repositories, workspace_id, view, row.user_id):
                entries.append(ViewEntry(user_id=row.user_id, view=view))
    return entries
