"""The subscriber routes: who follows an issue, and following or leaving it.

Subscribing needs only read access to the issue, as in Linear: following an issue
changes nothing about it, so anyone who can see it may ask to hear about it. The
caller can only subscribe or unsubscribe themselves, which is why the write routes
address `me` rather than a user id. The logic lives in `app.common.issue_subscribers`
so the MCP tools run the same path.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.issues import SubscribersRead
from app.common.issue_subscribers import list_subscribers as list_subscribers_for
from app.common.issue_subscribers import subscribe as subscribe_caller
from app.common.issue_subscribers import unsubscribe as unsubscribe_caller

router = APIRouter()


@router.get("/{workspace_id}/issues/{issue_id}/subscribers", response_model=SubscribersRead)
def list_subscribers(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SubscribersRead:
    """Everyone following one issue the caller may read."""
    return list_subscribers_for(repositories, context, issue_id)


@router.put("/{workspace_id}/issues/{issue_id}/subscribers/me", response_model=SubscribersRead)
def subscribe(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SubscribersRead:
    """Follow the issue. Subscribing twice keeps the first subscription."""
    return subscribe_caller(repositories, context, issue_id)


@router.delete("/{workspace_id}/issues/{issue_id}/subscribers/me", response_model=SubscribersRead)
def unsubscribe(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SubscribersRead:
    """Stop following the issue. Unsubscribing when not subscribed is not an error."""
    return unsubscribe_caller(repositories, context, issue_id)
