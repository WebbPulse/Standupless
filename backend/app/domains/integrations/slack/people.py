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

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.slack import SlackInstallation
from app.domains.integrations.chat.people import WORKSPACE_ROLES, NotLinked, member_context
from app.domains.integrations.slack import install
from app.domains.integrations.slack.api import SlackError

__all__ = ["WORKSPACE_ROLES", "NotLinked", "context_for"]


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
    return member_context(repositories, installation.workspace_id, _email_of(profile))
