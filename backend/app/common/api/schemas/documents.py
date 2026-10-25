"""Request and response schemas for documents: Markdown pages under a project, an initiative or a team.

Held in `common` because the planning routes and the MCP tools in the integrations
image both take and answer them.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional, get_args

from pydantic import BaseModel, Field, field_validator
from webbpulse.http import cursor_page

from app.common.api.schemas.planning import ProjectIconField
from app.common.change_source import ChangeSource

TITLE_MAX = 200

BODY_MAX_BYTES = 100_000
"""The largest Markdown body a document takes, in UTF-8 bytes."""

DocumentParentKind = Literal["project", "initiative", "team"]

ICON_MAX = 16
"""The longest emoji sequence a document icon takes, in characters."""

GLYPHS: frozenset[str] = frozenset(get_args(ProjectIconField))
"""The named glyphs a document may wear, the same set a project picks from."""


def _check_icon(value: Optional[str]) -> Optional[str]:
    """Hold an icon to one of the named glyphs or a short emoji; blank clears it."""
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if trimmed in GLYPHS:
        return trimmed
    if len(trimmed) > ICON_MAX or any(char.isascii() and (char.isalnum() or char.isspace()) for char in trimmed):
        raise ValueError("icon must be a glyph name or an emoji")
    return trimmed


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
    """The body a document create takes; the parent comes from the path.

    `template_id` names a document template the parent offers. Its title fills
    a left out `title`, and its body a left out `body`; a create without either
    a title or a template is refused.
    """

    title: Optional[str] = None
    body: Optional[str] = None
    icon: Optional[str] = None
    template_id: Optional[str] = None

    @field_validator("icon")
    @classmethod
    def check_icon(cls, value: Optional[str]) -> Optional[str]:
        """Hold the icon to a glyph name or an emoji."""
        return _check_icon(value)

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


class DocumentPatch(BaseModel):
    """The body a document patch takes; any field may be left out, and only `icon` cleared.

    `parent_kind` and `parent_id` together move the document under another
    project, initiative or team the caller may write under. `base_updated_at`
    is the `updated_at` the editor last read. When it is sent and the document
    has changed since, the patch is a 409 rather than writing over someone
    else's edit. `base_body_version` is the narrower guard an editor saving the
    body sends: the `body_version` it loaded. Only a patch that changes the body
    is held to it, so a rename or a move made meanwhile never makes it stale,
    and a stale one is a `BODY_CHANGED` 409 carrying the current body and its
    version.
    """

    title: Optional[str] = None
    body: Optional[str] = None
    icon: Optional[str] = None
    parent_kind: Optional[DocumentParentKind] = None
    parent_id: Optional[str] = None
    base_updated_at: Optional[datetime] = None
    base_body_version: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=64,
        description="The body_version the body edit started from; a stale one is a 409.",
    )

    @field_validator("icon")
    @classmethod
    def check_icon(cls, value: Optional[str]) -> Optional[str]:
        """Hold the icon to a glyph name or an emoji; null or blank clears it."""
        return _check_icon(value)

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
    icon: Optional[str] = None
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
    body_version: str = Field(default="", description="The body's version, sent back as base_body_version.")
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
