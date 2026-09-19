"""Recording a GitHub App installation and keeping its repository rows current.

Shared by the callback, which records an install the first time, and the events
consumer, which keeps it current as repositories are added or removed and removes
it on uninstall. Both need the same write, and two spellings of it would drift.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Mapping

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import Installation, Repository_, install_key, repo_key
from app.domains.integrations import github_api

_log = logging.getLogger(__name__)


def record_installation(
    repositories: Repositories,
    workspace_id: str,
    installation_id: str,
    *,
    installed_by: str,
) -> Installation:
    """Store the install row and one row per repository it can see.

    The repository list is fetched here rather than left to the first webhook,
    because a workspace that installs the App and sees an empty repository list
    would reasonably conclude the install failed.
    """
    account_login = ""
    account_type = "Organization"
    repository_selection = "selected"
    html_url = ""
    try:
        details = github_api.get_installation(installation_id)
        account = details.get("account") or {}
        if isinstance(account, Mapping):
            account_login = str(account.get("login", ""))
            account_type = str(account.get("type", "Organization"))
        repository_selection = str(details.get("repository_selection", "selected"))
        html_url = str(details.get("html_url", ""))
    except github_api.GithubError:
        _log.warning(
            "Could not read the installation account.",
            extra={"event": "integrations.install_account_unavailable"},
        )

    installation = Installation(
        workspace_id=workspace_id,
        github_key=install_key(installation_id),
        installation_id=installation_id,
        account_login=account_login,
        account_type=account_type,
        repository_selection=repository_selection,
        html_url=html_url,
        installed_by=installed_by,
        installed_at=utc_now(),
    )
    repositories.github.create_installation(installation)
    sync_repositories(repositories, workspace_id, installation_id)
    return installation


def sync_repositories(repositories: Repositories, workspace_id: str, installation_id: str) -> int:
    """Make the stored repository rows match what the installation can see.

    Rows for repositories the installation lost are removed, so an issue key in a
    repository somebody revoked stops moving issues. The `project_id` a person set
    on a surviving row is preserved, because refreshing the list is not a reason to
    forget which project a repository feeds.
    """
    try:
        remote = github_api.list_installation_repositories(installation_id)
    except github_api.GithubError:
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
                project_id=previous.project_id if previous is not None else None,
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
                project_id=previous.project_id if previous is not None else None,
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
