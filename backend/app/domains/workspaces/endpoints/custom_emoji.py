"""Custom emoji routes: list a workspace's emoji, add one from an upload, delete one.

Any member may add an emoji, the way anyone in a chat workspace can, while a
guest, who reaches only the teams they were invited to, may not. Deleting is for
the uploader or a workspace admin. Uploads ride the icon path: a signed PUT
under the workspace's emoji prefix, then the create call checks, resizes and
names it. The images are served by the public icon route.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.custom_emoji import EMOJI_CONTENT_TYPES, MAX_EMOJI_BYTES, process_emoji_image
from app.common.db.dynamo.custom_emoji import LIST_MAX, CustomEmoji
from app.common.icons import (
    IconUploadCreate,
    IconUploadRead,
    delete_icon_objects,
    emoji_owner,
    normalized_type,
    presign_icon,
    unprocessable,
    verify_upload,
)
from app.common.workspace_members import NOT_FOUND
from app.domains.workspaces.schemas.custom_emoji import (
    CustomEmojiCreate,
    CustomEmojiListRead,
    CustomEmojiRead,
)

router = APIRouter()

GUESTS_REFUSED = {"error_code": "FORBIDDEN", "message": "Guests cannot add custom emoji"}

DELETE_REFUSED = {"error_code": "FORBIDDEN", "message": "Only the uploader or an admin can delete this emoji"}

NAME_TAKEN = {"error_code": "EMOJI_NAME_TAKEN", "message": "An emoji with that name already exists"}

LIMIT_REACHED = {"error_code": "EMOJI_LIMIT_REACHED", "message": "This workspace has reached its custom emoji limit"}


def _refuse_guests(context: AuthzContext) -> None:
    """Hold adding an emoji to full members of the workspace."""
    if context.is_guest:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=GUESTS_REFUSED)


@router.get("/{workspace_id}/emoji", response_model=CustomEmojiListRead)
def list_custom_emoji(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> CustomEmojiListRead:
    """Every custom emoji of the workspace, by name, with who uploaded each."""
    rows = repositories.custom_emoji.list_for_workspace(context.workspace_id)
    uploaders = repositories.users.get_many(sorted({row.created_by for row in rows})) if rows else {}
    return CustomEmojiListRead(emoji=[CustomEmojiRead.from_row(row, uploaders.get(row.created_by)) for row in rows])


@router.post(
    "/{workspace_id}/emoji/uploads",
    response_model=IconUploadRead,
    status_code=status.HTTP_201_CREATED,
)
def create_custom_emoji_upload(
    payload: IconUploadCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
) -> IconUploadRead:
    """Sign a PUT for one custom emoji image, which the create call then names."""
    _refuse_guests(context)
    if normalized_type(payload.content_type) not in EMOJI_CONTENT_TYPES:
        raise unprocessable("Custom emoji must be PNG, GIF or WebP images", "UNSUPPORTED_MEDIA_TYPE")
    if payload.size_bytes > MAX_EMOJI_BYTES:
        raise unprocessable(f"Custom emoji are limited to {MAX_EMOJI_BYTES} bytes", "UPLOAD_TOO_LARGE")
    return presign_icon(emoji_owner(context.workspace_id), payload)


@router.post(
    "/{workspace_id}/emoji",
    response_model=CustomEmojiRead,
    status_code=status.HTTP_201_CREATED,
)
def create_custom_emoji(
    payload: CustomEmojiCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> CustomEmojiRead:
    """Name an uploaded image as a custom emoji, resized server side.

    The name is checked for a clash before the image is touched, so a taken name
    costs no S3 work, and the conditional put settles a race between two people
    claiming the same name at once; the loser's image is removed.
    """
    _refuse_guests(context)
    if repositories.custom_emoji.get(context.workspace_id, payload.name) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=NAME_TAKEN)
    if len(repositories.custom_emoji.list_for_workspace(context.workspace_id)) >= LIST_MAX:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LIMIT_REACHED)
    owner = emoji_owner(context.workspace_id)
    key = verify_upload(owner, payload.upload_id)
    process_emoji_image(owner, key)
    row = CustomEmoji(
        workspace_id=context.workspace_id,
        name=payload.name,
        image_key=key,
        created_by=context.user_id,
    )
    try:
        repositories.custom_emoji.create(row)
    except ConditionFailed:
        delete_icon_objects(owner.prefix, only=key)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=NAME_TAKEN) from None
    return CustomEmojiRead.from_row(row, repositories.users.get(context.user_id))


@router.delete("/{workspace_id}/emoji/{name}", status_code=status.HTTP_204_NO_CONTENT)
def delete_custom_emoji(
    name: Annotated[str, Path(min_length=1, max_length=64)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete one custom emoji and its image, for its uploader or a workspace admin.

    Text and reactions that used it keep the `:name:` shortcode, which renders as
    plain text from then on.
    """
    row = repositories.custom_emoji.get(context.workspace_id, name.strip(":").lower())
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    if row.created_by != context.user_id and not context.is_workspace_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=DELETE_REFUSED)
    repositories.custom_emoji.delete(context.workspace_id, row.name)
    delete_icon_objects(emoji_owner(context.workspace_id).prefix, only=row.image_key)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
