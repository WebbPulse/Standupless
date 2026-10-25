"""Project status list, create, patch and delete, shared by the project status routes and the MCP tools.

A workspace sets up its own project statuses, each a named stage inside one of
the six fixed categories, as Linear's project statuses are. A project row keeps
its category in `status`, which every rule reads, and the status itself in
`status_id`. A workspace that never edited its statuses reads six seeded
defaults whose ids are the category names, so a project row written before
custom statuses already points at its default and no row is migrated. The
first edit stores the defaults, then applies itself.

Each category keeps at least one status. Deleting one moves its projects onto a
replacement in the same category. A bare category value, or the legacy `done`,
resolves to the category's default: the seeded status when it is still there,
otherwise the first status of the category.
"""

from __future__ import annotations

from typing import Iterable, Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.project_statuses import (
    ProjectStatusCreate,
    ProjectStatusListRead,
    ProjectStatusRead,
    ProjectStatusUpdate,
)
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import (
    LEGACY_PROJECT_STATUSES,
    PROJECT_STATUSES,
    Project,
    ProjectStatusRow,
    new_planning_id,
    project_status_key,
)
from app.common.labels import name_key
from app.common.planning_rules import not_found, unprocessable, visible_project_teams, visible_team_ids

DEFAULT_PROJECT_STATUS_NAMES: dict[str, str] = {
    "backlog": "Backlog",
    "planned": "Planned",
    "in_progress": "In progress",
    "paused": "Paused",
    "completed": "Completed",
    "canceled": "Canceled",
}
"""The seeded project statuses by category, each stored under its category as its id."""

CATEGORY_ALIASES: dict[str, str] = {**LEGACY_PROJECT_STATUSES, "started": "in_progress"}
"""Other spellings of a category a caller may send: the legacy `done` and Linear's `started`."""

CLOSED_CATEGORIES = frozenset({"completed", "canceled"})
"""The categories that close a project."""


def _conflict(name: str) -> HTTPException:
    """The 409 a project status name another project status holds gets."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "error_code": "CONFLICT",
            "message": f"A project status named {name} already exists",
            "details": {"name": name},
        },
    )


def default_project_statuses(workspace_id: str) -> list[ProjectStatusRow]:
    """The six seeded project statuses of a workspace that has not edited its own."""
    now = utc_now()
    return [
        ProjectStatusRow(
            workspace_id=workspace_id,
            status_id=category,
            name=DEFAULT_PROJECT_STATUS_NAMES[category],
            category=category,
            position=0,
            created_by="system",
            created_at=now,
            updated_at=now,
        )
        for category in PROJECT_STATUSES
    ]


def workspace_project_statuses(repositories: Repositories, workspace_id: str) -> list[ProjectStatusRow]:
    """The workspace's project statuses by category then position, the seeded defaults before any edit."""
    stored = repositories.planning.list_project_statuses(workspace_id)
    return stored or default_project_statuses(workspace_id)


def _materialised(repositories: Repositories, workspace_id: str) -> list[ProjectStatusRow]:
    """The workspace's stored project statuses, storing the seeded defaults first when none are."""
    stored = repositories.planning.list_project_statuses(workspace_id)
    if stored:
        return stored
    for row in default_project_statuses(workspace_id):
        try:
            repositories.planning.put_project_status(row, create=True)
        except ConditionFailed:
            continue
    return repositories.planning.list_project_statuses(workspace_id)


def category_of(value: str) -> Optional[str]:
    """The category a category value or one of its aliases names, or None."""
    candidate = value.strip().lower()
    candidate = CATEGORY_ALIASES.get(candidate, candidate)
    return candidate if candidate in PROJECT_STATUSES else None


def default_status_for(statuses: Iterable[ProjectStatusRow], category: str) -> Optional[ProjectStatusRow]:
    """The status a bare category lands on: the seeded one when kept, else the category's first."""
    within = [row for row in statuses if row.category == category]
    for row in within:
        if row.status_id == category:
            return row
    return within[0] if within else None


def find_status(statuses: Iterable[ProjectStatusRow], status_id: str) -> Optional[ProjectStatusRow]:
    """The workspace status with this id, or None."""
    for row in statuses:
        if row.status_id == status_id:
            return row
    return None


def resolve_status(
    statuses: list[ProjectStatusRow], value: str, *, by_name: bool = False
) -> Optional[ProjectStatusRow]:
    """The status a value names: its id, then its name when `by_name`, then the default of the category it spells."""
    candidate = value.strip()
    if not candidate:
        return None
    exact = find_status(statuses, candidate)
    if exact is not None:
        return exact
    if by_name:
        wanted = name_key(candidate)
        for row in statuses:
            if name_key(row.name) == wanted:
                return row
    category = category_of(candidate)
    return default_status_for(statuses, category) if category is not None else None


def status_of_project(statuses: list[ProjectStatusRow], project: Project) -> Optional[ProjectStatusRow]:
    """The status a project sits in, its category's default when its stored id is gone."""
    row = find_status(statuses, project.effective_status_id)
    if row is not None and row.category == project.status:
        return row
    return default_status_for(statuses, project.status)


def choose_project_status(
    repositories: Repositories,
    workspace_id: str,
    *,
    status_value: Optional[str],
    status_id: Optional[str],
    current: Optional[Project] = None,
) -> Optional[tuple[str, str]]:
    """The category and status id a create or patch lands on, or None when it names neither.

    `status_id` must name a workspace status, and a `status` sent alongside must be
    its category. A bare `status` is a category: a patch that keeps the project in
    its current category keeps its status, and otherwise the category's default
    is taken. Either answers 422 on a value the workspace does not know.
    """
    if status_id is None and status_value is None:
        return None
    statuses = workspace_project_statuses(repositories, workspace_id)
    if status_value is None or status_id is not None:
        row = find_status(statuses, status_id or "")
        if row is None:
            raise unprocessable(f"Unknown project status: {status_id}")
        if status_value is not None and category_of(status_value) != row.category:
            raise unprocessable(f"status {status_value} is not the category of project status {status_id}")
        return row.category, row.status_id
    category = category_of(status_value)
    if category is None:
        row = find_status(statuses, status_value)
        if row is None:
            raise unprocessable(f"Unknown project status: {status_value}")
        return row.category, row.status_id
    if current is not None and current.status == category:
        kept = status_of_project(statuses, current)
        if kept is not None:
            return category, kept.status_id
    default = default_status_for(statuses, category)
    if default is None:
        raise unprocessable(f"No project status in category {category}")
    return category, default.status_id


CATEGORY_FILTER_PREFIX = "category:"
"""The prefix that makes a status filter keep a whole category, its seeded default's id notwithstanding."""


def status_filter_match(statuses: list[ProjectStatusRow], value: str) -> tuple[str, str]:
    """What a status filter value keeps, as `("id", status_id)` or `("category", category)`, or 422.

    A value naming a workspace status keeps the projects in that status, a
    seeded default included; any other category value, such as `started`, `done`
    or a category whose seeded status is gone, keeps every project in the
    category, whatever its status, as does a `category:` prefix on any category.
    """
    candidate = value.strip()
    if candidate.startswith(CATEGORY_FILTER_PREFIX):
        named = category_of(candidate[len(CATEGORY_FILTER_PREFIX) :])
        if named is None:
            raise unprocessable(f"Unknown project status category: {value}")
        return "category", named
    exact = find_status(statuses, candidate)
    category = category_of(candidate)
    if exact is not None:
        return "id", exact.status_id
    if category is not None:
        return "category", category
    raise unprocessable(f"Unknown project status: {value}")


def project_in_filter(statuses: list[ProjectStatusRow], project: Project, wanted: tuple[str, str]) -> bool:
    """Whether a project passes one status filter from `status_filter_match`."""
    kind, value = wanted
    if kind == "category":
        return project.status == value
    row = status_of_project(statuses, project)
    return row is not None and row.status_id == value


def _read(statuses: list[ProjectStatusRow], row: ProjectStatusRow, counts: dict[str, int]) -> ProjectStatusRead:
    """One status as the API returns it."""
    default = default_status_for(statuses, row.category)
    is_default = default is not None and default.status_id == row.status_id
    return ProjectStatusRead.from_row(row, is_default=is_default, project_count=counts.get(row.status_id, 0))


def list_project_statuses(repositories: Repositories, context: AuthzContext) -> ProjectStatusListRead:
    """Every project status of the workspace, each with how many projects the caller can see sit in it."""
    statuses = workspace_project_statuses(repositories, context.workspace_id)
    visible = set(visible_team_ids(repositories, context))
    counts: dict[str, int] = {}
    for project in repositories.planning.list_projects(context.workspace_id):
        if not visible_project_teams(project, visible):
            continue
        row = status_of_project(statuses, project)
        if row is not None:
            counts[row.status_id] = counts.get(row.status_id, 0) + 1
    return ProjectStatusListRead(statuses=[_read(statuses, row, counts) for row in statuses])


def _check_unique(statuses: Iterable[ProjectStatusRow], name: str, exclude_status_id: Optional[str] = None) -> None:
    """Refuse with a 409 a name another project status already holds."""
    wanted = name_key(name)
    for row in statuses:
        if row.status_id != exclude_status_id and name_key(row.name) == wanted:
            raise _conflict(name.strip())


def _place(
    repositories: Repositories,
    statuses: list[ProjectStatusRow],
    moved: ProjectStatusRow,
    position: Optional[int],
) -> ProjectStatusRow:
    """Put a status at a position within its category, renumbering the category's others to stay in order."""
    others = [row for row in statuses if row.category == moved.category and row.status_id != moved.status_id]
    index = len(others) if position is None else max(0, min(position, len(others)))
    ordered = [*others[:index], moved, *others[index:]]
    now = utc_now()
    placed = moved
    for number, row in enumerate(ordered):
        if row.status_id == moved.status_id:
            placed = row.model_copy(update={"position": number})
            continue
        if row.position != number:
            repositories.planning.put_project_status(
                row.model_copy(update={"position": number, "updated_at": now}), create=False
            )
    return placed


def create_project_status(
    repositories: Repositories, context: AuthzContext, payload: ProjectStatusCreate
) -> ProjectStatusRead:
    """Add a project status to one category, or 409 when its name is taken."""
    statuses = _materialised(repositories, context.workspace_id)
    _check_unique(statuses, payload.name)
    status_id = new_planning_id()
    row = ProjectStatusRow(
        workspace_id=context.workspace_id,
        planning_key=project_status_key(status_id),
        status_id=status_id,
        name=payload.name,
        category=payload.category,
        color=payload.color,
        description=(payload.description or "").strip() or None,
        created_by=context.user_id,
    )
    row = _place(repositories, statuses, row, payload.position)
    try:
        repositories.planning.put_project_status(row, create=True)
    except ConditionFailed as exc:
        raise _conflict(payload.name) from exc
    return _read([*statuses, row], row, {})


def update_project_status(
    repositories: Repositories, context: AuthzContext, status_id: str, payload: ProjectStatusUpdate
) -> ProjectStatusRead:
    """Rename, recolour, redescribe or reorder a project status, or 404; a null colour or description clears it."""
    statuses = _materialised(repositories, context.workspace_id)
    existing = find_status(statuses, status_id)
    if existing is None:
        raise not_found()
    given = payload.model_dump(exclude_unset=True)
    changes: dict[str, object] = {}
    if given.get("name") is not None and given["name"] != existing.name:
        if name_key(given["name"]) != name_key(existing.name):
            _check_unique(statuses, given["name"], status_id)
        changes["name"] = given["name"]
    if "color" in given and given["color"] != existing.color:
        changes["color"] = given["color"]
    if "description" in given:
        description = (given["description"] or "").strip() or None
        if description != existing.description:
            changes["description"] = description
    updated = existing.model_copy(update=changes)
    if given.get("position") is not None and given["position"] != existing.position:
        updated = _place(repositories, statuses, updated, given["position"])
    if updated == existing:
        return _read(statuses, existing, {})
    updated = updated.model_copy(update={"updated_at": utc_now()})
    try:
        repositories.planning.put_project_status(updated, create=False)
    except ConditionFailed as exc:
        raise not_found() from exc
    refreshed = [updated if row.status_id == status_id else row for row in statuses]
    return _read(refreshed, updated, {})


def delete_project_status(
    repositories: Repositories,
    context: AuthzContext,
    status_id: str,
    replacement_status_id: Optional[str] = None,
) -> int:
    """Delete a project status and move its projects onto a replacement, answering how many moved.

    The replacement must sit in the same category, and defaults to the first other
    status there. The last status of a category cannot be deleted. Every project
    of the workspace in the status is moved, seen by the caller or not.
    """
    statuses = _materialised(repositories, context.workspace_id)
    existing = find_status(statuses, status_id)
    if existing is None:
        raise not_found()
    siblings = [row for row in statuses if row.category == existing.category and row.status_id != status_id]
    if not siblings:
        raise unprocessable("Each category keeps at least one project status")
    if replacement_status_id is None:
        replacement = siblings[0]
    else:
        found = find_status(siblings, replacement_status_id)
        if found is None:
            raise unprocessable("replacement_status_id must name another project status in the same category")
        replacement = found
    remaining = [row for row in statuses if row.status_id != status_id]
    moved = 0
    for project in repositories.planning.list_projects(context.workspace_id):
        if project.status != existing.category or project.effective_status_id != status_id:
            continue
        try:
            repositories.planning.replace_project(
                project.model_copy(update={"status_id": replacement.status_id}), keep_import_batch=True
            )
        except ConditionFailed:
            continue
        moved += 1
    repositories.planning.delete_project_status(context.workspace_id, status_id)
    for number, row in enumerate(row for row in remaining if row.category == existing.category):
        if row.position != number:
            repositories.planning.put_project_status(row.model_copy(update={"position": number}), create=False)
    return moved
