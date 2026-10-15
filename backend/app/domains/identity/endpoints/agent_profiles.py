"""The caller's private agent profiles, for the account settings page and the CLI.

Every route reads the caller's own partition, so there is no way to name another
person's profile. A signed in session passes unrestricted; a personal API key, which
is what the CLI carries, must hold `settings:read` to list or restore and
`settings:write` to delete. Saving goes through the MCP tool, which is where an
agent holding the local files already is.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response, status
from webbpulse.audit import AuditActor

from app.common import agent_profiles
from app.common.api.dependencies.authz import caller_person_with, request_context
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.agent_profiles import (
    AgentProfileActivityRead,
    AgentProfileListRead,
    AgentProfileSnapshotRead,
    AgentProfileVersionListRead,
)

router = APIRouter()

ProfileName = Annotated[str, Path(..., min_length=1, max_length=128)]

Reader = Annotated[str, Depends(caller_person_with("settings:read"))]

Writer = Annotated[str, Depends(caller_person_with("settings:write"))]


def _actor(request: Request, subject: str) -> AuditActor:
    """The caller as their own trail records them, with the client and address they came from."""
    context = request_context(request, "", subject, "")
    return AuditActor(id=subject, kind=context.actor.value, source=context.source, ip=context.ip, amr=context.amr)


def _refusal(exc: agent_profiles.AgentProfileError) -> HTTPException:
    """The store's refusal in the platform error envelope."""
    return HTTPException(status_code=exc.status, detail={"error_code": exc.code, "message": exc.message})


@router.get("/me/agent-profiles", response_model=AgentProfileListRead)
def list_my_agent_profiles(
    subject: Reader,
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> AgentProfileListRead:
    """Every agent profile the caller keeps, in name order."""
    return agent_profiles.list_profiles(repositories, subject)


@router.get("/me/agent-profiles/activity", response_model=AgentProfileActivityRead)
def list_my_agent_profile_activity(
    subject: Reader,
    repositories: Annotated[Repositories, Depends(get_repositories)],
    limit: int = Query(50, ge=1, le=100),
    cursor: Optional[str] = Query(None, max_length=2048),
) -> AgentProfileActivityRead:
    """The caller's own saves, restores and deletes, newest first."""
    return agent_profiles.list_activity(repositories, subject, limit=limit, cursor=cursor)


@router.get("/me/agent-profiles/{name}/versions", response_model=AgentProfileVersionListRead)
def list_my_agent_profile_versions(
    name: ProfileName,
    subject: Reader,
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> AgentProfileVersionListRead:
    """One profile's kept versions, newest first."""
    try:
        return agent_profiles.list_versions(repositories, subject, name)
    except agent_profiles.AgentProfileError as exc:
        raise _refusal(exc) from exc


@router.get("/me/agent-profiles/{name}", response_model=AgentProfileSnapshotRead)
def get_my_agent_profile(
    name: ProfileName,
    request: Request,
    subject: Reader,
    repositories: Annotated[Repositories, Depends(get_repositories)],
    version: Optional[str] = Query(None, max_length=16, description="A version number, or latest."),
) -> AgentProfileSnapshotRead:
    """One version's files, the latest unless named, recorded on the trail as a restore."""
    try:
        return agent_profiles.read_profile(repositories, subject, name, version, _actor(request, subject))
    except agent_profiles.AgentProfileError as exc:
        raise _refusal(exc) from exc


@router.delete("/me/agent-profiles/{name}", status_code=status.HTTP_204_NO_CONTENT)
def delete_my_agent_profile(
    name: ProfileName,
    request: Request,
    subject: Writer,
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a profile and every kept version of it."""
    try:
        agent_profiles.delete_profile(repositories, subject, name, _actor(request, subject))
    except agent_profiles.AgentProfileError as exc:
        raise _refusal(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
