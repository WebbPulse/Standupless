"""Release routes: a team's record of what shipped where, and the pipeline of stages it ships through.

The logic lives in `app.common.releases` so the MCP tools and the GitHub deployment
source record releases through the same path. Reading needs only read access to the
team; recording and editing a release needs membership; changing the pipeline or
deleting a release needs a team administrator.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status
from webbpulse.http import CursorPage

from app.common import releases
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.releases import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    ReleaseCreate,
    ReleaseDetailRead,
    ReleaseIssuesAdd,
    ReleaseListRead,
    ReleasePipelineRead,
    ReleasePipelineUpdate,
    ReleaseRead,
    ReleaseStageAdvance,
    ReleaseUpdate,
)

router = APIRouter()

ReleaseId = Annotated[str, Path(min_length=1, max_length=64)]


@router.get("/{workspace_id}/teams/{team_id}/release-pipeline", response_model=ReleasePipelineRead)
def get_release_pipeline(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ReleasePipelineRead:
    """The team's ordered release stages, one Production stage when it configured none."""
    return releases.get_pipeline(repositories, context, str(context.team_id))


@router.put("/{workspace_id}/teams/{team_id}/release-pipeline", response_model=ReleasePipelineRead)
def set_release_pipeline(
    payload: ReleasePipelineUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ReleasePipelineRead:
    """Replace the team's release stages and the GitHub environments that reach each, as a team administrator."""
    return releases.set_pipeline(repositories, context, str(context.team_id), payload)


@router.get("/{workspace_id}/teams/{team_id}/releases", response_model=ReleaseListRead)
def list_releases(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[ReleaseRead]:
    """One page of the team's releases, newest first."""
    rows, next_cursor = releases.list_releases(repositories, context, str(context.team_id), cursor=cursor, limit=limit)
    return ReleaseListRead(items=rows, next_cursor=next_cursor)


@router.post(
    "/{workspace_id}/teams/{team_id}/releases",
    response_model=ReleaseDetailRead,
    status_code=status.HTTP_201_CREATED,
    responses={200: {"model": ReleaseDetailRead, "description": "The commit already had a release, now advanced."}},
)
def create_release(
    payload: ReleaseCreate,
    response: Response,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ReleaseDetailRead:
    """Record a release reaching a stage; a sha the team already released advances that release and answers 200."""
    detail, created = releases.create_release(repositories, context, str(context.team_id), payload)
    if not created:
        response.status_code = status.HTTP_200_OK
    return detail


@router.get("/{workspace_id}/teams/{team_id}/releases/{release_id}", response_model=ReleaseDetailRead)
def get_release(
    release_id: ReleaseId,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ReleaseDetailRead:
    """One release with its issues and notes."""
    return releases.get_release(repositories, context, str(context.team_id), release_id)


@router.patch("/{workspace_id}/teams/{team_id}/releases/{release_id}", response_model=ReleaseDetailRead)
def update_release(
    payload: ReleaseUpdate,
    release_id: ReleaseId,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ReleaseDetailRead:
    """Rename a release or change its version, description or link."""
    return releases.update_release(repositories, context, str(context.team_id), release_id, payload)


@router.delete("/{workspace_id}/teams/{team_id}/releases/{release_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_release(
    release_id: ReleaseId,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a release as a team administrator; the issues it carried are untouched."""
    releases.delete_release(repositories, context, str(context.team_id), release_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{workspace_id}/teams/{team_id}/releases/{release_id}/stages", response_model=ReleaseDetailRead)
def advance_release(
    payload: ReleaseStageAdvance,
    release_id: ReleaseId,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ReleaseDetailRead:
    """Mark a release as having reached a stage of the team's pipeline."""
    return releases.advance_release(repositories, context, str(context.team_id), release_id, payload)


@router.post("/{workspace_id}/teams/{team_id}/releases/{release_id}/issues", response_model=ReleaseDetailRead)
def add_release_issues(
    payload: ReleaseIssuesAdd,
    release_id: ReleaseId,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ReleaseDetailRead:
    """Add issues of the team to a release by key or id."""
    return releases.add_release_issues(repositories, context, str(context.team_id), release_id, payload.issues)


@router.delete(
    "/{workspace_id}/teams/{team_id}/releases/{release_id}/issues/{issue_ref}", response_model=ReleaseDetailRead
)
def remove_release_issue(
    release_id: ReleaseId,
    issue_ref: Annotated[str, Path(min_length=1, max_length=64)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ReleaseDetailRead:
    """Take one issue off a release, by key or id."""
    return releases.remove_release_issue(repositories, context, str(context.team_id), release_id, issue_ref)
