"""Project to project dependencies, shared by the project routes and the MCP tools.

A dependency is stored once, in the blocks direction, in the planning partition,
so either project reads it as `blocks` or `blocked_by` from its own side. A link
is refused when it would point a project at itself or close a loop, because a
plan whose projects wait on each other can never start. Every reader sees only
the ends it may see, so a dependency on a project in a hidden team stays hidden.
"""

from __future__ import annotations

from collections.abc import Iterable

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.planning import ProjectRead, ProjectRelationCreate, ProjectRelationRead
from app.common.db.dynamo.planning import ProjectRelation, project_relation_key
from app.common.planning_rules import (
    load_readable_project,
    not_found,
    require_project_editor,
    unprocessable,
    visible_project_teams,
    visible_team_ids,
)

Dependencies = dict[str, tuple[list[str], list[str]]]
"""Each project's blockers and the projects it blocks, by project id."""


def dependency_map(relations: Iterable[ProjectRelation], visible_project_ids: set[str]) -> Dependencies:
    """Each visible project's blockers and blocked projects, keeping only links whose both ends are visible."""
    found: Dependencies = {}
    for relation in relations:
        blocker, blocked = relation.project_id, relation.target_project_id
        if blocker not in visible_project_ids or blocked not in visible_project_ids:
            continue
        found.setdefault(blocked, ([], []))[0].append(blocker)
        found.setdefault(blocker, ([], []))[1].append(blocked)
    return found


def with_dependencies(body: ProjectRead, dependencies: Dependencies) -> ProjectRead:
    """The response body with its blockers and blocked projects filled in."""
    blocked_by, blocking = dependencies.get(body.project_id, ([], []))
    body.blocked_by_project_ids = list(blocked_by)
    body.blocking_project_ids = list(blocking)
    return body


def visible_ends(repositories: Repositories, context: AuthzContext, project_id: str) -> set[str]:
    """The project and every project linked to it that the caller may see.

    Reads the related projects one by one rather than the whole workspace, since a
    single project has few dependencies.
    """
    visible = set(visible_team_ids(repositories, context))
    seen = {project_id}
    for relation in repositories.planning.list_project_relations(context.workspace_id):
        if not relation.involves(project_id):
            continue
        other = relation.target_project_id if relation.project_id == project_id else relation.project_id
        row = repositories.planning.get_project(context.workspace_id, other)
        if row is not None and visible_project_teams(row, visible):
            seen.add(other)
    return seen


def fill_one(repositories: Repositories, context: AuthzContext, body: ProjectRead) -> ProjectRead:
    """One project's response body with the dependencies the caller may see."""
    relations = repositories.planning.list_project_relations(context.workspace_id)
    ends = visible_ends(repositories, context, body.project_id)
    return with_dependencies(body, dependency_map(relations, ends))


def relation_read(relation: ProjectRelation, project_id: str) -> ProjectRelationRead:
    """One dependency as the path project reads it."""
    blocks = relation.project_id == project_id
    return ProjectRelationRead(
        relation_id=relation.relation_id,
        type="blocks" if blocks else "blocked_by",
        project_id=project_id,
        target_project_id=relation.target_project_id if blocks else relation.project_id,
        created_by=relation.created_by,
        created_at=relation.created_at,
    )


def list_relations(repositories: Repositories, context: AuthzContext, project_id: str) -> list[ProjectRelationRead]:
    """Every dependency of one readable project whose other end the caller may see, oldest first."""
    load_readable_project(repositories, context, project_id)
    ends = visible_ends(repositories, context, project_id)
    return [
        relation_read(relation, project_id)
        for relation in repositories.planning.list_project_relations(context.workspace_id)
        if relation.involves(project_id) and relation.project_id in ends and relation.target_project_id in ends
    ]


def would_loop(relations: Iterable[ProjectRelation], blocker_id: str, blocked_id: str) -> bool:
    """Whether `blocker_id` blocking `blocked_id` closes a loop, because `blocked_id` already reaches `blocker_id`."""
    edges: dict[str, list[str]] = {}
    for relation in relations:
        edges.setdefault(relation.project_id, []).append(relation.target_project_id)
    stack = [blocked_id]
    reached: set[str] = set()
    while stack:
        current = stack.pop()
        if current == blocker_id:
            return True
        if current in reached:
            continue
        reached.add(current)
        stack.extend(edges.get(current, []))
    return False


def create_relation(
    repositories: Repositories, context: AuthzContext, project_id: str, payload: ProjectRelationCreate
) -> tuple[ProjectRelationRead, bool]:
    """Link two projects, answering the dependency and whether it was new.

    Takes a writer on one of the path project's teams and read access to the
    target. Linking a pair that is already linked the same way answers the
    stored link, so a retry is harmless.
    """
    _, teams = load_readable_project(repositories, context, project_id)
    require_project_editor(repositories, context, teams)
    target_id = payload.target_project_id
    if target_id == project_id:
        raise unprocessable("A project cannot block itself")
    load_readable_project(repositories, context, target_id)
    blocker_id, blocked_id = (project_id, target_id) if payload.type == "blocks" else (target_id, project_id)

    existing = repositories.planning.get_project_relation(context.workspace_id, blocker_id, blocked_id)
    if existing is not None:
        return relation_read(existing, project_id), False
    relations = repositories.planning.list_project_relations(context.workspace_id)
    if would_loop(relations, blocker_id, blocked_id):
        raise unprocessable("That dependency would make the projects wait on each other")
    relation = ProjectRelation(
        workspace_id=context.workspace_id,
        planning_key=project_relation_key(blocker_id, blocked_id),
        project_id=blocker_id,
        target_project_id=blocked_id,
        created_by=context.user_id,
    )
    try:
        repositories.planning.create_project_relation(relation)
    except ConditionFailed as exc:
        stored = repositories.planning.get_project_relation(context.workspace_id, blocker_id, blocked_id)
        if stored is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"error_code": "CONFLICT", "message": "That dependency changed while it was being added"},
            ) from exc
        return relation_read(stored, project_id), False
    return relation_read(relation, project_id), True


def delete_relation(repositories: Repositories, context: AuthzContext, project_id: str, relation_id: str) -> str:
    """Remove one dependency of the path project, answering the project at its other end.

    Takes a writer on one of the path project's teams. A relation id that is not
    one of this project's dependencies reads as not found.
    """
    _, teams = load_readable_project(repositories, context, project_id)
    require_project_editor(repositories, context, teams)
    for relation in repositories.planning.list_project_relations(context.workspace_id):
        if relation.relation_id == relation_id and relation.involves(project_id):
            repositories.planning.delete(context.workspace_id, relation.planning_key)
            return relation.target_project_id if relation.project_id == project_id else relation.project_id
    raise not_found()
