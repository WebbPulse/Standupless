"""Project routes: create, read, list, update and delete a project.

Reading and listing go through the authorization dependency, which is what makes
a guest see only the projects they hold a membership in. The list route filters
with `AuthzContext.can_see_project` rather than a query of its own, so the same
decision that guards a single project guards the collection.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from webbpulse.dynamodb import ConditionFailed, TransactionCanceled

from app.common.api.dependencies.authz import (
    IMPLIED_PROJECT_ROLE,
    AuthzContext,
    Capability,
    require,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.memberships import Membership, project_member_key
from app.common.db.dynamo.projects import Project, new_project_id
from app.domains.projects.schemas.project import (
    ProjectCreate,
    ProjectListRead,
    ProjectRead,
    ProjectUpdate,
)

router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

PREFIX_TAKEN = {"error_code": "CONFLICT", "message": "That project key prefix is in use"}


@router.get("/{workspace_id}/projects", response_model=ProjectListRead)
def list_projects(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ProjectListRead:
    """Every project in the workspace the caller may see.

    A guest sees only the projects they are a member of, which is the same rule
    the single project route applies, read off the context rather than repeated.
    """
    projects = repositories.projects.list_for_workspace(context.workspace_id)
    visible = [project for project in projects if context.can_see_project(project.project_id)]
    roles = _project_roles(repositories, context, [p.project_id for p in visible])
    return ProjectListRead(projects=[ProjectRead.from_row(p, roles.get(p.project_id)) for p in visible])


@router.post("/{workspace_id}/projects", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_CREATE))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ProjectRead:
    """Create a project, make the caller its admin and seed the default statuses.

    All three land as one `TransactWriteItems` across the three tables, seven items
    in total, because a project written without its statuses is unusable and cannot
    be recreated: the prefix is taken, so a retry 409s while issue creation 422s on
    the missing statuses. All or nothing means a failure leaves the prefix free.
    """
    project = Project(
        workspace_id=context.workspace_id,
        project_id=new_project_id(),
        name=payload.name,
        key_prefix=payload.key_prefix,
        estimate_scale=payload.estimate_scale,
    )
    membership = Membership(
        workspace_id=context.workspace_id,
        member_key=project_member_key(project.project_id, context.user_id),
        user_id=context.user_id,
        role="admin",
        project_id=project.project_id,
    )
    statuses = repositories.project_config.default_statuses(context.workspace_id, project.project_id)
    try:
        actions = [
            repositories.projects.create_action(project),
            repositories.memberships.put_action(membership),
            *(repositories.project_config.create_status_action(row) for row in statuses),
        ]
        repositories.projects.transact_write(actions)
    except ConditionFailed as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PREFIX_TAKEN) from exc
    except TransactionCanceled as exc:
        if not exc.conditional_check_failed:
            raise
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PREFIX_TAKEN) from exc
    return ProjectRead.from_row(project, "admin")


@router.get("/{workspace_id}/projects/{project_id}", response_model=ProjectRead)
def read_project(
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ProjectRead:
    """One project the caller may read, carrying their project role."""
    project = _load(repositories, context)
    return ProjectRead.from_row(project, context.project_role)


@router.patch("/{workspace_id}/projects/{project_id}", response_model=ProjectRead)
def update_project(
    payload: ProjectUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ProjectRead:
    """Change a project's name, description or estimate scale."""
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not attributes:
        return ProjectRead.from_row(_load(repositories, context), context.project_role)

    updated = repositories.projects.update(context.workspace_id, str(context.project_id), **attributes)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return ProjectRead.from_row(updated, context.project_role)


@router.delete("/{workspace_id}/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_DELETE))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a project and the configuration and counters that hang off it.

    The project row goes last, so a crash leaves an empty project rather than
    orphaned statuses nothing can reach.
    """
    project_id = str(context.project_id)
    repositories.project_config.delete_for_project(context.workspace_id, project_id)
    repositories.counters.delete_for_project(context.workspace_id, project_id)
    repositories.projects.delete(context.workspace_id, project_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _load(repositories: Repositories, context: AuthzContext) -> Project:
    """The project named in the path, or a 404.

    Authorization has already run, so a missing row here means the project was
    deleted between the membership read and this one.
    """
    project = repositories.projects.get(context.workspace_id, str(context.project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return project


def _project_roles(repositories: Repositories, context: AuthzContext, project_ids: list[str]) -> dict[str, str]:
    """The caller's role on each listed project, explicit membership winning.

    A workspace owner or admin implies project admin, and a member implies project
    member, which is the mapping the contract states for the `role` field.
    """
    implied = IMPLIED_PROJECT_ROLE.get(context.role)
    roles: dict[str, str] = {}
    if implied is not None:
        roles = {project_id: implied for project_id in project_ids}

    memberships = repositories.memberships.list_project_memberships_for_user(context.workspace_id, context.user_id)
    for membership in memberships:
        if membership.project_id in project_ids:
            roles[membership.project_id] = membership.role
    return roles
