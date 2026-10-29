"""The MCP tool that reads one attachment, and the attachment summaries other tools carry.

A screenshot embedded in a description or a comment is stored as a stable content
path that only a browser holding a media token can open, so an agent reading the
Markdown sees the path and never the picture. `get_attachment` closes that gap: an
image comes back as MCP image content, and any other file as its metadata and a
short-lived presigned GET, the URL the web download route mints.

Visibility is decided exactly as the download route decides it, through the shared
discussion rule on the attachment's issue, so an issue the caller cannot read, in
another workspace, a team they are outside or hidden by any rule that helper later
learns, answers the same not-found an absent attachment does.
"""

from __future__ import annotations

import base64
from datetime import timedelta
from typing import Any, Iterable

from webbpulse.storage import disposition_for, presigned_get

from app.common import discussion_rules
from app.common.core.config import settings
from app.common.db.dynamo.attachments import Attachment
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.media_tokens import CONTENT_PATH, referenced_attachments
from app.common.upload_rules import normalized_content_type
from app.domains.integrations.mcp.toolkit import NOT_VISIBLE, Tool, ToolCall, issue_ref, object_schema, string
from app.domains.integrations.mcp.transport import ToolContent, ToolError

INLINE_IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})
"""The image types returned as MCP image content; SVG and anything else is a link instead."""

MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024
"""The largest image returned inline.

Base64 grows it by a third, so the JSON-RPC answer stays under the 6 MB Lambda
response limit and under the per-image limit model clients accept.
"""

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
)
