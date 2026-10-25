"""Document routes: Markdown pages under a project, an initiative or a team, and the issues they mention.

A document is listed and created through its parent and reached afterwards by its
own id, so a link to it survives a rename and a move, and the page needs nothing
but the id.
The rules, the version history and the backlinks live in `app.common.documents`,
which the MCP tools share. A parent also lists the document templates its new
documents and updates may start from, which `app.common.document_templates` reads.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Response, status

from app.common import document_templates
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.documents import (
    DocumentCreate,
    DocumentListRead,
    DocumentPatch,
    DocumentRead,
    DocumentVersionListRead,
)
from app.common.api.schemas.templates import DocumentTemplateListRead, TemplateRead
from app.common.documents import (
    create_document,
    delete_document,
    get_document,
    list_document_versions,
    list_documents,
    list_issue_documents,
    list_workspace_documents,
    load_parent,
    update_document,
)
from app.common.initiative_writes import initiative_template_offer

router = APIRouter()


def _offer_read(offer: document_templates.Offer) -> DocumentTemplateListRead:
    """The response shape of the document templates one parent offers."""
    return DocumentTemplateListRead(
        templates=[TemplateRead.from_row(row) for row in offer.templates],
        default_document_template_id=offer.default_document_template_id,
        default_update_template_id=offer.default_update_template_id,
    )


@router.get("/{workspace_id}/projects/{project_id}/document-templates", response_model=DocumentTemplateListRead)
def list_project_document_templates(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> DocumentTemplateListRead:
    """The document templates a project's new documents and updates may start from, and its defaults."""
    return _offer_read(document_templates.project_offer(repositories, context, project_id))


@router.get("/{workspace_id}/initiatives/{initiative_id}/document-templates", response_model=DocumentTemplateListRead)
def list_initiative_document_templates(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> DocumentTemplateListRead:
    """The workspace document templates an initiative's new documents and updates may start from."""
    return _offer_read(initiative_template_offer(repositories, context, initiative_id))


@router.get("/{workspace_id}/teams/{team_id}/document-templates", response_model=DocumentTemplateListRead)
def list_team_document_templates(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[str, Path()],
) -> DocumentTemplateListRead:
    """The document templates a team's new documents may start from, and its defaults."""
    parent = load_parent(repositories, context, "team", team_id)
    return _offer_read(document_templates.offer(repositories, context, parent.teams))


@router.get("/{workspace_id}/teams/{team_id}/documents", response_model=DocumentListRead)
def list_team_documents(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[str, Path()],
) -> Any:
    """A team's documents, most recently edited first."""
    return DocumentListRead(items=list_documents(repositories, context, "team", team_id), next_cursor=None)


@router.post(
    "/{workspace_id}/teams/{team_id}/documents",
    response_model=DocumentRead,
    status_code=status.HTTP_201_CREATED,
)
def create_team_document(
    payload: DocumentCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[str, Path()],
) -> DocumentRead:
    """Write a new document under a team, as a member of it."""
    return create_document(repositories, context, "team", team_id, payload)


@router.get("/{workspace_id}/projects/{project_id}/documents", response_model=DocumentListRead)
def list_project_documents(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> Any:
    """A project's documents, most recently edited first."""
    return DocumentListRead(items=list_documents(repositories, context, "project", project_id), next_cursor=None)


@router.post(
    "/{workspace_id}/projects/{project_id}/documents",
    response_model=DocumentRead,
    status_code=status.HTTP_201_CREATED,
)
def create_project_document(
    payload: DocumentCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> DocumentRead:
    """Write a new document under a project, as a writer on one of its teams."""
    return create_document(repositories, context, "project", project_id, payload)


@router.get("/{workspace_id}/initiatives/{initiative_id}/documents", response_model=DocumentListRead)
def list_initiative_documents(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> Any:
    """An initiative's documents, most recently edited first."""
    return DocumentListRead(items=list_documents(repositories, context, "initiative", initiative_id), next_cursor=None)


@router.post(
    "/{workspace_id}/initiatives/{initiative_id}/documents",
    response_model=DocumentRead,
    status_code=status.HTTP_201_CREATED,
)
def create_initiative_document(
    payload: DocumentCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> DocumentRead:
    """Write a new document under an initiative, as a workspace member."""
    return create_document(repositories, context, "initiative", initiative_id, payload)


@router.get("/{workspace_id}/documents", response_model=DocumentListRead)
def list_all_documents(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> Any:
    """Every document the caller can read, most recently edited first, for the command palette."""
    return DocumentListRead(items=list_workspace_documents(repositories, context), next_cursor=None)


@router.get("/{workspace_id}/documents/{document_id}", response_model=DocumentRead)
def read_document(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    document_id: Annotated[str, Path()],
) -> DocumentRead:
    """One document with its Markdown and the issues it mentions."""
    return get_document(repositories, context, document_id)


@router.patch("/{workspace_id}/documents/{document_id}", response_model=DocumentRead)
def edit_document(
    payload: DocumentPatch,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    document_id: Annotated[str, Path()],
) -> DocumentRead:
    """Rename, rewrite, restyle or move a document; a stale `base_updated_at` is a 409."""
    return update_document(repositories, context, document_id, payload)


@router.delete("/{workspace_id}/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_document(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    document_id: Annotated[str, Path()],
) -> Response:
    """Delete a document with its history, as its author or an admin."""
    delete_document(repositories, context, document_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/documents/{document_id}/versions", response_model=DocumentVersionListRead)
def list_versions(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    document_id: Annotated[str, Path()],
) -> Any:
    """A document's earlier versions, newest first."""
    return DocumentVersionListRead(items=list_document_versions(repositories, context, document_id), next_cursor=None)


@router.get("/{workspace_id}/issues/{issue_id}/documents", response_model=DocumentListRead)
def list_backlinks(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    issue_id: Annotated[str, Path()],
) -> Any:
    """The documents that mention one issue, for its page."""
    return DocumentListRead(items=list_issue_documents(repositories, context, issue_id), next_cursor=None)
