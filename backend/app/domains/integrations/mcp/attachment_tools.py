"""The MCP tools that read and upload attachments, and the summaries other tools carry.

A screenshot embedded in a description or a comment is stored as a stable content
path that only a browser holding a media token can open, so an agent reading the
Markdown sees the path and never the picture. `get_attachment` closes that gap: an
image comes back as MCP image content, and any other file as its metadata and a
short-lived presigned GET, the URL the web download route mints.

Visibility is decided exactly as the download route decides it, through the shared
discussion rule on the attachment's issue, so an issue the caller cannot read, in
another workspace, a team they are outside or hidden by any rule that helper later
learns, answers the same not-found an absent attachment does.

An upload runs the path the web upload runs, `app.common.attachment_uploads`, so
it meets the same membership check, type allow list, ceilings and storage. Two tools
reach it because agents differ. `upload_attachment` carries the bytes inside the
call, the only way in for an agent with no network beyond its MCP connection, and
is capped by what a Lambda request can hold. The presign and commit pair sends the
bytes straight to S3 up to the web's own ceilings, for an agent that can make an
HTTP request.

The web records no activity for an upload, because a pasted screenshot shows in the
body it lands in. An agent's upload does record one, so the feed says the file came
from that agent's user through MCP.
"""

from __future__ import annotations

import base64
import binascii
from datetime import timedelta
from typing import Any, Iterable

from webbpulse.storage import disposition_for, presigned_get

from app.common import discussion_rules
from app.common.attachment_uploads import commit_upload, start_upload, store_upload
from app.common.core.config import settings
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.attachments import Attachment
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.media_tokens import CONTENT_PATH, referenced_attachments
from app.common.upload_rules import VIDEO_CONTENT_TYPES, normalized_content_type
from app.common.url_attachments import TITLE_MAX
from app.domains.integrations.mcp.toolkit import NOT_VISIBLE, Tool, ToolCall, issue_ref, object_schema, string
from app.domains.integrations.mcp.transport import ToolContent, ToolError

INLINE_IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})
"""The image types returned as MCP image content; SVG and anything else is a link instead."""

MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024
"""The largest image returned inline.

Base64 grows it by a third, so the JSON-RPC answer stays under the 6 MB Lambda
response limit and under the per-image limit model clients accept.
"""

MAX_INLINE_UPLOAD_BYTES = MAX_INLINE_IMAGE_BYTES
"""The largest file `upload_attachment` takes inside the call.

Base64 grows it by a third, and the request carrying it has to fit the 6 MB Lambda
payload limit even when API Gateway encodes the body again, which the read side's
cap already holds to.
"""

MAX_INLINE_UPLOAD_CHARACTERS = (MAX_INLINE_UPLOAD_BYTES + 2) // 3 * 4
"""The longest base64 text that can decode within the cap, so a larger one is never decoded."""

ISSUE_REF = "The issue the file is attached to: its id, or its key such as ABC-123"

DOWNLOAD_URL_EXPIRES_IN = 300
"""How long the presigned GET handed to an agent stays valid, the web download route's window."""


def attachment_summary(attachment: Attachment) -> dict[str, Any]:
    """One stored file as the tools list it, enough for a client to decide to fetch it."""
    return {
        "attachment_id": attachment.attachment_id,
        "issue_id": attachment.issue_id,
        "filename": attachment.title,
        "content_type": attachment.content_type,
        "size_bytes": attachment.size_bytes,
    }


def _references(bodies: Iterable[str | None]) -> bool:
    """Whether any body embeds a content path, so the attachment query is skipped when none does."""
    return any(body and CONTENT_PATH.search(body) for body in bodies)


def embedded_attachments(call: ToolCall, issue: Issue, bodies: list[str | None]) -> list[list[dict[str, Any]]]:
    """For each body, the files on the issue it embeds, in the order they appear.

    One query reads the issue's attachments, and only when some body embeds a
    content path at all. An embedded path naming another workspace or a file that is
    no longer on the issue is left out rather than listed as something to fetch.
    """
    if not _references(bodies):
        return [[] for _ in bodies]
    workspace_id = call.context.workspace_id
    files = {
        row.attachment_id: row
        for row in call.repositories.attachments.iter_for_issue(workspace_id, issue.issue_id)
        if row.kind == "file" and row.s3_key
    }
    return [
        [
            attachment_summary(files[found])
            for found in referenced_attachments(workspace_id, [body or ""])
            if found in files
        ]
        for body in bodies
    ]


def _bucket() -> str:
    """The attachments bucket, or a tool error when this environment has none."""
    bucket = settings.ATTACHMENTS_BUCKET.strip()
    if not bucket:
        raise ToolError("File attachments are not configured for this environment")
    return bucket


def _read_object(bucket: str, key: str) -> bytes:
    """One stored object's bytes, at most one byte past the inline cap.

    The object read is bounded so a row understating its size cannot make the
    function buffer a large file. A missing object is the same not-found an absent
    row is.
    """
    import boto3
    from botocore.exceptions import ClientError

    client = boto3.client("s3", region_name=settings.AWS_REGION or None)
    try:
        response = client.get_object(Bucket=bucket, Key=key, Range=f"bytes=0-{MAX_INLINE_IMAGE_BYTES}")
    except ClientError as exc:
        raise ToolError(NOT_VISIBLE) from exc
    return response["Body"].read(MAX_INLINE_IMAGE_BYTES + 1)


def _too_large(size: int) -> ToolError:
    """The refusal for an image over the inline cap, saying how to get it anyway."""
    return ToolError(
        f"That image is {size} bytes, over the {MAX_INLINE_IMAGE_BYTES} bytes returned inline. "
        "Call get_attachment again with as_url true for a short-lived download URL."
    )


def _download(bucket: str, attachment: Attachment) -> dict[str, Any]:
    """The attachment's metadata with a short-lived presigned GET, as the download route mints it."""
    content_type = attachment.content_type or "application/octet-stream"
    download = presigned_get(
        bucket,
        str(attachment.s3_key),
        DOWNLOAD_URL_EXPIRES_IN,
        response_content_type=content_type,
        response_content_disposition=disposition_for(content_type, attachment.title),
        region_name=settings.AWS_REGION,
    )
    return {
        **attachment_summary(attachment),
        "download_url": download.url,
        "expires_at": (utc_now() + timedelta(seconds=download.expires_in)).isoformat(),
    }


def _get_attachment(call: ToolCall) -> Any:
    """One attachment on an issue: an image inline, any other file as a download URL, a link as its URL."""
    issue = issue_ref(call, call.require("issue_id"))
    discussion_rules.load_visible_issue(call.repositories, call.context, issue.issue_id)
    attachment = call.repositories.attachments.get(
        call.context.workspace_id, issue.issue_id, str(call.require("attachment_id"))
    )
    if attachment is None:
        raise ToolError(NOT_VISIBLE)
    if attachment.kind != "file" or not attachment.s3_key:
        return {
            "attachment_id": attachment.attachment_id,
            "issue_id": issue.issue_id,
            "title": attachment.title,
            "url": attachment.url,
        }

    bucket = _bucket()
    content_type = normalized_content_type(attachment.content_type or "")
    if call.optional("as_url", False) or content_type not in INLINE_IMAGE_TYPES:
        return _download(bucket, attachment)
    if (attachment.size_bytes or 0) > MAX_INLINE_IMAGE_BYTES:
        raise _too_large(attachment.size_bytes or 0)

    data = _read_object(bucket, attachment.s3_key)
    if len(data) > MAX_INLINE_IMAGE_BYTES:
        raise _too_large(len(data))
    return ToolContent(
        summary=attachment_summary(attachment),
        blocks=({"type": "image", "data": base64.b64encode(data).decode("ascii"), "mimeType": content_type},),
    )


def _label(value: Any) -> str:
    """A filename for link text: one line, with what would end the text escaped."""
    line = " ".join(str(value).split())
    return line.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def embed_markdown(attachment: Attachment) -> str:
    """The Markdown that shows this file in a body on the same issue, as the web editor writes it.

    Only the stable content path goes in, never a credential; the page appends a
    media token when it renders. An inline image or video embeds, marking a video
    the way the editor does, and any other file becomes a link.
    """
    label = _label(attachment.title)
    path = (
        f"/api/workspaces/{attachment.workspace_id}/attachments/{attachment.attachment_id}"
        f"/content?issue_id={attachment.issue_id}"
    )
    content_type = normalized_content_type(attachment.content_type or "")
    if content_type in VIDEO_CONTENT_TYPES:
        return f"![{label}]({path}&media=video)"
    if content_type in INLINE_IMAGE_TYPES:
        return f"![{label}]({path})"
    return f"[{label}]({path})"


def _uploaded(call: ToolCall, issue: Issue, attachment: Attachment) -> dict[str, Any]:
    """Record the upload in the issue's activity and answer the file with its embed."""
    call.repositories.activity.record(
        build_activity(
            call.context.workspace_id,
            issue.team_id,
            issue.issue_id,
            call.context.user_id,
            "attachment_added",
            to_value=attachment.title,
            source=call.context.source,
        )
    )
    return {**attachment_summary(attachment), "markdown": embed_markdown(attachment)}


def _bounded_text(call: ToolCall, name: str) -> str:
    """A required filename held to the upload route's length cap, or a tool error."""
    value = str(call.require(name))
    if len(value) > TITLE_MAX:
        raise ToolError(f"{name} must be at most {TITLE_MAX} characters")
    return value


def _title(call: ToolCall) -> str | None:
    """An optional display title held to the commit route's length cap, or a tool error."""
    value = call.optional("title")
    if value is None:
        return None
    if len(str(value)) > TITLE_MAX:
        raise ToolError(f"title must be at most {TITLE_MAX} characters")
    return str(value)


def _over_inline_cap() -> ToolError:
    """The refusal for a file too large to carry in the call, naming the tools that take it."""
    return ToolError(
        f"That file is over the {MAX_INLINE_UPLOAD_BYTES} bytes upload_attachment takes. "
        "Use create_attachment_upload and commit_attachment_upload for a larger file."
    )


def _decoded(value: Any) -> bytes:
    """The bytes of a base64 argument, line wrapped or not, within the inline cap, or a tool error.

    The length is read before decoding, so an oversize argument is refused without
    building the bytes, and the refusal names the tools that take a larger file.
    """
    text = "".join(str(value).split())
    if len(text) > MAX_INLINE_UPLOAD_CHARACTERS:
        raise _over_inline_cap()
    try:
        data = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ToolError("content_base64 must be valid base64") from exc
    if not data:
        raise ToolError("content_base64 must not be empty")
    if len(data) > MAX_INLINE_UPLOAD_BYTES:
        raise _over_inline_cap()
    return data


def _size(value: Any) -> int:
    """A declared size as a positive whole number of bytes, or a tool error."""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ToolError("size_bytes must be a positive whole number of bytes")
    return value


def _upload_attachment(call: ToolCall) -> Any:
    """Store a file carried inside the call and answer it with its embed."""
    issue = issue_ref(call, call.require("issue_id"))
    stored = store_upload(
        call.repositories,
        call.context,
        issue.issue_id,
        _bounded_text(call, "filename"),
        str(call.require("content_type")),
        _decoded(call.require("content_base64")),
        _title(call),
    )
    return _uploaded(call, issue, stored)


def _create_attachment_upload(call: ToolCall) -> Any:
    """Mint a presigned PUT for a file the agent sends to S3 itself, storing nothing yet."""
    issue = issue_ref(call, call.require("issue_id"))
    started = start_upload(
        call.repositories,
        call.context,
        issue.issue_id,
        _bounded_text(call, "filename"),
        str(call.require("content_type")),
        _size(call.require("size_bytes")),
    )
    return {
        "upload_id": started.upload_id,
        "ticket": started.ticket,
        "url": started.url,
        "method": "PUT",
        "headers": dict(started.headers),
        "max_bytes": started.max_bytes,
        "expires_at": started.expires_at.isoformat(),
    }


def _commit_attachment_upload(call: ToolCall) -> Any:
    """Record a file the agent has sent to S3 and answer it with its embed."""
    issue = issue_ref(call, call.require("issue_id"))
    committed = commit_upload(
        call.repositories,
        call.context,
        issue.issue_id,
        str(call.require("upload_id")),
        str(call.require("ticket")),
        _title(call),
    )
    return _uploaded(call, issue, committed)


FILENAME_HELP = "The file's name, at most 200 characters"

CONTENT_TYPE_HELP = (
    "The file's content type, such as image/png. Images other than SVG, video, PDF, text and common "
    "document types are accepted, as in the web editor"
)

TITLE_HELP = "What the file reads as on the issue; its filename when left out"

EMBED_HELP = (
    "The answer carries attachment_id and markdown: put markdown in a description or comment on the same "
    "issue with update_issue or add_comment to display the file, since a media token opens files per issue."
)

ATTACHMENT_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="get_attachment",
        description=(
            "Read one file attached to an issue, such as a screenshot embedded in its description or a comment. "
            "get_issue and list_comments list the attachments each body embeds. A PNG, JPEG, GIF or WebP image up "
            f"to {MAX_INLINE_IMAGE_BYTES} bytes comes back as image content; any other file, or any file with "
            "as_url true, comes back as its metadata and a download URL valid for five minutes. A URL link "
            "answers its URL."
        ),
        scopes=("issues:read",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "attachment_id": string("The attachment to read, as get_issue or list_comments lists it"),
                "as_url": {
                    "type": "boolean",
                    "description": "Answer a short-lived download URL instead of the image itself",
                },
            },
            required=("issue_id", "attachment_id"),
        ),
        handler=_get_attachment,
    ),
    Tool(
        name="upload_attachment",
        description=(
            f"Upload a file of at most {MAX_INLINE_UPLOAD_BYTES} bytes to an issue, its bytes carried in this call "
            "as base64, so it needs no network beyond this connection. Any member of the issue's team may upload, "
            f"under the web's file type rules and the workspace's storage. {EMBED_HELP} For a larger file use "
            "create_attachment_upload."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "filename": string(FILENAME_HELP),
                "content_type": string(CONTENT_TYPE_HELP),
                "content_base64": string("The file's bytes, base64 encoded"),
                "title": string(TITLE_HELP),
            },
            required=("issue_id", "filename", "content_type", "content_base64"),
        ),
        handler=_upload_attachment,
    ),
    Tool(
        name="create_attachment_upload",
        description=(
            "Start an upload of a file up to the web's limits, 25 MiB or 200 MiB for video, for an agent that can "
            "make HTTP requests. Any member of the issue's team may upload, within the workspace's storage. Send "
            "the file with an HTTP PUT to the url in the answer, with exactly the headers it lists, then call "
            "commit_attachment_upload within the hour. Nothing shows on the issue until that commit."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "filename": string(FILENAME_HELP),
                "content_type": string(CONTENT_TYPE_HELP),
                "size_bytes": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "The file's exact size in bytes, which the upload URL enforces",
                },
            },
            required=("issue_id", "filename", "content_type", "size_bytes"),
        ),
        handler=_create_attachment_upload,
    ),
    Tool(
        name="commit_attachment_upload",
        description=(
            f"Finish an upload started with create_attachment_upload, once the PUT has succeeded. {EMBED_HELP}"
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "upload_id": string("The upload_id create_attachment_upload answered"),
                "ticket": string("The ticket create_attachment_upload answered"),
                "title": string(TITLE_HELP),
            },
            required=("issue_id", "upload_id", "ticket"),
        ),
        handler=_commit_attachment_upload,
    ),
)
