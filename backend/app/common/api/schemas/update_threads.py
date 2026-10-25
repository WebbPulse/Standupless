"""Request and response schemas for replies and reactions on project updates."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.common.change_source import ChangeSource
from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.update_threads import UpdateComment
from app.common.discussion_reads import AuthorRead, ReactionGroupRead, check_emoji


def _check_body(value: str) -> str:
    """Hold a reply body to non-blank markdown under the comment byte cap."""
    if not value.strip():
        raise ValueError("body must not be empty")
    if len(value.encode("utf-8")) > ISSUE_BODY_MAX_BYTES:
        raise ValueError(f"body must be at most {ISSUE_BODY_MAX_BYTES} bytes")
    return value


class ProjectUpdateCommentCreate(BaseModel):
    """The body a reply on a project update takes."""

    body: str

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        """Hold the body to the shared cap."""
        return _check_body(value)


class ProjectUpdateCommentPatch(BaseModel):
    """The body a reply edit takes."""

    body: str

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        """Hold the body to the shared cap."""
        return _check_body(value)


class ProjectUpdateCommentRead(BaseModel):
    """One reply on a project update as the API returns it.

    `can_edit` says whether this caller may edit or delete it, which is its
    author, a workspace admin or an admin of one of the project's teams.
    """

    comment_id: str
    update_id: str
    project_id: str
    workspace_id: str
    body: str
    author_id: str
    author: AuthorRead
    mentions: list[str] = Field(default_factory=list)
    reactions: list[ReactionGroupRead] = Field(default_factory=list)
    source: Optional[ChangeSource] = None
    created_at: datetime
    edited_at: Optional[datetime] = None
    can_edit: bool = False

    @classmethod
    def from_row(
        cls,
        comment: UpdateComment,
        *,
        author: AuthorRead,
        reactions: list[ReactionGroupRead],
        can_edit: bool,
    ) -> "ProjectUpdateCommentRead":
        """Build the response shape from a stored reply and what the thread read joined onto it."""
        return cls(
            comment_id=comment.comment_id,
            update_id=comment.update_id,
            project_id=comment.project_id,
            workspace_id=comment.workspace_id,
            body=comment.body,
            author_id=comment.author_id,
            author=author,
            mentions=comment.mentions,
            reactions=reactions,
            source=comment.source,  # pyright: ignore[reportArgumentType]
            created_at=comment.created_at,
            edited_at=comment.edited_at,
            can_edit=can_edit,
        )


class ProjectUpdateCommentListRead(BaseModel):
    """An update's whole thread, oldest reply first.

    Not a cursor page: a thread is read in one query and renders whole, as an
    update's replies are a conversation of a few messages rather than a feed.
    """

    comments: list[ProjectUpdateCommentRead]


class ProjectUpdateReactionWrite(BaseModel):
    """The body a reaction `PUT` on an update or one of its replies takes.

    `comment_id` names a reply of the update to react to, and leaving it out
    reacts to the update itself.
    """

    emoji: str = Field(min_length=1)
    comment_id: Optional[str] = None

    @field_validator("emoji")
    @classmethod
    def check_emoji(cls, value: str) -> str:
        """Hold the reaction to exactly one emoji, stored in its normalised form."""
        return check_emoji(value)
