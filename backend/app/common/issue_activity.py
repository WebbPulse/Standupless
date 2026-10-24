"""One page of an issue's history, shared by the activity route and the MCP tool.

Both read the same rows through the same visibility check and the same cursor
scope, so a cursor one hands out is one the other accepts. A row naming another
issue answers that issue under its team's current key prefix, so history written
before a team key change reads the keys shown everywhere else.
"""

from __future__ import annotations

from typing import Optional

from webbpulse.dynamodb import encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import resume_key
from app.common.change_source import source_for
from app.common.db.dynamo.activity import Activity, as_activity
from app.common.issue_keys import current_reference_value, is_issue_reference, retired_prefixes
from app.common.issue_mentions import visible_backlink
from app.common.issue_rules import load_visible_issue


def _names_an_issue(value: object) -> bool:
    """Whether an activity value, or any item of a list one, names an issue by key."""
    if isinstance(value, list):
        return any(is_issue_reference(item) for item in value)
    return is_issue_reference(value)


def with_current_keys(repositories: Repositories, workspace_id: str, rows: list[Activity]) -> list[Activity]:
    """`rows` with every issue they name under its team's current key prefix.

    The workspace's retired prefixes are read only when a row on the page names an
    issue, so a page of status and field changes costs no extra read.
    """
    if not any(_names_an_issue(row.from_value) or _names_an_issue(row.to_value) for row in rows):
        return rows
    renames = retired_prefixes(repositories.teams, workspace_id)
    if not renames:
        return rows
    return [
        row.model_copy(
            update={
                "from_value": current_reference_value(row.from_value, renames),
                "to_value": current_reference_value(row.to_value, renames),
            }
        )
        for row in rows
    ]


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
    A "mentioned in" backlink from a team the caller cannot see is dropped the same way.
    """
    load_visible_issue(repositories, context, issue_id)
    scope = f"activity:{context.workspace_id}:{issue_id}"
    page = repositories.activity.list_for_issue(
        context.workspace_id,
        issue_id,
        limit=limit,
        start_key=resume_key(cursor, scope),
    )
    rows = [row for row in (as_activity(item) for item in page.items) if visible_backlink(context, row)]
    if source is not None:
        rows = [row for row in rows if source_for(row.source, row.actor_kind) == source]
    rows = with_current_keys(repositories, context.workspace_id, rows)
    return rows, encode_start_key(page.last_evaluated_key, scope=scope)
