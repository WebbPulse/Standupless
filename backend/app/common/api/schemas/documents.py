"""Request and response schemas for documents: Markdown pages under a project or an initiative.

Held in `common` because the planning routes and the MCP tools in the integrations
image both take and answer them.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator
from webbpulse.http import cursor_page

from app.common.change_source import ChangeSource

TITLE_MAX = 200

BODY_MAX_BYTES = 100_000
"""The largest Markdown body a document takes, in UTF-8 bytes."""

DocumentParentKind = Literal["project", "initiative"]


def _check_title(value: Optional[str]) -> Optional[str]:
    """Hold a title to non-blank text under the cap, trimmed."""
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        raise ValueError("title must not be blank")
    if len(trimmed) > TITLE_MAX:
        raise ValueError(f"title must be at most {TITLE_MAX} characters")
    return trimmed


def _check_body(value: Optional[str]) -> Optional[str]:
    """Hold a body under the byte cap; an empty document is allowed."""
    if value is None:
        return None
    if len(value.encode("utf-8")) > BODY_MAX_BYTES:
        raise ValueError(f"body must be at most {BODY_MAX_BYTES} bytes")
    return value


class DocumentCreate(BaseModel):
    """The body a document create takes; the parent comes from the path."""

    title: str
    body: str = ""

    @field_validator("title")
    @classmethod
    def check_title(cls, value: str) -> str:
        """Hold the title to non-blank text under the cap."""
        return _check_title(value) or value

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        """Hold the body under the byte cap."""
        return _check_body(value) or ""


class DocumentPatch(BaseModel):
    """The body a document patch takes; either field may be left out, neither cleared.

    `base_updated_at` is the `updated_at` the editor last read. When it is sent
    and the document has changed since, the patch is a 409 rather than writing
    over someone else's edit.
    """

    title: Optional[str] = None
    body: Optional[str] = None
    base_updated_at: Optional[datetime] = None

    @field_validator("title")
    @classmethod
    def check_title(cls, value: Optional[str]) -> Optional[str]:
        """Hold the title to non-blank text under the cap."""
        return _check_title(value)

    @field_validator("body")
    @classmethod
    def check_body(cls, value: Optional[str]) -> Optional[str]:
        """Hold the body under the byte cap."""
        return _check_body(value)


class DocumentMentionRead(BaseModel):
    """One issue a document mentions, as its key was written."""

    key: str
    issue_id: str
    team_id: str


class DocumentSummaryRead(BaseModel):
    """One document without its body, as a listing answers it.

    `can_edit` and `can_delete` say what this caller may do, so a client draws
    the controls without repeating the rules.
    """

    document_id: str
    workspace_id: str
    parent_kind: DocumentParentKind
    parent_id: str
    parent_name: str = ""
    title: str
    author_id: str
    updated_by: str
    source: Optional[ChangeSource] = None
    created_at: datetime
    updated_at: datetime
    can_edit: bool = False
    can_delete: bool = False


class DocumentRead(DocumentSummaryRead):
    """One document with its Markdown and the issues it mentions that this caller can see."""

    body: str
    mentions: list[DocumentMentionRead] = Field(default_factory=list)


class DocumentVersionRead(BaseModel):
    """An earlier title and body of a document, as it stood at the end of one edit session."""

    version_id: str
    document_id: str
    title: str
    body: str
    edited_by: str
    edited_at: datetime


DocumentListRead = cursor_page(DocumentSummaryRead, "documents", model_name="DocumentListRead")

DocumentVersionListRead = cursor_page(DocumentVersionRead, "versions", model_name="DocumentVersionListRead")
