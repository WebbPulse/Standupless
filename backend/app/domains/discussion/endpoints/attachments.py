"""Attachment routes: list, attach a URL, the three-call upload, download, delete.

The upload is three calls on purpose. The presign call mints a bounded PUT and
stores nothing, the browser PUTs straight to S3, and only the commit call records
the row that makes the object visible on the issue. An abandoned upload is
therefore an orphaned object the bucket lifecycle rule collects, never a
half-attached row a reader can see.

Bytes never pass through this function in either direction. The bucket is private,
and the only path to an object is a presigned GET minted per request with a short
window and a disposition that forces anything not inline-safe to download.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status
from webbpulse.dynamodb import ConditionFailed
from webbpulse.http import CursorPage
from webbpulse.storage import disposition_for, is_allowed_upload, presigned_get, presigned_put

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.core.config import settings
from app.common.db.dynamo.attachments import as_attachment, build_attachment, new_upload_id, object_key
from app.common.db.dynamo.base import utc_now
from app.domains.discussion.schemas.discussion import (
    ATTACHMENT_CONTENT_TYPES,
    DEFAULT_LIMIT,
    DOWNLOAD_EXPIRES_IN,
    MAX_LIMIT,
    MAX_UPLOAD_BYTES,
    TITLE_MAX,
    AttachmentListRead,
    AttachmentRead,
    DownloadRead,
    UploadCommit,
    UploadTicketCreate,
    UploadTicketRead,
    UrlAttachmentCreate,
    favicon_for,
    title_for,
)
from app.domains.discussion.service import (
    attachments_bucket,
    conflict,
    forbidden,
    is_project_admin,
    load_visible_issue,
    not_found,
    object_exists,
    require_project_member,
    unknown_upload,
    unprocessable,
)
from app.domains.discussion.upload_ticket import TICKET_TTL_SECONDS, TicketError, mint_ticket, read_ticket

router = APIRouter()


@router.get("/{workspace_id}/attachments", response_model=AttachmentListRead)
def list_attachments(
    issue_id: Annotated[str, Query(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[AttachmentRead]:
    """One page of an issue's attachments, oldest first.

    No URL is minted here. A list of twenty attachments would otherwise be twenty
    bearer credentials handed out whether or not anything is downloaded, so a URL
    costs an explicit call for the one object the reader asked for.
    """
    load_visible_issue(repositories, context, issue_id)
    scope = f"attachments:{context.workspace_id}:{issue_id}"
    page = repositories.attachments.list_for_issue(
        context.workspace_id,
        issue_id,
        limit=limit,
        start_key=decode_cursor(cursor, scope),
    )
    return AttachmentListRead(
        items=[AttachmentRead.from_row(as_attachment(item)) for item in page.items],
        next_cursor=encode_cursor(page.last_evaluated_key, scope),
    )


@router.post(
    "/{workspace_id}/attachments/url",
    response_model=AttachmentRead,
    status_code=status.HTTP_201_CREATED,
)
def attach_url(
    payload: UrlAttachmentCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> AttachmentRead:
    """Hang a link on an issue, deriving its favicon without fetching it.

    The MVP does not crawl the target, so a title the caller does not give defaults
    to the host and the favicon is a composed URL. Not fetching is the decision: a
    crawl on a write path is a request the caller controls the destination of.
    """
    issue = load_visible_issue(repositories, context, payload.issue_id)
    require_project_member(repositories, context, issue.project_id)

    attachment = build_attachment(
        context.workspace_id,
        payload.issue_id,
        issue.project_id,
        "url",
        title_for(payload.url, payload.title),
        context.user_id,
        url=payload.url,
        favicon_url=favicon_for(payload.url),
    )
    try:
        created = repositories.attachments.create(attachment)
    except ConditionFailed as exc:
        raise conflict("That attachment already exists") from exc
    return AttachmentRead.from_row(created)


@router.post(
    "/{workspace_id}/attachments/uploads",
    response_model=UploadTicketRead,
    status_code=status.HTTP_201_CREATED,
)
def create_upload(
    payload: UploadTicketCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> UploadTicketRead:
    """Mint a bounded presigned PUT, storing nothing on the issue yet.

    The declared size is refused above the cap rather than quietly lowered, because
    a client that declares 100 MB and receives a 25 MiB URL fails at the end of the
    upload instead of the start.

    The type is checked before signing rather than after the object lands: the type
    goes into the signature, so refusing it here is what keeps the object from
    existing at all.
    """
    issue = load_visible_issue(repositories, context, payload.issue_id)
    require_project_member(repositories, context, issue.project_id)

    content_type = payload.content_type.strip()
    if (
        not is_allowed_upload(content_type)
        or content_type.split(";")[0].strip().lower() not in ATTACHMENT_CONTENT_TYPES
    ):
        raise unprocessable(
            "That file type cannot be uploaded",
            error_code="UNSUPPORTED_MEDIA_TYPE",
        )
    if payload.size_bytes > MAX_UPLOAD_BYTES:
        raise unprocessable(
            f"Files are limited to {MAX_UPLOAD_BYTES} bytes",
            error_code="UPLOAD_TOO_LARGE",
        )

    bucket = attachments_bucket()
    upload_id = new_upload_id()
    key = object_key(context.workspace_id, payload.issue_id, upload_id, payload.filename)
    upload = presigned_put(
        bucket,
        key,
        content_type,
        payload.size_bytes,
        expires_in=TICKET_TTL_SECONDS,
        region_name=settings.AWS_REGION,
    )
    ticket = mint_ticket(
        context.workspace_id,
        payload.issue_id,
        context.user_id,
        upload_id,
        key,
        payload.filename,
        content_type,
        payload.size_bytes,
    )
    return UploadTicketRead(
        upload_id=upload_id,
        ticket=ticket,
        url=upload.url,
        headers=upload.headers,
        s3_key=key,
        max_bytes=upload.max_bytes,
        expires_at=utc_now() + timedelta(seconds=upload.expires_in),
    )


@router.post(
    "/{workspace_id}/attachments",
    response_model=AttachmentRead,
    status_code=status.HTTP_201_CREATED,
)
def commit_upload(
    payload: UploadCommit,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> AttachmentRead:
    """Record an uploaded object as an attachment, once it is really in the bucket.

    The ticket is what proves the key was signed by this service for this caller on
    this issue, so the recorded type and size are the ones S3 was told to enforce
    rather than anything the commit body claims.

    The object is checked for existence first, so a commit for an upload that never
    happened is a 409 rather than a row pointing at nothing.
    """
    issue = load_visible_issue(repositories, context, payload.issue_id)
    require_project_member(repositories, context, issue.project_id)

    try:
        claims = read_ticket(payload.ticket, context.workspace_id, payload.issue_id, context.user_id)
    except TicketError as exc:
        raise unknown_upload() from exc
    if claims.get("upload_id") != payload.upload_id:
        raise unknown_upload()

    key = str(claims["key"])
    filename = str(claims.get("filename", ""))
    bucket = attachments_bucket()
    if not object_exists(bucket, key):
        raise conflict("That upload is not in the bucket yet")

    attachment = build_attachment(
        context.workspace_id,
        payload.issue_id,
        issue.project_id,
        "file",
        (payload.title.strip()[:TITLE_MAX] if payload.title and payload.title.strip() else filename),
        context.user_id,
        s3_key=key,
        content_type=str(claims.get("content_type", "")),
        size_bytes=int(claims.get("size_bytes", 0)),
    )
    try:
        created = repositories.attachments.create(attachment)
    except ConditionFailed as exc:
        raise conflict("That attachment already exists") from exc
    return AttachmentRead.from_row(created)


@router.get("/{workspace_id}/attachments/{attachment_id}/download", response_model=DownloadRead)
def download_attachment(
    attachment_id: Annotated[str, Path(min_length=1)],
    issue_id: Annotated[str, Query(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> DownloadRead:
    """Mint a short-lived presigned GET for one stored object.

    The disposition is decided by the stored type, so anything outside the
    inline-safe set downloads rather than rendering, and a stored `text/html` or
    SVG cannot be served as a page from the bucket origin. The filename rides along
    so a ULID key downloads under a human name.

    The URL is a bearer credential for that one key until it expires. It is minted
    per request and neither stored nor logged.
    """
    load_visible_issue(repositories, context, issue_id)
    attachment = repositories.attachments.get(context.workspace_id, issue_id, attachment_id)
    if attachment is None:
        raise not_found()
    if attachment.kind != "file" or not attachment.s3_key:
        raise unprocessable("That attachment is a link, not a file")

    content_type = attachment.content_type or "application/octet-stream"
    download = presigned_get(
        attachments_bucket(),
        attachment.s3_key,
        DOWNLOAD_EXPIRES_IN,
        response_content_type=content_type,
        response_content_disposition=disposition_for(content_type, attachment.title),
        region_name=settings.AWS_REGION,
    )
    return DownloadRead(
        url=download.url,
        expires_at=utc_now() + timedelta(seconds=download.expires_in),
    )


@router.delete("/{workspace_id}/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_attachment(
    attachment_id: Annotated[str, Path(min_length=1)],
    issue_id: Annotated[str, Query(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Detach one attachment, leaving its object to the bucket lifecycle rule.

    The uploader or a project admin. The row is what makes an object visible on the
    issue, so removing it is the whole of the delete a reader can observe, and the
    object is collected by the bucket rather than by a delete this request has to
    get right.
    """
    load_visible_issue(repositories, context, issue_id)
    attachment = repositories.attachments.get(context.workspace_id, issue_id, attachment_id)
    if attachment is None:
        raise not_found()
    if attachment.uploaded_by != context.user_id and not is_project_admin(repositories, context, attachment.project_id):
        raise forbidden()

    repositories.attachments.delete(context.workspace_id, issue_id, attachment_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
