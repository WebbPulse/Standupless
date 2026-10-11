"""Issue template routes: a team's templates, the workspace's, and a team's default.

A team's list is its own templates, its parent team's when the caller can see
the parent, and the workspace's, each tagged with the `scope` it came from. Any
team member may keep the team's templates, as in Linear; choosing the default
the create dialog opens with is a team admin's call, and the workspace's
templates are a workspace admin's.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status

from app.common import issue_templates
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.templates import (
    TemplateCreate,
    TemplateListRead,
    TemplateRead,
    TemplateSettingsRead,
    TemplateSettingsUpdate,
    TemplateUpdate,
)

router = APIRouter()


@router.get("/{workspace_id}/teams/{team_id}/templates", response_model=TemplateListRead)
def list_team_templates(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TemplateListRead:
    """Every template the team offers, its own, its parent's and the workspace's, and its default."""
    team_id = str(context.team_id)
    rows, default = issue_templates.list_team_templates(repositories, context, team_id)
    return TemplateListRead(
        templates=[TemplateRead.from_row(row, team_id) for row in rows], default_template_id=default
    )


@router.post(
    "/{workspace_id}/teams/{team_id}/templates",
    response_model=TemplateRead,
    status_code=status.HTTP_201_CREATED,
)
def create_team_template(
    payload: TemplateCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TemplateRead:
    """Add a template to the team, at the end of its list unless a position is given."""
    team_id = str(context.team_id)
    created = issue_templates.create_team_template(repositories, context, team_id, payload)
    return TemplateRead.from_row(created, team_id)


@router.patch("/{workspace_id}/teams/{team_id}/templates/{template_id}", response_model=TemplateRead)
def update_team_template(
    payload: TemplateUpdate,
    template_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TemplateRead:
    """Change, clear or move one of the team's own templates."""
    team_id = str(context.team_id)
    updated = issue_templates.update_team_template(repositories, context, team_id, template_id, payload)
    return TemplateRead.from_row(updated, team_id)


@router.delete(
    "/{workspace_id}/teams/{team_id}/templates/{template_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_team_template(
    template_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete one of the team's own templates."""
    issue_templates.delete_team_template(repositories, context, str(context.team_id), template_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/teams/{team_id}/template-settings", response_model=TemplateSettingsRead)
def read_template_settings(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TemplateSettingsRead:
    """The team's saved default template and the one its create dialog opens with."""
    stored, effective = issue_templates.template_settings(repositories, context, str(context.team_id))
    return TemplateSettingsRead.from_row(stored, effective)


@router.patch("/{workspace_id}/teams/{team_id}/template-settings", response_model=TemplateSettingsRead)
def update_template_settings(
    payload: TemplateSettingsUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TemplateSettingsRead:
    """Set or clear the template the team's create dialog opens with."""
    stored, effective = issue_templates.update_template_settings(repositories, context, str(context.team_id), payload)
    return TemplateSettingsRead.from_row(stored, effective)


@router.get("/{workspace_id}/templates", response_model=TemplateListRead)
def list_workspace_templates(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TemplateListRead:
    """Every workspace template, which every team offers."""
    rows = issue_templates.list_workspace_templates(repositories, context)
    return TemplateListRead(templates=[TemplateRead.from_row(row) for row in rows])


@router.post("/{workspace_id}/templates", response_model=TemplateRead, status_code=status.HTTP_201_CREATED)
def create_workspace_template(
    payload: TemplateCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TemplateRead:
    """Add a template every team offers."""
    return TemplateRead.from_row(issue_templates.create_workspace_template(repositories, context, payload))


@router.patch("/{workspace_id}/templates/{template_id}", response_model=TemplateRead)
def update_workspace_template(
    payload: TemplateUpdate,
    template_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TemplateRead:
    """Change, clear or move one workspace template."""
    updated = issue_templates.update_workspace_template(repositories, context, template_id, payload)
    return TemplateRead.from_row(updated)


@router.delete("/{workspace_id}/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace_template(
    template_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete one workspace template."""
    issue_templates.delete_workspace_template(repositories, context, template_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
