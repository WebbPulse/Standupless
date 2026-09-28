"""Project milestone create, patch and delete, shared by the milestone routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code. A milestone is reached through its project, so the right to change one is
the project's own: a writer on one of its visible teams. Reordering is a patch of
`sort_order`, a base 62 fractional key, so a drag rewrites one row.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.planning import MilestoneCreate, MilestoneRead, MilestoneUpdate
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import ProjectMilestone, milestone_key, new_planning_id
from app.common.planning_rules import load_readable_project, not_found, require_project_editor, unprocessable

MILESTONES_MAX = 100
"""How many milestones one project may hold; a plan, not a backlog."""

BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

FIRST_SORT_ORDER = "V"
"""Where the first milestone lands, near the middle of the alphabet so either end has room."""


def sort_order_after(last: str | None) -> str:
    """A base 62 key that sorts after `last`, or the first key when there is none.

    Bumps the final character when it has room and otherwise appends one, so the
    key stays short and still sorts after every key it follows.
    """
    if not last:
        return FIRST_SORT_ORDER
    position = BASE62.find(last[-1])
    if 0 <= position < len(BASE62) - 1:
        return last[:-1] + BASE62[position + 1]
    return last + FIRST_SORT_ORDER


def _load_editable_project(repositories: Repositories, context: AuthzContext, project_id: str) -> None:
    """Hold that the caller can read the project and write in one of its visible teams."""
    _, teams = load_readable_project(repositories, context, project_id)
    require_project_editor(repositories, context, teams)


def create_milestone(
    repositories: Repositories, context: AuthzContext, project_id: str, payload: MilestoneCreate
) -> MilestoneRead:
    """Add a milestone to a project, after the last one unless a position is given."""
    _load_editable_project(repositories, context, project_id)

    existing = repositories.planning.list_milestones(context.workspace_id, project_id)
    if len(existing) >= MILESTONES_MAX:
        raise unprocessable(f"A project holds at most {MILESTONES_MAX} milestones")
    sort_order = payload.sort_order or sort_order_after(existing[-1].sort_order if existing else None)

    milestone_id = new_planning_id()
    milestone = ProjectMilestone(
        workspace_id=context.workspace_id,
        planning_key=milestone_key(project_id, milestone_id),
        milestone_id=milestone_id,
        project_id=project_id,
        name=payload.name,
        description=payload.description,
        target_date=payload.target_date,
        sort_order=sort_order,
        created_by=context.user_id,
    )
    try:
        created = repositories.planning.create_milestone(milestone)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That milestone already exists"},
        ) from exc
    return MilestoneRead.from_row(created)


def update_milestone(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    milestone_id: str,
    payload: MilestoneUpdate,
) -> MilestoneRead:
    """Rename, redate, redescribe or reorder one milestone.

    The row is read first and written whole, so the counters the rollup consumer
    maintains ride along untouched.
    """
    _load_editable_project(repositories, context, project_id)
    existing = repositories.planning.get_milestone(context.workspace_id, project_id, milestone_id)
    if existing is None:
        raise not_found()

    fields: dict[str, Any] = payload.model_dump(exclude_unset=True)
    for name in ("name", "sort_order"):
        if name in fields and fields[name] is None:
            raise unprocessable(f"{name} must not be null")

    updated = existing.model_copy(update={**fields, "updated_at": utc_now()})
    try:
        stored = repositories.planning.replace_milestone(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    return MilestoneRead.from_row(stored)


def delete_milestone(repositories: Repositories, context: AuthzContext, project_id: str, milestone_id: str) -> None:
    """Delete one milestone; its issues stay in the project with no milestone.

    Takes the same right as editing the project, since it removes a stage of the
    plan rather than any team's work.
    """
    _load_editable_project(repositories, context, project_id)
    if not repositories.planning.delete(context.workspace_id, milestone_key(project_id, milestone_id)):
        raise not_found()
