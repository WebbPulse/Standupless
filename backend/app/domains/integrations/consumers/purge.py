"""The integrations stage of the team purge: pull request links and repository pins.

Runs before the issues stage, because links are filed under the issue they point
at and the team's issues are how this stage finds them. Repositories pinned to
the team are unpinned rather than removed, since the repository still belongs to
the installation and can match every other team.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.common.api.dependencies.repositories import Repositories
from app.common.team_purge import Deadline, PurgeJob
from app.common.team_purge import build_router as build_purge_router

STAGE = "integrations"

PAGE = 25


def unpin_repositories(repositories: Repositories, workspace_id: str, team_id: str) -> int:
    """Point every repository pinned to the team back at every team, returning how many."""
    unpinned = 0
    for repository in repositories.github.list_repositories(workspace_id):
        if repository.team_id == team_id and repositories.github.set_repository_team(
            workspace_id, repository.repository_id, None
        ):
            unpinned += 1
    return unpinned


def step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Unpin the team's repositories, then remove the links of its issues after the cursor."""
    if job.cursor == 0:
        unpin_repositories(repositories, job.workspace_id, job.team_id)
    after = job.cursor
    while True:
        issues = repositories.issues.page_after(job.workspace_id, job.team_id, after, limit=PAGE)
        if not issues:
            return None
        for issue in issues:
            repositories.github.delete_links_for_issue(job.workspace_id, issue.issue_id)
            after = issue.number
            if deadline.expired():
                return after


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """This stage's consumer router."""
    return build_purge_router(STAGE, STAGE, step, repositories)
