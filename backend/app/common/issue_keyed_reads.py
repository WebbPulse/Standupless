"""Issue reads that start from one person's own index rather than every team.

"Subscribed by me", "created by" one person and "assigned to" one person each have
an index keyed on that person and the workspace, which is what the My issues tabs
ask for. Reading it touches only that person's issues, where the general list has
to fan out across every visible team, and the workspace being the index range key
keeps another tenant's rows out of the read itself.
"""

from __future__ import annotations

from typing import Optional

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.issues import Issue
from app.common.issue_filters import IssueFilter
from app.common.issue_keys import current_all

KEYED_READ_CAP = 1000
"""How many issues one keyed read of a person's own index gathers at most.

A person's assigned, created or subscribed set is read whole and then filtered and
sorted, so the cap bounds the one read that has no natural page boundary.
"""


def single(values: "frozenset[Optional[str]]") -> Optional[str]:
    """The one concrete value of a filter, or `None` when it holds none or several."""
    if len(values) != 1:
        return None
    (value,) = tuple(values)
    return value


def keyed_rows(
    repositories: Repositories, context: AuthzContext, wanted: IssueFilter, subscribed: bool, teams: list[str]
) -> Optional[list[Issue]]:
    """The candidate rows when a person index can answer the read, else `None`.

    The narrowest index wins; the remaining filters still run afterwards, so a
    request carrying two of them gets the intersection. Rows in teams the caller
    may not read are dropped here, before anything is sorted or counted.
    """
    workspace_id = context.workspace_id
    allowed = set(teams)
    if subscribed:
        ids = repositories.subscriptions.issue_ids_for_user(workspace_id, context.user_id, max_items=KEYED_READ_CAP)
        rows = list(repositories.issues.get_many(workspace_id, ids).values())
    elif (creator := single(wanted.creator_ids)) is not None:
        ids = repositories.issues.issue_ids_created_by(workspace_id, creator, max_items=KEYED_READ_CAP)
        rows = list(repositories.issues.get_many(workspace_id, ids).values())
    elif (assignee := single(wanted.assignee_ids)) is not None:
        rows = repositories.issues.iter_for_assignee(workspace_id, assignee, max_items=KEYED_READ_CAP)
    else:
        return None
    return current_all(repositories.teams, (issue for issue in rows if issue.team_id in allowed))
