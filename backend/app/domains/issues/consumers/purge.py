"""The issues stage of the team purge: issues, their relations, activity and subscribers.

Runs after every stage that finds its rows through the team's issues. It always
reads the first page again, because the rows it has finished are gone, so it
needs no cursor. A sub-issue in another team is kept and loses its parent, the
same as when its parent is deleted one at a time.

A workspace purge ends by clearing whatever the issues and relations partitions
still hold for the tenant, so an issue whose team row was already gone is not left.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.common.api.dependencies.repositories import Repositories
from app.common.relation_effects import delete_relations
from app.common.team_purge import Deadline, PurgeJob
from app.common.team_purge import build_router as build_purge_router

STAGE = "issues"

PAGE = 25


def purge_issue(repositories: Repositories, workspace_id: str, team_id: str, issue_id: str) -> None:
    """Remove one issue with its links, history and subscribers, orphaning children in other teams."""
    for child in repositories.issues.iter_children(workspace_id, issue_id):
        if child.team_id != team_id:
            repositories.issues.replace(child.model_copy(update={"parent_id": None}))
    delete_relations(repositories, workspace_id, issue_id)
    repositories.activity.delete_for_issue(workspace_id, issue_id)
    repositories.subscriptions.delete_for_issue(workspace_id, issue_id)
    repositories.issues.delete(workspace_id, issue_id)


def step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Remove the team's issues a page at a time."""
    while True:
        issues = repositories.issues.page_after(job.workspace_id, job.team_id, 0, limit=PAGE)
        if not issues:
            repositories.activity.delete_tombstones(job.workspace_id, job.team_id)
            repositories.activity.delete_team_events(job.workspace_id, job.team_id)
            return None
        for issue in issues:
            purge_issue(repositories, job.workspace_id, job.team_id, issue.issue_id)
        if deadline.expired():
            return 0


def workspace_step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Remove every issue and relation the workspace still holds, one page of issues at a time."""
    while True:
        issues = repositories.issues.page_for_workspace(job.workspace_id, limit=PAGE)
        if not issues:
            break
        for issue in issues:
            purge_issue(repositories, job.workspace_id, issue.team_id, issue.issue_id)
        if deadline.expired():
            return 0
    repositories.relations.delete_workspace_rows(job.workspace_id)
    repositories.activity.delete_tombstones(job.workspace_id)
    repositories.activity.delete_team_events(job.workspace_id)
    return None


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """This stage's consumer router."""
    return build_purge_router(STAGE, STAGE, step, repositories, workspace_step=workspace_step)
