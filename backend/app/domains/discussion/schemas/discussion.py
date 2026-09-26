"""Request and response schemas for the discussion domain.

Every list body is an object with one plural key beside `next_cursor`, matching the
M1 and M2 domains, which is what `webbpulse.http.cursor_page` builds. Validation
that needs no table read happens here, so a malformed body is a 422 naming the
field; anything needing the issue's team or an upload ticket is decided in the
route, because a schema cannot read.
"""

from __future__ import annotations

import unicodedata
from datetime import datetime
from typing import Annotated, Literal, Optional
from urllib.parse import urlparse

from fastapi import Query
from pydantic import BaseModel, Field, field_validator, model_validator
from webbpulse.http import cursor_page
from webbpulse.storage import UPLOAD_CONTENT_TYPES

from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.attachments import Attachment
from app.common.db.dynamo.comments import Comment

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

TITLE_MAX = 200

COMMENT_ATTACHMENTS_MAX = 10
"""The most attachments one comment may carry.

Bounds the batch read that renders a thread page and keeps a comment a message
with a few files rather than a folder.
"""

URL_MAX = 2048

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
"""The ceiling a presigned PUT is signed with, 25 MiB.

A larger declared `size_bytes` is refused rather than silently lowered, because a
client that declares 100 MB and is handed a 25 MiB URL fails at the end of the
upload instead of at the start.
"""

DOWNLOAD_EXPIRES_IN = 300
"""How long a presigned download stays valid, in seconds.

Short because the URL is a bearer credential for the object until it expires, and
the frontend mints one per click rather than storing it.
"""

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
"""The 24 emoji the picker offers, in picker order, commonest first.

Product content rather than a platform concern, so it lives here and not in the
shared package. An allow list rather than free text because the emoji is part of a
row's sort key: an arbitrary string would let a caller mint unbounded distinct keys
in one partition, and a skin tone or a zero-width-joiner sequence would render as a
different reaction from the one a reader picked.

This is the one canonical set. `scripts/export_reactions.py` writes it out as
`frontend/src/lib/reactions.json`, which the picker imports, and
`tests/domains/discussion/test_reactions.py` fails when the checked-in file has
drifted, so the two halves cannot disagree the way they did.
"""

LEGACY_REACTION_EMOJI: tuple[str, ...] = (
    "\N{SMILING FACE WITH SMILING EYES}",
    "\N{FACE WITH TEARS OF JOY}",
    "\N{CONFETTI BALL}",
    "\N{SPARKLING HEART}",
    "\N{HAMMER AND WRENCH}",
    "\N{GLOWING STAR}",
    "\N{SEE-NO-EVIL MONKEY}",
)
"""Emoji an earlier allow list accepted that the picker no longer offers.

Still accepted, because rows carrying them exist and refusing them would make an
existing reaction impossible to re-add or remove through the same validated body.
They are deliberately absent from the exported picker set.
"""

VARIATION_SELECTOR = "\N{VARIATION SELECTOR-16}"
"""U+FE0F, the emoji presentation selector.

Stripped before the allow-list test because a client may send either presentation
of the same character. Two of the accepted emoji differ from each other by nothing
else, so comparing raw strings refused the form the picker actually sends.
"""


def normalize_emoji(value: str) -> str:
    """One emoji in the form the allow list and the sort key are held in.

    NFC first, so a decomposed sequence compares equal, then the variation selector
    is dropped, so both presentations of the same character are one reaction rather
    than two rows a reader sees side by side.
    """
    return unicodedata.normalize("NFC", value).replace(VARIATION_SELECTOR, "")


ALLOWED_EMOJI: frozenset[str] = frozenset(normalize_emoji(emoji) for emoji in REACTION_EMOJI + LEGACY_REACTION_EMOJI)
"""Every emoji a reaction may carry, normalised, so a lookup needs no second form."""

EMOJI_MAX_CODE_POINTS = 8
"""The contract's own bound on an emoji, held even though the allow list is tighter.

Checked before the membership test so an over-long string is refused as malformed
rather than compared against the whole list.
"""

ATTACHMENT_CONTENT_TYPES: frozenset[str] = frozenset(UPLOAD_CONTENT_TYPES) - {"image/svg+xml"}
"""What an upload may declare here: the platform allow list minus SVG.

The shared list admits `image/svg+xml` and leans on `disposition_for` to force it
to download, which is a correct answer for a product that needs SVG. This contract
refuses it outright, so the product narrows the platform list rather than restating
it: a type added upstream arrives here, and the one exclusion says why it is an
exclusion.
"""


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


def _check_emoji(value: str) -> str:
    """Hold an emoji to the product's allow list, in either presentation form.

    The normalised form is what is returned, so the stored sort key is the same
    whether or not the caller sent the variation selector.
    """
    candidate = normalize_emoji(value.strip())
    if not candidate:
        raise ValueError("emoji must not be empty")
    if len(candidate) > EMOJI_MAX_CODE_POINTS:
        raise ValueError("emoji must be at most 8 code points")
    if candidate not in ALLOWED_EMOJI:
        raise ValueError("emoji is not one this product accepts")
    return candidate


def _check_https_url(value: str) -> str:
    """Hold an attachment URL to `https` and to the contract's length cap.

    `http` is refused rather than upgraded: an attachment renders as a link a reader
    clicks, and silently rewriting the scheme would point them somewhere the author
    did not name.
    """
    candidate = value.strip()
    if not candidate:
        raise ValueError("url must not be empty")
    if len(candidate) > URL_MAX:
        raise ValueError(f"url must be at most {URL_MAX} characters")
    parsed = urlparse(candidate)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("url must be an absolute https URL")
    return candidate


def favicon_for(url: str) -> str | None:
    """The favicon the MVP shows beside a URL attachment, derived without a fetch.

    Derived rather than crawled: resolving the target would put an outbound request
    from a Lambda on a user-supplied URL in the write path, which is a request
    forgery surface for a picture beside a link.
    """
    host = urlparse(url).netloc
    if not host:
        return None
    return f"https://www.google.com/s2/favicons?domain={host}"


def title_for(url: str, title: str | None) -> str:
    """The title a URL attachment carries, defaulting to the host.

    The MVP does not crawl the target, so a title the caller does not give is the
    host rather than a fetched page title.
    """
    if title and title.strip():
        return title.strip()[:TITLE_MAX]
    return urlparse(url).netloc or url[:TITLE_MAX]


class AuthorRead(BaseModel):
    """Who wrote a comment, denormalised onto the response.

    Rendered from one batched user read per page rather than stored on the row, so
    a display name change is reflected without rewriting every comment.
    """

    user_id: str
    display_name: str = ""
    email: str = ""


class ReactionGroupRead(BaseModel):
    """One emoji's reactions on one target.

    `reacted` is resolved against the calling user, which is what lets the frontend
    render the caller's own reaction as pressed without a second read.
    """

    emoji: str
    count: int
    user_ids: list[str] = Field(default_factory=list)
    reacted: bool = False


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
    """One comment as the API returns it."""

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
    created_at: datetime
    edited_at: Optional[datetime] = None

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
            created_at=comment.created_at,
            edited_at=comment.edited_at,
        )


CommentListRead = cursor_page(CommentRead, "comments", model_name="CommentListRead")
"""The body the comments list route answers with, items under `comments`."""


class CommentCreate(BaseModel):
    """The body a comment create takes.

    `attachment_ids` names attachments already on the same issue, uploaded or
    linked first through the attachment routes, which the comment then shows
    inline. The route holds that each one exists under this issue. The body may
    be empty only when the comment carries an attachment, so a screenshot can be
    posted without a caption while a comment is never blank.
    """

    body: str = ""
    parent_comment_id: Optional[str] = None
    attachment_ids: list[str] = Field(default_factory=list, max_length=COMMENT_ATTACHMENTS_MAX)

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


class ReactionWrite(BaseModel):
    """The body a reaction `PUT` takes.

    `issue_id` is required for a `comment` target and ignored for an `issue` one,
    because a comment's partition is its issue and the route reads the comment back
    to hold that the pair really goes together.
    """

    target_id: str = Field(min_length=1)
    target_kind: TargetKindField
    emoji: str = Field(min_length=1)
    issue_id: Optional[str] = None

    @field_validator("emoji")
    @classmethod
    def check_emoji(cls, value: str) -> str:
        """Hold the emoji to the product's allow list."""
        return _check_emoji(value)


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
        return _check_https_url(value)


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


class DownloadRead(BaseModel):
    """A presigned GET and when it stops working.

    Minted per request and never stored or logged, so the window is the whole
    guard on a URL that is a bearer credential until it expires.
    """

    url: str
    expires_at: datetime
