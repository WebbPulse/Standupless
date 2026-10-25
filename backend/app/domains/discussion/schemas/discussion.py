"""Request and response schemas for the discussion domain.

Every list body is an object with one plural key beside `next_cursor`, matching the
M1 and M2 domains, which is what `webbpulse.http.cursor_page` builds. Validation
that needs no table read happens here, so a malformed body is a 422 naming the
field; anything needing the issue's team or an upload ticket is decided in the
route, because a schema cannot read.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Optional

from fastapi import Query
from pydantic import BaseModel, Field, field_validator, model_validator
from webbpulse.http import cursor_page
from webbpulse.storage import disposition_for

from app.common.change_source import ChangeSource
from app.common.comment_anchors import ANCHOR_CONTEXT_MAX, ANCHOR_QUOTE_MAX
from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.attachments import Attachment
from app.common.db.dynamo.comments import Comment, CommentAnchor, GithubThread, SlackThread, ThreadResolution
from app.common.discussion_reads import AuthorRead, ReactionGroupRead, check_emoji
from app.common.upload_rules import VIDEO_CONTENT_TYPES, normalized_content_type
from app.common.url_attachments import TITLE_MAX, check_https_url

TargetKindField = Literal["issue", "comment"]

TargetKindQuery = Annotated[TargetKindField, Query()]
"""`target_kind` as a query parameter, validated to the two kinds by the literal.

Shared by the reaction read and delete so an unknown kind is a 422 naming the
parameter in both, rather than a string that reaches a repository and matches
nothing.
"""

AttachmentKindField = Literal["url", "file"]

DEFAULT_LIMIT = 50

MAX_LIMIT = 100


COMMENT_ATTACHMENTS_MAX = 10
"""The most attachments one comment may carry.

Bounds the batch read that renders a thread page and keeps a comment a message
with a few files rather than a folder.
"""


DOWNLOAD_EXPIRES_IN = 300
"""How long a presigned download stays valid, in seconds.

Short because the URL is a bearer credential for the object until it expires, and
the frontend mints one per click rather than storing it.
"""

CONTENT_EXPIRES_IN = 900
"""How long the presigned GET behind an inline image or video stays valid, in seconds.

Longer than a download link because a video element keeps issuing range requests
against the URL it was redirected to while the reader watches and seeks.
"""

CONTENT_REDIRECT_MAX_AGE = 300
"""How long a browser may reuse one content redirect, well inside `CONTENT_EXPIRES_IN`."""

REACTION_EMOJI: tuple[str, ...] = (
    "\N{THUMBS UP SIGN}",
    "\N{THUMBS DOWN SIGN}",
    "\N{SMILING FACE WITH OPEN MOUTH AND SMILING EYES}",
    "\N{PARTY POPPER}",
    "\N{CONFUSED FACE}",
    "\N{HEAVY BLACK HEART}",
    "\N{ROCKET}",
    "\N{EYES}",
    "\N{PERSON WITH FOLDED HANDS}",
    "\N{FIRE}",
    "\N{HUNDRED POINTS SYMBOL}",
    "\N{WHITE HEAVY CHECK MARK}",
    "\N{CROSS MARK}",
    "\N{WARNING SIGN}",
    "\N{BUG}",
    "\N{ELECTRIC LIGHT BULB}",
    "\N{MEMO}",
    "\N{HOURGLASS WITH FLOWING SAND}",
    "\N{THINKING FACE}",
    "\N{CLAPPING HANDS SIGN}",
    "\N{PERSON RAISING BOTH HANDS IN CELEBRATION}",
    "\N{SMILING FACE WITH OPEN MOUTH AND COLD SWEAT}",
    "\N{HANDSHAKE}",
    "\N{WHITE MEDIUM STAR}",
)
"""The 24 quick picks the picker leads with, commonest first.

Product content rather than a platform concern, so it lives here and not in the
shared package. Any single emoji is accepted, so this is not an allow list: it is
the short row a reader reaches without searching.

`scripts/export_reactions.py` writes it out as `frontend/src/lib/reactions.json`,
which the picker imports, and `tests/domains/discussion/test_reactions.py` fails
when the checked-in file has drifted, so the two halves cannot disagree.
"""


def content_disposition(content_type: str, filename: str) -> str:
    """The disposition an embedded file is served with.

    The platform rule, except that the video types this product embeds play inline
    rather than downloading when the content URL is opened on its own.
    """
    disposition = disposition_for(content_type, filename)
    if normalized_content_type(content_type) in VIDEO_CONTENT_TYPES and disposition.startswith("attachment"):
        return "inline" + disposition[len("attachment") :]
    return disposition


def _check_body(value: str) -> str:
    """Hold a comment body to the shared byte cap and to being non-empty.

    Measured in UTF-8 bytes rather than characters, because the cap exists to keep
    the item well under DynamoDB's limit and it is the encoded length that counts.
    """
    if not value.strip():
        raise ValueError("body must not be empty")
    if len(value.encode("utf-8")) > ISSUE_BODY_MAX_BYTES:
        raise ValueError(f"body must be at most {ISSUE_BODY_MAX_BYTES} bytes")
    return value


class ReactionListRead(BaseModel):
    """The body the reactions list route answers with.

    Not a cursor page: a group is a count over a whole partition, so a page
    boundary would produce a count of part of it.
    """

    reactions: list[ReactionGroupRead]


class AttachmentRead(BaseModel):
    """One attachment as the API returns it.

    `s3_key` is returned so the frontend can key a cache on it. It is not a
    credential: the bucket is private and the only way to a byte is the download
    route, which mints a presigned GET per request.
    """

    attachment_id: str
    issue_id: str
    workspace_id: str
    team_id: str
    kind: AttachmentKindField
    title: str
    url: Optional[str] = None
    favicon_url: Optional[str] = None
    s3_key: Optional[str] = None
    content_type: Optional[str] = None
    size_bytes: Optional[int] = None
    uploaded_by: str
    created_at: datetime

    @classmethod
    def from_row(cls, attachment: Attachment) -> "AttachmentRead":
        """One stored attachment as the response."""
        return cls(
            attachment_id=attachment.attachment_id,
            issue_id=attachment.issue_id,
            workspace_id=attachment.workspace_id,
            team_id=attachment.team_id,
            kind="file" if attachment.kind == "file" else "url",
            title=attachment.title,
            url=attachment.url,
            favicon_url=attachment.favicon_url,
            s3_key=attachment.s3_key,
            content_type=attachment.content_type,
            size_bytes=attachment.size_bytes,
            uploaded_by=attachment.uploaded_by,
            created_at=attachment.created_at,
        )


class CommentRead(BaseModel):
    """One comment as the API returns it.

    `github_thread` is set on a root comment whose thread is synced to a GitHub
    pull request or issue, `slack_thread` on the root synced with the Slack
    thread the issue was created from, and `resolution` on a root whose thread is resolved,
    which a reader collapses to one line. `anchor` is set on a root pinned to a
    passage of the issue description. `document_id` is set on a comment on a
    document, whose `issue_id` then repeats the document id and whose `team_id`
    is empty.
    """

    comment_id: str
    issue_id: str
    workspace_id: str
    team_id: str
    body: str
    parent_comment_id: Optional[str] = None
    author_id: str
    author: AuthorRead
    mentions: list[str] = Field(default_factory=list)
    reactions: list[ReactionGroupRead] = Field(default_factory=list)
    reply_count: int = 0
    attachments: list[AttachmentRead] = Field(default_factory=list)
    source: Optional[ChangeSource] = None
    created_at: datetime
    edited_at: Optional[datetime] = None
    github_thread: Optional[GithubThread] = None
    slack_thread: Optional[SlackThread] = None
    resolution: Optional[ThreadResolution] = None
    anchor: Optional[CommentAnchor] = None
    document_id: Optional[str] = None

    @classmethod
    def from_row(
        cls,
        comment: Comment,
        *,
        author: AuthorRead,
        reactions: list[ReactionGroupRead] | None = None,
        reply_count: int = 0,
        attachments: list[AttachmentRead] | None = None,
    ) -> "CommentRead":
        """One stored comment as the response, with the parts it is joined to.

        `attachments` is in the comment's stored order and leaves out any that were
        removed since, so a deleted file drops out of the comment rather than
        rendering as a broken chip.
        """
        return cls(
            comment_id=comment.comment_id,
            issue_id=comment.issue_id,
            workspace_id=comment.workspace_id,
            team_id=comment.team_id,
            body=comment.body,
            parent_comment_id=comment.parent_comment_id,
            author_id=comment.author_id,
            author=author,
            mentions=list(comment.mentions),
            reactions=list(reactions or []),
            reply_count=reply_count,
            attachments=list(attachments or []),
            source=comment.source,  # pyright: ignore[reportArgumentType]
            created_at=comment.created_at,
            edited_at=comment.edited_at,
            github_thread=comment.github_thread,
            slack_thread=comment.slack_thread,
            resolution=comment.resolution,
            anchor=comment.anchor,
            document_id=comment.document_id,
        )


CommentListRead = cursor_page(CommentRead, "comments", model_name="CommentListRead")
"""The body the comments list route answers with, items under `comments`."""


class CommentCreate(BaseModel):
    """The body a comment create takes.

    `attachment_ids` names attachments already on the same issue, uploaded or
    linked first through the attachment routes, which the comment then shows
    inline. The route holds that each one exists under this issue. The body may
    be empty only when the comment carries an attachment, so a screenshot can be
    posted without a caption while a comment is never blank. `anchor` pins a new
    thread to a passage of the description, so a reply cannot carry one.
    """

    body: str = ""
    parent_comment_id: Optional[str] = None
    attachment_ids: list[str] = Field(default_factory=list, max_length=COMMENT_ATTACHMENTS_MAX)
    anchor: Optional[CommentAnchor] = None

    @field_validator("anchor")
    @classmethod
    def check_anchor(cls, value: Optional[CommentAnchor]) -> Optional[CommentAnchor]:
        """Hold the passage to a non-blank quote under the caps, trimming its context."""
        if value is None:
            return None
        quote = value.quote.strip()
        if not quote:
            raise ValueError("anchor quote must not be blank")
        if len(quote) > ANCHOR_QUOTE_MAX:
            raise ValueError(f"anchor quote must be at most {ANCHOR_QUOTE_MAX} characters")
        return CommentAnchor(
            quote=quote,
            prefix=value.prefix[-ANCHOR_CONTEXT_MAX:] if value.prefix else "",
            suffix=value.suffix[:ANCHOR_CONTEXT_MAX],
        )

    @field_validator("attachment_ids")
    @classmethod
    def check_attachment_ids(cls, value: list[str]) -> list[str]:
        """Drop repeats and refuse blanks, keeping the order the author attached in."""
        if any(not item.strip() for item in value):
            raise ValueError("attachment_ids must not contain blanks")
        return list(dict.fromkeys(item.strip() for item in value))

    @model_validator(mode="after")
    def check_body(self) -> CommentCreate:
        """Hold the body to the shared cap, letting it be blank only beside an attachment."""
        if self.anchor is not None and self.parent_comment_id is not None:
            raise ValueError("a reply cannot be pinned to a passage")
        if self.attachment_ids and not self.body.strip():
            self.body = ""
            return self
        self.body = _check_body(self.body)
        return self


class CommentUpdate(BaseModel):
    """The body a comment edit takes, carrying the issue that partitions it."""

    issue_id: str = Field(min_length=1)
    body: str = Field(min_length=1)

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        """Hold the body to the shared byte cap."""
        return _check_body(value)


class DocumentCommentCreate(BaseModel):
    """The body a comment on a document takes: text, and the root it replies to if any."""

    body: str = Field(min_length=1)
    parent_comment_id: Optional[str] = None

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        """Hold the body to the shared byte cap."""
        return _check_body(value)


class DocumentCommentUpdate(BaseModel):
    """The body an edit of a comment on a document takes."""

    body: str = Field(min_length=1)

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        """Hold the body to the shared byte cap."""
        return _check_body(value)


class ReactionWrite(BaseModel):
    """The body a reaction `PUT` takes.

    `issue_id` is required for a `comment` target and ignored for an `issue` one,
    because a comment's partition is its issue and the route reads the comment back
    to hold that the pair really goes together. A comment on a document names its
    document in `document_id` instead.
    """

    target_id: str = Field(min_length=1)
    target_kind: TargetKindField
    emoji: str = Field(min_length=1)
    issue_id: Optional[str] = None
    document_id: Optional[str] = None

    @field_validator("emoji")
    @classmethod
    def check_emoji(cls, value: str) -> str:
        """Hold the value to exactly one emoji."""
        return check_emoji(value)


AttachmentListRead = cursor_page(AttachmentRead, "attachments", model_name="AttachmentListRead")
"""The body the attachments list route answers with, items under `attachments`."""


class UrlAttachmentCreate(BaseModel):
    """The body a URL attachment create takes."""

    issue_id: str = Field(min_length=1)
    url: str = Field(min_length=1)
    title: Optional[str] = Field(default=None, max_length=TITLE_MAX)

    @field_validator("url")
    @classmethod
    def check_url(cls, value: str) -> str:
        """Hold the URL to `https` and to the length cap."""
        return check_https_url(value)


class UploadTicketCreate(BaseModel):
    """The body an upload ticket request takes.

    `size_bytes` is what the client declares, and it becomes the `Content-Length`
    signed into the URL, so S3 enforces the ceiling at the header rather than the
    application measuring it after the bytes land.
    """

    issue_id: str = Field(min_length=1)
    filename: str = Field(min_length=1, max_length=TITLE_MAX)
    content_type: str = Field(min_length=1)
    size_bytes: int = Field(gt=0)


class UploadTicketRead(BaseModel):
    """The presigned PUT and the exact headers the client has to send.

    `headers` comes straight from `PresignedUpload.headers` and none of it is
    advisory: every header is inside the signature, so a PUT that omits or changes
    one is refused by S3 rather than stored differently from what was authorised.
    """

    upload_id: str
    ticket: str
    url: str
    headers: dict[str, str]
    s3_key: str
    max_bytes: int
    expires_at: datetime


class UploadCommit(BaseModel):
    """The body that records an uploaded object as an attachment.

    Only this call makes an upload visible on the issue, so an abandoned one is an
    orphaned object the lifecycle rule collects rather than a half-attached row.
    """

    issue_id: str = Field(min_length=1)
    upload_id: str = Field(min_length=1)
    ticket: str = Field(min_length=1)
    title: Optional[str] = Field(default=None, max_length=TITLE_MAX)


class StorageUsageRead(BaseModel):
    """The workspace's pooled attachment storage: what its uploads hold against its plan."""

    plan: str
    used_bytes: int
    limit_bytes: int


class DownloadRead(BaseModel):
    """A presigned GET and when it stops working.

    Minted per request and never stored or logged, so the window is the whole
    guard on a URL that is a bearer credential until it expires.
    """

    url: str
    expires_at: datetime


class MediaTokensRead(BaseModel):
    """Media tokens for the file attachments on one issue, keyed by attachment id.

    Each token is appended to that attachment's stable content path at render time,
    so a stored body never carries a credential.
    """

    tokens: dict[str, str]
    expires_at: datetime
