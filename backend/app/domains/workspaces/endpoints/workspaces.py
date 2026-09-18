"""The workspace routes: a health probe and the caller's own workspaces.

`GET /api/workspaces` answers only what the caller owns, read through the
`owner_user_id-index`, so no response can span tenants. The workspace is the
tenant, and every key this product adds later carries its id. The body is the
`{"workspaces": [...]}` envelope every list route in this product uses.
"""

from __future__ import annotations

from typing import Annotated, Any, Dict

from fastapi import APIRouter, Depends

from app.common.api.dependencies.identity_claims import require_identity_subject
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.domains.workspaces.schemas.workspace import WorkspaceListRead

router = APIRouter()


@router.get("/health", include_in_schema=False)
def health() -> Dict[str, Any]:
    """Liveness for this domain, reading nothing."""
    return {"status": "healthy", "domain": "workspaces"}


@router.get("", response_model=WorkspaceListRead)
def list_workspaces(
    subject: Annotated[str, Depends(require_identity_subject)],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceListRead:
    """Every workspace the signed in caller owns, newest first.

    Answers the `{"workspaces": [...]}` envelope rather than a bare array, so a
    cursor can be added beside the items without breaking a client. A caller who
    owns none gets an empty list, which is what a new account sees.
    """
    rows = repositories.workspaces.list_for_user(subject)
    return WorkspaceListRead.from_rows(rows)
