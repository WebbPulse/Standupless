"""Linking a team to a GitHub repository for two way issue sync, and the per-issue link.

The team link is read under the team, like the transition rules, because it is
configured on the team's settings page. The issue link is read under the issue so
the issue sidebar can show which GitHub issue it mirrors without knowing the team's
configuration.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.github import IssueSync
from app.domains.integrations.schemas.integrations import IssueSyncRead, TeamSyncRead, TeamSyncWrite
from app.domains.integrations.service import not_found
from app.domains.integrations.team_sync import read_team_sync, save_team_sync

router = APIRouter()


def _require_team(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the team exists in this workspace, or 404."""
    if repositories.teams.get(context.workspace_id, team_id) is None:
        raise not_found()


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
    read = read_team_sync(repositories, context.workspace_id, team_id)
    if read is None:
        raise not_found()
    return read


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

    A public repository may only sync GitHub to Standupless, and asking for two
    way sync with one is a 422, because writing back would publish the team's
    issues on GitHub, unless `allow_public_two_way` is on in the same write.

    Saving an enabled link also queues a backlink job for each synced issue whose
    backlink comment is missing or out of date, so saving the settings again is
    how a team admin backfills backlinks or refreshes them after a prefix rename.
    """
    _require_team(repositories, context, team_id)
    return save_team_sync(repositories, context.workspace_id, context.user_id, team_id, payload)


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
