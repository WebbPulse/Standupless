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

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.core.config import settings
from app.common.db.dynamo.github import LabelSetSetting
from app.domains.integrations import github_api
from app.domains.integrations.install_state import mint_state
from app.domains.integrations.schemas.integrations import (
    InstallationRead,
    InstallUrlRead,
    LabelSetRead,
    LabelSetWrite,
    RepositoryLinkWrite,
    RepositoryRead,
)
from app.domains.integrations.service import not_configured, not_found, repository_read, require_team_content
from app.domains.integrations.team_sync import record_pin

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
    """The installation this workspace has, a 404 when it has none, or a 409 with no App.

    The 409 NOT_CONFIGURED is what lets the settings page say the environment has no App rather
    than offering a connect button that can only fail.
    """
    if not settings.github_configured:
        raise not_configured()
    installation = repositories.github.get_installation(context.workspace_id)
    if installation is None:
        raise not_found()
    linked = repositories.github.list_repositories(context.workspace_id)
    label_set = repositories.github.get_label_set(context.workspace_id) or LabelSetSetting(
        workspace_id=context.workspace_id
    )
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
        label_set=LabelSetRead(enabled=label_set.enabled, include_public=label_set.include_public),
    )


@router.put("/{workspace_id}/github/installation/label-set", response_model=LabelSetRead)
def put_label_set(
    payload: LabelSetWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelSetRead:
    """Turn the workspace label set push on or off, a 404 with no installation, or a 409 with no App.

    Turning it on, or widening it to public repositories, queues a push to every
    repository the installation can see. Turning it off stops later pushes and
    deletes nothing on GitHub.
    """
    from app.domains.integrations.label_set import queue_push

    if not settings.github_configured:
        raise not_configured()
    installation = repositories.github.get_installation(context.workspace_id)
    if installation is None:
        raise not_found()
    existing = repositories.github.get_label_set(context.workspace_id)
    before = {
        "enabled": existing.enabled if existing is not None else False,
        "include_public": existing.include_public if existing is not None else False,
    }
    row = repositories.github.put_label_set(
        LabelSetSetting(
            workspace_id=context.workspace_id,
            enabled=payload.enabled,
            include_public=payload.include_public,
            updated_by=context.user_id,
        )
    )
    after = {"enabled": row.enabled, "include_public": row.include_public}
    changed = [name for name in after if before[name] != after[name]]
    if changed:
        audit.record(
            repositories,
            context,
            "github.label_set_updated",
            target_type="github",
            target_id=installation.installation_id,
            target_label=installation.account_login,
            before={name: before[name] for name in changed},
            after={name: after[name] for name in changed},
        )
    widened = row.enabled and (not before["enabled"] or (row.include_public and not before["include_public"]))
    queued = queue_push(context.workspace_id) if widened else False
    return LabelSetRead(enabled=row.enabled, include_public=row.include_public, queued=queued)


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
    """Point one repository at one team, or clear the link, and choose what records its releases.

    A repository links issues by matching every team's prefix, pinned or not;
    naming a team only chooses whose releases it feeds. A body naming only
    `release_source` keeps the team.
    """
    from app.domains.integrations.tag_releases import resolve_release_source

    sets_team = "team_id" in payload.model_fields_set or payload.release_source is None
    if sets_team and payload.team_id is not None:
        team = repositories.teams.get(context.workspace_id, payload.team_id)
        if team is None:
            raise not_found()
        require_team_content(context, payload.team_id)
    current = repositories.github.get_repository(context.workspace_id, repository_id)
    if current is None:
        raise not_found()
    team_id = payload.team_id if sets_team else current.team_id
    source = None
    if payload.release_source is not None:
        if team_id is not None:
            require_team_content(context, team_id)
        source = resolve_release_source(
            repositories,
            context.workspace_id,
            team_id,
            kind=payload.release_source.kind,
            tag_pattern=payload.release_source.tag_pattern,
            status=payload.release_source.status,
            move_issues=payload.release_source.move_issues,
        )
    if sets_team and not repositories.github.set_repository_team(context.workspace_id, repository_id, team_id):
        raise not_found()
    if source is not None and not repositories.github.set_repository_release_source(
        context.workspace_id, repository_id, source
    ):
        raise not_found()
    row = repositories.github.get_repository(context.workspace_id, repository_id)
    if row is None:
        raise not_found()
    if sets_team:
        record_pin(repositories, context, repository_id, row.full_name, current.team_id, row.team_id)
    return repository_read(row)
