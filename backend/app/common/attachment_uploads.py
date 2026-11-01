"""File uploads onto an issue, shared by the attachment routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a file an agent uploads must meet the same rules as one a person drops
into the web editor: the same visibility and team membership check, the same type
allow list and ceilings, and the same pooled storage reservation.

Two ways in reach one record step. The presign and commit pair sends the bytes
straight to S3, and `store_upload` takes bytes already in hand for a caller that
cannot reach S3 itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Mapping

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed
from webbpulse.storage import presigned_put

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.attachments import Attachment, build_attachment, new_upload_id, object_key, stored_bytes
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.discussion_rules import conflict, load_visible_issue, require_team_member
from app.common.plan_limits import check_storage, storage_limit_of
from app.common.upload_rules import ATTACHMENT_CONTENT_TYPES, normalized_content_type, upload_ceiling
from app.common.upload_ticket import TICKET_TTL_SECONDS, TicketError, mint_ticket, read_ticket
from app.common.url_attachments import TITLE_MAX


@dataclass(frozen=True)
class StartedUpload:
    """A presigned PUT and the ticket that later commits it."""

    upload_id: str
    ticket: str
    url: str
    headers: Mapping[str, str]
    key: str
    max_bytes: int
    expires_at: datetime


def unprocessable(message: str, error_code: str = "VALIDATION_ERROR") -> HTTPException:
    """A 422 carrying one of the contract's own error codes.

    The code is a parameter because M3 adds `UNSUPPORTED_MEDIA_TYPE` and
    `UPLOAD_TOO_LARGE` beside the platform envelope's own, and a client
    distinguishes them by code rather than by message.
    """
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"error_code": error_code, "message": message},
    )


def unknown_upload() -> HTTPException:
    """The 404 a commit naming a ticket this caller did not mint gets.

    One answer for an absent ticket, an expired one and one minted for another
    caller or another issue, so a commit cannot be used to probe for tickets.
    """
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error_code": "UNKNOWN_UPLOAD", "message": "No such upload"},
    )


def attachments_bucket() -> str:
    """The bucket attachments are presigned against, or a 422 when none is set.

    Fails closed rather than guessing a name: a function deployed without the
    bucket or without its IAM grant refuses to sign, instead of handing out a URL
    that S3 rejects after the client has read the whole file.
    """
    bucket = settings.ATTACHMENTS_BUCKET.strip()
    if not bucket:
        raise unprocessable("File uploads are not configured for this environment")
    return bucket


def object_exists(bucket: str, key: str) -> bool:
    """Whether one object is really in the bucket.

    The commit's guard, so recording an attachment for an upload that never
    happened is a 409 rather than a row pointing at nothing. `webbpulse.storage`
    presigns but does not read, and a `HeadObject` is the one S3 call this path
    makes for a presigned upload; anything beyond it belongs upstream rather than
    here.

    Any error that is not a plain absence is treated as absence too, because the
    only use of this answer is whether to record a row, and recording one on an
    inconclusive read is the worse failure.
    """
    import boto3
    from botocore.exceptions import ClientError

    client = boto3.client("s3", region_name=settings.AWS_REGION or None)
    try:
        client.head_object(Bucket=bucket, Key=key)
    except ClientError:
        return False
    return True


def _admit(
    repositories: Repositories, context: AuthzContext, issue_id: str, content_type: str, size_bytes: int
) -> Issue:
    """The issue an upload lands on, once its caller, type, size and storage all pass.

    The type is checked before anything is stored or signed, so a refused type never
    exists in the bucket. A declared size above the ceiling is refused rather than
    quietly lowered, so a client fails at the start of an upload and not at its end.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)
    if normalized_content_type(content_type) not in ATTACHMENT_CONTENT_TYPES:
        raise unprocessable(
            "That file type cannot be uploaded",
            error_code="UNSUPPORTED_MEDIA_TYPE",
        )
    ceiling = upload_ceiling(content_type)
    if size_bytes > ceiling:
        raise unprocessable(
            f"Files of this type are limited to {ceiling} bytes",
            error_code="UPLOAD_TOO_LARGE",
        )
    check_storage(
        repositories.workspaces.get(context.workspace_id),
        repositories.attachments.storage_used(context.workspace_id),
        size_bytes,
    )
    return issue


def _record(
    repositories: Repositories,
    context: AuthzContext,
    issue: Issue,
    title: str | None,
    filename: str,
    key: str,
    content_type: str,
    size_bytes: int,
) -> Attachment:
    """Record a stored object as an attachment, reserving its bytes first.

    Storage is checked again here, because other uploads may have committed since
    the first check, and the bytes are then reserved by one conditional write on the
    workspace's counter, so two uploads racing for the last bytes cannot both land.
    """
    workspace = repositories.workspaces.get(context.workspace_id)
    check_storage(workspace, repositories.attachments.storage_used(context.workspace_id), size_bytes)
    attachment = build_attachment(
        context.workspace_id,
        issue.issue_id,
        issue.team_id,
        "file",
        (title.strip()[:TITLE_MAX] if title and title.strip() else filename),
        context.user_id,
        s3_key=key,
        content_type=content_type,
        size_bytes=size_bytes,
    )
    reserved = stored_bytes([attachment])
    limit = storage_limit_of(workspace)
    if not repositories.attachments.reserve_storage(context.workspace_id, reserved, limit):
        check_storage(workspace, max(limit, repositories.attachments.storage_used(context.workspace_id)), reserved)
    try:
        return repositories.attachments.create(attachment)
    except ConditionFailed as exc:
        repositories.attachments.add_storage(context.workspace_id, -reserved)
        raise conflict("That attachment already exists") from exc
    except Exception:
        repositories.attachments.add_storage(context.workspace_id, -reserved)
        raise


def start_upload(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: str,
    filename: str,
    content_type: str,
    size_bytes: int,
) -> StartedUpload:
    """Mint a bounded presigned PUT and its ticket, storing nothing on the issue yet."""
    declared_type = content_type.strip()
    _admit(repositories, context, issue_id, declared_type, size_bytes)
    bucket = attachments_bucket()
    upload_id = new_upload_id()
    key = object_key(context.workspace_id, issue_id, upload_id, filename)
    upload = presigned_put(
        bucket,
        key,
        declared_type,
        size_bytes,
        expires_in=TICKET_TTL_SECONDS,
        region_name=settings.AWS_REGION,
    )
    ticket = mint_ticket(
        context.workspace_id,
        issue_id,
        context.user_id,
        upload_id,
        key,
        filename,
        declared_type,
        size_bytes,
    )
    return StartedUpload(
        upload_id=upload_id,
        ticket=ticket,
        url=upload.url,
        headers=upload.headers,
        key=key,
        max_bytes=upload.max_bytes,
        expires_at=utc_now() + timedelta(seconds=upload.expires_in),
    )


def commit_upload(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: str,
    upload_id: str,
    ticket: str,
    title: str | None = None,
) -> Attachment:
    """Record an uploaded object as an attachment, once it is really in the bucket.

    The ticket is what proves the key was signed by this service for this caller on
    this issue, so the recorded type and size are the ones S3 was told to enforce
    rather than anything the commit claims. The object is checked for existence
    first, so a commit for an upload that never happened is a 409 rather than a row
    pointing at nothing.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)
    try:
        claims = read_ticket(ticket, context.workspace_id, issue_id, context.user_id)
    except TicketError as exc:
        raise unknown_upload() from exc
    if claims.get("upload_id") != upload_id:
        raise unknown_upload()

    key = str(claims["key"])
    if not object_exists(attachments_bucket(), key):
        raise conflict("That upload is not in the bucket yet")
    return _record(
        repositories,
        context,
        issue,
        title,
        str(claims.get("filename", "")),
        key,
        str(claims.get("content_type", "")),
        int(claims.get("size_bytes", 0)),
    )


def store_upload(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: str,
    filename: str,
    content_type: str,
    data: bytes,
    title: str | None = None,
) -> Attachment:
    """Store bytes already in hand under the rules a presigned upload meets.

    The size is the bytes' real length, and the object lands before its row, so a
    failed record leaves an orphaned object the bucket lifecycle rule collects,
    never a row pointing at nothing, as an abandoned presigned upload does.
    """
    declared_type = content_type.strip()
    issue = _admit(repositories, context, issue_id, declared_type, len(data))
    bucket = attachments_bucket()
    key = object_key(context.workspace_id, issue_id, new_upload_id(), filename)

    import boto3

    boto3.client("s3", region_name=settings.AWS_REGION or None).put_object(
        Bucket=bucket, Key=key, Body=data, ContentType=declared_type
    )
    return _record(repositories, context, issue, title, filename, key, declared_type, len(data))
