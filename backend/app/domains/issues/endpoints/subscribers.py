"""The subscriber routes: who follows an issue, and following or leaving it.

Subscribing needs only read access to the issue, as in Linear: following an issue
changes nothing about it, so anyone who can see it may ask to hear about it. The
write routes address a user id, where `me` is the caller; naming a teammate
subscribes or unsubscribes them, provided they can see the issue. The logic lives
in `app.common.issue_subscribers` so the MCP tools run the same path.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.issues import SubscribersRead
from app.common.issue_subscribers import list_subscribers as list_subscribers_for
from app.common.issue_subscribers import subscribe as subscribe_person
from app.common.issue_subscribers import unsubscribe as unsubscribe_person

router = APIRouter()


@router.get("/{workspace_id}/issues/{issue_id}/subscribers", response_model=SubscribersRead)
def list_subscribers(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SubscribersRead:
    """Everyone following one issue the caller may read."""
    return list_subscribers_for(repositories, context, issue_id)


@router.put("/{workspace_id}/issues/{issue_id}/subscribers/{user_id}", response_model=SubscribersRead)
def subscribe(
    issue_id: Annotated[str, Path(min_length=1)],
    user_id: Annotated[str, Path(min_length=1, description="The person to subscribe, or `me` for the caller.")],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SubscribersRead:
    """Subscribe the caller or a teammate who can see the issue. Subscribing twice keeps the first subscription."""
    return subscribe_person(repositories, context, issue_id, user_id)


@router.delete("/{workspace_id}/issues/{issue_id}/subscribers/{user_id}", response_model=SubscribersRead)
def unsubscribe(
    issue_id: Annotated[str, Path(min_length=1)],
    user_id: Annotated[str, Path(min_length=1, description="The person to unsubscribe, or `me` for the caller.")],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SubscribersRead:
    """Unsubscribe the caller or a teammate. Unsubscribing someone not subscribed is not an error."""
    return unsubscribe_person(repositories, context, issue_id, user_id)
