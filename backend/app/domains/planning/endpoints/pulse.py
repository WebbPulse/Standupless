"""Pulse routes: the feed of followed project and initiative updates, its unread state and follows.

The feed is the caller's own, so every route reads as the caller and none take
another person's id. Following a project needs only that the caller may read
it, and following an initiative that they are not a guest. The rules live in
`app.common.pulse`, which the MCP tools and the email digest share.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Path, Query

from app.common import pulse, pulse_reads
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.planning import (
    PulseCountRead,
    PulseFollowRead,
    PulseListRead,
    PulseReadMarker,
    PulseScopeField,
)

router = APIRouter()


@router.get("/{workspace_id}/pulse", response_model=PulseListRead)
def list_pulse(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    scope: Annotated[PulseScopeField, Query()] = "for_me",
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=pulse.MAX_LIMIT)] = pulse.DEFAULT_LIMIT,
) -> Any:
    """One page of the caller's Pulse: what they follow, everything they may read, or recent updates by engagement."""
    items, next_cursor = pulse_reads.list_pulse(repositories, context, scope=scope, cursor=cursor, limit=limit)
    return PulseListRead(items=items, next_cursor=next_cursor)


@router.get("/{workspace_id}/pulse/count", response_model=PulseCountRead)
def count_pulse(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> PulseCountRead:
    """How many entries of the caller's "for me" Pulse are unread, which the sidebar badge shows."""
    return PulseCountRead(unread=pulse_reads.unread_count(repositories, context))


@router.post("/{workspace_id}/pulse/read", response_model=PulseReadMarker)
def read_pulse(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> PulseReadMarker:
    """Mark everything in the caller's Pulse read as of now."""
    return PulseReadMarker(read_at=pulse_reads.mark_read(repositories, context))


@router.get("/{workspace_id}/projects/{project_id}/follow", response_model=PulseFollowRead)
def get_project_follow(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> PulseFollowRead:
    """Whether the caller follows a project in Pulse, and whether that is their own choice."""
    return pulse_reads.project_follow(repositories, context, project_id)


@router.put("/{workspace_id}/projects/{project_id}/follow", response_model=PulseFollowRead)
def follow_project(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> PulseFollowRead:
    """Follow a project, so its updates, health changes and milestones reach the caller's Pulse."""
    return pulse_reads.set_project_follow(repositories, context, project_id, True)


@router.delete("/{workspace_id}/projects/{project_id}/follow", response_model=PulseFollowRead)
def unfollow_project(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> PulseFollowRead:
    """Unfollow a project, even one the caller leads or is a member of."""
    return pulse_reads.set_project_follow(repositories, context, project_id, False)


@router.get("/{workspace_id}/initiatives/{initiative_id}/follow", response_model=PulseFollowRead)
def get_initiative_follow(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> PulseFollowRead:
    """Whether the caller follows an initiative in Pulse, and whether that is their own choice."""
    return pulse_reads.initiative_follow(repositories, context, initiative_id)


@router.put("/{workspace_id}/initiatives/{initiative_id}/follow", response_model=PulseFollowRead)
def follow_initiative(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> PulseFollowRead:
    """Follow an initiative, and with it every project inside it the caller has not unfollowed."""
    return pulse_reads.set_initiative_follow(repositories, context, initiative_id, True)


@router.delete("/{workspace_id}/initiatives/{initiative_id}/follow", response_model=PulseFollowRead)
def unfollow_initiative(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> PulseFollowRead:
    """Unfollow an initiative, even one the caller owns."""
    return pulse_reads.set_initiative_follow(repositories, context, initiative_id, False)
