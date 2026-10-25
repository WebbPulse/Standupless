"""Initiative routes: list, create, read, patch, delete, project membership and the update feed.

An initiative groups projects across teams, as in Linear, and may name a lead
team. Every rule lives in `app.common.initiative_writes`, which the MCP tools
share: a guest is refused, any other member reads and edits unless the lead team
is private and they are outside it, and the rollup counts only the projects the
caller can see.

Each initiative update carries the same thread a project update does: replies
and emoji reactions, on the update and on its replies. Anyone who reads the
initiative replies and reacts, and a reply is its author's, the initiative
owner's or a workspace admin's to edit or delete. Those rules live in
`app.common.initiative_update_threads`.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.planning import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    UPDATES_DEFAULT_LIMIT,
    InitiativeCreate,
    InitiativeListRead,
    InitiativeProgressRead,
    InitiativeRead,
    InitiativeUpdate,
    InitiativeUpdateCreate,
    InitiativeUpdateListRead,
    InitiativeUpdatePatch,
    InitiativeUpdateRead,
    ProjectRead,
)
from app.common.api.schemas.update_threads import (
    ProjectUpdateCommentCreate,
    ProjectUpdateCommentListRead,
    ProjectUpdateCommentPatch,
    ProjectUpdateCommentRead,
    ProjectUpdateReactionWrite,
)
from app.common.discussion_reads import ReactionGroupRead
from app.common.initiative_progress import initiative_progress
from app.common.initiative_update_threads import (
    add_initiative_update_reaction,
    create_initiative_update_comment,
    delete_initiative_update_comment,
    edit_initiative_update_comment,
    list_initiative_update_comments,
    remove_initiative_update_reaction,
)
from app.common.initiative_writes import (
    add_project_to_initiative,
    create_initiative,
    create_initiative_update,
    delete_initiative,
    delete_initiative_update,
    get_initiative,
    list_initiative_updates,
    list_initiatives,
    remove_project_from_initiative,
    update_initiative,
    update_initiative_update,
)

router = APIRouter()


@router.get("/{workspace_id}/initiatives", response_model=InitiativeListRead)
def list_initiative_page(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    status_filter: Annotated[Optional[str], Query(alias="status")] = None,
    team_id: Annotated[
        Optional[str],
        Query(min_length=1, description="Keep one lead team's initiatives, or `none` for the workspace level ones"),
    ] = None,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> Any:
    """One page of the initiatives the caller sees by target date, undated last, each rolled up."""
    rows, next_cursor = list_initiatives(
        repositories, context, status_filter=status_filter, team_filter=team_id, cursor=cursor, limit=limit
    )
    return InitiativeListRead(items=rows, next_cursor=next_cursor)


@router.post("/{workspace_id}/initiatives", response_model=InitiativeRead, status_code=status.HTTP_201_CREATED)
def create_initiative_row(
    payload: InitiativeCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> InitiativeRead:
    """Create an initiative with no projects yet."""
    return create_initiative(repositories, context, payload)


@router.get("/{workspace_id}/initiatives/{initiative_id}", response_model=InitiativeRead)
def read_initiative_row(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> InitiativeRead:
    """One initiative, rolled up from the projects the caller can see across its sub-initiatives."""
    return get_initiative(repositories, context, initiative_id)


@router.get("/{workspace_id}/initiatives/{initiative_id}/progress", response_model=InitiativeProgressRead)
def read_initiative_progress(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> InitiativeProgressRead:
    """Scope, started and completed work per day across the initiative and its sub-initiatives."""
    return initiative_progress(repositories, context, initiative_id)


@router.patch("/{workspace_id}/initiatives/{initiative_id}", response_model=InitiativeRead)
def update_initiative_row(
    payload: InitiativeUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> InitiativeRead:
    """Patch an initiative's fields; null clears the description, owner, team, health, date, cadence or parent."""
    return update_initiative(repositories, context, initiative_id, payload)


@router.delete("/{workspace_id}/initiatives/{initiative_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_initiative_row(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> Response:
    """Delete an initiative and its updates; its projects stay, outside any initiative."""
    delete_initiative(repositories, context, initiative_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{workspace_id}/initiatives/{initiative_id}/projects/{project_id}", response_model=ProjectRead)
def add_project(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> ProjectRead:
    """Put a project in an initiative, moving it out of any other; needs editor rights on the project."""
    return add_project_to_initiative(repositories, context, initiative_id, project_id)


@router.delete("/{workspace_id}/initiatives/{initiative_id}/projects/{project_id}", response_model=ProjectRead)
def remove_project(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> ProjectRead:
    """Take a project out of an initiative; needs editor rights on the project."""
    return remove_project_from_initiative(repositories, context, initiative_id, project_id)


@router.get("/{workspace_id}/initiatives/{initiative_id}/updates", response_model=InitiativeUpdateListRead)
def list_updates(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = UPDATES_DEFAULT_LIMIT,
) -> Any:
    """One page of an initiative's updates, newest first."""
    rows, next_cursor = list_initiative_updates(repositories, context, initiative_id, cursor=cursor, limit=limit)
    return InitiativeUpdateListRead(items=rows, next_cursor=next_cursor)


@router.post(
    "/{workspace_id}/initiatives/{initiative_id}/updates",
    response_model=InitiativeUpdateRead,
    status_code=status.HTTP_201_CREATED,
)
def create_update(
    payload: InitiativeUpdateCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> InitiativeUpdateRead:
    """Post an update, which sets the initiative's health to the one it reports."""
    return create_initiative_update(repositories, context, initiative_id, payload)


@router.patch("/{workspace_id}/initiatives/{initiative_id}/updates/{update_id}", response_model=InitiativeUpdateRead)
def update_update(
    payload: InitiativeUpdatePatch,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
) -> InitiativeUpdateRead:
    """Edit an update's body or health, as its author, the initiative's owner or a workspace admin."""
    return update_initiative_update(repositories, context, initiative_id, update_id, payload)


@router.delete(
    "/{workspace_id}/initiatives/{initiative_id}/updates/{update_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_update(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
) -> Response:
    """Delete an update, as its author, the initiative's owner or a workspace admin."""
    delete_initiative_update(repositories, context, initiative_id, update_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/{workspace_id}/initiatives/{initiative_id}/updates/{update_id}/comments",
    response_model=ProjectUpdateCommentListRead,
)
def list_update_replies(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
) -> ProjectUpdateCommentListRead:
    """Every reply on an initiative update, oldest first."""
    return ProjectUpdateCommentListRead(
        comments=list_initiative_update_comments(repositories, context, initiative_id, update_id)
    )


@router.post(
    "/{workspace_id}/initiatives/{initiative_id}/updates/{update_id}/comments",
    response_model=ProjectUpdateCommentRead,
    status_code=status.HTTP_201_CREATED,
)
def create_update_reply(
    payload: ProjectUpdateCommentCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
) -> ProjectUpdateCommentRead:
    """Reply on an initiative update, notifying its author, the owner, earlier repliers and anyone mentioned."""
    return create_initiative_update_comment(repositories, context, initiative_id, update_id, payload)


@router.patch(
    "/{workspace_id}/initiatives/{initiative_id}/updates/{update_id}/comments/{comment_id}",
    response_model=ProjectUpdateCommentRead,
)
def edit_update_reply(
    payload: ProjectUpdateCommentPatch,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
    comment_id: Annotated[str, Path()],
) -> ProjectUpdateCommentRead:
    """Edit a reply, as its author, the initiative owner or a workspace admin."""
    return edit_initiative_update_comment(repositories, context, initiative_id, update_id, comment_id, payload)


@router.delete(
    "/{workspace_id}/initiatives/{initiative_id}/updates/{update_id}/comments/{comment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_update_reply(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
    comment_id: Annotated[str, Path()],
) -> Response:
    """Delete a reply and its reactions, as its author, the initiative owner or a workspace admin."""
    delete_initiative_update_comment(repositories, context, initiative_id, update_id, comment_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put(
    "/{workspace_id}/initiatives/{initiative_id}/updates/{update_id}/reactions",
    response_model=ReactionGroupRead,
)
def add_update_reaction_route(
    payload: ProjectUpdateReactionWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
) -> ReactionGroupRead:
    """React to an initiative update, or to one of its replies when `comment_id` names one."""
    return add_initiative_update_reaction(repositories, context, initiative_id, update_id, payload)


@router.delete(
    "/{workspace_id}/initiatives/{initiative_id}/updates/{update_id}/reactions",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_update_reaction_route(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
    emoji: Annotated[str, Query(min_length=1, max_length=64)],
    comment_id: Annotated[Optional[str], Query()] = None,
) -> Response:
    """Take the caller's reaction off an initiative update or one of its replies."""
    remove_initiative_update_reaction(repositories, context, initiative_id, update_id, emoji, comment_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
