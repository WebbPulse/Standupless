"""Linking a team to a GitHub repository for two way issue sync, and the per-issue link.

The team link is read under the team, like the transition rules, because it is
configured on the team's settings page. The issue link is read under the issue so
the issue sidebar can show which GitHub issue it mirrors without knowing the team's
configuration.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import IssueSync, TeamSync, team_sync_key
from app.domains.integrations.schemas.integrations import IssueSyncRead, TeamSyncRead, TeamSyncWrite
from app.domains.integrations.service import conflict, not_found, unprocessable

router = APIRouter()


def _require_team(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the team exists in this workspace, or 404."""
    if repositories.teams.get(context.workspace_id, team_id) is None:
        raise not_found()


def team_sync_read(row: TeamSync) -> TeamSyncRead:
    """The public shape of one team's sync link."""
    return TeamSyncRead.model_validate(row.model_dump())


def issue_sync_read(row: IssueSync) -> IssueSyncRead:
    """The public shape of one issue's GitHub link."""
    return IssueSyncRead(
        issue_id=row.issue_id,
        repository_full_name=row.full_name,
        number=row.number,
        url=row.html_url,
        origin="standupless" if row.origin == "standupless" else "github",
        synced_at=row.synced_at,
    )


@router.get("/{workspace_id}/teams/{team_id}/github-sync", response_model=TeamSyncRead)
def get_team_sync(
    team_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamSyncRead:
    """The repository this team's issues sync with, or 404 when there is none."""
    _require_team(repositories, context, team_id)
    row = repositories.github.get_team_sync(context.workspace_id, team_id)
    if row is None:
        raise not_found()
    return team_sync_read(row)


@router.put("/{workspace_id}/teams/{team_id}/github-sync", response_model=TeamSyncRead)
def put_team_sync(
    team_id: Annotated[str, Path(min_length=1)],
    payload: TeamSyncWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamSyncRead:
    """Link this team to a repository the installation can see, or change the link.

    A repository already syncing with another team is refused with 409, because
    one GitHub issue cannot belong to two teams. Only issues opened after the link
    are imported; existing ones stay on GitHub.
    """
    _require_team(repositories, context, team_id)
    repository = repositories.github.get_repository(context.workspace_id, payload.repository_id)
    if repository is None:
        raise unprocessable("The GitHub App cannot see that repository.")
    now = utc_now()
    existing = repositories.github.get_team_sync(context.workspace_id, team_id)
    row = TeamSync(
        workspace_id=context.workspace_id,
        github_key=team_sync_key(team_id),
        team_id=team_id,
        repository_id=repository.repository_id,
        full_name=repository.full_name,
        direction=payload.direction,
        enabled=payload.enabled,
        sync_labels=payload.sync_labels,
        created_by=existing.created_by if existing is not None else context.user_id,
        created_at=existing.created_at if existing is not None else now,
        updated_at=now,
    )
    try:
        repositories.github.put_team_sync(row)
    except ConditionFailed:
        raise conflict("That repository already syncs with another team.") from None
    return team_sync_read(row)


@router.delete("/{workspace_id}/teams/{team_id}/github-sync", status_code=status.HTTP_204_NO_CONTENT)
def delete_team_sync(
    team_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Stop syncing this team. Issues already imported stay, and stop following GitHub."""
    _require_team(repositories, context, team_id)
    if not repositories.github.delete_team_sync(context.workspace_id, team_id):
        raise not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/issues/{issue_id}/github-sync", response_model=IssueSyncRead)
def get_issue_sync(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueSyncRead:
    """The GitHub issue this issue is synced with, or 404 when it has none.

    An issue in a team the caller is outside gives the same 404 as one with no
    link, so the answer confirms nothing about the id.
    """
    issue = repositories.issues.get(context.workspace_id, issue_id)
    if issue is None or not context.can_see_team(issue.team_id):
        raise not_found()
    row = repositories.github.get_issue_sync(context.workspace_id, issue_id)
    if row is None or row.state != "linked" or not row.number:
        raise not_found()
    return issue_sync_read(row)
