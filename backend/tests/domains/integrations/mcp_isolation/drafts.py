"""Isolation arguments for the comment and new issue draft MCP tools.

Drafts are keyed by the credential's own user in the key's own workspace, so
listing every draft answers from home, and reading or discarding the owner's
own draft in the other workspace answers null or a no-op from home rather than
a refusal. Saving, reading or discarding a foreign issue's comment draft
refuses, because the issue never resolves, and saving a new issue draft on a
foreign team refuses, because the team never resolves.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.common.db.dynamo.views import IssueDraft, issue_draft_key
from tests.domains.helpers import OWNER

ANSWERS_AT_HOME: frozenset[str] = frozenset(
    {"list_comment_drafts", "list_issue_drafts", "get_issue_draft", "delete_issue_draft"}
)

FOREIGN_DRAFT = "01JB000000000000000FOREIGND"


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """A new issue draft in the other workspace, on the owner's own row there."""
    now = datetime(2026, 10, 1, tzinfo=timezone.utc)
    repositories.views.put_issue_draft(
        IssueDraft(
            workspace_id=workspace_id,
            view_key=issue_draft_key(OWNER, FOREIGN_DRAFT),
            user_id=OWNER,
            draft_id=FOREIGN_DRAFT,
            team_id=team_id,
            title="Foreign draft",
            created_at=now,
            updated_at=now,
        )
    )
    return {"issue_draft_id": FOREIGN_DRAFT}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    return {
        "set_comment_draft": {"issue_id": foreign["issue_id"], "body": "Staged"},
        "get_comment_draft": {"issue_id": foreign["issue_id"]},
        "list_comment_drafts": {},
        "delete_comment_draft": {"issue_id": foreign["issue_id"]},
        "save_issue_draft": {"team_id": foreign["team_id"], "title": "Should not land"},
        "get_issue_draft": {"draft_id": foreign["issue_draft_id"]},
        "list_issue_drafts": {},
        "delete_issue_draft": {"draft_id": foreign["issue_draft_id"]},
    }
