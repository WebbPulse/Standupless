"""Request and response schemas for comment and status update drafts, shared by the drafts routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a draft an agent stages must be held to exactly what the route holds a
person's to: the body cap a posted comment or update has, so a draft can always
be posted.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.common.api.schemas.planning import UPDATE_BODY_MAX_BYTES, ProjectHealthField
from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.views import CommentDraft, CommentDraftParent, UpdateDraft, UpdateDraftTarget


class DraftWrite(BaseModel):
    """The body a draft save takes, which replaces whatever the thread's draft held."""

    body: str = Field(min_length=1)

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        """Refuse a blank draft and hold the body to the comment byte cap."""
        if not value.strip():
            raise ValueError("body must not be blank")
        if len(value.encode("utf-8")) > ISSUE_BODY_MAX_BYTES:
            raise ValueError(f"body must be at most {ISSUE_BODY_MAX_BYTES} bytes")
        return value


class DraftRead(BaseModel):
    """One of the caller's comment drafts, with what it sits on as a listing names it.

    `parent_kind` says which parent is set: `issue_id` for an issue,
    `document_id` for a document, or `update_id` with its `project_id` or
    `initiative_id` for an update thread. `parent_comment_id` is the root
    comment a reply draft answers, or null for a draft on the parent itself.
    `issue_key`, `issue_title` and `document_title` are read at answer time, so
    a moved or renamed parent never shows a stale one.
    """

    parent_kind: CommentDraftParent = "issue"
    issue_id: Optional[str] = None
    document_id: Optional[str] = None
    update_id: Optional[str] = None
    project_id: Optional[str] = None
    initiative_id: Optional[str] = None
    parent_comment_id: Optional[str] = None
    team_id: Optional[str] = None
    body: str
    issue_key: Optional[str] = None
    issue_title: Optional[str] = None
    document_title: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(
        cls,
        row: CommentDraft,
        *,
        issue_key: str | None = None,
        issue_title: str | None = None,
        document_title: str | None = None,
    ) -> DraftRead:
        """The response shape of one stored draft."""
        return cls(
            parent_kind=row.parent_kind,
            issue_id=row.issue_id or None,
            document_id=row.document_id,
            update_id=row.update_id,
            project_id=row.project_id,
            initiative_id=row.initiative_id,
            parent_comment_id=row.parent_comment_id,
            team_id=row.team_id or None,
            body=row.body,
            issue_key=issue_key,
            issue_title=issue_title,
            document_title=document_title,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class DraftListRead(BaseModel):
    """The caller's drafts, newest saved first."""

    drafts: list[DraftRead]


class UpdateDraftWrite(BaseModel):
    """The body a status update draft save takes, replacing whatever the target's draft held.

    `health` is the health the author has picked so far, or null while they
    have not picked one, so a draft can be saved before the update is complete.
    """

    body: str = Field(min_length=1)
    health: Optional[ProjectHealthField] = None

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        """Refuse a blank draft and hold the body to the update byte cap."""
        if not value.strip():
            raise ValueError("body must not be blank")
        if len(value.encode("utf-8")) > UPDATE_BODY_MAX_BYTES:
            raise ValueError(f"body must be at most {UPDATE_BODY_MAX_BYTES} bytes")
        return value


class UpdateDraftRead(BaseModel):
    """One of the caller's status update drafts, with the project or initiative it sits on.

    `target_kind` says which of `project_id` and `initiative_id` is set.
    `target_name` is read at answer time, so a renamed target never shows a
    stale one.
    """

    target_kind: UpdateDraftTarget
    project_id: Optional[str] = None
    initiative_id: Optional[str] = None
    target_name: Optional[str] = None
    body: str
    health: Optional[ProjectHealthField] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row: UpdateDraft, *, target_name: str | None = None) -> UpdateDraftRead:
        """The response shape of one stored status update draft."""
        return cls(
            target_kind=row.target_kind,
            project_id=row.target_id if row.target_kind == "project" else None,
            initiative_id=row.target_id if row.target_kind == "initiative" else None,
            target_name=target_name,
            body=row.body,
            health=row.health,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class UpdateDraftListRead(BaseModel):
    """The caller's status update drafts, newest saved first."""

    drafts: list[UpdateDraftRead]
