"""One page of an issue's history, shared by the activity route and the MCP tool.

Both read the same rows through the same visibility check and the same cursor
scope, so a cursor one hands out is one the other accepts.
"""

from __future__ import annotations

from typing import Optional

from webbpulse.dynamodb import encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import resume_key
from app.common.change_source import source_for
from app.common.db.dynamo.activity import Activity, as_activity
from app.common.issue_rules import load_visible_issue


def activity_page(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: str,
    *,
    cursor: Optional[str] = None,
    limit: int,
    source: Optional[str] = None,
) -> tuple[list[Activity], Optional[str]]:
    """One page of a visible issue's history, newest first, and the cursor after it.

    `source` keeps only the rows made through that client, filtered within the page,
    so a filtered page can be short while its cursor still walks the whole history.
    A GitHub or system row written before sources were recorded matches its actor kind.
    """
    load_visible_issue(repositories, context, issue_id)
    scope = f"activity:{context.workspace_id}:{issue_id}"
    page = repositories.activity.list_for_issue(
        context.workspace_id,
        issue_id,
        limit=limit,
        start_key=resume_key(cursor, scope),
    )
    rows = [as_activity(item) for item in page.items]
    if source is not None:
        rows = [row for row in rows if source_for(row.source, row.actor_kind) == source]
    return rows, encode_start_key(page.last_evaluated_key, scope=scope)
