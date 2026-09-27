"""The discussion stage of the team purge: comments, reactions and attachments.

Runs first, because every row it owns is keyed by an issue id and the team's
issues are how it finds them. It walks the team's issues by number, so the
cursor it resumes from is the last number it finished.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.team_purge import Deadline, PurgeJob
from app.common.team_purge import build_router as build_purge_router
from app.domains.discussion.service import delete_objects

STAGE = "discussion"

PAGE = 25


def purge_issue(repositories: Repositories, workspace_id: str, issue_id: str) -> None:
    """Remove one issue's thread, reactions and attachments, objects first.

    Objects go before their rows, so a failure part way leaves a row that still
    names its object for the retry rather than an object nothing names.
    """
    for comment in repositories.comments.iter_for_issue(workspace_id, issue_id):
        repositories.reactions.delete_for_target(workspace_id, comment.comment_id)
    repositories.comments.delete_for_issue(workspace_id, issue_id)
    repositories.reactions.delete_for_target(workspace_id, issue_id)

    attachments = repositories.attachments.iter_for_issue(workspace_id, issue_id)
    if not attachments:
        return
    keys = [row.s3_key for row in attachments if row.s3_key]
    bucket = settings.ATTACHMENTS_BUCKET.strip()
    if keys and bucket:
        delete_objects(bucket, keys)
    repositories.attachments.delete_many(workspace_id, issue_id, [row.attachment_id for row in attachments])


def step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Purge the discussion of the team's issues numbered after the cursor."""
    after = job.cursor
    while True:
        issues = repositories.issues.page_after(job.workspace_id, job.team_id, after, limit=PAGE)
        if not issues:
            return None
        for issue in issues:
            purge_issue(repositories, job.workspace_id, issue.issue_id)
            after = issue.number
            if deadline.expired():
                return after


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """This stage's consumer router."""
    return build_purge_router(STAGE, STAGE, step, repositories)
