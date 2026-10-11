"""Document rows in the `planning` table: Markdown pages filed under a project or an initiative.

A document lives in the workspace partition beside its parent, in four row shapes:

- `document#<parent_kind>#<parent_id>#<document>` is the summary: title, author,
  times, search terms and the issues the text mentions. A parent's documents are
  one query, and the workspace's are one query under `document#`.
- `document_body#<document>` holds the Markdown and names the parent, so a
  document is found by its id alone in two reads, and a listing never pays for
  bodies.
- `document_version#<document>#<version>` is a snapshot of an earlier title and
  body, kept for the last `VERSIONS_KEPT` edit sessions.
- `document_mention#<issue>#<document>` is the backlink from one mentioned issue,
  so an issue's documents are one query.

None of these kinds pass the planning stream filters, so no consumer reads them.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable, Literal

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Repository, new_ulid

from app.common.db.dynamo.base import build_repository, utc_now
from app.common.db.dynamo.tables import PLANNING

DOCUMENT = "document"

DOCUMENT_BODY = "document_body"

DOCUMENT_VERSION = "document_version"

DOCUMENT_MENTION = "document_mention"

DOCUMENT_KEY_PREFIX = "document#"

ParentKind = Literal["project", "initiative"]

PARENT_KINDS: tuple[str, ...] = ("project", "initiative")

VERSIONS_KEPT = 20
"""How many earlier versions one document keeps; the oldest goes when another is taken."""

LIST_MAX = 1000
"""The most documents one parent or one workspace listing reads."""


def document_prefix(parent_kind: str, parent_id: str) -> str:
    """The sort key prefix every document of one parent shares."""
    return f"{DOCUMENT_KEY_PREFIX}{parent_kind}#{parent_id}#"


def document_key(parent_kind: str, parent_id: str, document_id: str) -> str:
    """The sort key of one document's summary row."""
    return f"{document_prefix(parent_kind, parent_id)}{document_id}"


def document_body_key(document_id: str) -> str:
    """The sort key of one document's body row."""
    return f"{DOCUMENT_BODY}#{document_id}"


def document_version_prefix(document_id: str) -> str:
    """The sort key prefix every version of one document shares."""
    return f"{DOCUMENT_VERSION}#{document_id}#"


def document_version_key(document_id: str, version_id: str) -> str:
    """The sort key of one version row."""
    return f"{document_version_prefix(document_id)}{version_id}"


def document_mention_prefix(issue_id: str) -> str:
    """The sort key prefix of every backlink to one issue."""
    return f"{DOCUMENT_MENTION}#{issue_id}#"


def document_mention_key(issue_id: str, document_id: str) -> str:
    """The sort key of one backlink row."""
    return f"{document_mention_prefix(issue_id)}{document_id}"


def new_document_id() -> str:
    """A fresh, time ordered document or version id."""
    return new_ulid()


class DocumentMention(BaseModel):
    """One issue a document's text names, under the key as it was written."""

    key: str
    issue_id: str
    team_id: str


class Document(BaseModel):
    """One document's summary row: everything but the body."""

    workspace_id: str
    planning_key: str = ""
    document_id: str = Field(default_factory=new_document_id)
    kind: str = DOCUMENT
    parent_kind: ParentKind
    parent_id: str
    title: str
    author_id: str
    updated_by: str
    source: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    terms: list[str] = Field(default_factory=list)
    mention_keys: list[str] = Field(default_factory=list)
    mentions: list[DocumentMention] = Field(default_factory=list)

    def model_post_init(self, _context: Any) -> None:
        """Derive the sort key from the parent and id when none was given."""
        if not self.planning_key:
            self.planning_key = document_key(self.parent_kind, self.parent_id, self.document_id)


class DocumentBody(BaseModel):
    """One document's Markdown, with its parent and its kept version ids, newest first."""

    workspace_id: str
    planning_key: str = ""
    document_id: str
    kind: str = DOCUMENT_BODY
    parent_kind: str
    parent_id: str
    body: str = ""
    version_ids: list[str] = Field(default_factory=list)

    def model_post_init(self, _context: Any) -> None:
        """Derive the sort key from the id when none was given."""
        if not self.planning_key:
            self.planning_key = document_body_key(self.document_id)


class DocumentVersion(BaseModel):
    """An earlier title and body of one document, as it stood before an edit session."""

    workspace_id: str
    planning_key: str = ""
    version_id: str = Field(default_factory=new_document_id)
    document_id: str
    kind: str = DOCUMENT_VERSION
    title: str
    body: str
    edited_by: str
    edited_at: datetime

    def model_post_init(self, _context: Any) -> None:
        """Derive the sort key from the document and version ids when none was given."""
        if not self.planning_key:
            self.planning_key = document_version_key(self.document_id, self.version_id)


class DocumentLink(BaseModel):
    """One backlink row: a document that mentions one issue."""

    workspace_id: str
    planning_key: str = ""
    kind: str = DOCUMENT_MENTION
    issue_id: str
    document_id: str
    parent_kind: str
    parent_id: str

    def model_post_init(self, _context: Any) -> None:
        """Derive the sort key from the issue and document when none was given."""
        if not self.planning_key:
            self.planning_key = document_mention_key(self.issue_id, self.document_id)


def _key(workspace_id: str, planning_key: str) -> dict[str, str]:
    """The primary key of one planning row."""
    return {"workspace_id": workspace_id, "planning_key": planning_key}


class DocumentRepository:
    """Reads and writes document rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build the planning table's own."""
        self._repository = build_repository(PLANNING, repository)

    def get_body(self, workspace_id: str, document_id: str) -> DocumentBody | None:
        """One document's body row, or `None`."""
        if not workspace_id or not document_id:
            return None
        item = self._repository.get(_key(workspace_id, document_body_key(document_id)))
        if item is None or item.get("kind") != DOCUMENT_BODY:
            return None
        return DocumentBody.model_validate(dict(item))

    def get_summary(self, workspace_id: str, parent_kind: str, parent_id: str, document_id: str) -> Document | None:
        """One document's summary row under its parent, or `None`."""
        if not workspace_id or not document_id:
            return None
        item = self._repository.get(_key(workspace_id, document_key(parent_kind, parent_id, document_id)))
        if item is None or item.get("kind") != DOCUMENT:
            return None
        return Document.model_validate(dict(item))

    def get(self, workspace_id: str, document_id: str) -> tuple[Document, DocumentBody] | None:
        """One document's summary and body by its id alone, or `None`."""
        body = self.get_body(workspace_id, document_id)
        if body is None:
            return None
        summary = self.get_summary(workspace_id, body.parent_kind, body.parent_id, document_id)
        if summary is None:
            return None
        return summary, body

    def get_summaries(self, workspace_id: str, keys: Iterable[str]) -> list[Document]:
        """The summary rows under the given sort keys, in no particular order; absent ones are skipped."""
        wanted = sorted(set(keys))
        if not workspace_id or not wanted:
            return []
        items = self._repository.batch_get([_key(workspace_id, key) for key in wanted])
        return [Document.model_validate(dict(item)) for item in items if item.get("kind") == DOCUMENT]

    def list_for_parent(
        self, workspace_id: str, parent_kind: str, parent_id: str, *, max_items: int = LIST_MAX
    ) -> list[Document]:
        """Every document of one parent, oldest first."""
        if not workspace_id or not parent_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id)
            & Key("planning_key").begins_with(document_prefix(parent_kind, parent_id)),
            max_items=max_items,
        )
        return [Document.model_validate(dict(item)) for item in items if item.get("kind") == DOCUMENT]

    def list_for_workspace(self, workspace_id: str, *, max_items: int = LIST_MAX) -> list[Document]:
        """Every document of the workspace, grouped by parent."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(DOCUMENT_KEY_PREFIX),
            max_items=max_items,
        )
        return [Document.model_validate(dict(item)) for item in items if item.get("kind") == DOCUMENT]

    def create(self, document: Document, body: DocumentBody) -> Document:
        """Store a new document's body and summary, raising `ConditionFailed` when the id is taken."""
        self._repository.put(body.model_dump(mode="json"), condition=Attr("planning_key").not_exists())
        self._repository.put(document.model_dump(mode="json"), condition=Attr("planning_key").not_exists())
        self._write_links(document, added=[mention.issue_id for mention in document.mentions], removed=[])
        return document

    def replace(self, previous: Document, document: Document, body: DocumentBody) -> Document:
        """Write an edited document over its rows, moving its backlinks to match its mentions.

        Raises `ConditionFailed` when the document went away under the edit.
        """
        self._repository.put(document.model_dump(mode="json"), condition=Attr("planning_key").exists())
        self._repository.put(body.model_dump(mode="json"), condition=Attr("planning_key").exists())
        before = {mention.issue_id for mention in previous.mentions}
        after = {mention.issue_id for mention in document.mentions}
        self._write_links(document, added=sorted(after - before), removed=sorted(before - after))
        return document

    def add_version(self, version: DocumentVersion, body: DocumentBody) -> DocumentBody:
        """Store one version and answer the body carrying its id, dropping versions past the cap."""
        self._repository.put(version.model_dump(mode="json"))
        kept = [version.version_id, *[existing for existing in body.version_ids if existing != version.version_id]]
        dropped = kept[VERSIONS_KEPT:]
        if dropped:
            self._repository.delete_many(
                [_key(body.workspace_id, document_version_key(body.document_id, old)) for old in dropped]
            )
        return body.model_copy(update={"version_ids": kept[:VERSIONS_KEPT]})

    def list_versions(
        self, workspace_id: str, document_id: str, *, limit: int = VERSIONS_KEPT
    ) -> list[DocumentVersion]:
        """One document's kept versions, newest first."""
        if not workspace_id or not document_id:
            return []
        page = self._repository.query(
            Key("workspace_id").eq(workspace_id)
            & Key("planning_key").begins_with(document_version_prefix(document_id)),
            limit=limit,
            ascending=False,
        )
        return [
            DocumentVersion.model_validate(dict(item)) for item in page.items if item.get("kind") == DOCUMENT_VERSION
        ]

    def list_links(self, workspace_id: str, issue_id: str, *, max_items: int = 200) -> list[DocumentLink]:
        """The backlink rows of one issue, oldest document first."""
        if not workspace_id or not issue_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(document_mention_prefix(issue_id)),
            max_items=max_items,
        )
        return [DocumentLink.model_validate(dict(item)) for item in items if item.get("kind") == DOCUMENT_MENTION]

    def delete(self, workspace_id: str, document: Document) -> None:
        """Remove one document with its body, its versions and its backlinks."""
        keys = [
            _key(workspace_id, document_mention_key(mention.issue_id, document.document_id))
            for mention in document.mentions
        ]
        keys.extend(
            _key(workspace_id, str(item["planning_key"]))
            for item in self._repository.iter_query(
                Key("workspace_id").eq(workspace_id)
                & Key("planning_key").begins_with(document_version_prefix(document.document_id)),
                projection="planning_key",
                max_items=VERSIONS_KEPT * 5,
            )
        )
        keys.append(_key(workspace_id, document_body_key(document.document_id)))
        keys.append(_key(workspace_id, document.planning_key))
        self._repository.delete_many(keys)

    def delete_for_parent(self, workspace_id: str, parent_kind: str, parent_id: str) -> int:
        """Remove every document of one parent, returning how many went."""
        documents = self.list_for_parent(workspace_id, parent_kind, parent_id)
        for document in documents:
            self.delete(workspace_id, document)
        return len(documents)

    def _write_links(self, document: Document, *, added: list[str], removed: list[str]) -> None:
        """Add and remove the backlink rows one document's mentions changed."""
        for issue_id in added:
            link = DocumentLink(
                workspace_id=document.workspace_id,
                issue_id=issue_id,
                document_id=document.document_id,
                parent_kind=document.parent_kind,
                parent_id=document.parent_id,
            )
            self._repository.put(link.model_dump(mode="json"))
        if removed:
            self._repository.delete_many(
                [
                    _key(document.workspace_id, document_mention_key(issue_id, document.document_id))
                    for issue_id in removed
                ]
            )


def summary_keys(links: Iterable[DocumentLink]) -> list[str]:
    """The summary sort keys a set of backlinks point at."""
    return [document_key(link.parent_kind, link.parent_id, link.document_id) for link in links]
