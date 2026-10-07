"""Archiving and restoring one issue by hand, shared by the issue routes and the MCP tools.

Held in `common` rather than in the issues domain because the MCP tools run in
the integrations image, which must not import another domain's code. Both
actions are idempotent: archiving an archived issue and restoring a live one
return the issue unchanged and record nothing, so a double click or a retried
tool call never writes a second history row.
"""

from __future__ import annotations

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.issue_rules import not_found, require_team_member


def archive_issue(repositories: Repositories, context: AuthzContext, issue: Issue) -> Issue:
    """Archive one visible issue as the caller, recording an `archived` history row.

    Any team member may archive, as in Linear, whatever the issue's status. When
    the conditional write loses to a concurrent change the issue is read again,
    so an archive that landed elsewhere still answers as archived.
    """
    require_team_member(repositories, context, issue.team_id)
    if issue.archived_at is not None:
        return issue
    stored = repositories.issues.archive(issue, utc_now())
    if stored is None:
        return _reread(repositories, issue)
    repositories.activity.record(
        build_activity(
            context.workspace_id,
            stored.team_id,
            stored.issue_id,
            context.user_id,
            "archived",
            source=context.source,
        )
    )
    return stored


def unarchive_issue(repositories: Repositories, context: AuthzContext, issue: Issue) -> Issue:
    """Restore one archived issue as the caller, recording an `unarchived` history row.

    The restore counts as an edit, so an issue restored after its archive period
    stays visible for a whole period again before the sweep takes it back.
    """
    require_team_member(repositories, context, issue.team_id)
    if issue.archived_at is None:
        return issue
    stored = repositories.issues.unarchive(issue, context.user_id, utc_now(), source=context.source)
    if stored is None:
        return _reread(repositories, issue)
    repositories.activity.record(
        build_activity(
            context.workspace_id,
            stored.team_id,
            stored.issue_id,
            context.user_id,
            "unarchived",
            source=context.source,
        )
    )
    return stored


def _reread(repositories: Repositories, issue: Issue) -> Issue:
    """The issue as it stands after a lost conditional write, or the 404 when it is gone."""
    fresh = repositories.issues.get(issue.workspace_id, issue.issue_id)
    if fresh is None:
        raise not_found()
    return fresh
