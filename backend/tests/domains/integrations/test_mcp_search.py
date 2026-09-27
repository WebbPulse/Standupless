"""The `search_issues` tool's filters, which are the HTTP issue list's own.

Held through the transport so the argument shapes an agent sends, a string or a
list of strings, are what is under test.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER
from tests.domains.integrations.conftest import TEAM
from tests.domains.integrations.test_mcp import mint, tool


def _create(client: TestClient, secret: str, **arguments: Any) -> str:
    """Create one issue through the tool and answer its id."""
    body = tool(client, secret, "create_issue", {"team_id": TEAM, "title": "An issue", **arguments}).json()
    assert body["result"]["isError"] is False, body
    return json.loads(body["result"]["content"][0]["text"])["issue_id"]


def _search(client: TestClient, secret: str, **arguments: Any) -> Any:
    """Run the search tool and answer its parsed result."""
    body = tool(client, secret, "search_issues", arguments).json()
    return body["result"]


def test_search_takes_lists_and_the_none_sentinel(client: TestClient, workspace: str, repositories: Any) -> None:
    """A list is any-of, and `none` finds the unassigned issue."""
    secret = mint(repositories, MEMBER, ("issues:write", "issues:read"))
    urgent = _create(client, secret, priority="urgent", assignee_id=MEMBER)
    high = _create(client, secret, priority="high")
    _create(client, secret, priority="low", assignee_id=MEMBER)

    by_priority = json.loads(_search(client, secret, priority=["urgent", "high"])["content"][0]["text"])
    unassigned = json.loads(_search(client, secret, assignee_id="none")["content"][0]["text"])
    mine_urgent = json.loads(_search(client, secret, assignee_id="me", priority="urgent")["content"][0]["text"])

    assert {row["issue_id"] for row in by_priority["issues"]} == {urgent, high}
    assert {row["issue_id"] for row in unassigned["issues"]} == {high}
    assert {row["issue_id"] for row in mine_urgent["issues"]} == {urgent}


def test_search_filters_by_status_category(client: TestClient, workspace: str, repositories: Any) -> None:
    """A category resolves through each team's statuses, and a bad one is a tool error."""
    secret = mint(repositories, MEMBER, ("issues:write", "issues:read"))
    statuses = {row.category: row for row in repositories.team_config.list_statuses(workspace, TEAM)}
    started = _create(client, secret, status_id=statuses["started"].status_id)
    _create(client, secret)

    found = json.loads(_search(client, secret, status_category="started")["content"][0]["text"])
    refused = _search(client, secret, status_category="finished")

    assert {row["issue_id"] for row in found["issues"]} == {started}
    assert refused["isError"] is True
