"""The saved view listing, shared by the view routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and which views a caller may read is decided once, from what they may
read, rather than filtered afterwards.
"""

from __future__ import annotations

from typing import Optional

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.views import SavedView
from app.common.issue_rules import require_team_reader, visible_team_ids


def readable_views(
    repositories: Repositories, context: AuthzContext, scope: str, team_id: Optional[str]
) -> list[SavedView]:
    """Saved views the caller may read, narrowed by scope, in name order.

    `mine` is the caller's own views, `team` the shared views of one team or of
    every team they can see, and `all` both. For a guest the teams are only the
    ones they hold a membership in.
    """
    rows: list[SavedView] = []

    if scope in ("mine", "all"):
        rows.extend(repositories.views.list_personal(context.workspace_id, context.user_id))

    if scope in ("team", "all"):
        if team_id:
            require_team_reader(repositories, context, team_id)
            wanted = [team_id]
        else:
            wanted = visible_team_ids(repositories, context)
        for candidate in wanted:
            rows.extend(repositories.views.list_for_team(context.workspace_id, candidate))

    if scope == "mine" and team_id:
        rows = [row for row in rows if row.team_id == team_id]

    return sorted(rows, key=lambda row: (row.name.lower(), row.view_id))
