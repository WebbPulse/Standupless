"""A list of issue keys as the issue ids an issue filter keeps.

The issue list, its CSV export and its insights take `key` beside `issue_id`, so
a one-off list such as `/issues/ABC-1,XYZ-7` is read in one request rather than
one by-key read per issue. Each key resolves the way the by-key read resolves it,
through a retired prefix or a move, and a key naming nothing is skipped.
"""

from __future__ import annotations

from typing import Iterable, Optional

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import parse_issue_key
from app.common.db.dynamo.teams import Team
from app.common.issue_move import find_issue_by_number
from app.common.issue_rules import unprocessable

KEY_LIST_MAX = 100
"""The most keys one request may name, the list route's page size."""

UNMATCHED_ISSUE_ID = "-"
"""An id no issue holds, kept when every key named misses, so the list is empty rather than unfiltered."""


def issue_ids_for_keys(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: Optional[Iterable[str]],
    key: Optional[Iterable[str]],
) -> Optional[list[str]]:
    """The `issue_id` filter values once `key` is folded in, or `None` when neither is given.

    Keys add to the ids named directly. A key that does not parse, names no team,
    or names no live issue is skipped; visibility is left to the list itself, which
    reads only the teams the caller may see. More than `KEY_LIST_MAX` keys is refused.
    """
    ids = [value for value in issue_id or [] if value]
    keys = [value for value in key or [] if value.strip()]
    if not keys:
        return ids or None
    if len(keys) > KEY_LIST_MAX:
        raise unprocessable(f"name at most {KEY_LIST_MAX} issue keys")
    teams: dict[str, Optional[Team]] = {}
    for raw in keys:
        parsed = parse_issue_key(raw)
        if parsed is None:
            continue
        prefix, number = parsed
        if prefix not in teams:
            teams[prefix] = repositories.teams.get_by_key_prefix(context.workspace_id, prefix)
        team = teams[prefix]
        if team is None:
            continue
        issue = find_issue_by_number(repositories, context.workspace_id, team.team_id, number)
        if issue is not None and issue.issue_id not in ids:
            ids.append(issue.issue_id)
    return ids or [UNMATCHED_ISSUE_ID]
