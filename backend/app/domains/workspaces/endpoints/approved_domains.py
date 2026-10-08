"""Approved email domain routes: manage the list, find workspaces to join, and join one.

The list is for a workspace owner or admin. The two join routes have no
membership to authorize against, so they read the caller's own claims, refuse any
delegated credential, and decide from the caller's verified email alone.

This router is included before the workspaces router, so `GET /joinable` is
matched before `GET /{workspace_id}` could read `joinable` as an id.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Response, status

from app.common import approved_domains
from app.common.api.dependencies.authz import AuthzContext, Capability, caller_claims, refuse_delegated_claims, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.approved_domains import (
    ApprovedDomainCreate,
    ApprovedDomainListRead,
    ApprovedDomainRead,
    JoinableWorkspaceListRead,
)
from app.common.api.schemas.workspaces import MemberRead
from app.domains.workspaces.endpoints.workspaces import refuse_deleted_caller

router = APIRouter()


@router.get("/joinable", response_model=JoinableWorkspaceListRead)
def list_joinable_workspaces(
    claims: Annotated[Any, Depends(caller_claims)],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> JoinableWorkspaceListRead:
    """Every workspace the caller's verified email domain may join and they are not in yet."""
    refuse_delegated_claims(claims)
    return approved_domains.joinable_workspaces(repositories, str(claims.get("sub", "")).strip())


@router.post("/{workspace_id}/join", response_model=MemberRead)
def join_workspace(
    workspace_id: Annotated[str, Path(min_length=1)],
    claims: Annotated[Any, Depends(caller_claims)],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    response: Response,
) -> MemberRead:
    """Join a workspace as a member through an approved email domain.

    Answers 201 for a new membership and 200 for one that already existed, and the
    same 404 for a workspace that does not exist as for one that does not approve
    the caller's domain.
    """
    refuse_delegated_claims(claims)
    subject = str(claims.get("sub", "")).strip()
    refuse_deleted_caller(repositories, subject)
    member, created = approved_domains.join_by_domain(repositories, subject, workspace_id)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return member


@router.get("/{workspace_id}/approved-domains", response_model=ApprovedDomainListRead)
def list_approved_domains(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ApprovedDomainListRead:
    """Every email domain whose verified addresses may join without an invite."""
    return approved_domains.list_approved_domains(repositories, context)


@router.post(
    "/{workspace_id}/approved-domains", response_model=ApprovedDomainRead, status_code=status.HTTP_201_CREATED
)
def add_approved_domain(
    payload: ApprovedDomainCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ApprovedDomainRead:
    """Approve the caller's own verified email domain. Public mail providers are refused."""
    return approved_domains.add_approved_domain(repositories, context, payload.domain)


@router.delete("/{workspace_id}/approved-domains/{domain}", status_code=status.HTTP_204_NO_CONTENT)
def remove_approved_domain(
    domain: Annotated[str, Path(min_length=1, max_length=254)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Stop approving a domain. People who already joined through it stay members."""
    approved_domains.remove_approved_domain(repositories, context, domain)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
