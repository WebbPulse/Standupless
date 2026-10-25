"""Earlier versions of an issue's description, recorded on save and read back for restore.

Each version is the description as one save left it, so the newest version is the
current text. Saves by the same author within `SESSION_GAP` of the newest version
rewrite it in place, the way document versions coalesce, so typing in bursts keeps
one version per sitting rather than one per keystroke. A sealed version is never
rewritten: the text an issue was created with, and the text a restore replaced. A description that changed
without a version, such as one written before versions existed or synced from
GitHub, is kept as a version of its own before the new text, so restoring can
always reach the text that was replaced.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.activity import DescriptionVersion, build_description_version
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.issue_rules import load_visible_issue

SESSION_GAP = timedelta(minutes=5)
"""How long after the newest version a save by the same author still rewrites it."""


def record_description_version(
    repositories: Repositories, context: AuthzContext, before: Issue | None, after: Issue
) -> None:
    """Record the description `after` holds, coalescing with the caller's recent version.

    `before` is the issue as it stood, or `None` for a new issue. An empty
    description on a new issue records nothing.
    """
    previous = before.body if before is not None else ""
    if before is None and not after.body:
        return
    workspace_id, issue_id = after.workspace_id, after.issue_id
    latest = repositories.activity.latest_description_version(workspace_id, issue_id)
    now = utc_now()
    if before is not None and previous and (latest is None or latest.body != previous):
        repositories.activity.save_description_version(
            build_description_version(
                workspace_id,
                issue_id,
                previous,
                before.updated_by or before.created_by,
                edited_at=before.updated_at,
                source=before.updated_source,
            )
        )
        latest = None
    if latest is not None and _coalesces(latest, context.user_id, previous, now):
        repositories.activity.save_description_version(
            latest.model_copy(update={"body": after.body, "edited_at": now, "source": context.source})
        )
        return
    repositories.activity.save_description_version(
        build_description_version(
            workspace_id,
            issue_id,
            after.body,
            context.user_id,
            edited_at=now,
            source=context.source,
            sealed=before is None,
        )
    )


def _coalesces(latest: DescriptionVersion, user_id: str, previous: str, now: datetime) -> bool:
    """Whether a save by `user_id` rewrites `latest` rather than adding a version."""
    return (
        not latest.sealed
        and latest.edited_by == user_id
        and latest.body == previous
        and now - latest.edited_at < SESSION_GAP
    )


def seal_latest_version(repositories: Repositories, issue: Issue) -> None:
    """Keep the newest version from being rewritten by the next save, ahead of a restore."""
    latest = repositories.activity.latest_description_version(issue.workspace_id, issue.issue_id)
    if latest is not None and not latest.sealed and latest.body == issue.body:
        repositories.activity.save_description_version(latest.model_copy(update={"sealed": True}))


def list_description_versions(
    repositories: Repositories, context: AuthzContext, issue_id: str
) -> tuple[Issue, list[DescriptionVersion]]:
    """A visible issue and its description versions, newest first."""
    issue = load_visible_issue(repositories, context, issue_id)
    return issue, repositories.activity.list_description_versions(context.workspace_id, issue.issue_id)


def get_description_version(repositories: Repositories, issue: Issue, version_id: str) -> DescriptionVersion:
    """One version of `issue`'s description, or a 404."""
    version = repositories.activity.get_description_version(issue.workspace_id, issue.issue_id, version_id)
    if version is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "NOT_FOUND", "message": "That description version does not exist"},
        )
    return version
