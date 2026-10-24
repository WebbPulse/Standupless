"""Project label list, create, patch and delete, shared by the project label routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code. Project labels are one set for the whole workspace, as Linear's are: any
reader of the workspace sees them, only its admins change them, and the caller
has already been held to that. A label name is unique among project labels,
compared trimmed and case folded. A deleted label is taken off every project
that carried it.
"""

from __future__ import annotations

from typing import Iterable, Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.project_labels import (
    ProjectLabelCreate,
    ProjectLabelListRead,
    ProjectLabelRead,
    ProjectLabelUpdate,
)
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import Project, ProjectLabel, new_planning_id, project_label_key
from app.common.labels import name_key
from app.common.planning_rules import not_found, unprocessable, visible_project_teams, visible_team_ids

NO_LABEL = "none"
"""The label filter value that keeps the projects carrying no label."""


def _conflict(name: str) -> HTTPException:
    """The 409 a project label name another project label holds gets."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "error_code": "CONFLICT",
            "message": f"A project label named {name} already exists",
            "details": {"name": name},
        },
    )


def _check_unique(labels: Iterable[ProjectLabel], name: str, exclude_label_id: Optional[str] = None) -> None:
    """Refuse with a 409 a name another project label already holds."""
    wanted = name_key(name)
    for label in labels:
        if label.label_id != exclude_label_id and name_key(label.name) == wanted:
            raise _conflict(name.strip())


def _visible_projects(repositories: Repositories, context: AuthzContext) -> list[Project]:
    """The workspace's projects the caller can see on at least one team."""
    visible = set(visible_team_ids(repositories, context))
    projects = repositories.planning.list_projects(context.workspace_id)
    return [row for row in projects if visible_project_teams(row, visible)]


def list_project_labels(repositories: Repositories, context: AuthzContext) -> ProjectLabelListRead:
    """Every project label of the workspace by name, each with how many projects the caller can see carry it."""
    counts: dict[str, int] = {}
    for project in _visible_projects(repositories, context):
        for label_id in project.label_ids:
            counts[label_id] = counts.get(label_id, 0) + 1
    labels = repositories.planning.list_project_labels(context.workspace_id)
    return ProjectLabelListRead(
        labels=[ProjectLabelRead.from_row(label, counts.get(label.label_id, 0)) for label in labels]
    )


def create_project_label(
    repositories: Repositories, context: AuthzContext, payload: ProjectLabelCreate
) -> ProjectLabelRead:
    """Add a project label to the workspace, or 409 when its name is taken."""
    _check_unique(repositories.planning.list_project_labels(context.workspace_id), payload.name)
    label_id = new_planning_id()
    label = ProjectLabel(
        workspace_id=context.workspace_id,
        planning_key=project_label_key(label_id),
        label_id=label_id,
        name=payload.name,
        color=payload.color,
        description=(payload.description or "").strip() or None,
        created_by=context.user_id,
    )
    try:
        repositories.planning.put_project_label(label, create=True)
    except ConditionFailed as exc:
        raise _conflict(payload.name) from exc
    return ProjectLabelRead.from_row(label)


def update_project_label(
    repositories: Repositories, context: AuthzContext, label_id: str, payload: ProjectLabelUpdate
) -> ProjectLabelRead:
    """Rename, recolour or redescribe a project label, or 404; a null or empty description clears it."""
    existing = repositories.planning.get_project_label(context.workspace_id, label_id)
    if existing is None:
        raise not_found()
    given = payload.model_dump(exclude_unset=True)
    changes: dict[str, object] = {}
    if given.get("name") is not None and given["name"] != existing.name:
        if name_key(given["name"]) != name_key(existing.name):
            _check_unique(repositories.planning.list_project_labels(context.workspace_id), given["name"], label_id)
        changes["name"] = given["name"]
    if given.get("color") is not None and given["color"] != existing.color:
        changes["color"] = given["color"]
    if "description" in given:
        description = (given["description"] or "").strip() or None
        if description != existing.description:
            changes["description"] = description
    if not changes:
        return ProjectLabelRead.from_row(existing)
    updated = existing.model_copy(update={**changes, "updated_at": utc_now()})
    try:
        repositories.planning.put_project_label(updated, create=False)
    except ConditionFailed as exc:
        raise not_found() from exc
    return ProjectLabelRead.from_row(updated)


def delete_project_label(repositories: Repositories, context: AuthzContext, label_id: str) -> int:
    """Delete a project label and take it off every project carrying it, answering how many it left.

    A missing label is a no-op. Every project of the workspace is cleared, seen by
    the caller or not, since an admin removing the label removes it everywhere.
    """
    if repositories.planning.get_project_label(context.workspace_id, label_id) is None:
        return 0
    cleared = 0
    for project in repositories.planning.list_projects(context.workspace_id):
        if label_id not in project.label_ids:
            continue
        kept = [value for value in project.label_ids if value != label_id]
        try:
            repositories.planning.replace_project(
                project.model_copy(update={"label_ids": kept}), keep_import_batch=True
            )
        except ConditionFailed:
            continue
        cleared += 1
    repositories.planning.delete_project_label(context.workspace_id, label_id)
    return cleared


def require_project_labels(repositories: Repositories, workspace_id: str, label_ids: Iterable[str]) -> None:
    """Refuse with a 422 a label id that names no project label of the workspace."""
    wanted = list(label_ids)
    if not wanted:
        return
    known = {label.label_id for label in repositories.planning.list_project_labels(workspace_id)}
    unknown = [label_id for label_id in wanted if label_id not in known]
    if unknown:
        raise unprocessable(f"Unknown project label: {unknown[0]}")


def label_values(raw: Optional[list[str]]) -> frozenset[Optional[str]]:
    """Label filter values as a set, `none` standing for a project with no label."""
    values: set[Optional[str]] = set()
    for item in raw or []:
        value = str(item).strip()
        if value:
            values.add(None if value == NO_LABEL else value)
    return frozenset(values)


def label_match(wanted: frozenset[Optional[str]], carried: Iterable[str]) -> bool:
    """Whether a project carrying `carried` passes a label filter: any named label, or none for `none`."""
    if not wanted:
        return True
    held = set(carried)
    if None in wanted and not held:
        return True
    return any(value in held for value in wanted if value is not None)


def label_scope(values: frozenset[Optional[str]]) -> str:
    """One label filter set spelled stably for a cursor scope."""
    return ",".join(sorted(NO_LABEL if value is None else value for value in values))
