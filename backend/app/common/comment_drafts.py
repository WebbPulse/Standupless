"""Comment drafts: one unposted comment per member per thread, on issues, documents and update threads.

Held in `common` because the drafts routes in the views image and the MCP tools
in the integrations image both run it, and that image may not import another
domain's code. A draft is its author's alone: every read and write is keyed by
the caller, so nobody can see or clear another member's draft, and drafts sit in
a table with no stream, so saving one never notifies anyone.

A draft sits on an issue, a document, or the reply thread of a project or
initiative update, and an issue or document draft may answer one root comment.
Every parent kind is held to what posting there would need, so a draft can
always be posted.

An agent stages a comment by saving a draft, and the person opening the issue
finds it restored in their composer, ready to edit and post. Posting clears the
draft the comment came from, whichever client posted it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from fastapi import HTTPException

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.drafts import DraftRead
from app.common.comment_writes import conflict
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.views import CommentDraft, CommentDraftParent, UpdateDraftTarget, draft_key
from app.common.document_comments import NO_TEAM, require_document_commenter
from app.common.documents import load_readable_document
from app.common.initiative_writes import load_initiative
from app.common.issue_keys import current
from app.common.issue_rules import load_visible_issue, not_found, require_team_member
from app.common.planning_rules import unprocessable
from app.common.project_update_threads import load_readable_update


@dataclass(frozen=True)
class UpdateThreadRef:
    """The update whose reply thread a draft sits on, with the project or initiative it belongs to."""

    target_kind: UpdateDraftTarget
    target_id: str
    update_id: str


@dataclass(frozen=True)
class DraftParent:
    """What one comment draft call names: exactly one of an issue, a document or an update thread."""

    issue_id: Optional[str] = None
    document_id: Optional[str] = None
    update: Optional[UpdateThreadRef] = None

    def __post_init__(self) -> None:
        """Refuse a call naming no parent or more than one."""
        named = sum(1 for value in (self.issue_id, self.document_id, self.update) if value)
        if named != 1:
            raise unprocessable("Name exactly one of an issue, a document and an update")

    @property
    def thread_id(self) -> str:
        """The id the draft's key is filed under."""
        if self.update is not None:
            return self.update.update_id
        return self.document_id or self.issue_id or ""


@dataclass(frozen=True)
class _Resolved:
    """A parent as the caller may reach it, with the fields its draft row carries and the names it answers with."""

    kind: CommentDraftParent
    thread_id: str
    team_id: str = ""
    issue: Optional[Issue] = None
    document_id: Optional[str] = None
    document_title: Optional[str] = None
    update_id: Optional[str] = None
    project_id: Optional[str] = None
    initiative_id: Optional[str] = None


def _thread(parent_comment_id: Optional[str]) -> Optional[str]:
    """A reply thread id with blanks read as the parent's own thread."""
    value = (parent_comment_id or "").strip()
    return value or None


def _issue_parent(issue: Issue) -> _Resolved:
    """An issue as a draft parent."""
    return _Resolved(kind="issue", thread_id=issue.issue_id, team_id=issue.team_id, issue=issue)


def _update_parent(repositories: Repositories, context: AuthzContext, update: UpdateThreadRef) -> _Resolved:
    """A readable update as a draft parent, or the 403 or 404 replying to it would meet."""
    if update.target_kind == "project":
        project, _, row = load_readable_update(repositories, context, update.target_id, update.update_id)
        return _Resolved(
            kind="project_update", thread_id=row.update_id, update_id=row.update_id, project_id=project.project_id
        )
    initiative = load_initiative(repositories, context, update.target_id)
    found = repositories.planning.get_initiative_update(
        context.workspace_id, initiative.initiative_id, update.update_id
    )
    if found is None:
        raise not_found()
    return _Resolved(
        kind="initiative_update",
        thread_id=found.update_id,
        update_id=found.update_id,
        initiative_id=initiative.initiative_id,
    )


def _readable(repositories: Repositories, context: AuthzContext, parent: DraftParent) -> _Resolved:
    """The parent a draft read names, as far as reading it needs."""
    if parent.update is not None:
        return _update_parent(repositories, context, parent.update)
    if parent.document_id:
        _, document = load_readable_document(repositories, context, parent.document_id)
        return _Resolved(
            kind="document",
            thread_id=document.document_id,
            document_id=document.document_id,
            document_title=document.title,
        )
    return _issue_parent(load_visible_issue(repositories, context, parent.issue_id or ""))


def _writable(
    repositories: Repositories, context: AuthzContext, parent: DraftParent, reply_to: Optional[str]
) -> _Resolved:
    """The parent a draft save names, held to what posting there would need."""
    if parent.update is not None:
        if reply_to:
            raise conflict("Update replies are one level deep")
        return _update_parent(repositories, context, parent.update)
    if parent.document_id:
        _, document = require_document_commenter(repositories, context, parent.document_id)
        resolved = _Resolved(
            kind="document",
            thread_id=document.document_id,
            document_id=document.document_id,
            document_title=document.title,
        )
    else:
        issue = load_visible_issue(repositories, context, parent.issue_id or "")
        require_team_member(repositories, context, issue.team_id)
        resolved = _issue_parent(issue)
    if reply_to:
        root = repositories.comments.get(context.workspace_id, resolved.thread_id, reply_to)
        if root is None:
            raise not_found()
        if root.parent_comment_id:
            raise conflict("Replies are one level deep")
    return resolved


def _read(repositories: Repositories, row: CommentDraft, resolved: _Resolved) -> DraftRead:
    """One draft as the API answers it, naming its issue by its current key or its document by its title."""
    if resolved.issue is not None:
        keyed = current(repositories.teams, resolved.issue)
        return DraftRead.from_row(row, issue_key=keyed.key, issue_title=resolved.issue.title)
    return DraftRead.from_row(row, document_title=resolved.document_title)


def _as_parent(issue_id: Optional[str], parent: Optional[DraftParent]) -> DraftParent:
    """The parent a call names, from the issue id the issue routes pass or a parent given whole."""
    if parent is not None:
        return parent
    return DraftParent(issue_id=issue_id)


def save_draft(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: Optional[str],
    body: str,
    *,
    parent_comment_id: Optional[str] = None,
    parent: Optional[DraftParent] = None,
) -> DraftRead:
    """Save the caller's draft on an issue, document or update thread, replacing the one there.

    Held to what posting it would need, so a draft can always be posted: the
    caller may comment in the issue's team, may comment on the document, or may
    read the update, and a reply draft answers a root comment of that issue or
    document. An update thread is one level, so it takes no reply.
    """
    target = _as_parent(issue_id, parent)
    reply_to = _thread(parent_comment_id)
    resolved = _writable(repositories, context, target, reply_to)
    existing = repositories.views.get_draft(context.workspace_id, context.user_id, resolved.thread_id, reply_to)
    now = utc_now()
    row = CommentDraft(
        workspace_id=context.workspace_id,
        view_key=draft_key(context.user_id, resolved.thread_id, reply_to),
        user_id=context.user_id,
        parent_kind=resolved.kind,
        issue_id=resolved.issue.issue_id if resolved.issue is not None else "",
        document_id=resolved.document_id,
        update_id=resolved.update_id,
        project_id=resolved.project_id,
        initiative_id=resolved.initiative_id,
        team_id=resolved.team_id or NO_TEAM,
        parent_comment_id=reply_to,
        body=body,
        created_at=existing.created_at if existing is not None else now,
        updated_at=now,
    )
    repositories.views.put_draft(row)
    return _read(repositories, row, resolved)


def get_draft(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: Optional[str],
    *,
    parent_comment_id: Optional[str] = None,
    parent: Optional[DraftParent] = None,
) -> DraftRead:
    """The caller's draft on an issue, document or update thread, or a 404 when there is none."""
    resolved = _readable(repositories, context, _as_parent(issue_id, parent))
    row = repositories.views.get_draft(
        context.workspace_id, context.user_id, resolved.thread_id, _thread(parent_comment_id)
    )
    if row is None:
        raise not_found()
    return _read(repositories, row, resolved)


def _row_parent(row: CommentDraft) -> DraftParent:
    """The parent a stored draft names."""
    if row.parent_kind == "document":
        return DraftParent(document_id=row.document_id)
    if row.parent_kind == "project_update":
        return DraftParent(update=UpdateThreadRef("project", row.project_id or "", row.update_id or ""))
    if row.parent_kind == "initiative_update":
        return DraftParent(update=UpdateThreadRef("initiative", row.initiative_id or "", row.update_id or ""))
    return DraftParent(issue_id=row.issue_id)


def _listed_elsewhere(repositories: Repositories, context: AuthzContext, row: CommentDraft) -> Optional[DraftRead]:
    """A document or update thread draft as the listing answers it, or `None` while its parent is out of reach."""
    try:
        resolved = _readable(repositories, context, _row_parent(row))
    except HTTPException:
        return None
    return _read(repositories, row, resolved)


def list_drafts(
    repositories: Repositories,
    context: AuthzContext,
    *,
    issue_id: Optional[str] = None,
    document_id: Optional[str] = None,
    update_id: Optional[str] = None,
) -> list[DraftRead]:
    """The caller's drafts, newest saved first, across the workspace or on one issue, document or update.

    At most one of the filters may be given. A draft on a parent the caller can
    no longer reach drops out of the listing and is kept, so regaining access
    brings it back. A draft on an issue that is gone is deleted on the way past.
    """
    filters = [value for value in (issue_id, document_id, update_id) if value]
    if len(filters) > 1:
        raise unprocessable("Filter by at most one of an issue, a document and an update")
    if issue_id:
        load_visible_issue(repositories, context, issue_id)
    if document_id:
        load_readable_document(repositories, context, document_id)
    rows = repositories.views.list_drafts(
        context.workspace_id, context.user_id, issue_id=filters[0] if filters else None
    )
    if not rows:
        return []
    issue_rows = [row for row in rows if row.parent_kind == "issue"]
    issues = (
        repositories.issues.get_many(context.workspace_id, list({row.issue_id for row in issue_rows}))
        if issue_rows
        else {}
    )
    answer: list[DraftRead] = []
    for row in rows:
        if row.parent_kind != "issue":
            listed = _listed_elsewhere(repositories, context, row)
            if listed is not None:
                answer.append(listed)
            continue
        issue = issues.get(row.issue_id)
        if issue is None:
            repositories.views.delete_draft(context.workspace_id, context.user_id, row.issue_id, row.parent_comment_id)
            continue
        if context.can_see_team(issue.team_id):
            answer.append(_read(repositories, row, _issue_parent(issue)))
    return answer


def delete_draft(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: Optional[str],
    *,
    parent_comment_id: Optional[str] = None,
    parent: Optional[DraftParent] = None,
) -> None:
    """Discard the caller's draft in one thread, a no-op when there is none.

    The parent is never read, so a draft on an issue, document or update since
    deleted or hidden can still be cleared.
    """
    target = _as_parent(issue_id, parent)
    repositories.views.delete_draft(context.workspace_id, context.user_id, target.thread_id, _thread(parent_comment_id))


def clear_posted_draft(
    repositories: Repositories,
    workspace_id: str,
    author_id: str,
    issue_id: str,
    parent_comment_id: Optional[str],
    posted_at: datetime,
) -> bool:
    """Clear the draft a posted comment came from, keeping one saved after it was posted.

    `issue_id` is the id the thread is filed under: the issue's, the
    document's, or the update's for a reply on an update thread.
    """
    return repositories.views.clear_draft_before(
        workspace_id, author_id, issue_id, _thread(parent_comment_id), posted_at
    )
