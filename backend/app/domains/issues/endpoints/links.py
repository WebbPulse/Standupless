"""Link routes: relate two issues, list both directions, and unlink.

A link is stored once per direction, so listing an issue's links is one query of
its own partition and the inverse index is only read to find what points at an
issue being deleted. The write side accepts only the canonical direction of an
asymmetric type, which is what stops two links disagreeing about which issue is
the duplicate.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.activity import build_activity
from app.domains.issues.schemas.issue import LinkCreate, LinkListRead, LinkRead
from app.domains.issues.service import (
    load_visible_issue,
    not_found,
    require_team_member,
    unprocessable,
)

router = APIRouter()


@router.get("/{workspace_id}/issues/{issue_id}/links", response_model=LinkListRead)
def list_links(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LinkListRead:
    """Every link touching one issue, in both directions.

    The far sides are fetched in one batch so a page of links costs two calls
    rather than one per row, and a link whose target the caller cannot see is left
    out: the link is only meaningful if the issue it names is readable.
    """
    load_visible_issue(repositories, context, issue_id)
    relations = repositories.relations.list_for_issue(context.workspace_id, issue_id)
    targets = repositories.issues.get_many(context.workspace_id, [relation.target_issue_id for relation in relations])
    links = []
    for relation in relations:
        target = targets.get(relation.target_issue_id)
        if target is None or not context.can_see_team(target.team_id):
            continue
        links.append(LinkRead.from_row(relation, target))
    return LinkListRead(links=links)


@router.post(
    "/{workspace_id}/issues/{issue_id}/links",
    response_model=LinkRead,
    status_code=status.HTTP_201_CREATED,
)
def create_link(
    payload: LinkCreate,
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LinkRead:
    """Link two issues, idempotently on the same pair and type.

    The caller must be able to write in the source's team and read the target's,
    so a member of one team cannot attach an issue they merely know the id of.
    A target they cannot see is a 404 rather than a 403, keeping ids unguessable.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)

    if payload.target_issue_id == issue_id:
        raise unprocessable("An issue cannot link to itself")

    target = repositories.issues.get(context.workspace_id, payload.target_issue_id)
    if target is None or not context.can_see_team(target.team_id):
        raise not_found()

    relation = repositories.relations.link(
        context.workspace_id,
        issue_id,
        payload.type,
        payload.target_issue_id,
        context.user_id,
    )
    repositories.activity.record(
        build_activity(
            context.workspace_id,
            issue.team_id,
            issue_id,
            context.user_id,
            "link_added",
            field=payload.type,
            to_value=payload.target_issue_id,
        )
    )
    return LinkRead.from_row(relation, target)


@router.delete(
    "/{workspace_id}/issues/{issue_id}/links/{link_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_link(
    issue_id: Annotated[str, Path(min_length=1)],
    link_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Remove a link, both directions at once.

    Named by `link_id` rather than by the pair, because the two rows share the id
    and the caller holds it from the list; the inverse is then keyed off the stored
    row instead of being reconstructed from the request.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)

    if not repositories.relations.delete_link(context.workspace_id, issue_id, link_id):
        raise not_found()

    repositories.activity.record(
        build_activity(
            context.workspace_id,
            issue.team_id,
            issue_id,
            context.user_id,
            "link_removed",
            from_value=link_id,
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
