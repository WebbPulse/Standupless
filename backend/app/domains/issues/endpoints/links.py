"""Link routes: relate two issues, list both directions, and unlink.

A link is stored once per direction, so listing an issue's links is one query of
its own partition and the inverse index is only read to find what points at an
issue being deleted. The write side accepts only the canonical direction of an
asymmetric type, which is what stops two links disagreeing about which issue is
the duplicate.
"""

from __future__ import annotations

from typing import Annotated, Iterable

from fastapi import APIRouter, Depends, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.issues import Issue
from app.common.issue_keys import current
from app.domains.issues.relation_effects import (
    blocked_side,
    close_as_duplicate,
    issue_reference,
    recount_blocked,
)
from app.domains.issues.schemas.issue import LinkCreate, LinkListRead, LinkRead, LinkStatusRead
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
    visible = {key: row for key, row in targets.items() if context.can_see_team(row.team_id)}
    statuses = _statuses(repositories, context.workspace_id, visible.values())
    links = []
    for relation in relations:
        target = visible.get(relation.target_issue_id)
        if target is None:
            continue
        links.append(LinkRead.from_row(relation, current(repositories.teams, target), statuses.get(target.status_id)))
    return LinkListRead(links=links)


def _statuses(repositories: Repositories, workspace_id: str, issues: Iterable[Issue]) -> dict[str, LinkStatusRead]:
    """The status of every named issue's team, keyed by status id.

    One read per distinct team rather than per link, and across teams, because a
    link may point anywhere in the workspace the caller can see.
    """
    found: dict[str, LinkStatusRead] = {}
    for team_id in dict.fromkeys(issue.team_id for issue in issues):
        for row in repositories.team_config.list_statuses(workspace_id, team_id):
            found[row.status_id] = LinkStatusRead(id=row.status_id, name=row.name, category=row.category)
    return found


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
            to_value=issue_reference(repositories, target),
        )
    )
    if payload.type == "duplicate_of":
        close_as_duplicate(repositories, context.workspace_id, context.user_id, issue)
    blocked = blocked_side(relation)
    if blocked is not None:
        recount_blocked(repositories, context.workspace_id, blocked)
    statuses = _statuses(repositories, context.workspace_id, [target])
    return LinkRead.from_row(relation, current(repositories.teams, target), statuses.get(target.status_id))


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

    removed = repositories.relations.delete_link(context.workspace_id, issue_id, link_id)
    if removed is None:
        raise not_found()

    target = repositories.issues.get(context.workspace_id, removed.target_issue_id)
    repositories.activity.record(
        build_activity(
            context.workspace_id,
            issue.team_id,
            issue_id,
            context.user_id,
            "link_removed",
            field=removed.relation_type,
            from_value=(
                issue_reference(repositories, target)
                if target is not None
                else {"id": removed.target_issue_id, "key": "", "title": ""}
            ),
        )
    )
    blocked = blocked_side(removed)
    if blocked is not None:
        recount_blocked(repositories, context.workspace_id, blocked)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
