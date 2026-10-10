"""Who a Slack person is in Standupless, decided afresh on every request.

A Slack user is matched to a Standupless account by the email Slack holds for
them, and only when Slack says that address is confirmed, so a person cannot act
as somebody else by typing their address into a Slack profile. The match then has
to be a live member of the workspace the Slack team is bound to, and the context
built here carries that member's own role and team access, so a command or a
shortcut can never do more than the same person could in the web app.
"""

from __future__ import annotations

from typing import Any, Mapping

from app.common import change_source
from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.slack import SlackInstallation
from app.domains.integrations.slack import install
from app.domains.integrations.slack.api import SlackError

WORKSPACE_ROLES = frozenset({"owner", "admin", "member", "guest"})


class NotLinked(Exception):
    """The Slack person has no Standupless account in this workspace that may act."""


def _email_of(profile: Mapping[str, Any]) -> str:
    """The confirmed email Slack holds for a person, or an empty string."""
    user = profile.get("user") or {}
    if not isinstance(user, Mapping):
        return ""
    if user.get("deleted") or user.get("is_bot") or user.get("is_restricted") or user.get("is_ultra_restricted"):
        return ""
    if user.get("is_email_confirmed") is False:
        return ""
    details = user.get("profile") or {}
    email = details.get("email", "") if isinstance(details, Mapping) else ""
    return str(email or "").strip().lower()


def context_for(repositories: Repositories, installation: SlackInstallation, slack_user_id: str) -> AuthzContext:
    """The authorization context of the Standupless member behind one Slack user, or `NotLinked`."""
    if not slack_user_id:
        raise NotLinked("no Slack user")
    try:
        profile = install.call(installation, "users.info", {"user": slack_user_id})
    except (SlackError, install.BotUnavailable) as error:
        raise NotLinked("Slack did not describe the user") from error
    email = _email_of(profile)
    if not email:
        raise NotLinked("no confirmed email")
    user = repositories.users.get_by_email(email)
    if user is None or user.disabled or user.purging_at is not None:
        raise NotLinked("no account")
    workspace_id = installation.workspace_id
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
