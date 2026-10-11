"""Document routes: Markdown pages under a project or an initiative, and the issues they mention.

A document is listed and created through its parent and reached afterwards by its
own id, so a link to it survives a rename and the page needs nothing but the id.
The rules, the version history and the backlinks live in `app.common.documents`,
which the MCP tools share.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.documents import (
    DocumentCreate,
    DocumentListRead,
    DocumentPatch,
    DocumentRead,
    DocumentVersionListRead,
)
from app.common.documents import (
    create_document,
    delete_document,
    get_document,
    list_document_versions,
    list_documents,
    list_issue_documents,
    list_workspace_documents,
    update_document,
)

router = APIRouter()


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
    """Rename or rewrite a document; a stale `base_updated_at` is a 409."""
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
