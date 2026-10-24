"""Isolation arguments for the comment draft MCP tools.

Drafts are keyed by the credential's own user in the key's own workspace, so
listing every draft answers from home. Saving, reading or discarding a foreign
issue's draft refuses, because the issue never resolves.
"""

from __future__ import annotations

from typing import Any

ANSWERS_AT_HOME: frozenset[str] = frozenset({"list_comment_drafts"})


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """No extra rows: the foreign issue is enough."""
    return {}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    return {
        "set_comment_draft": {"issue_id": foreign["issue_id"], "body": "Staged"},
        "get_comment_draft": {"issue_id": foreign["issue_id"]},
        "list_comment_drafts": {},
        "delete_comment_draft": {"issue_id": foreign["issue_id"]},
    }
