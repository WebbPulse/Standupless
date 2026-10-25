"""Team notification routes: which of a team's issue events reach the caller's inbox.

Served under `/views` so the gateway's views prefix routes them to the domain
that owns the views table the subscriptions live in, beside saved view
subscriptions.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.team_subscriptions import (
    TeamNotificationSubscriptionRead,
    TeamNotificationSubscriptionUpdate,
)
from app.common.team_subscriptions import set_team_subscription, team_subscription

router = APIRouter()


@router.get(
    "/{workspace_id}/views/teams/{team_id}/subscription",
    response_model=TeamNotificationSubscriptionRead,
)
def get_team_subscription(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path(min_length=1)],
    team_id: Annotated[str, Path(min_length=1, max_length=64)],
) -> TeamNotificationSubscriptionRead:
    """Which of one team's issue events reach the caller, every one off until turned on.

    A 404 when the caller cannot see the team.
    """
    return team_subscription(repositories, context, team_id)


@router.put(
    "/{workspace_id}/views/teams/{team_id}/subscription",
    response_model=TeamNotificationSubscriptionRead,
)
def update_team_subscription(
    body: TeamNotificationSubscriptionUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path(min_length=1)],
    team_id: Annotated[str, Path(min_length=1, max_length=64)],
) -> TeamNotificationSubscriptionRead:
    """Turn the named team issue events on or off for the caller, keeping the ones left out.

    Turning all four off removes the subscription. A 404 when the caller cannot
    see the team.
    """
    return set_team_subscription(repositories, context, team_id, body.model_dump())
