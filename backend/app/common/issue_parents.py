"""The parent rows a page of sub-issues names, so a list can label each child with its parent.

A sub-issue listed apart from its parent, grouped or filtered away from it, still
has to say whose step it is. Parents already on the page are reused, and the rest
cost one `BatchGetItem` per page rather than one read per row. A parent is only
reported when it sits in the child's own team, because sub-issues never cross
teams and a parent elsewhere could sit in a team the caller cannot see.
"""

from __future__ import annotations

from typing import Iterable

from app.common.db.dynamo.issues import Issue, IssueRepository
from app.common.db.dynamo.teams import TeamRepository
from app.common.issue_keys import current_all


def parents_of(
    issues: IssueRepository, teams: TeamRepository, workspace_id: str, rows: Iterable[Issue]
) -> dict[str, Issue]:
    """Each named parent keyed by id, under its current key, for the rows that have one in their own team."""
    page = list(rows)
    on_page = {row.issue_id: row for row in page}
    wanted = [row.parent_id for row in page if row.parent_id and row.parent_id not in on_page]
    fetched = issues.get_many(workspace_id, wanted) if wanted else {}
    found: dict[str, Issue] = {}
    for row in page:
        parent_id = row.parent_id
        if not parent_id or parent_id == row.issue_id or parent_id in found:
            continue
        parent = on_page.get(parent_id) or fetched.get(parent_id)
        if parent is not None and parent.team_id == row.team_id:
            found[parent_id] = parent
    return {parent.issue_id: parent for parent in current_all(teams, found.values())}
