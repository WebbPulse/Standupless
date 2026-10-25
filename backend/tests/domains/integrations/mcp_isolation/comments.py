"""Isolation arguments for the comment edit, delete and reaction tools and the issue link tools.

Each names a comment or a URL link on the other workspace's issue. The issue never
resolves through a key bound to this workspace, so every call refuses before the
comment or the link is read, and none of them answers from home.
"""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.attachments import build_attachment
from app.common.db.dynamo.comments import build_comment
from tests.domains.helpers import OWNER

ANSWERS_AT_HOME: frozenset[str] = frozenset()


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """A comment by the owner and a URL link on the other workspace's first issue."""
    source = repositories.issues.get_by_number(workspace_id, team_id, 1)
    comment = repositories.comments.create(build_comment(workspace_id, source.issue_id, team_id, OWNER, "Foreign"))
    link = repositories.attachments.create(
        build_attachment(
            workspace_id, source.issue_id, team_id, "url", "Foreign link", OWNER, url="https://example.com/foreign"
        )
    )
    return {"issue_comment_id": comment.comment_id, "issue_link_id": link.attachment_id}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    issue = foreign["issue_id"]
    comment = foreign["issue_comment_id"]
    link = foreign["issue_link_id"]
    return {
        "update_comment": {"issue_id": issue, "comment_id": comment, "body": "Should not land"},
        "delete_comment": {"issue_id": issue, "comment_id": comment},
        "add_comment_reaction": {"issue_id": issue, "comment_id": comment, "emoji": "👍"},
        "remove_comment_reaction": {"issue_id": issue, "comment_id": comment, "emoji": "👍"},
        "list_issue_links": {"issue_id": issue},
        "create_issue_link": {"issue_id": issue, "url": "https://example.com/should-not-land"},
        "update_issue_link": {"issue_id": issue, "link_id": link, "title": "Should not land"},
        "delete_issue_link": {"issue_id": issue, "link_id": link},
    }
