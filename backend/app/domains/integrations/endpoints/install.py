"""The GitHub App install routes a workspace admin drives.

The install url carries a signed expiring `state` rather than the workspace id in
the clear, because GitHub hands that value back to a route which has no session and
cannot otherwise tell which workspace an installation belongs to. Anything weaker
would let somebody attach their own installation to another workspace by editing a
query parameter.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.core.config import settings
from app.domains.integrations import github_api
from app.domains.integrations.install_state import mint_state
from app.domains.integrations.schemas.integrations import (
    InstallationRead,
    InstallUrlRead,
    RepositoryLinkWrite,
    RepositoryRead,
)
from app.domains.integrations.service import not_configured, not_found, repository_read

router = APIRouter()


@router.get("/{workspace_id}/github/install-url", response_model=InstallUrlRead)
def get_install_url(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
) -> InstallUrlRead:
    """Where to send this admin to install the App on their GitHub account.

    The state is minted per request and expires in minutes, so a url copied out of
    a browser history is not a standing grant to bind an installation later.
    """
    if not settings.github_configured:
        raise not_configured()
    state, expires_at = mint_state(context.workspace_id, context.user_id)
    return InstallUrlRead(url=github_api.install_url(state), expires_at=expires_at)


@router.get("/{workspace_id}/github/installation", response_model=InstallationRead)
def get_installation(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> InstallationRead:
    """The installation this workspace has, a 404 when it has none, or a 503 with no App.

    The 503 is what lets the settings page say the environment has no App rather
    than offering a connect button that can only fail.
    """
    if not settings.github_configured:
        raise not_configured()
    installation = repositories.github.get_installation(context.workspace_id)
    if installation is None:
        raise not_found()
    linked = repositories.github.list_repositories(context.workspace_id)
    return InstallationRead(
        installation_id=installation.installation_id,
        account_login=installation.account_login,
        account_type=installation.account_type,
        repository_selection=installation.repository_selection,
        html_url=installation.html_url,
        manage_url=installation.html_url
        or github_api.manage_url(installation.installation_id, installation.account_login, installation.account_type),
        avatar_url=installation.avatar_url,
        suspended=installation.suspended_at is not None,
        installed_by=installation.installed_by,
        installed_at=installation.installed_at,
        repository_count=len(linked),
    )


@router.delete("/{workspace_id}/github/installation", status_code=status.HTTP_204_NO_CONTENT)
def delete_installation(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Forget the installation and its repositories on this side.

    This does not uninstall the App on GitHub, which only an account admin can do
    there; the frontend links out for that. Webhook endpoints are deliberately left
    alone, because they are a workspace's own outbound configuration and have
    nothing to do with GitHub.
    """
    if repositories.github.get_installation(context.workspace_id) is None:
        raise not_found()
    repositories.github.delete_installation(context.workspace_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/github/repositories", response_model=list[RepositoryRead])
def list_repositories(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> list[RepositoryRead]:
    """Every repository the installation can see, with the team it feeds."""
    rows = repositories.github.list_repositories(context.workspace_id)
    return [repository_read(row) for row in sorted(rows, key=lambda row: row.full_name)]


@router.patch("/{workspace_id}/github/repositories/{repository_id}", response_model=RepositoryRead)
def link_repository(
    repository_id: str,
    payload: RepositoryLinkWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> RepositoryRead:
    """Point one repository at one team, or clear the link.

    A repository with no team still receives events and still links issues, by
    matching every team's prefix; naming a team narrows that to one prefix,
    which is what a workspace with two teams sharing a number range wants.
    """
    if payload.team_id is not None:
        team = repositories.teams.get(context.workspace_id, payload.team_id)
        if team is None:
            raise not_found()
    updated = repositories.github.set_repository_team(context.workspace_id, repository_id, payload.team_id)
    if not updated:
        raise not_found()
    row = repositories.github.get_repository(context.workspace_id, repository_id)
    if row is None:
        raise not_found()
    return repository_read(row)
