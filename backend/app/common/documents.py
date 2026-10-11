"""Documents under projects and initiatives, shared by the planning routes, search and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a document an agent writes must pass the same rights, keep the same
history and leave the same backlinks a person's does.

A document is read by whoever reads its parent. A project's documents are written
by a writer on any of its visible teams and an initiative's by any workspace
member who is not a guest, which is who edits the parent itself. Deleting one is
its author's, a workspace admin's, an admin of one of the project's teams, or the
initiative's creator or owner.

History is kept per edit session rather than per keystroke: an editor saving as
they type keeps writing over one version, and the state before the session is
kept once another person edits or the last edit is `SESSION_GAP` old.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Iterable, cast

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.documents import (
    DocumentCreate,
    DocumentMentionRead,
    DocumentPatch,
    DocumentRead,
    DocumentSummaryRead,
    DocumentVersionRead,
)
from app.common.change_source import ChangeSource
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.documents import (
    PARENT_KINDS,
    Document,
    DocumentBody,
    DocumentMention,
    DocumentVersion,
    ParentKind,
    new_document_id,
    summary_keys,
)
from app.common.db.dynamo.search_index import ranked_terms
from app.common.initiative_writes import load_initiative
from app.common.planning_rules import (
    forbidden,
    load_readable_project,
    not_found,
    team_role,
    unprocessable,
    visible_project_teams,
    visible_team_ids,
)

SESSION_GAP = timedelta(minutes=10)
"""How long one editor may pause before their next edit starts a new version."""

MENTIONS_MAX = 50
"""The most issue keys one document resolves into backlinks."""

TERMS_MAX = 1000
"""The most distinct search terms one document keeps, taken from the title first and then the body."""

MENTION_PATTERN = re.compile(r"(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,5})-(\d{1,9})(?![0-9])")
"""An issue key as a person writes one in prose or a link: an uppercase team prefix and a number."""


@dataclass
class Parent:
    """The project or initiative a document sits under, as this caller sees it."""

    kind: ParentKind
    parent_id: str
    name: str
    teams: list[str] = field(default_factory=list)
    owners: tuple[str | None, ...] = ()


@dataclass
class Rights:
    """One caller's edit and delete rights on documents, with team roles read once per team."""

    repositories: Repositories
    context: AuthzContext
    roles: dict[str, str | None] = field(default_factory=dict)

    def role(self, team_id: str) -> str | None:
        """The caller's role on one team, cached for the request."""
        if team_id not in self.roles:
            self.roles[team_id] = team_role(self.repositories, self.context, team_id)
        return self.roles[team_id]

    def can_edit(self, parent: Parent) -> bool:
        """Whether the caller may create and edit documents under one parent."""
        if parent.kind == "initiative":
            return not self.context.is_guest
        return any(self.role(team_id) is not None for team_id in parent.teams)

    def can_delete(self, parent: Parent, document: Document) -> bool:
        """Whether the caller may delete one document."""
        if document.author_id == self.context.user_id or self.context.is_workspace_admin:
            return True
        if parent.kind == "initiative":
            return not self.context.is_guest and self.context.user_id in parent.owners
        return any(self.role(team_id) == "admin" for team_id in parent.teams)


def conflict(message: str) -> HTTPException:
    """A 409 carrying the product's error envelope."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error_code": "CONFLICT", "message": message},
    )


def load_parent(repositories: Repositories, context: AuthzContext, parent_kind: str, parent_id: str) -> Parent:
    """A parent the caller may read, or the 404 or 403 its own loader gives."""
    if parent_kind == "project":
        project, teams = load_readable_project(repositories, context, parent_id)
        return Parent(kind="project", parent_id=project.project_id, name=project.name, teams=teams)
    if parent_kind == "initiative":
        initiative = load_initiative(repositories, context, parent_id)
        return Parent(
            kind="initiative",
            parent_id=initiative.initiative_id,
            name=initiative.name,
            owners=(initiative.created_by, initiative.owner_id),
        )
    raise not_found()


def readable_parents(repositories: Repositories, context: AuthzContext) -> dict[tuple[str, str], Parent]:
    """Every parent the caller may read, keyed by kind and id.

    One read of the projects and one of the initiatives, so a workspace listing
    or a search decides every document's visibility without a read per document.
    """
    visible = set(visible_team_ids(repositories, context))
    parents: dict[tuple[str, str], Parent] = {}
    for project in repositories.planning.list_projects(context.workspace_id):
        teams = visible_project_teams(project, visible)
        if teams:
            parents[("project", project.project_id)] = Parent(
                kind="project", parent_id=project.project_id, name=project.name, teams=teams
            )
    if not context.is_guest:
        for initiative in repositories.planning.list_initiatives(context.workspace_id):
            parents[("initiative", initiative.initiative_id)] = Parent(
                kind="initiative",
                parent_id=initiative.initiative_id,
                name=initiative.name,
                owners=(initiative.created_by, initiative.owner_id),
            )
    return parents


def mention_keys(*parts: str | None) -> list[str]:
    """The distinct issue keys some text names, in the order written, capped at `MENTIONS_MAX`."""
    keys: dict[str, None] = {}
    for part in parts:
        for match in MENTION_PATTERN.finditer(part or ""):
            keys[f"{match.group(1)}-{int(match.group(2))}"] = None
            if len(keys) >= MENTIONS_MAX:
                return list(keys)
    return list(keys)


def resolve_mentions(repositories: Repositories, context: AuthzContext, keys: Iterable[str]) -> list[DocumentMention]:
    """The issues the keys name that this caller can see, one entry per issue.

    A key in a team the writer cannot see resolves to nothing, so a document never
    records, and never shows its readers, an issue its writer could not open.
    """
    teams: dict[str, str | None] = {}
    found: list[DocumentMention] = []
    seen: set[str] = set()
    for key in keys:
        prefix, _, number = key.rpartition("-")
        if prefix not in teams:
            team = repositories.teams.get_by_key_prefix(context.workspace_id, prefix)
            teams[prefix] = team.team_id if team is not None else None
        team_id = teams[prefix]
        if team_id is None or not context.can_see_team(team_id):
            continue
        issue = repositories.issues.get_by_number(context.workspace_id, team_id, int(number))
        if issue is None or issue.issue_id in seen or not context.can_see_team(issue.team_id):
            continue
        seen.add(issue.issue_id)
        found.append(DocumentMention(key=key, issue_id=issue.issue_id, team_id=issue.team_id))
    return found


def _summary(rights: Rights, parent: Parent, document: Document) -> DocumentSummaryRead:
    """One document's listing shape, with this caller's rights on it."""
    return DocumentSummaryRead(
        document_id=document.document_id,
        workspace_id=document.workspace_id,
        parent_kind=document.parent_kind,
        parent_id=document.parent_id,
        parent_name=parent.name,
        title=document.title,
        author_id=document.author_id,
        updated_by=document.updated_by,
        source=cast("ChangeSource | None", document.source),
        created_at=document.created_at,
        updated_at=document.updated_at,
        can_edit=rights.can_edit(parent),
        can_delete=rights.can_delete(parent, document),
    )


def _read(rights: Rights, parent: Parent, document: Document, body: DocumentBody) -> DocumentRead:
    """One document in full, its mentions narrowed to the issues this caller can see."""
    return DocumentRead(
        **_summary(rights, parent, document).model_dump(),
        body=body.body,
        mentions=[
            DocumentMentionRead(key=mention.key, issue_id=mention.issue_id, team_id=mention.team_id)
            for mention in document.mentions
            if rights.context.can_see_team(mention.team_id)
        ],
    )


def _by_recency(rows: list[DocumentSummaryRead]) -> list[DocumentSummaryRead]:
    """Documents most recently edited first."""
    return sorted(rows, key=lambda row: row.updated_at, reverse=True)


def list_documents(
    repositories: Repositories, context: AuthzContext, parent_kind: str, parent_id: str
) -> list[DocumentSummaryRead]:
    """Every document of one parent the caller may read, most recently edited first."""
    parent = load_parent(repositories, context, parent_kind, parent_id)
    rights = Rights(repositories, context)
    rows = repositories.documents.list_for_parent(context.workspace_id, parent.kind, parent.parent_id)
    return _by_recency([_summary(rights, parent, row) for row in rows])


def list_workspace_documents(repositories: Repositories, context: AuthzContext) -> list[DocumentSummaryRead]:
    """Every document the caller may read across the workspace, most recently edited first."""
    parents = readable_parents(repositories, context)
    rights = Rights(repositories, context)
    rows = repositories.documents.list_for_workspace(context.workspace_id)
    return _by_recency(
        [
            _summary(rights, parents[(row.parent_kind, row.parent_id)], row)
            for row in rows
            if (row.parent_kind, row.parent_id) in parents
        ]
    )


def search_documents(
    repositories: Repositories, context: AuthzContext, terms: set[str], limit: int
) -> list[DocumentSummaryRead]:
    """Readable documents whose title and body hold every term, most recently edited first."""
    if not terms:
        return []
    parents = readable_parents(repositories, context)
    rights = Rights(repositories, context)
    hits = [
        row
        for row in repositories.documents.list_for_workspace(context.workspace_id)
        if (row.parent_kind, row.parent_id) in parents and terms.issubset(row.terms)
    ]
    hits.sort(key=lambda row: row.updated_at, reverse=True)
    return [_summary(rights, parents[(row.parent_kind, row.parent_id)], row) for row in hits[:limit]]


def _load(repositories: Repositories, context: AuthzContext, document_id: str) -> tuple[Parent, Document, DocumentBody]:
    """A document the caller may read, with its parent, or a 404."""
    found = repositories.documents.get(context.workspace_id, document_id)
    if found is None:
        raise not_found()
    document, body = found
    try:
        parent = load_parent(repositories, context, document.parent_kind, document.parent_id)
    except HTTPException as exc:
        raise not_found() from exc
    return parent, document, body


def get_document(repositories: Repositories, context: AuthzContext, document_id: str) -> DocumentRead:
    """One document the caller may read, with its body."""
    parent, document, body = _load(repositories, context, document_id)
    return _read(Rights(repositories, context), parent, document, body)


def create_document(
    repositories: Repositories,
    context: AuthzContext,
    parent_kind: str,
    parent_id: str,
    payload: DocumentCreate,
) -> DocumentRead:
    """Write a new document under a parent the caller may edit."""
    if parent_kind not in PARENT_KINDS:
        raise unprocessable(f"parent_kind must be one of {', '.join(PARENT_KINDS)}")
    parent = load_parent(repositories, context, parent_kind, parent_id)
    rights = Rights(repositories, context)
    if not rights.can_edit(parent):
        raise forbidden()
    keys = mention_keys(payload.title, payload.body)
    now = utc_now()
    document_id = new_document_id()
    document = Document(
        workspace_id=context.workspace_id,
        document_id=document_id,
        parent_kind=parent.kind,
        parent_id=parent.parent_id,
        title=payload.title,
        author_id=context.user_id,
        updated_by=context.user_id,
        source=context.source,
        created_at=now,
        updated_at=now,
        terms=sorted(ranked_terms(payload.title, payload.body, cap=TERMS_MAX)),
        mention_keys=keys,
        mentions=resolve_mentions(repositories, context, keys),
    )
    body = DocumentBody(
        workspace_id=context.workspace_id,
        document_id=document_id,
        parent_kind=parent.kind,
        parent_id=parent.parent_id,
        body=payload.body,
    )
    try:
        repositories.documents.create(document, body)
    except ConditionFailed as exc:
        raise conflict("That document already exists") from exc
    return _read(rights, parent, document, body)


def update_document(
    repositories: Repositories, context: AuthzContext, document_id: str, payload: DocumentPatch
) -> DocumentRead:
    """Rename or rewrite a document, keeping the state before a new edit session as a version."""
    parent, existing, body = _load(repositories, context, document_id)
    rights = Rights(repositories, context)
    if not rights.can_edit(parent):
        raise forbidden()
    fields = payload.model_dump(exclude_unset=True)
    for name in ("title", "body"):
        if name in fields and fields[name] is None:
            raise unprocessable(f"{name} must not be null")
    if payload.base_updated_at is not None and payload.base_updated_at != existing.updated_at:
        raise conflict("The document changed since you opened it")
    title = fields.get("title", existing.title)
    text = fields.get("body", body.body)
    if title == existing.title and text == body.body:
        return _read(rights, parent, existing, body)
    now = utc_now()
    if existing.updated_by != context.user_id or now - existing.updated_at > SESSION_GAP:
        body = repositories.documents.add_version(
            DocumentVersion(
                workspace_id=context.workspace_id,
                document_id=existing.document_id,
                title=existing.title,
                body=body.body,
                edited_by=existing.updated_by,
                edited_at=existing.updated_at,
            ),
            body,
        )
    keys = mention_keys(title, text)
    mentions = existing.mentions if keys == existing.mention_keys else resolve_mentions(repositories, context, keys)
    edited = existing.model_copy(
        update={
            "title": title,
            "updated_by": context.user_id,
            "source": context.source,
            "updated_at": now,
            "terms": sorted(ranked_terms(title, text, cap=TERMS_MAX)),
            "mention_keys": keys,
            "mentions": mentions,
        }
    )
    stored_body = body.model_copy(update={"body": text})
    try:
        repositories.documents.replace(existing, edited, stored_body)
    except ConditionFailed as exc:
        raise not_found() from exc
    return _read(rights, parent, edited, stored_body)


def delete_document(repositories: Repositories, context: AuthzContext, document_id: str) -> None:
    """Delete a document with its history and backlinks, as its author or an admin."""
    parent, document, _ = _load(repositories, context, document_id)
    if not Rights(repositories, context).can_delete(parent, document):
        raise forbidden()
    repositories.documents.delete(context.workspace_id, document)


def list_document_versions(
    repositories: Repositories, context: AuthzContext, document_id: str
) -> list[DocumentVersionRead]:
    """A readable document's kept versions, newest first."""
    _, document, _ = _load(repositories, context, document_id)
    return [
        DocumentVersionRead(
            version_id=version.version_id,
            document_id=version.document_id,
            title=version.title,
            body=version.body,
            edited_by=version.edited_by,
            edited_at=version.edited_at,
        )
        for version in repositories.documents.list_versions(context.workspace_id, document.document_id)
    ]


def list_issue_documents(repositories: Repositories, context: AuthzContext, issue_id: str) -> list[DocumentSummaryRead]:
    """The readable documents that mention one visible issue, most recently edited first."""
    issue = repositories.issues.get(context.workspace_id, issue_id)
    if issue is None or not context.can_see_team(issue.team_id):
        raise not_found()
    links = repositories.documents.list_links(context.workspace_id, issue.issue_id)
    if not links:
        return []
    parents = readable_parents(repositories, context)
    readable = [link for link in links if (link.parent_kind, link.parent_id) in parents]
    rights = Rights(repositories, context)
    rows = repositories.documents.get_summaries(context.workspace_id, summary_keys(readable))
    return _by_recency([_summary(rights, parents[(row.parent_kind, row.parent_id)], row) for row in rows])
