"""Reading and setting one person's subscription to a team's issue events.

Shared by the views route and the MCP tools so both hold the same rule: the
caller may only follow a team they can see, and a guest outside the team gets
the same 404 as for a team that never existed.
"""

from __future__ import annotations

from typing import Mapping

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.team_subscriptions import TeamNotificationSubscriptionRead
from app.common.db.dynamo.views import TEAM_SUBSCRIPTION_EVENTS, TeamNotificationSubscription
from app.common.issue_rules import require_team_reader


def _read(team_id: str, row: TeamNotificationSubscription | None) -> TeamNotificationSubscriptionRead:
    """The response body for one subscription row, every event off when there is none."""
    if row is None:
        return TeamNotificationSubscriptionRead(team_id=team_id)
    return TeamNotificationSubscriptionRead(
        team_id=team_id,
        issue_created=row.issue_created,
        triage=row.triage,
        completed=row.completed,
        cancelled=row.cancelled,
    )


def team_subscription(
    repositories: Repositories, context: AuthzContext, team_id: str
) -> TeamNotificationSubscriptionRead:
    """Which of one visible team's issue events reach the caller, or 404 when they cannot see it."""
    require_team_reader(repositories, context, team_id)
    return _read(team_id, repositories.views.get_team_subscription(context.workspace_id, team_id, context.user_id))


def set_team_subscription(
    repositories: Repositories, context: AuthzContext, team_id: str, events: Mapping[str, bool | None]
) -> TeamNotificationSubscriptionRead:
    """Turn the named events on or off for the caller, keeping the rest, and answer the result.

    Turning every event off removes the stored row, so the team's subscribers
    stay exactly the people who want to hear something.
    """
    require_team_reader(repositories, context, team_id)
    changes = {
        event: bool(value) for event, value in events.items() if event in TEAM_SUBSCRIPTION_EVENTS and value is not None
    }
    row = repositories.views.set_team_subscription(context.workspace_id, team_id, context.user_id, changes)
    return _read(team_id, row)
