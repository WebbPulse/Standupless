"""The `attachments` table: what is hanging off one issue, by link or by upload.

Partitioned per issue like `comments`, so listing an issue's attachments is one
query and the sort key is a ULID that reads oldest first.

A `file` attachment stores its S3 key and never a URL. The only way to a byte is
the download route, which mints a presigned GET per request, so a row that leaks
grants nothing and a key that is cached by the frontend is not a credential.

The workspace's storage counter lives here too, one row under the pseudo issue
`storage`, because this table is the one the discussion domain writes and every
byte it counts is committed or released next to an attachment row.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Page, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import ATTACHMENTS

AttachmentKind = Literal["url", "file"]

ATTACHMENT_KINDS: tuple[str, ...] = ("url", "file")

STORAGE_PARTITION = "storage"
"""The pseudo issue id the workspace's storage counter row sits under, never a ULID."""

STORAGE_ROW_ID = "usage"

STORAGE_ATTRIBUTE = "bytes_used"


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


def _storage_key(workspace_id: str) -> dict[str, str]:
    """The key of the workspace's storage counter row in this table."""
    return {"ws_issue": ws_issue(workspace_id, STORAGE_PARTITION), "attachment_id": STORAGE_ROW_ID}


def stored_bytes(attachments: Iterable[Attachment]) -> int:
    """The bytes the uploaded files among `attachments` count against storage."""
    return sum(row.size_bytes or 0 for row in attachments if row.kind == "file" and row.s3_key)


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

    def get_many(self, workspace_id: str, issue_id: str, attachment_ids: list[str]) -> dict[str, Attachment]:
        """The named attachments of one issue keyed by id, skipping any that are gone.

        One `BatchGetItem` behind a comment page, so rendering the files a thread
        carries costs one call rather than one per attachment. The issue is part of
        every key, so an id belonging to another issue simply resolves to nothing.
        """
        wanted = [attachment_id for attachment_id in dict.fromkeys(attachment_ids) if attachment_id]
        if not workspace_id or not issue_id or not wanted:
            return {}
        partition = ws_issue(workspace_id, issue_id)
        items = self._repository.batch_get(
            [{"ws_issue": partition, "attachment_id": attachment_id} for attachment_id in wanted]
        )
        return {str(item["attachment_id"]): as_attachment(item) for item in items}

    def create(self, attachment: Attachment) -> Attachment:
        """Store a new attachment, raising `ConditionFailed` when the id is taken."""
        self._repository.put(as_item(attachment), condition=Attr("attachment_id").not_exists())
        return attachment

    def delete(self, workspace_id: str, issue_id: str, attachment_id: str) -> Attachment | None:
        """Remove one attachment row, returning it when this call was the one that removed it.

        The delete is conditional on the row existing, so two concurrent deletes of
        one row cannot both report it and release its bytes twice.

        The S3 object is deliberately left behind for the bucket's lifecycle rule:
        the row is what makes an object visible on the issue, so removing it is the
        whole of the delete a reader can observe.
        """
        existing = self.get(workspace_id, issue_id, attachment_id)
        if existing is None:
            return None
        try:
            self._repository.delete(
                {"ws_issue": ws_issue(workspace_id, issue_id), "attachment_id": attachment_id},
                condition=Attr("attachment_id").exists(),
            )
        except ConditionFailed:
            return None
        return existing

    def storage_used(self, workspace_id: str) -> int:
        """The bytes of uploaded files the workspace's attachments hold, never below zero."""
        if not workspace_id:
            return 0
        item = self._repository.get(_storage_key(workspace_id))
        if item is None:
            return 0
        return max(0, int(item.get(STORAGE_ATTRIBUTE, 0)))

    def add_storage(self, workspace_id: str, delta: int) -> int:
        """Move the workspace's storage counter by `delta` bytes and return the new total.

        One atomic `ADD`, so concurrent commits and deletes never lose an update.
        A zero delta, a link attachment's, reads the counter instead of writing it.
        """
        if not workspace_id:
            return 0
        if delta == 0:
            return self.storage_used(workspace_id)
        return max(0, self._repository.increment(_storage_key(workspace_id), STORAGE_ATTRIBUTE, delta))

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

    def iter_for_issue(self, workspace_id: str, issue_id: str, *, max_items: int = 1000) -> list[Attachment]:
        """Every attachment of one issue, which the team purge reads for its object keys."""
        if not workspace_id or not issue_id:
            return []
        items = self._repository.iter_query(
            Key("ws_issue").eq(ws_issue(workspace_id, issue_id)),
            max_items=max_items,
        )
        return [Attachment.model_validate(dict(item)) for item in items]

    def delete_many(self, workspace_id: str, issue_id: str, attachment_ids: list[str]) -> int:
        """Remove the named attachment rows of one issue, returning how many went."""
        if not attachment_ids:
            return 0
        partition = ws_issue(workspace_id, issue_id)
        return self._repository.delete_many(
            [{"ws_issue": partition, "attachment_id": attachment_id} for attachment_id in attachment_ids]
        )
