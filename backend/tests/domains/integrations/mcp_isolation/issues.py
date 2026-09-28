"""Isolation arguments for the issues MCP tools added beyond the original set."""

from __future__ import annotations

from typing import Any

from tests.domains.helpers import OWNER
from tests.domains.integrations.conftest import seed_issue

FOREIGN_TARGET = "01JB0000000000000000000IT9"

ANSWERS_AT_HOME: frozenset[str] = frozenset()


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """A second foreign issue and a link to it from the first, so a relation id can be named."""
    source = repositories.issues.get_by_number(workspace_id, team_id, 1)
    seed_issue(repositories, workspace_id, team_id, FOREIGN_TARGET, "OTH", 2)
    relation = repositories.relations.link(workspace_id, source.issue_id, "blocks", FOREIGN_TARGET, OWNER)
    return {"relation_id": relation.link_id, "target_issue_id": FOREIGN_TARGET}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    issue = foreign["issue_id"]
    return {
        "delete_issue_relation": {"issue_id": issue, "relation_id": foreign["relation_id"]},
        "list_issue_subscribers": {"issue_id": issue},
        "subscribe_to_issue": {"issue_id": issue},
        "unsubscribe_from_issue": {"issue_id": issue},
        "bulk_update_issues": {"issue_ids": [issue], "assignee_id": "me", "priority": "urgent"},
    }
