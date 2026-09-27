"""The integrations stage of the team purge: pull request links, repository pins, issue sync and webhooks.

The team's own webhooks go with it, delivery logs included, while a webhook that
covers every team is kept. Runs before the issues stage, because links are filed under the issue they point
at and the team's issues are how this stage finds them. Repositories pinned to
the team are unpinned rather than removed, since the repository still belongs to
the installation and can match every other team.

A workspace purge ends with the whole GitHub partition: the installation record,
its repositories, any link left, every issue sync row, and the outbound webhooks
with their delivery logs. The GitHub App
itself stays installed on the GitHub side until someone removes it there; with its
record gone, a delivery for it resolves to no workspace and is dropped.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.common.api.dependencies.repositories import Repositories
from app.common.team_purge import WORKSPACE, Deadline, PurgeJob
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
    """Unpin the team's repositories, drop its sync link and webhooks, then its issues' links and sync rows."""
    if job.cursor == 0 and job.kind != WORKSPACE:
        unpin_repositories(repositories, job.workspace_id, job.team_id)
        repositories.github.delete_team_sync(job.workspace_id, job.team_id)
        repositories.github.delete_team_endpoints(job.workspace_id, job.team_id)
    after = job.cursor
    while True:
        issues = repositories.issues.page_after(job.workspace_id, job.team_id, after, limit=PAGE)
        if not issues:
            return None
        for issue in issues:
            repositories.github.delete_links_for_issue(job.workspace_id, issue.issue_id)
            repositories.github.delete_issue_sync(job.workspace_id, issue.issue_id)
            after = issue.number
            if deadline.expired():
                return after


def workspace_step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Remove the workspace's whole GitHub partition: install, repositories, links, sync rows and webhooks."""
    repositories.github.delete_workspace_rows(job.workspace_id)
    return None


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """This stage's consumer router."""
    return build_purge_router(STAGE, STAGE, step, repositories, workspace_step=workspace_step)
