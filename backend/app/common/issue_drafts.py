"""New issue drafts: the create dialog's unfiled issues, many per member per workspace.

Held in `common` because the drafts routes in the views image and the MCP tools
in the integrations image both run it. A draft is its author's alone: every read
and write is keyed by the caller, so another member's draft answers the same 404
an absent one does, and drafts sit in the views table, which has no stream, so
saving one never notifies anyone.

A draft names the team it would be filed in, and a draft on a team the caller
can no longer see drops out of the listing and reads as absent, while it is
kept, so regaining access brings it back. The team purge deletes the drafts
filed to it.
"""

from __future__ import annotations

from typing import Optional

from webbpulse.dynamodb import new_ulid

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issue_drafts import IssueDraftRead, IssueDraftWrite
from app.common.comment_writes import conflict
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.views import ISSUE_DRAFTS_MAX, IssueDraft, issue_draft_key
from app.common.issue_rules import not_found, require_team_reader

LIMIT_REACHED = (
    f"You have {ISSUE_DRAFTS_MAX} issue drafts, the most one person can keep in a workspace. "
    "Delete a draft to save another."
)
"""The refusal a save gets once the caller holds the most drafts they may keep."""


def save_issue_draft(
    repositories: Repositories,
    context: AuthzContext,
    payload: IssueDraftWrite,
    *,
    draft_id: Optional[str] = None,
) -> IssueDraftRead:
    """Save one of the caller's drafts, creating it when the id is new or omitted.

    Saving again under the same id replaces every field and keeps when the
    draft was first saved. The team must be one the caller can see, and a new
    draft past the cap is refused with a 409 rather than replacing an old one.
    """
    require_team_reader(repositories, context, payload.team_id)
    identifier = draft_id or new_ulid()
    existing = repositories.views.get_issue_draft(context.workspace_id, context.user_id, identifier)
    if existing is None:
        held = repositories.views.list_issue_drafts(context.workspace_id, context.user_id)
        if len(held) >= ISSUE_DRAFTS_MAX:
            raise conflict(LIMIT_REACHED)
    elif not context.can_see_team(existing.team_id):
        raise not_found()
    now = utc_now()
    row = IssueDraft(
        workspace_id=context.workspace_id,
        view_key=issue_draft_key(context.user_id, identifier),
        user_id=context.user_id,
        draft_id=identifier,
        team_id=payload.team_id,
        title=payload.title,
        body=payload.body,
        template_id=payload.template_id,
        template_title=payload.template_title,
        template_body=payload.template_body,
        answers=dict(payload.answers),
        status_id=payload.status_id,
        priority=payload.priority,
        assignee_id=payload.assignee_id,
        label_ids=list(payload.label_ids),
        estimate=payload.estimate,
        project_id=payload.project_id,
        project_milestone_id=payload.project_milestone_id,
        cycle_id=payload.cycle_id,
        start_date=payload.start_date.isoformat() if payload.start_date else None,
        due_date=payload.due_date.isoformat() if payload.due_date else None,
        parent_id=payload.parent_id,
        parent_key=payload.parent_key if payload.parent_id else None,
        parent_title=payload.parent_title if payload.parent_id else None,
        sub_issues=list(payload.sub_issues),
        created_at=existing.created_at if existing is not None else now,
        updated_at=now,
    )
    repositories.views.put_issue_draft(row)
    return IssueDraftRead.from_row(row)


def get_issue_draft(repositories: Repositories, context: AuthzContext, draft_id: str) -> IssueDraftRead:
    """One of the caller's drafts, or a 404 when there is none or its team is out of sight."""
    row = repositories.views.get_issue_draft(context.workspace_id, context.user_id, draft_id)
    if row is None or not context.can_see_team(row.team_id):
        raise not_found()
    return IssueDraftRead.from_row(row)


def list_issue_drafts(repositories: Repositories, context: AuthzContext) -> list[IssueDraftRead]:
    """The caller's drafts, newest saved first, leaving out those on teams out of sight."""
    rows = repositories.views.list_issue_drafts(context.workspace_id, context.user_id)
    return [IssueDraftRead.from_row(row) for row in rows if context.can_see_team(row.team_id)]


def delete_issue_draft(repositories: Repositories, context: AuthzContext, draft_id: str) -> None:
    """Discard one of the caller's drafts, a no-op when there is none."""
    repositories.views.delete_issue_draft(context.workspace_id, context.user_id, draft_id)
