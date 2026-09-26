"""The subscriber routes: who follows an issue, and following or leaving it.

Subscribing needs only read access to the issue, as in Linear: following an issue
changes nothing about it, so anyone who can see it may ask to hear about it. The
caller can only subscribe or unsubscribe themselves, which is why the write routes
address `me` rather than a user id.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.domains.issues.schemas.subscribers import SubscriberRead, SubscribersRead
from app.domains.issues.service import load_visible_issue

router = APIRouter()


def _render(repositories: Repositories, context: AuthzContext, issue_id: str) -> SubscribersRead:
    """The issue's subscribers with their names, oldest subscription first."""
    rows = repositories.subscriptions.list_for_issue(context.workspace_id, issue_id)
    rows.sort(key=lambda row: row.created_at)
    users = repositories.users.get_many([row.user_id for row in rows]) if rows else {}
    subscribers = []
    for row in rows:
        user = users.get(row.user_id)
        name = (user.display_name or str(user.email).split("@", 1)[0]) if user is not None else ""
        subscribers.append(
            SubscriberRead(user_id=row.user_id, display_name=name, reason=row.reason, created_at=row.created_at)
        )
    return SubscribersRead(
        subscribers=subscribers,
        subscribed=any(row.user_id == context.user_id for row in rows),
    )


@router.get("/{workspace_id}/issues/{issue_id}/subscribers", response_model=SubscribersRead)
def list_subscribers(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SubscribersRead:
    """Everyone following one issue the caller may read."""
    load_visible_issue(repositories, context, issue_id)
    return _render(repositories, context, issue_id)


@router.put("/{workspace_id}/issues/{issue_id}/subscribers/me", response_model=SubscribersRead)
def subscribe(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SubscribersRead:
    """Follow the issue. Subscribing twice keeps the first subscription."""
    issue = load_visible_issue(repositories, context, issue_id)
    repositories.subscriptions.subscribe(context.workspace_id, issue_id, issue.team_id, context.user_id, "manual")
    return _render(repositories, context, issue_id)


@router.delete("/{workspace_id}/issues/{issue_id}/subscribers/me", response_model=SubscribersRead)
def unsubscribe(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SubscribersRead:
    """Stop following the issue. Unsubscribing when not subscribed is not an error."""
    load_visible_issue(repositories, context, issue_id)
    repositories.subscriptions.unsubscribe(context.workspace_id, issue_id, context.user_id)
    return _render(repositories, context, issue_id)
