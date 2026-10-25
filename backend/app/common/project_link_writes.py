"""Project Resources link create, patch and delete, shared by the link routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code. A link is reached through its project, so the right to change one is the
project's own: a writer on one of its visible teams. Reordering is a patch of
`sort_order`, a base 62 fractional key, so a drag rewrites one row. The linked
page is never fetched; a link reads as the title the person typed or its hostname.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common import project_activity
from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.planning import ProjectLinkCreate, ProjectLinkRead, ProjectLinkUpdate, ProjectRead
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import PROJECT_LINKS_MAX, ProjectLink, new_planning_id, project_link_key
from app.common.milestone_writes import sort_order_after
from app.common.planning_rules import load_readable_project, not_found, require_project_editor, unprocessable


def _load_editable_project(repositories: Repositories, context: AuthzContext, project_id: str) -> None:
    """Hold that the caller can read the project and write in one of its visible teams."""
    _, teams = load_readable_project(repositories, context, project_id)
    require_project_editor(repositories, context, teams)


def project_links(repositories: Repositories, workspace_id: str, project_id: str) -> list[ProjectLinkRead]:
    """Every Resources link of a project the caller already reads, in manual order."""
    return [ProjectLinkRead.from_row(row) for row in repositories.planning.list_project_links(workspace_id, project_id)]


def with_links(repositories: Repositories, body: ProjectRead) -> ProjectRead:
    """A single project read with its Resources links filled in."""
    body.links = project_links(repositories, body.workspace_id, body.project_id)
    return body


def list_links(repositories: Repositories, context: AuthzContext, project_id: str) -> list[ProjectLinkRead]:
    """Every Resources link of a project the caller can read, in manual order."""
    load_readable_project(repositories, context, project_id)
    return project_links(repositories, context.workspace_id, project_id)


def create_link(
    repositories: Repositories, context: AuthzContext, project_id: str, payload: ProjectLinkCreate
) -> ProjectLinkRead:
    """Add a Resources link to a project, after the last one unless a position is given."""
    _load_editable_project(repositories, context, project_id)

    existing = repositories.planning.list_project_links(context.workspace_id, project_id)
    if len(existing) >= PROJECT_LINKS_MAX:
        raise unprocessable(f"A project holds at most {PROJECT_LINKS_MAX} links")
    sort_order = payload.sort_order or sort_order_after(existing[-1].sort_order if existing else None)

    link_id = new_planning_id()
    link = ProjectLink(
        workspace_id=context.workspace_id,
        planning_key=project_link_key(project_id, link_id),
        link_id=link_id,
        project_id=project_id,
        url=payload.url,
        title=payload.title,
        sort_order=sort_order,
        created_by=context.user_id,
    )
    try:
        created = repositories.planning.put_project_link(link, create=True)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That link already exists"},
        ) from exc
    project_activity.record_link_added(repositories, context, created)
    return ProjectLinkRead.from_row(created)


def update_link(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    link_id: str,
    payload: ProjectLinkUpdate,
) -> ProjectLinkRead:
    """Retitle, repoint or reorder one Resources link."""
    _load_editable_project(repositories, context, project_id)
    existing = repositories.planning.get_project_link(context.workspace_id, project_id, link_id)
    if existing is None:
        raise not_found()

    fields: dict[str, Any] = payload.model_dump(exclude_unset=True)
    for name in ("url", "sort_order"):
        if name in fields and fields[name] is None:
            raise unprocessable(f"{name} must not be null")

    updated = existing.model_copy(update={**fields, "updated_at": utc_now()})
    try:
        stored = repositories.planning.put_project_link(updated, create=False)
    except ConditionFailed as exc:
        raise not_found() from exc
    project_activity.record_link_changes(repositories, context, existing, stored)
    return ProjectLinkRead.from_row(stored)


def delete_link(repositories: Repositories, context: AuthzContext, project_id: str, link_id: str) -> None:
    """Remove one Resources link from a project."""
    _load_editable_project(repositories, context, project_id)
    existing = repositories.planning.get_project_link(context.workspace_id, project_id, link_id)
    if existing is None or not repositories.planning.delete(
        context.workspace_id, project_link_key(project_id, link_id)
    ):
        raise not_found()
    project_activity.record_link_removed(repositories, context, existing)
