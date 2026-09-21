"""The `attachments` table: what is hanging off one issue, by link or by upload.

Partitioned per issue like `comments`, so listing an issue's attachments is one
query and the sort key is a ULID that reads oldest first.

A `file` attachment stores its S3 key and never a URL. The only way to a byte is
the download route, which mints a presigned GET per request, so a row that leaks
grants nothing and a key that is cached by the frontend is not a credential.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Page, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import ATTACHMENTS

AttachmentKind = Literal["url", "file"]

ATTACHMENT_KINDS: tuple[str, ...] = ("url", "file")


def new_attachment_id() -> str:
    """A fresh attachment id, a ULID so the partition reads in creation order."""
    return new_ulid()


def new_upload_id() -> str:
    """A fresh upload id, minted server side so a client never names an object key."""
    return new_ulid()


def ws_issue(workspace_id: str, issue_id: str) -> str:
    """The partition key of one issue's attachments."""
    return f"{workspace_id}#{issue_id}"


def object_key(workspace_id: str, issue_id: str, upload_id: str, filename: str) -> str:
    """The S3 key one upload is stored under.

    The workspace id leads so an IAM condition or a bucket policy can be written
    per tenant later without moving a single object. The upload id sits between the
    issue and the filename so two uploads of the same name never collide.
    """
    return f"workspaces/{workspace_id}/issues/{issue_id}/{upload_id}/{filename}"


class Attachment(BaseModel):
    """One attachment on an issue, either a link or an uploaded object."""

    ws_issue: str
    attachment_id: str = Field(default_factory=new_attachment_id)
    workspace_id: str
    issue_id: str
    team_id: str
    kind: str
    title: str
    url: str | None = None
    favicon_url: str | None = None
    s3_key: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    uploaded_by: str
    created_at: datetime = Field(default_factory=utc_now)


def build_attachment(
    workspace_id: str,
    issue_id: str,
    team_id: str,
    kind: str,
    title: str,
    uploaded_by: str,
    *,
    url: str | None = None,
    favicon_url: str | None = None,
    s3_key: str | None = None,
    content_type: str | None = None,
    size_bytes: int | None = None,
) -> Attachment:
    """One attachment with its partition key already composed."""
    return Attachment(
        ws_issue=ws_issue(workspace_id, issue_id),
        workspace_id=workspace_id,
        issue_id=issue_id,
        team_id=team_id,
        kind=kind,
        title=title,
        uploaded_by=uploaded_by,
        url=url,
        favicon_url=favicon_url,
        s3_key=s3_key,
        content_type=content_type,
        size_bytes=size_bytes,
    )


def as_attachment(item: Mapping[str, Any]) -> Attachment:
    """One stored item as an `Attachment`.

    `size_bytes` comes back as a `Decimal` from a numeric attribute, which pydantic
    coerces to `int`, so the model stays the one shape the routes see.
    """
    return Attachment.model_validate(item)


class AttachmentRepository:
    """Reads and writes `attachments` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(ATTACHMENTS, repository)

    def get(self, workspace_id: str, issue_id: str, attachment_id: str) -> Attachment | None:
        """One attachment of one issue, or `None`.

        The issue is a parameter rather than derived because it is the partition,
        which is why every single-attachment route takes `issue_id` as a query.
        """
        if not workspace_id or not issue_id or not attachment_id:
            return None
        item = self._repository.get({"ws_issue": ws_issue(workspace_id, issue_id), "attachment_id": attachment_id})
        return as_attachment(item) if item is not None else None

    def create(self, attachment: Attachment) -> Attachment:
        """Store a new attachment, raising `ConditionFailed` when the id is taken."""
        self._repository.put(as_item(attachment), condition=Attr("attachment_id").not_exists())
        return attachment

    def delete(self, workspace_id: str, issue_id: str, attachment_id: str) -> bool:
        """Remove one attachment row, reporting whether one was there.

        The S3 object is deliberately left behind for the bucket's lifecycle rule:
        the row is what makes an object visible on the issue, so removing it is the
        whole of the delete a reader can observe.
        """
        if self.get(workspace_id, issue_id, attachment_id) is None:
            return False
        self._repository.delete({"ws_issue": ws_issue(workspace_id, issue_id), "attachment_id": attachment_id})
        return True

    def list_for_issue(
        self,
        workspace_id: str,
        issue_id: str,
        *,
        limit: int = 50,
        start_key: Mapping[str, Any] | None = None,
    ) -> Page:
        """One page of an issue's attachments, oldest first as the contract says."""
        return self._repository.query(
            Key("ws_issue").eq(ws_issue(workspace_id, issue_id)),
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=True,
        )
