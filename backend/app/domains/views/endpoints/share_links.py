"""Share link management: list, create and revoke, all inside one workspace.

Creating a share link is a write even though the thing it exposes is a read.
Publishing an issue to anyone holding a URL is a decision about the project, not
about the reader, so every create goes through `require_project_member` against
the target's own project rather than through the workspace read capability alone.

The listing is built from the targets the caller may see rather than filtered
afterwards, because `share_links` is partitioned by token hash and has no
workspace partition to query: a link onto an invisible project is never fetched
rather than fetched and dropped.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status

from app.common.api.dependencies.authz import (
    AuthzContext,
    Capability,
    refuse_api_key_actor,
    require,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.core.config import settings
from app.common.db.dynamo.share_links import (
    ShareLink,
    expiry_timestamp,
    hash_token,
    new_token,
    target_key,
)
from app.domains.views.schemas.share import (
    MAX_LINKS_PER_WORKSPACE,
    ShareLinkCreate,
    ShareLinkCreated,
    ShareLinkListRead,
    ShareLinkRead,
    TargetTypeField,
)
from app.domains.views.service import (
    forbidden,
    is_project_admin,
    not_found,
    require_project_member,
    visible_project_ids,
)
from app.domains.views.share_service import shareable_view

router = APIRouter()

AT_LIMIT = {
    "error_code": "CONFLICT",
    "message": f"A workspace may hold at most {MAX_LINKS_PER_WORKSPACE} live share links",
}


def _share_url(token: str) -> str:
    """The absolute frontend URL one token is read at.

    Composed here rather than in the client so the settings page does not have to
    know the frontend origin, which differs between staging and production and
    would otherwise be a second place that mapping lives.
    """
    base = str(getattr(settings, "FRONTEND_URL", "") or "").rstrip("/")
    return f"{base}/shared/{token}" if base else f"/shared/{token}"


def _listed_url() -> str:
    """The tokenless path a listing renders.

    A list that carried live tokens would make the list itself a credential, and a
    read grant on the settings page would become a read grant on every share.
    """
    return "/shared"


@router.get("/{workspace_id}/share-links", response_model=ShareLinkListRead)
def list_share_links(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    target_type: Optional[TargetTypeField] = Query(default=None),
    target_id: Optional[str] = Query(default=None),
) -> ShareLinkListRead:
    """Every share link the caller may see, newest first.

    Narrowed to one target when both query parameters arrive, which is what an
    issue page asks for. Without them the answer is every link onto every issue and
    view of the projects this caller can read, so a guest sees only the projects
    they hold a membership in.
    """
    if target_type and target_id:
        rows = repositories.share_links.list_for_target(context.workspace_id, target_type, target_id)
        visible = [row for row in rows if context.can_see_project(row.project_id)]
    else:
        visible = _links_for_visible_projects(repositories, context)

    return ShareLinkListRead(share_links=[ShareLinkRead.from_row(row, url=_listed_url()) for row in visible])


def _links_for_visible_projects(repositories: Repositories, context: AuthzContext) -> list[ShareLink]:
    """Every link onto an issue or view of a project this caller may read.

    Built by asking each visible project for its issues' and views' links rather
    than by reading the whole table, because the table has no workspace partition.
    The fan-out is bounded by the workspace's own link limit, so it stays one short
    query per target rather than a scan.
    """
    project_ids = set(visible_project_ids(repositories, context))
    if not project_ids:
        return []

    targets: list[tuple[str, str]] = []
    for project_id in sorted(project_ids):
        for view in repositories.views.list_for_project(context.workspace_id, project_id):
            targets.append(("view", view.view_id))
        for item in repositories.issues.list_for_project(context.workspace_id, project_id).items:
            targets.append(("issue", str(item["issue_id"])))

    rows = repositories.share_links.list_for_targets(context.workspace_id, targets)
    return [row for row in rows if row.project_id in project_ids]


@router.post(
    "/{workspace_id}/share-links",
    response_model=ShareLinkCreated,
    status_code=status.HTTP_201_CREATED,
)
def create_share_link(
    payload: ShareLinkCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ShareLinkCreated:
    """Mint a share link onto one issue or one view, and show its token once.

    The project and the title are resolved from the target row and denormalised
    onto the link, so a settings listing needs no second read and the anonymous
    read is bounded by a project id that was decided at create time rather than
    re-derived later against whatever the row says then.
    """
    refuse_api_key_actor(context)

    if payload.target_type == "issue":
        project_id, title = _issue_target(repositories, context, payload.target_id)
    else:
        project_id, title = _view_target(repositories, context, payload.target_id)

    require_project_member(repositories, context, project_id)

    if _live_link_count(repositories, context) >= MAX_LINKS_PER_WORKSPACE:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=AT_LIMIT)

    token = new_token()
    link = ShareLink(
        token_hash=hash_token(token),
        ws_target=target_key(context.workspace_id, payload.target_type, payload.target_id),
        workspace_id=context.workspace_id,
        target_type=payload.target_type,
        target_id=payload.target_id,
        project_id=project_id,
        title=title,
        created_by=context.user_id,
        expires_at=expiry_timestamp(payload.expires_in_days),
    )
    stored = repositories.share_links.create(link)

    return ShareLinkCreated(
        **ShareLinkRead.from_row(stored, url=_share_url(token)).model_dump(),
        token=token,
    )


def _issue_target(repositories: Repositories, context: AuthzContext, issue_id: str) -> tuple[str, str]:
    """The project and title of an issue the caller may share, or a 404."""
    issue = repositories.issues.get(context.workspace_id, issue_id)
    if issue is None or not context.can_see_project(issue.project_id):
        raise not_found()
    return issue.project_id, issue.title


def _view_target(repositories: Repositories, context: AuthzContext, view_id: str) -> tuple[str, str]:
    """The project and name of a view the caller may share, or a 404 or 422.

    A view scoped to no project is refused here rather than at the table, because
    the refusal is about what the link would mean rather than about the write.
    """
    view = repositories.views.find(
        context.workspace_id,
        view_id,
        context.user_id,
        visible_project_ids(repositories, context),
    )
    if view is None:
        raise not_found()
    return shareable_view(view), view.name


def _live_link_count(repositories: Repositories, context: AuthzContext) -> int:
    """How many live links this workspace holds, for the limit check.

    Counted over the caller's visible projects, which for an admin is the whole
    workspace. The count is advisory: the limit exists to bound growth, and a race
    that leaves a workspace one link over costs nothing.
    """
    return len([row for row in _links_for_visible_projects(repositories, context) if row.revoked_at is None])


@router.delete("/{workspace_id}/share-links/{token_hash}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_share_link(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    token_hash: str = Path(..., min_length=1),
) -> Response:
    """Revoke one link the caller created, or any link for a project admin.

    Named by hash rather than by token, because the settings list is what a person
    revokes from and the token is deliberately the one thing that list does not
    carry.

    A link in a workspace the caller is not in, or onto a project they cannot see,
    answers the same 404 an absent one does, so the hash space cannot be probed.
    """
    refuse_api_key_actor(context)

    link = repositories.share_links.get(token_hash)
    if link is None or link.workspace_id != context.workspace_id:
        raise not_found()
    if not context.can_see_project(link.project_id):
        raise not_found()

    if link.created_by != context.user_id and not is_project_admin(repositories, context, link.project_id):
        raise forbidden()

    if link.revoked_at is None:
        repositories.share_links.revoke(token_hash)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
