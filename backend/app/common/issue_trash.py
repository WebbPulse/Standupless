"""Deleting an issue to its team's trash, restoring it, and purging it for good.

Linear keeps a deleted issue restorable for 30 days before it is gone. A delete
here does the same: the row stays, stamped with who deleted it and when, and its
index composites move to the team's trash partition, so it leaves every list,
board, cycle, project, search and inbox read while its children, links, labels,
comments and history wait for a restore. The hourly sweep, or a team admin by
hand, purges it, which is what the old delete did at once: the children are
reparented, the links removed and the history dropped.

Held in `common` rather than in the issues domain because the MCP tools run in
the integrations image, which must not import another domain's code.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import TRASH_RETENTION_DAYS, Issue
from app.common.issue_rules import (
    default_status,
    issue_changed,
    not_found,
    require_team_admin,
    require_team_member,
    require_team_reader,
)
from app.common.relation_effects import (
    child_activity,
    delete_relations,
    recount_blocked,
    recount_blocking,
    recount_relations,
)

TRASH_RETENTION = timedelta(days=TRASH_RETENTION_DAYS)
"""How long a deleted issue stays restorable before the sweep purges it."""


def forbidden() -> HTTPException:
    """The 403 a caller who may see the issue but not delete or restore it gets."""
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"error_code": "FORBIDDEN", "message": "Not allowed"},
    )


def may_trash(repositories: Repositories, context: AuthzContext, issue: Issue) -> bool:
    """Whether this caller may delete or restore this issue.

    A team admin always may. Anyone else may only for an issue they created that
    has no live sub-issues, so an ordinary member cannot hide someone else's tree.
    A retired team is read-only, so its 409 reaches the caller for everyone.
    """
    try:
        require_team_admin(repositories, context, issue.team_id)
        return True
    except HTTPException as exc:
        if exc.status_code in (status.HTTP_404_NOT_FOUND, status.HTTP_409_CONFLICT):
            raise
    if issue.created_by != context.user_id:
        return False
    if repositories.issues.has_children(context.workspace_id, issue.issue_id):
        return False
    try:
        require_team_member(repositories, context, issue.team_id)
    except HTTPException:
        return False
    return True


def delete_issue(repositories: Repositories, context: AuthzContext, issue: Issue) -> Issue:
    """Move one live issue to its team's trash as the caller, answering the deleted row.

    Records a `deleted` history row, a tombstone so cached lists drop the issue,
    and recounts the issues it blocked or was blocked by, which no longer count it.
    """
    if not may_trash(repositories, context, issue):
        raise forbidden()
    try:
        stored = repositories.issues.soft_delete(issue, context.user_id, utc_now())
    except ConditionFailed as exc:
        if repositories.issues.get(context.workspace_id, issue.issue_id) is None:
            raise not_found() from exc
        raise issue_changed() from exc
    repositories.activity.record(
        build_activity(
            context.workspace_id, stored.team_id, stored.issue_id, context.user_id, "deleted", source=context.source
        )
    )
    repositories.activity.record_tombstone(context.workspace_id, stored.team_id, stored.issue_id, context.user_id)
    recount_far_sides(repositories, context.workspace_id, stored.issue_id)
    return stored


def restore_issue(repositories: Repositories, context: AuthzContext, issue: Issue) -> Issue:
    """Take one deleted issue back out of the trash as the caller, answering the live row.

    Idempotent: restoring a live issue answers it unchanged. A status the team no
    longer shows falls back to its default, and a parent purged meanwhile is
    cleared, so the restored issue always lands somewhere a list can show it. Its
    own link and blocker counts are recounted, since its links may have moved on.
    """
    if issue.deleted_at is None:
        return issue
    if not may_trash(repositories, context, issue):
        raise forbidden()
    repaired = repair_for_restore(repositories, issue)
    try:
        stored = repositories.issues.restore(repaired, context.user_id, utc_now(), source=context.source)
    except ConditionFailed as exc:
        fresh = repositories.issues.get(context.workspace_id, issue.issue_id, include_deleted=True)
        if fresh is None:
            raise not_found() from exc
        if fresh.deleted_at is None:
            return fresh
        raise issue_changed() from exc
    repositories.activity.record(
        build_activity(
            context.workspace_id, stored.team_id, stored.issue_id, context.user_id, "restored", source=context.source
        )
    )
    recount_far_sides(repositories, context.workspace_id, stored.issue_id)
    recount_relations(repositories, context.workspace_id, stored.issue_id)
    recount_blocked(repositories, context.workspace_id, stored.issue_id)
    recount_blocking(repositories, context.workspace_id, stored.issue_id)
    return repositories.issues.get(context.workspace_id, stored.issue_id) or stored


def repair_for_restore(repositories: Repositories, issue: Issue) -> Issue:
    """The deleted issue with any field fixed that went stale while it sat in the trash."""
    update: dict[str, object] = {}
    shown = repositories.team_config.get_status(issue.workspace_id, issue.team_id, issue.status_id)
    if shown is None or shown.hidden:
        update["status_id"] = default_status(repositories, issue.workspace_id, issue.team_id).status_id
    if issue.parent_id and repositories.issues.get(issue.workspace_id, issue.parent_id, include_deleted=True) is None:
        update["parent_id"] = None
    if not update:
        return issue
    repaired = issue.model_copy(update=update)
    return repaired.at_revision(issue.read_revision())


def recount_far_sides(repositories: Repositories, workspace_id: str, issue_id: str) -> None:
    """Recount the link, blocked and blocking markers of every issue linked to one that left or rejoined."""
    relations = repositories.relations.list_for_issue(workspace_id, issue_id, limit=1000)
    for linked_id in dict.fromkeys(row.target_issue_id for row in relations):
        recount_relations(repositories, workspace_id, linked_id)
    for blocked_id in dict.fromkeys(row.target_issue_id for row in relations if row.relation_type == "blocks"):
        recount_blocked(repositories, workspace_id, blocked_id)
    for blocker_id in dict.fromkeys(row.target_issue_id for row in relations if row.relation_type == "blocked_by"):
        recount_blocking(repositories, workspace_id, blocker_id)


def list_trash(repositories: Repositories, context: AuthzContext, team_id: str) -> list[Issue]:
    """One team's deleted issues, newest number first, for anyone who may read the team."""
    require_team_reader(repositories, context, team_id)
    return repositories.issues.iter_trash(context.workspace_id, team_id)


def purge_now(repositories: Repositories, context: AuthzContext, issue: Issue) -> None:
    """Delete one issue from the trash for good, which only a team admin may do."""
    require_team_admin(repositories, context, issue.team_id)
    if issue.deleted_at is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "NOT_DELETED", "message": "Move the issue to the trash first."},
        )
    purge_issue(repositories, context.workspace_id, issue, context.user_id, source=context.source)


def purge_issue(
    repositories: Repositories,
    workspace_id: str,
    issue: Issue,
    actor_id: str,
    *,
    actor_kind: str = "user",
    source: str | None = None,
) -> None:
    """Remove one issue row for good: reparent its children, drop its links, history and subscriptions.

    Its live children lose their parent and their history records the change; a
    child sitting in the trash keeps the stale id until a restore clears it. A
    tombstone is written so a list that still caches the issue drops it.
    """
    children = repositories.issues.iter_children(workspace_id, issue.issue_id)
    for child in children:
        repositories.issues.replace_with(child, lambda current: current.model_copy(update={"parent_id": None}))
    repositories.activity.record_many(
        [
            build_activity(
                workspace_id,
                child.team_id,
                child.issue_id,
                actor_id,
                "field_changed",
                actor_kind=actor_kind,
                field="parent_id",
                from_value=issue.issue_id,
                to_value=None,
                source=source,
            )
            for child in children
        ]
        + child_activity(repositories, workspace_id, actor_id, issue, issue.parent_id, None, source)
    )
    delete_relations(repositories, workspace_id, issue.issue_id)
    repositories.activity.delete_for_issue(workspace_id, issue.issue_id)
    repositories.subscriptions.delete_for_issue(workspace_id, issue.issue_id)
    repositories.issues.delete(workspace_id, issue.issue_id)
    repositories.activity.record_tombstone(workspace_id, issue.team_id, issue.issue_id, actor_id)


def purge_due(deleted_at: datetime | None, now: datetime) -> bool:
    """Whether an issue deleted at `deleted_at` has outlived the trash retention by `now`."""
    return deleted_at is not None and deleted_at <= now - TRASH_RETENTION
