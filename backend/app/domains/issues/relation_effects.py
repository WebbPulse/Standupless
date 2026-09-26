"""What a link or a parent change does beyond the rows it writes.

Linear closes an issue marked as a duplicate, shows a blocked marker on an issue
while any of its blockers is open, and writes a sub-issue entry into the parent's
history. Each of those is a second write that follows from the first, so they live
here once and the routes, the rollup consumer and the purge all reach them the same
way.

The blocked marker is a denormalised `blocked_by_open_count` on the issue row
rather than a read at list time. A list or board page would otherwise query the
relations of every row it shows, one query per issue, while the count only moves
on a link write or a blocker's status change, both of which already pass through
this domain.
"""

from __future__ import annotations

from typing import Iterable

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.activity import Activity, build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.relations import Relation
from app.common.db.dynamo.team_config import Status
from app.common.issue_keys import current
from app.domains.issues.service import COMPLETED_CATEGORIES

CANCELLED_CATEGORY = "cancelled"


def issue_reference(repositories: Repositories, issue: Issue) -> dict[str, str]:
    """The id, current key and title of one issue, as an activity value.

    Stored whole rather than as an id so an entry still names its issue after
    the link is gone or the sub-issue moved elsewhere, when the page reading the
    history no longer holds that issue.
    """
    shown = current(repositories.teams, issue)
    return {"id": shown.issue_id, "key": shown.key, "title": shown.title}


def blocked_side(relation: Relation) -> str | None:
    """Which issue of a link is the blocked one, or `None` for a non-blocking link."""
    if relation.relation_type == "blocked_by":
        return relation.issue_id
    if relation.relation_type == "blocks":
        return relation.target_issue_id
    return None


def categories_for(repositories: Repositories, workspace_id: str, team_ids: Iterable[str]) -> dict[str, str]:
    """Each status id of the named teams mapped to its category, one read per team."""
    categories: dict[str, str] = {}
    for team_id in dict.fromkeys(team_ids):
        for row in repositories.team_config.list_statuses(workspace_id, team_id):
            categories[row.status_id] = row.category
    return categories


def recount_blocked(repositories: Repositories, workspace_id: str, issue_id: str) -> int | None:
    """Write how many open issues block one issue, answering the count.

    Recounted from the stored links rather than incremented, so a retried stream
    record or a repeated link lands on the same number. Nothing is written when the
    count already holds or the issue is gone.
    """
    issue = repositories.issues.get(workspace_id, issue_id)
    if issue is None:
        return None
    blockers = [
        relation.target_issue_id
        for relation in repositories.relations.list_for_issue(workspace_id, issue_id)
        if relation.relation_type == "blocked_by"
    ]
    rows = repositories.issues.get_many(workspace_id, blockers)
    categories = categories_for(repositories, workspace_id, (row.team_id for row in rows.values()))
    count = sum(1 for row in rows.values() if categories.get(row.status_id) not in COMPLETED_CATEGORIES)
    if issue.blocked_by_open_count != count:
        repositories.issues.set_blocked_by_open_count(workspace_id, issue_id, count)
    return count


def recount_blocked_by(repositories: Repositories, workspace_id: str, blocker_id: str) -> list[str]:
    """Recount every issue one issue blocks, answering their ids.

    What a blocker's status change calls: the issues it blocks are named by the
    `blocks` rows under its own partition, so this is one query plus one recount
    per blocked issue.
    """
    blocked = [
        relation.target_issue_id
        for relation in repositories.relations.list_for_issue(workspace_id, blocker_id)
        if relation.relation_type == "blocks"
    ]
    for issue_id in blocked:
        recount_blocked(repositories, workspace_id, issue_id)
    return blocked


def delete_relations(repositories: Repositories, workspace_id: str, issue_id: str) -> None:
    """Remove every link of an issue being deleted, then recount the issues it blocked.

    The blocked side is read before the rows go, because afterwards nothing names
    it, and an issue that lost its only open blocker must lose its marker too.
    """
    blocked = [
        relation.target_issue_id
        for relation in repositories.relations.list_for_issue(workspace_id, issue_id, limit=1000)
        if relation.relation_type == "blocks"
    ]
    repositories.relations.delete_for_issue(workspace_id, issue_id)
    for blocked_id in dict.fromkeys(blocked):
        recount_blocked(repositories, workspace_id, blocked_id)


def cancelled_status(repositories: Repositories, workspace_id: str, team_id: str) -> Status | None:
    """The team's first cancelled-category status, or `None` when it has none."""
    rows = repositories.team_config.list_statuses(workspace_id, team_id)
    cancelled = [row for row in rows if row.category == CANCELLED_CATEGORY]
    return cancelled[0] if cancelled else None


def close_as_duplicate(repositories: Repositories, workspace_id: str, actor_id: str, issue: Issue) -> Issue:
    """Move an issue just marked as a duplicate to its team's cancelled status.

    Linear's behaviour: a duplicate is closed as cancelled unless it is already
    finished, and the move is recorded as the actor's own status change so the
    history reads the same as if they had moved it by hand. Removing the link later
    leaves the status alone. Answers the issue as it now stands.
    """
    categories = categories_for(repositories, workspace_id, [issue.team_id])
    if categories.get(issue.status_id) in COMPLETED_CATEGORIES:
        return issue
    target = cancelled_status(repositories, workspace_id, issue.team_id)
    if target is None:
        return issue

    moved = issue.model_copy(update={"status_id": target.status_id, "updated_at": utc_now()})
    stored = repositories.issues.replace(moved)
    repositories.activity.record(
        build_activity(
            workspace_id,
            issue.team_id,
            issue.issue_id,
            actor_id,
            "field_changed",
            field="status_id",
            from_value=issue.status_id,
            to_value=target.status_id,
        )
    )
    return stored


def child_activity(
    repositories: Repositories,
    workspace_id: str,
    actor_id: str,
    child: Issue,
    old_parent_id: str | None,
    new_parent_id: str | None,
) -> list[Activity]:
    """The `child_removed` and `child_added` rows a parent change writes on the parents.

    Each names the child whole, so the parent's history still links it after the
    child moves on. A parent that is gone gets no row.
    """
    if old_parent_id == new_parent_id:
        return []
    reference = issue_reference(repositories, child)
    parents = repositories.issues.get_many(
        workspace_id, [parent for parent in (old_parent_id, new_parent_id) if parent]
    )
    rows: list[Activity] = []
    old_parent = parents.get(old_parent_id) if old_parent_id else None
    if old_parent is not None:
        rows.append(
            build_activity(
                workspace_id,
                old_parent.team_id,
                old_parent.issue_id,
                actor_id,
                "child_removed",
                from_value=reference,
            )
        )
    new_parent = parents.get(new_parent_id) if new_parent_id else None
    if new_parent is not None:
        rows.append(
            build_activity(
                workspace_id,
                new_parent.team_id,
                new_parent.issue_id,
                actor_id,
                "child_added",
                to_value=reference,
            )
        )
    return rows
