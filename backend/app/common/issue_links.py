"""Link list, create and delete, shared by the link routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a link an agent adds must leave the same activity row, duplicate close
and blocked count a person's link does.
"""

from __future__ import annotations

from typing import Iterable

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import LinkCreate, LinkRead, LinkStatusRead
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.relations import Relation
from app.common.issue_keys import current
from app.common.issue_rules import load_visible_issue, not_found, require_team_member, unprocessable
from app.common.relation_effects import blocked_side, close_as_duplicate, issue_reference, recount_blocked


def list_links(repositories: Repositories, context: AuthzContext, issue_id: str) -> list[LinkRead]:
    """Every link touching one visible issue, in both directions.

    The far sides are fetched in one batch so a page of links costs two calls
    rather than one per row, and a link whose target the caller cannot see is left
    out: the link is only meaningful if the issue it names is readable.
    """
    load_visible_issue(repositories, context, issue_id)
    relations = repositories.relations.list_for_issue(context.workspace_id, issue_id)
    targets = repositories.issues.get_many(context.workspace_id, [relation.target_issue_id for relation in relations])
    visible = {key: row for key, row in targets.items() if context.can_see_team(row.team_id)}
    statuses = link_statuses(repositories, context.workspace_id, visible.values())
    links = []
    for relation in relations:
        target = visible.get(relation.target_issue_id)
        if target is None:
            continue
        links.append(LinkRead.from_row(relation, current(repositories.teams, target), statuses.get(target.status_id)))
    return links


def link_statuses(repositories: Repositories, workspace_id: str, issues: Iterable[Issue]) -> dict[str, LinkStatusRead]:
    """The status of every named issue's team, keyed by status id.

    One read per distinct team rather than per link, and across teams, because a
    link may point anywhere in the workspace the caller can see.
    """
    found: dict[str, LinkStatusRead] = {}
    for team_id in dict.fromkeys(issue.team_id for issue in issues):
        for row in repositories.team_config.list_statuses(workspace_id, team_id):
            found[row.status_id] = LinkStatusRead(id=row.status_id, name=row.name, category=row.category)
    return found


def create_link(repositories: Repositories, context: AuthzContext, issue_id: str, payload: LinkCreate) -> LinkRead:
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
    statuses = link_statuses(repositories, context.workspace_id, [target])
    return LinkRead.from_row(relation, current(repositories.teams, target), statuses.get(target.status_id))


def delete_link(repositories: Repositories, context: AuthzContext, issue_id: str, link_id: str) -> Relation:
    """Remove a link, both directions at once, answering the removed row of this issue.

    The caller must be able to write in the issue's team. The removal is recorded on
    the issue's history naming the far side whole, and the blocked side of a
    blocking link is recounted so its marker clears when its last open blocker goes.
    An unknown link id is the same 404 an invisible issue is.
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
    return removed
