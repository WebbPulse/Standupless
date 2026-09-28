"""Workspace logo routes, and the public route every icon URL resolves through.

The logo routes are workspace admin only. The public route serves workspace,
team and person icons alike: it takes no credential, because an `<img>` sends
none to another origin, and instead refuses any path that is not an icon key,
whose random last segment is what keeps an icon private to those shown its URL.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import RedirectResponse

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.workspaces import WorkspaceRead
from app.common.icons import (
    REDIRECT_MAX_AGE,
    IconCommit,
    IconUploadCreate,
    IconUploadRead,
    delete_icon_objects,
    parse_icon_path,
    presign_icon,
    presigned_icon_url,
    verify_upload,
    workspace_owner,
)
from app.common.workspace_members import NOT_FOUND

router = APIRouter()

public_router = APIRouter()


@router.post(
    "/{workspace_id}/icon/uploads",
    response_model=IconUploadRead,
    status_code=status.HTTP_201_CREATED,
)
def create_workspace_icon_upload(
    payload: IconUploadCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
) -> IconUploadRead:
    """Sign a PUT for a new workspace logo, which the commit call then makes current."""
    return presign_icon(workspace_owner(context.workspace_id), payload)


@router.put("/{workspace_id}/icon", response_model=WorkspaceRead)
def set_workspace_icon(
    payload: IconCommit,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceRead:
    """Make an uploaded image the workspace logo and delete the one it replaces."""
    owner = workspace_owner(context.workspace_id)
    key = verify_upload(owner, payload.upload_id)
    workspace = repositories.workspaces.set_icon(context.workspace_id, key)
    if workspace is None:
        delete_icon_objects(owner.prefix)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    delete_icon_objects(owner.prefix, keep=key)
    return WorkspaceRead.from_row(workspace, context.role)


@router.delete("/{workspace_id}/icon", response_model=WorkspaceRead)
def clear_workspace_icon(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceRead:
    """Remove the workspace logo, falling back to its initials, and delete the image."""
    workspace = repositories.workspaces.set_icon(context.workspace_id, None)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    delete_icon_objects(workspace_owner(context.workspace_id).prefix)
    return WorkspaceRead.from_row(workspace, context.role)


def _redirect(path: str) -> RedirectResponse:
    """Redirect one icon path to a short presigned GET, or 404 when it is not an icon key.

    Anything that is not exactly an icon key is a 404, so these routes can never be
    used to read another object in the bucket.
    """
    key = parse_icon_path(path)
    if key is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return RedirectResponse(
        presigned_icon_url(key),
        status_code=status.HTTP_302_FOUND,
        headers={"Cache-Control": f"private, max-age={REDIRECT_MAX_AGE}"},
    )


@public_router.get("/team/{workspace_id}/{team_id}/{icon_id}", response_class=RedirectResponse)
def team_icon_content(workspace_id: str, team_id: str, icon_id: str) -> RedirectResponse:
    """Serve one team icon URL."""
    return _redirect(f"team/{workspace_id}/{team_id}/{icon_id}")


@public_router.get("/{kind}/{owner_id}/{icon_id}", response_class=RedirectResponse)
def icon_content(kind: str, owner_id: str, icon_id: str) -> RedirectResponse:
    """Serve one workspace logo or person avatar URL."""
    return _redirect(f"{kind}/{owner_id}/{icon_id}")
