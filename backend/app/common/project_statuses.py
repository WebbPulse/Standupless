"""Project status list, create, patch and delete, shared by the project status routes and the MCP tools.

A workspace sets up its own project statuses, each a named stage inside one of
the six fixed categories, as Linear's project statuses are. A project row keeps
its category in `status`, which every rule reads, and the status itself in
`status_id`. A workspace that never edited its statuses reads six seeded
defaults whose ids are the category names, so a project row written before
custom statuses already points at its default and no row is migrated. The
first edit stores the defaults, then applies itself.

A status belongs to the workspace or to one team, as Linear's do. A workspace
status is offered to every project; a team status only to the projects on that
team, and that team's admins change it as well as the workspace's. The seeded
defaults are always workspace statuses, and a team adding its own does not
store them.

Each category keeps at least one workspace status. Deleting one moves its
projects onto a replacement in the same category, and deleting a team status
moves them onto the category's workspace default. A bare category value, or the
legacy `done`, resolves to the category's default: the seeded status when it is
still there, otherwise the first workspace status of the category.
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
from app.common.project_scopes import (
    clashing,
    findable_team_ids,
    listed,
    offered,
    require_listed_team,
    require_scope_admin,
)

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


def _ordered(rows: Iterable[ProjectStatusRow]) -> list[ProjectStatusRow]:
    """Statuses by category, the workspace's before each team's, then position, as the table lists them."""
    order = {category: index for index, category in enumerate(PROJECT_STATUSES)}
    return sorted(
        rows,
        key=lambda row: (
            order.get(row.category, len(order)),
            row.team_id is not None,
            row.team_id or "",
            row.position,
            row.status_id,
        ),
    )


def _has_workspace_rows(rows: Iterable[ProjectStatusRow]) -> bool:
    """Whether the workspace has stored its own statuses, rather than only some team's."""
    return any(row.team_id is None for row in rows)


def workspace_project_statuses(repositories: Repositories, workspace_id: str) -> list[ProjectStatusRow]:
    """Every project status of the workspace and its teams, the seeded defaults standing in before any edit."""
    stored = repositories.planning.list_project_statuses(workspace_id)
    if _has_workspace_rows(stored):
        return stored
    return _ordered([*default_project_statuses(workspace_id), *stored])


def _materialised(repositories: Repositories, workspace_id: str) -> list[ProjectStatusRow]:
    """Every stored project status, storing the seeded defaults first when the workspace has none of its own."""
    stored = repositories.planning.list_project_statuses(workspace_id)
    if _has_workspace_rows(stored):
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
    """The status a bare category lands on: the seeded one when kept, else the category's first workspace status.

    A team status is never a default, so a project lands the same way whichever
    teams it is on.
    """
    within = [row for row in statuses if row.category == category and row.team_id is None]
    for row in within:
        if row.status_id == category:
            return row
    return within[0] if within else None


def find_status(statuses: Iterable[ProjectStatusRow], status_id: str) -> Optional[ProjectStatusRow]:
    """The status with this id among those given, or None."""
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
    team_ids: Iterable[str],
    current: Optional[Project] = None,
) -> Optional[tuple[str, str]]:
    """The category and status id a create or patch lands on, or None when it names neither.

    `status_id` must name a status offered to a project on `team_ids`, the
    workspace's or one of those teams', and a `status` sent alongside must be its
    category. A bare `status` is a category: a patch that keeps the project in its
    current category keeps its status while it is still offered, and otherwise
    the category's default is taken. Either answers 422 on a value the project
    is not offered.
    """
    if status_id is None and status_value is None:
        return None
    statuses = offered(workspace_project_statuses(repositories, workspace_id), team_ids)
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


def list_project_statuses(
    repositories: Repositories, context: AuthzContext, team_id: Optional[str] = None
) -> ProjectStatusListRead:
    """The workspace's project statuses with those of one team, or of every team the caller finds.

    Each carries how many projects the caller can see sit in it. A team the
    caller cannot find answers a 404.
    """
    if team_id is not None:
        require_listed_team(repositories, context, team_id)
    statuses = workspace_project_statuses(repositories, context.workspace_id)
    visible = set(visible_team_ids(repositories, context))
    counts: dict[str, int] = {}
    for project in repositories.planning.list_projects(context.workspace_id):
        if not visible_project_teams(project, visible):
            continue
        row = status_of_project(statuses, project)
        if row is not None:
            counts[row.status_id] = counts.get(row.status_id, 0) + 1
    shown = listed(statuses, findable_team_ids(repositories, context), team_id)
    return ProjectStatusListRead(statuses=[_read(statuses, row, counts) for row in shown])


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
    """Put a status at a position within its category and scope, renumbering the others there to stay in order.

    The workspace's statuses and each team's are numbered apart, so a team
    reordering its own never moves the workspace's.
    """
    others = [
        row
        for row in statuses
        if row.category == moved.category and row.team_id == moved.team_id and row.status_id != moved.status_id
    ]
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
    """Add a project status to one category of the workspace or of one team, or 409 when its name is taken there."""
    team_id = payload.team_id
    if team_id is not None:
        require_listed_team(repositories, context, team_id)
    require_scope_admin(repositories, context, team_id)
    if team_id is None:
        statuses = _materialised(repositories, context.workspace_id)
    else:
        statuses = workspace_project_statuses(repositories, context.workspace_id)
    _check_unique(clashing(statuses, team_id), payload.name)
    status_id = new_planning_id()
    row = ProjectStatusRow(
        workspace_id=context.workspace_id,
        planning_key=project_status_key(status_id),
        status_id=status_id,
        name=payload.name,
        category=payload.category,
        color=payload.color,
        description=(payload.description or "").strip() or None,
        team_id=team_id,
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
    """Rename, recolour, redescribe or reorder a project status, or 404; a null colour or description clears it.

    The caller must administer the status's scope, the workspace or its team.
    """
    statuses, existing = _editable(repositories, context, status_id)
    given = payload.model_dump(exclude_unset=True)
    changes: dict[str, object] = {}
    if given.get("name") is not None and given["name"] != existing.name:
        if name_key(given["name"]) != name_key(existing.name):
            _check_unique(clashing(statuses, existing.team_id), given["name"], status_id)
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


def _editable(
    repositories: Repositories, context: AuthzContext, status_id: str
) -> tuple[list[ProjectStatusRow], ProjectStatusRow]:
    """Every status with the one about to change, once the caller is held to its scope, or a 404.

    Changing a workspace status stores the seeded defaults first, so the row
    being changed exists; changing a team status leaves them unstored.
    """
    statuses = workspace_project_statuses(repositories, context.workspace_id)
    existing = find_status(statuses, status_id)
    if existing is None:
        raise not_found()
    require_scope_admin(repositories, context, existing.team_id)
    if existing.team_id is not None:
        return statuses, existing
    statuses = _materialised(repositories, context.workspace_id)
    stored = find_status(statuses, status_id)
    if stored is None:
        raise not_found()
    return statuses, stored


def _replacement_for(
    statuses: list[ProjectStatusRow], existing: ProjectStatusRow, replacement_status_id: Optional[str]
) -> ProjectStatusRow:
    """The status a deleted one's projects move onto, or a 422.

    A workspace status is replaced by another workspace status of its category,
    the first by default, and the last one there cannot go. A team status is
    replaced by the category's workspace default, or by a named workspace status
    or other status of the same team in the category.
    """
    if existing.team_id is None:
        candidates = [
            row
            for row in statuses
            if row.category == existing.category and row.team_id is None and row.status_id != existing.status_id
        ]
        if not candidates:
            raise unprocessable("Each category keeps at least one project status")
        if replacement_status_id is None:
            return candidates[0]
    else:
        candidates = [
            row
            for row in statuses
            if row.category == existing.category
            and row.team_id in (None, existing.team_id)
            and row.status_id != existing.status_id
        ]
        if replacement_status_id is None:
            default = default_status_for(statuses, existing.category)
            if default is None:
                raise unprocessable("Each category keeps at least one project status")
            return default
    found = find_status(candidates, replacement_status_id)
    if found is None:
        raise unprocessable("replacement_status_id must name another project status in the same category")
    return found


def delete_project_status(
    repositories: Repositories,
    context: AuthzContext,
    status_id: str,
    replacement_status_id: Optional[str] = None,
) -> int:
    """Delete a project status and move its projects onto a replacement, answering how many moved.

    The replacement must sit in the same category, as `_replacement_for` picks
    it. The last workspace status of a category cannot be deleted. Every project
    of the workspace in the status is moved, seen by the caller or not. The
    caller must administer the status's scope, the workspace or its team.
    """
    statuses, existing = _editable(repositories, context, status_id)
    replacement = _replacement_for(statuses, existing, replacement_status_id)
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
    for number, row in enumerate(
        row for row in remaining if row.category == existing.category and row.team_id == existing.team_id
    ):
        if row.position != number:
            repositories.planning.put_project_status(row.model_copy(update={"position": number}), create=False)
    return moved
