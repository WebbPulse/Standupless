"""Team visibility decided for a person other than the caller, outside a request.

`AuthzContext.can_see_team` decides for the caller from what authorization already
read. Choosing an assignee or a notification recipient decides for someone else,
so it reads that person's rows here instead, with the same rule: a guest needs a
membership of the team, and so does anyone on a private team.
"""

from __future__ import annotations

from collections.abc import Collection

from app.common.api.dependencies.repositories import Repositories


def needs_team_membership(repositories: Repositories, workspace_id: str, team_id: str, role: str) -> bool:
    """Whether a person with this workspace role reaches the team only through a membership."""
    return role == "guest" or repositories.memberships.is_private_team(workspace_id, team_id)


def person_can_see_team(repositories: Repositories, workspace_id: str, team_id: str, user_id: str) -> bool:
    """Whether one person of the workspace may read one team and its content."""
    if not workspace_id or not team_id or not user_id:
        return False
    membership = repositories.memberships.get(workspace_id, user_id)
    if membership is None:
        return False
    if not needs_team_membership(repositories, workspace_id, team_id, membership.role):
        return True
    return repositories.memberships.get_team_membership(workspace_id, team_id, user_id) is not None


def destination_can_carry(
    repositories: Repositories, workspace_id: str, team_id: str, created_by: str, private_team_ids: Collection[str]
) -> bool:
    """Whether an outbound destination set up on one team may still send that team's content.

    A destination on an open team always may. On a private team its creator must
    still be able to read the team, so one a workspace admin pointed at it from
    outside, or one whose creator has since left, stops sending.
    """
    if team_id not in private_team_ids:
        return True
    return person_can_see_team(repositories, workspace_id, team_id, created_by)
