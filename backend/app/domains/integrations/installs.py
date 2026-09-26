"""Recording a GitHub App installation and keeping its repository rows current.

Shared by the callback, which records an install the first time, and the events
consumer, which keeps it current as repositories are added or removed and removes
it on uninstall. Both need the same write, and two spellings of it would drift.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Iterable, Mapping

from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import Installation, Repository_, install_key, repo_key
from app.domains.integrations import github_api

if TYPE_CHECKING:  # pragma: no cover
    from webbpulse.integrations.github import AppInstallation, GitHubAppClient

_log = logging.getLogger(__name__)


FRESHNESS_SKEW = timedelta(minutes=2)
"""How far GitHub's clock may lag this one when comparing an install to its state."""


class BindRejected(Exception):
    """An installation that cannot be bound to the workspace that asked, with the reason.

    `reason` is the outcome the settings page is sent back with, so it is one of a
    short fixed list rather than free text.
    """

    def __init__(self, reason: str) -> None:
        """Keep the outcome code as the message and as an attribute."""
        super().__init__(reason)
        self.reason = reason


def _stamp(details: object, name: str) -> datetime | None:
    """A timestamp field of an installation, or `None` when it is absent or unreadable.

    Read by name because GitHub reports `created_at` and `updated_at` on every
    installation while the shared `AppInstallation` does not carry them yet. An
    installation without them has no freshness to prove, so the check below fails
    closed to `stale` rather than binding something it cannot date.
    """
    value = getattr(details, name, None)
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _read_installation(client: GitHubAppClient, installation_id: str) -> AppInstallation:
    """The installation as GitHub reports it to this App, or `BindRejected`.

    Read with the App JWT, so an id that belongs to another App, or to nothing, is a
    404 here. That is what turns the unauthenticated `installation_id` GitHub puts in
    the redirect into something this product can trust.
    """
    try:
        details = client.get_app_installation(installation_id)
    except github_api.GitHubNotFound as error:
        raise BindRejected("not_found") from error
    app_id = str(details.app_id or "")
    if app_id and settings.GITHUB_APP_ID and app_id != str(settings.GITHUB_APP_ID):
        raise BindRejected("not_found")
    return details


def _gone(client: GitHubAppClient, installation_id: str) -> bool:
    """Whether GitHub answers that an installation no longer exists for this App."""
    try:
        _read_installation(client, installation_id)
    except BindRejected:
        return True
    except github_api.GitHubError:
        return False
    return False


def _installation_row(
    workspace_id: str,
    installation_id: str,
    details: AppInstallation,
    *,
    installed_by: str,
    installed_at: datetime | None,
) -> Installation:
    """The stored row for one installation, built from GitHub's own record of it."""
    account_login = details.account_login
    account_type = details.account_type or "Organization"
    html_url = details.html_url or github_api.manage_url(installation_id, account_login, account_type)
    return Installation(
        workspace_id=workspace_id,
        github_key=install_key(installation_id),
        installation_id=installation_id,
        account_login=account_login,
        account_type=account_type,
        repository_selection=details.repository_selection or "selected",
        html_url=html_url,
        avatar_url=details.account_avatar_url,
        installed_by=installed_by,
        installed_at=installed_at or utc_now(),
        suspended_at=details.suspended_at,
    )


def bind_installation(
    repositories: Repositories,
    workspace_id: str,
    installation_id: str,
    *,
    installed_by: str,
    state_issued_at: datetime,
    setup_action: str,
    user_verified: bool = False,
) -> str:
    """Bind a just finished install to the workspace whose signed state came back.

    Answers `installed` or `updated`, or raises `BindRejected` naming why not. The
    installation must be this App's, must not already belong to another workspace,
    and the workspace must not already hold a different one. An installation not yet
    bound anywhere must also have been created, or changed, after the state was
    minted: the redirect's `installation_id` is attacker controlled, and without
    that an admin could name somebody else's unclaimed installation and read its
    repositories into their own workspace. `user_verified` means GitHub confirmed,
    through the user authorization that followed the install, that the person who
    came back can reach this installation, which is the stronger proof and makes the
    freshness check unnecessary.

    A workspace still holding an installation GitHub no longer knows, because the
    uninstall webhook has not landed yet, is cleared so a reinstall can bind.
    """
    with github_api.app_client() as client:
        return _bind(
            client,
            repositories,
            workspace_id,
            installation_id,
            installed_by=installed_by,
            state_issued_at=state_issued_at,
            setup_action=setup_action,
            user_verified=user_verified,
        )


def _bind(
    client: GitHubAppClient,
    repositories: Repositories,
    workspace_id: str,
    installation_id: str,
    *,
    installed_by: str,
    state_issued_at: datetime,
    setup_action: str,
    user_verified: bool,
) -> str:
    """`bind_installation` against one open client, so every GitHub read shares its token."""
    details = _read_installation(client, installation_id)

    owner = repositories.github.installation_by_id(installation_id)
    if owner is not None and owner.workspace_id != workspace_id:
        raise BindRejected("taken")

    current = repositories.github.get_installation(workspace_id)
    if current is not None and current.installation_id != installation_id:
        if not _gone(client, current.installation_id):
            raise BindRejected("already_connected")
        remove_installation(repositories, workspace_id)

    if owner is None and not user_verified:
        floor = state_issued_at - FRESHNESS_SKEW
        created_at = _stamp(details, "created_at")
        updated_at = _stamp(details, "updated_at")
        stamp = created_at if setup_action == "install" else max(filter(None, (created_at, updated_at)), default=None)
        if stamp is None or stamp < floor:
            raise BindRejected("stale")
    if owner is None:
        row = _installation_row(workspace_id, installation_id, details, installed_by=installed_by, installed_at=None)
        try:
            repositories.github.create_installation(row)
        except ConditionFailed as error:
            raise BindRejected("taken") from error
        sync_repositories(repositories, workspace_id, installation_id, client=client)
        return "installed"

    row = _installation_row(
        workspace_id,
        installation_id,
        details,
        installed_by=owner.installed_by,
        installed_at=owner.installed_at,
    )
    repositories.github.put_installation(row)
    sync_repositories(repositories, workspace_id, installation_id, client=client)
    return "updated"


def refresh_installation(repositories: Repositories, installation_id: str) -> str:
    """Re-read a bound installation from GitHub after its settings changed there.

    Answers the workspace it belongs to, or an empty string when none does. Safe to
    run without a session because everything it writes comes from GitHub's answer to
    this App, never from the caller.
    """
    owner = repositories.github.installation_by_id(installation_id)
    if owner is None:
        return ""
    try:
        with github_api.app_client() as client:
            details = _read_installation(client, installation_id)
            repositories.github.put_installation(
                _installation_row(
                    owner.workspace_id,
                    installation_id,
                    details,
                    installed_by=owner.installed_by,
                    installed_at=owner.installed_at,
                )
            )
            sync_repositories(repositories, owner.workspace_id, installation_id, client=client)
    except (BindRejected, github_api.GitHubError):
        _log.warning(
            "Could not refresh a bound installation.",
            extra={"event": "integrations.install_refresh_failed"},
        )
    return owner.workspace_id


def set_suspended(repositories: Repositories, workspace_id: str, suspended_at: datetime | None) -> None:
    """Mark the workspace's installation suspended on GitHub, or clear the mark."""
    installation = repositories.github.get_installation(workspace_id)
    if installation is None:
        return
    repositories.github.put_installation(installation.model_copy(update={"suspended_at": suspended_at}))


def set_repository_selection(repositories: Repositories, workspace_id: str, selection: str) -> None:
    """Record whether the installation covers every repository or a chosen few."""
    installation = repositories.github.get_installation(workspace_id)
    if installation is None or not selection or installation.repository_selection == selection:
        return
    repositories.github.put_installation(installation.model_copy(update={"repository_selection": selection}))


def sync_repositories(
    repositories: Repositories,
    workspace_id: str,
    installation_id: str,
    *,
    client: GitHubAppClient | None = None,
) -> int:
    """Make the stored repository rows match what the installation can see.

    Rows for repositories the installation lost are removed, so an issue key in a
    repository somebody revoked stops moving issues. The `team_id` a person set
    on a surviving row is preserved, because refreshing the list is not a reason to
    forget which team a repository feeds.

    `client` is the caller's open client when it has one, so a bind reads the
    installation and its repositories on one token; without one a client is built
    for this call and closed with it.
    """
    try:
        if client is not None:
            remote = client.list_installation_repositories(installation_id)
        else:
            with github_api.app_client() as own:
                remote = own.list_installation_repositories(installation_id)
    except github_api.GitHubError:
        _log.warning(
            "Could not list installation repositories.",
            extra={"event": "integrations.repository_sync_failed"},
        )
        return 0

    existing = {str(row.repository_id): row for row in repositories.github.list_repositories(workspace_id)}
    seen: set[str] = set()
    for entry in remote:
        repository_id = str(entry.get("id", ""))
        if not repository_id:
            continue
        seen.add(repository_id)
        previous = existing.get(repository_id)
        repositories.github.put_repository(
            Repository_(
                workspace_id=workspace_id,
                github_key=repo_key(repository_id),
                repository_id=repository_id,
                installation_id=installation_id,
                full_name=str(entry.get("full_name", "")),
                name=str(entry.get("name", "")),
                private=bool(entry.get("private", True)),
                default_branch=str(entry.get("default_branch", "main")),
                team_id=previous.team_id if previous is not None else None,
                linked_at=previous.linked_at if previous is not None else utc_now(),
            )
        )

    for repository_id in set(existing) - seen:
        repositories.github.delete_repository(workspace_id, repository_id)

    return len(seen)


def apply_repository_changes(
    repositories: Repositories,
    workspace_id: str,
    installation_id: str,
    *,
    added: Iterable[Mapping[str, Any]],
    removed: Iterable[Mapping[str, Any]],
) -> None:
    """Apply an `installation_repositories` delta without a full refetch.

    The webhook carries the delta, so applying it directly keeps this off GitHub's
    API and out of its rate limit for what is a common event in a busy account.
    """
    for entry in added:
        repository_id = str(entry.get("id", ""))
        if not repository_id:
            continue
        previous = repositories.github.get_repository(workspace_id, repository_id)
        repositories.github.put_repository(
            Repository_(
                workspace_id=workspace_id,
                github_key=repo_key(repository_id),
                repository_id=repository_id,
                installation_id=installation_id,
                full_name=str(entry.get("full_name", "")),
                name=str(entry.get("name", "")),
                private=bool(entry.get("private", True)),
                default_branch=str(entry.get("default_branch", "main")),
                team_id=previous.team_id if previous is not None else None,
                linked_at=previous.linked_at if previous is not None else utc_now(),
            )
        )

    for entry in removed:
        repository_id = str(entry.get("id", ""))
        if repository_id:
            repositories.github.delete_repository(workspace_id, repository_id)


def remove_installation(repositories: Repositories, workspace_id: str) -> int:
    """Forget an installation and its repositories after an uninstall.

    Issue links are left in place: they are history of what happened, and deleting
    them would silently rewrite an issue's activity because somebody uninstalled an
    App. Webhook endpoints are left for the same reason they survive a manual
    disconnect, being the workspace's own outbound configuration.
    """
    return repositories.github.delete_installation(workspace_id)
