"""Share link management: list, create and revoke, all inside one workspace.

Creating a share link is a write even though the thing it exposes is a read.
Publishing an issue to anyone holding a URL is a decision about the team, not
about the reader, so every create goes through `require_team_member` against
the target's own team rather than through the workspace read capability alone.

The listing reads the workspace's own tokens and then drops the ones onto
teams the caller cannot see. The package's table carries a tenant index, so
this is one query rather than the per-target fan-out the product-local table
forced, and team visibility stays a filter over a bounded set.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from webbpulse.identity.share_tokens import mint_share_token, revoke_share_token

from app.common.api.dependencies.authz import (
    AuthzContext,
    Capability,
    refuse_api_key_actor,
    require,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.core.config import settings
from app.common.db.dynamo.base import expiry_timestamp
from app.common.db.dynamo.share_links import ShareLinkView, share_capability
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
    is_team_admin,
    not_found,
    require_team_member,
    visible_team_ids,
)
from app.domains.views.share_service import DEFAULT_SORT, shareable_view, snapshot_filter

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
    view of the teams this caller can read, so a guest sees only the teams
    they hold a membership in.
    """
    if target_type and target_id:
        records = repositories.share_links.list_for_target(context.workspace_id, (target_type, target_id))
    else:
        records = repositories.share_links.list_for_tenant(context.workspace_id)

    links = _newest_first([ShareLinkView(record) for record in records])
    visible = [link for link in links if context.can_see_team(link.team_id)]

    return ShareLinkListRead(share_links=[ShareLinkRead.from_row(link, url=_listed_url()) for link in visible])


def _newest_first(links: list[ShareLinkView]) -> list[ShareLinkView]:
    """The workspace's links in creation order, newest first.

    Sorted here rather than trusted to the index, because the package answers from
    a created_at index in ascending order and the settings list reads newest first.
    """
    return sorted(links, key=lambda link: link.created_at, reverse=True)


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
    """Mint a share link onto one issue, one view or one team filter, and show its token once.

    The team and the title are resolved from the target row and denormalised
    onto the link, so a settings listing needs no second read and the anonymous
    read is bounded by a team id that was decided at create time rather than
    re-derived later against whatever the row says then.
    """
    refuse_api_key_actor(context)

    snapshot: Optional[dict[str, Any]] = None
    sort: Optional[str] = None
    if payload.target_type == "issue":
        team_id, title = _issue_target(repositories, context, payload.target_id)
    elif payload.target_type == "view":
        team_id, title = _view_target(repositories, context, payload.target_id)
    else:
        team_id, title = _filter_target(repositories, context, payload)
        snapshot = snapshot_filter(team_id, payload.filter)
        sort = payload.sort or DEFAULT_SORT

    require_team_member(repositories, context, team_id)

    if _live_link_count(repositories, context) >= MAX_LINKS_PER_WORKSPACE:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=AT_LIMIT)

    minted = mint_share_token(
        tenant_id=context.workspace_id,
        capability=share_capability(team_id, title, filter=snapshot, sort=sort),
        target=(payload.target_type, payload.target_id),
        name=title,
        created_by=context.user_id,
        expires_at=expiry_timestamp(payload.expires_in_days) or None,
        store=repositories.share_links,
    )

    return ShareLinkCreated(
        **ShareLinkRead.from_row(ShareLinkView(minted.record), url=_share_url(minted.plaintext)).model_dump(),
        token=minted.plaintext,
    )


def _issue_target(repositories: Repositories, context: AuthzContext, issue_id: str) -> tuple[str, str]:
    """The team and title of an issue the caller may share, or a 404."""
    issue = repositories.issues.get(context.workspace_id, issue_id)
    if issue is None or not context.can_see_team(issue.team_id):
        raise not_found()
    return issue.team_id, issue.title


def _view_target(repositories: Repositories, context: AuthzContext, view_id: str) -> tuple[str, str]:
    """The team and name of a view the caller may share, or a 404 or 422.

    A view scoped to no team is refused here rather than at the table, because
    the refusal is about what the link would mean rather than about the write.
    """
    view = repositories.views.find(
        context.workspace_id,
        view_id,
        context.user_id,
        visible_team_ids(repositories, context),
    )
    if view is None:
        raise not_found()
    return shareable_view(view), view.name


def _filter_target(repositories: Repositories, context: AuthzContext, payload: ShareLinkCreate) -> tuple[str, str]:
    """The team and title of an unsaved filter the caller may share, or a 404.

    `target_id` names the team, and the title defaults to the team's own name so a
    settings listing has something to show for a link nobody named.
    """
    team = repositories.teams.get(context.workspace_id, payload.target_id)
    if team is None or not context.can_see_team(team.team_id):
        raise not_found()
    return team.team_id, payload.title or f"{team.name} issues"


def _live_link_count(repositories: Repositories, context: AuthzContext) -> int:
    """How many live links this workspace holds, for the limit check.

    Counted over the whole workspace rather than over the caller's visible
    teams, because the limit bounds the tenant's storage and a member who can
    see one team should not be able to mint past it by being unable to see the
    rest. The count is advisory: a race that leaves a workspace one link over
    costs nothing.
    """
    records = repositories.share_links.list_for_tenant(context.workspace_id)
    return len([record for record in records if not record.is_revoked])


@router.delete("/{workspace_id}/share-links/{token_hash}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_share_link(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    token_hash: str = Path(..., min_length=1),
) -> Response:
    """Revoke one link the caller created, or any link for a team admin.

    Named by hash rather than by token, because the settings list is what a person
    revokes from and the token is deliberately the one thing that list does not
    carry.

    A link in a workspace the caller is not in, or onto a team they cannot see,
    answers the same 404 an absent one does, so the hash space cannot be probed.
    """
    refuse_api_key_actor(context)

    record = repositories.share_links.get(token_hash)
    if record is None or record.tenant_id != context.workspace_id:
        raise not_found()
    link = ShareLinkView(record)
    if not context.can_see_team(link.team_id):
        raise not_found()

    if link.created_by != context.user_id and not is_team_admin(repositories, context, link.team_id):
        raise forbidden()

    if link.revoked_at is None:
        revoke_share_token(token_hash, repositories.share_links)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
