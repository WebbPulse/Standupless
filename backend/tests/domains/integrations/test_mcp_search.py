"""The `search_issues` tool's filters, which are the HTTP issue list's own.

Held through the transport so the argument shapes an agent sends, a string or a
list of strings, are what is under test.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from webbpulse.dynamodb import new_ulid

from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import MEMBER, OWNER
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


def test_create_issue_names_possible_duplicates(client: TestClient, workspace: str, repositories: Any) -> None:
    """An open issue sharing the new title's terms comes back, and the new issue never names itself."""
    from app.common.db.dynamo.search_index import tokenize

    secret = mint(repositories, MEMBER, ("issues:write", "issues:read"))
    first = _create(client, secret, title="Login redirect broken on Safari")
    repositories.search_index.apply(
        workspace, TEAM, first, appeared=tokenize("Login redirect broken on Safari"), departed=set()
    )

    body = tool(client, secret, "create_issue", {"team_id": TEAM, "title": "Login redirect fails"}).json()
    created = json.loads(body["result"]["content"][0]["text"])

    assert [row["issue_id"] for row in created["possible_duplicates"]] == [first]
    assert created["possible_duplicates"][0]["issue_key"]
    assert created["possible_duplicates"][0]["status"]


def _seed_many(repositories: Any, workspace: str, count: int, oldest_title: str) -> str:
    """Put `count` issues straight into one team, numbered upwards, and answer the oldest's id."""
    statuses = repositories.team_config.list_statuses(workspace, TEAM)
    oldest = ""
    for number in range(1, count + 1):
        issue_id = new_ulid()
        repositories.issues.create(
            Issue(
                workspace_id=workspace,
                issue_id=issue_id,
                team_id=TEAM,
                key=f"ABC-{number}",
                number=number,
                title=oldest_title if number == 1 else f"Routine chore {number}",
                status_id=statuses[0].status_id,
                created_by=OWNER,
            )
        )
        if number == 1:
            oldest = issue_id
    return oldest


def test_search_finds_an_issue_older_than_the_newest_fifty(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The team is walked past its first page, so the first issue of a large team is found."""
    oldest = _seed_many(repositories, workspace, 60, "Quarterly zebra audit")
    secret = mint(repositories, MEMBER, ("issues:read",))

    found = json.loads(_search(client, secret, query="zebra")["content"][0]["text"])

    assert [row["issue_id"] for row in found["issues"]] == [oldest]
    assert found["next_cursor"] is None


def test_search_resumes_with_a_cursor_when_the_scan_budget_stops_it(
    client: TestClient, workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A spent budget answers a cursor, and following it reaches the oldest match."""
    from app.common import issue_writes

    monkeypatch.setattr(issue_writes, "TEAM_SCAN_BUDGET", 4)
    oldest = _seed_many(repositories, workspace, 10, "Quarterly zebra audit")
    secret = mint(repositories, MEMBER, ("issues:read",))

    seen: "list[str]" = []
    cursor = None
    for _ in range(10):
        arguments: "dict[str, Any]" = {"query": "zebra"}
        if cursor:
            arguments["cursor"] = cursor
        page = json.loads(_search(client, secret, **arguments)["content"][0]["text"])
        seen.extend(row["issue_id"] for row in page["issues"])
        cursor = page["next_cursor"]
        if not cursor:
            break

    assert seen == [oldest]
    assert cursor is None


def test_search_finds_an_issue_by_its_key(client: TestClient, workspace: str, repositories: Any) -> None:
    """A query equal to a key, in any case, answers that issue, as Linear's search does."""
    secret = mint(repositories, MEMBER, ("issues:write", "issues:read"))
    wanted = _create(client, secret, title="Cache the token")
    _create(client, secret, title="Something else")
    key = repositories.issues.get(workspace, wanted).key

    exact = json.loads(_search(client, secret, query=key)["content"][0]["text"])
    lowered = json.loads(_search(client, secret, query=key.lower())["content"][0]["text"])

    assert [row["issue_id"] for row in exact["issues"]] == [wanted]
    assert [row["issue_id"] for row in lowered["issues"]] == [wanted]
