"""The Standupless member behind a confirmed email, as the chat Apps act for them.

Each App finds a confirmed email its own way, and both then need the same answer:
a live member of the bound workspace, carrying that member's own role and team
access, so a command can never do more than the same person could in the web app.
"""

from __future__ import annotations

from app.common import change_source
from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.memberships import WORKSPACE_ROLES


class NotLinked(Exception):
    """The chat person has no Standupless account in this workspace that may act."""


def member_context(repositories: Repositories, workspace_id: str, email: str) -> AuthzContext:
    """The authorization context of the live member with this confirmed email, or `NotLinked`."""
    address = email.strip().lower()
    if not address:
        raise NotLinked("no confirmed email")
    user = repositories.users.get_by_email(address)
    if user is None or user.disabled or user.purging_at is not None:
        raise NotLinked("no account")
    membership = repositories.memberships.get(workspace_id, user.id)
    if membership is None or membership.role not in WORKSPACE_ROLES:
        raise NotLinked("not a member")
    private = repositories.memberships.list_private_team_ids(workspace_id)
    team_ids: tuple[str, ...] = ()
    if membership.role == "guest" or private:
        team_ids = tuple(
            row.team_id
            for row in repositories.memberships.list_team_memberships_for_user(workspace_id, user.id)
            if row.team_id is not None
        )
    return AuthzContext(
        workspace_id=workspace_id,
        user_id=user.id,
        role=membership.role,
        team_ids=team_ids,
        private_team_ids=private,
        source=change_source.API,
    )
