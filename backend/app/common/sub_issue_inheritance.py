"""What a new sub-issue takes from its parent when the create leaves it out, as Linear does.

Team, priority and project are carried by the clients that file sub-issues. The
two rules here sit on the create path so every client, the API and MCP included,
lands a sub-issue in the same place: the parent's cycle when the child starts in
an active status and that cycle is still open, and the parent's assignee when
the creator is that assignee or every existing sibling shares it. Labels are
never inherited. A field the create names, null included, always wins.
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.issues import Issue
from app.common.issue_rules import check_assignee

ACTIVE_CATEGORIES: frozenset[str] = frozenset({"unstarted", "started"})
"""The status categories a sub-issue must start in to join its parent's cycle."""

CLOSED_CYCLE_STATUSES: frozenset[str] = frozenset({"completed", "cancelled"})
"""The cycle statuses a new sub-issue never joins."""

SIBLING_LIMIT = 1000
"""The most existing sub-issues read when checking that they share an assignee."""


def inherited_cycle_id(
    repositories: Repositories,
    parent: Issue,
    category: str,
    in_triage: bool,
    *,
    today: Optional[str] = None,
) -> Optional[str]:
    """The parent's cycle for a new sub-issue starting in an active status, else None.

    A backlog or triage start stays out of the cycle, and so does a parent whose
    cycle has ended, been cancelled or gone.
    """
    if in_triage or category not in ACTIVE_CATEGORIES or not parent.cycle_id:
        return None
    cycle = repositories.planning.get_cycle(parent.workspace_id, parent.team_id, parent.cycle_id)
    if cycle is None or cycle.status(today) in CLOSED_CYCLE_STATUSES:
        return None
    return cycle.cycle_id


def inherited_assignee_id(repositories: Repositories, creator_id: str, parent: Issue) -> Optional[str]:
    """The parent's assignee for a new sub-issue, or None when the rules leave it unassigned.

    The child takes it when the creator is the parent's assignee, or when every
    existing sub-issue shares it, none at all counting as sharing. An assignee
    who can no longer be given work in the team is not carried down.
    """
    assignee_id = parent.assignee_id
    if not assignee_id:
        return None
    if creator_id != assignee_id:
        siblings = repositories.issues.iter_children(parent.workspace_id, parent.issue_id, max_items=SIBLING_LIMIT)
        if any(child.assignee_id != assignee_id for child in siblings):
            return None
    try:
        return check_assignee(repositories, parent.workspace_id, parent.team_id, assignee_id)
    except HTTPException:
        return None
