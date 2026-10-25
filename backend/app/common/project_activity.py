"""A project's activity: who changed its properties, milestones and Resources links, and when.

Held in `common` because the project and milestone writes it records are shared by
the planning routes and the MCP tools, and the feed is read by both. Rows live in
the workspace's `planning` partition under the project's own prefix, written by the
path that made the change, right after the change is stored.

A team the caller cannot see is left out of any team list a row carries, and a
row whose team change was only to hidden teams is dropped, so the feed never names
a team the project's own read would hide.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional
from urllib.parse import urlsplit

from webbpulse.dynamodb import encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import resume_key
from app.common.api.schemas.planning import MAX_LIMIT, PROJECT_ACTIVITY_DEFAULT_LIMIT, ProjectActivityRead
from app.common.db.dynamo.planning import (
    Project,
    ProjectActivityRow,
    ProjectLink,
    ProjectMilestone,
    new_planning_id,
    project_activity_key,
    project_activity_prefix,
)
from app.common.planning_rules import load_readable_project, visible_team_ids

TRACKED_FIELDS: tuple[str, ...] = (
    "name",
    "status",
    "health",
    "priority",
    "lead_id",
    "member_ids",
    "label_ids",
    "start_date",
    "target_date",
    "team_ids",
    "initiative_id",
)
"""The project properties a change to is recorded, the ones Linear's project activity names."""

MILESTONE_FIELDS: tuple[str, ...] = ("name", "target_date")
"""The milestone properties a change to is recorded."""

LINK_FIELDS: tuple[str, ...] = ("title", "url")
"""The Resources link properties a change to is recorded; a reorder is not."""


def _row(
    context: AuthzContext,
    project_id: str,
    event: str,
    *,
    field: Optional[str] = None,
    from_value: Any = None,
    to_value: Any = None,
    milestone_id: Optional[str] = None,
    link_id: Optional[str] = None,
) -> ProjectActivityRow:
    """One activity row by the caller, with its sort key composed."""
    activity_id = new_planning_id()
    return ProjectActivityRow(
        workspace_id=context.workspace_id,
        planning_key=project_activity_key(project_id, activity_id),
        activity_id=activity_id,
        project_id=project_id,
        event=event,
        field=field,
        from_value=from_value,
        to_value=to_value,
        milestone_id=milestone_id,
        link_id=link_id,
        actor_id=context.user_id,
        source=context.source,
    )


def _changed(before: Any, after: Any) -> bool:
    """Whether a property moved, a list read as a set so a reorder is no change."""
    if isinstance(before, list) or isinstance(after, list):
        return set(before or []) != set(after or [])
    return before != after


def record_project_created(repositories: Repositories, context: AuthzContext, project: Project) -> None:
    """Record that the caller created a project."""
    repositories.planning.record_project_activity([_row(context, project.project_id, "created")])


def record_project_changes(
    repositories: Repositories, context: AuthzContext, before: Project, after: Project
) -> list[ProjectActivityRow]:
    """Record one row per tracked property a patch moved, answering the rows written."""
    rows = [
        _row(
            context,
            after.project_id,
            "field_changed",
            field=name,
            from_value=getattr(before, name),
            to_value=getattr(after, name),
        )
        for name in TRACKED_FIELDS
        if _changed(getattr(before, name), getattr(after, name))
    ]
    return repositories.planning.record_project_activity(rows)


def record_milestone_added(repositories: Repositories, context: AuthzContext, milestone: ProjectMilestone) -> None:
    """Record that the caller added a milestone, naming it as it was created."""
    repositories.planning.record_project_activity(
        [
            _row(
                context,
                milestone.project_id,
                "milestone_added",
                to_value=milestone.name,
                milestone_id=milestone.milestone_id,
            )
        ]
    )


def record_milestone_removed(repositories: Repositories, context: AuthzContext, milestone: ProjectMilestone) -> None:
    """Record that the caller removed a milestone, keeping its name since the row is gone."""
    repositories.planning.record_project_activity(
        [
            _row(
                context,
                milestone.project_id,
                "milestone_removed",
                from_value=milestone.name,
                milestone_id=milestone.milestone_id,
            )
        ]
    )


def record_milestone_changes(
    repositories: Repositories, context: AuthzContext, before: ProjectMilestone, after: ProjectMilestone
) -> None:
    """Record a rename or a new target date of one milestone, one row per property moved."""
    rows = [
        _row(
            context,
            after.project_id,
            "milestone_changed",
            field=name,
            from_value=getattr(before, name),
            to_value=getattr(after, name),
            milestone_id=after.milestone_id,
        )
        for name in MILESTONE_FIELDS
        if _changed(getattr(before, name), getattr(after, name))
    ]
    repositories.planning.record_project_activity(rows)


def link_label(link: ProjectLink) -> str:
    """What a Resources link reads as: its title, or the hostname of its URL when it has none."""
    if link.title:
        return link.title
    return urlsplit(link.url).hostname or link.url


def record_link_added(repositories: Repositories, context: AuthzContext, link: ProjectLink) -> None:
    """Record that the caller added a Resources link, naming it as it was created."""
    repositories.planning.record_project_activity(
        [_row(context, link.project_id, "link_added", to_value=link_label(link), link_id=link.link_id)]
    )


def record_link_removed(repositories: Repositories, context: AuthzContext, link: ProjectLink) -> None:
    """Record that the caller removed a Resources link, keeping its label since the row is gone."""
    repositories.planning.record_project_activity(
        [_row(context, link.project_id, "link_removed", from_value=link_label(link), link_id=link.link_id)]
    )


def record_link_changes(
    repositories: Repositories, context: AuthzContext, before: ProjectLink, after: ProjectLink
) -> None:
    """Record a new title or URL of one Resources link, one row per property moved."""
    rows = [
        _row(
            context,
            after.project_id,
            "link_changed",
            field=name,
            from_value=getattr(before, name),
            to_value=getattr(after, name),
            link_id=after.link_id,
        )
        for name in LINK_FIELDS
        if _changed(getattr(before, name), getattr(after, name))
    ]
    repositories.planning.record_project_activity(rows)


def cursor_scope(workspace_id: str, project_id: str) -> str:
    """The scope a feed cursor is minted under, so it only resumes the same feed."""
    return f"project_activity:{workspace_id}:{project_id}"


def _start_key(cursor: Optional[str], workspace_id: str, project_id: str) -> Optional[Mapping[str, Any]]:
    """A decoded cursor, or `None` when it would resume outside this project's activity."""
    start = resume_key(cursor, cursor_scope(workspace_id, project_id))
    if start is None or start.get("workspace_id") != workspace_id:
        return None
    if not str(start.get("planning_key", "")).startswith(project_activity_prefix(project_id)):
        return None
    return start


def _visible_teams(row: ProjectActivityRow, visible: set[str]) -> Optional[ProjectActivityRow]:
    """A team change narrowed to the teams the caller sees, or `None` when nothing visible moved."""
    if row.field != "team_ids":
        return row
    before = [team_id for team_id in row.from_value or [] if team_id in visible]
    after = [team_id for team_id in row.to_value or [] if team_id in visible]
    if not _changed(before, after):
        return None
    return row.model_copy(update={"from_value": before, "to_value": after})


def activity_page(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    *,
    cursor: Optional[str] = None,
    limit: Optional[int] = None,
) -> tuple[list[ProjectActivityRead], Optional[str]]:
    """One page of a readable project's activity, newest first, and the cursor after it."""
    project, _ = load_readable_project(repositories, context, project_id)
    size = max(1, min(limit or PROJECT_ACTIVITY_DEFAULT_LIMIT, MAX_LIMIT))
    rows, last_key = repositories.planning.list_project_activity(
        context.workspace_id,
        project.project_id,
        limit=size,
        start_key=_start_key(cursor, context.workspace_id, project.project_id),
    )
    visible = set(visible_team_ids(repositories, context))
    shown = [narrowed for narrowed in (_visible_teams(row, visible) for row in rows) if narrowed is not None]
    return (
        [ProjectActivityRead.from_row(row) for row in shown],
        encode_start_key(last_key, scope=cursor_scope(context.workspace_id, project.project_id)),
    )
