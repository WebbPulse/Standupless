"""The product side of the GitHub App: a client per unit of work and the install links.

Every call to GitHub goes through `webbpulse.integrations.github`, which owns the App
JWT, the installation token exchange, paging, and the typed errors. What stays here is
what only this product knows: where an admin is sent to install the App, where they
manage an installation afterwards, and how a client is built for one unit of work.

A client is built per callback or per queued job and closed with it. The shared client
caches installation tokens on the instance, so a client that outlived the invocation
would keep an hour long credential in a warm container for no gain; one exchange per
unit of work is the price of never holding one.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from webbpulse.integrations.github import (
    GitHubAppClient,
    GitHubError,
    GitHubNotConfigured,
    GitHubNotFound,
    load_github_app_settings,
)

from app.common.core.config import settings

__all__ = [
    "GitHubError",
    "GitHubNotConfigured",
    "GitHubNotFound",
    "app_client",
    "install_url",
    "manage_url",
    "repository_names",
]


def app_client() -> GitHubAppClient:
    """A client for this environment's App, to be closed when the unit of work ends.

    The App id and private key resolve from the environment first and then the `app`
    secret, the same order the rest of the settings use. Raises `GitHubNotConfigured`,
    naming the missing keys and never their values, when the App has not been created
    or its secret has not been filled.
    """
    return GitHubAppClient.from_settings(load_github_app_settings(settings.APP_SECRETS_ARN or None))


def install_url(state: str) -> str:
    """Where a workspace admin is sent to install the App.

    Built from the slug rather than the App id because the slug is what the public
    install path takes, and it is a configuration value rather than a secret.
    """
    slug = settings.GITHUB_APP_SLUG
    if not slug:
        raise GitHubNotConfigured("this environment has no GitHub App slug")
    return f"https://github.com/apps/{slug}/installations/new?state={state}"


def manage_url(installation_id: str, account_login: str, account_type: str) -> str:
    """Where an account admin changes this installation's repository access on GitHub.

    An organization's installation lives under the organization's settings and a
    user's under their own, which is the same page GitHub reports as `html_url`.
    """
    if account_type == "Organization" and account_login:
        return f"https://github.com/organizations/{account_login}/settings/installations/{installation_id}"
    return f"https://github.com/settings/installations/{installation_id}"


def repository_names(repositories: Sequence[Mapping[str, Any]]) -> list[str]:
    """The full names of a repository list, for a log line that names no token."""
    return [str(item.get("full_name", "")) for item in repositories if item.get("full_name")]
