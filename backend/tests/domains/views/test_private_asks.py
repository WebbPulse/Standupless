"""Private asks in search and on the board.

A private ask is read only by its requester and its team's explicit members, so
a search hit or a board card for it reaches them and nobody else, a workspace
owner or admin included, whether the search is by words or by its key.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, make_private, sign_in
from tests.domains.views.conftest import TEAM, seed_issue
from tests.domains.views.test_search import index_issue


@pytest.fixture
def private_ask(issues_client: TestClient, workspace: str, repositories: Any, statuses: Any) -> "dict[str, Any]":
    """One indexed private ask in `TEAM`, filed by `MEMBER`; `GUEST` is the team's explicit member."""
    sign_in(issues_client, MEMBER)
    created = seed_issue(issues_client, workspace, title="Confidential widget payroll", team_id=TEAM)
    index_issue(repositories, workspace, TEAM, created)
    make_private(repositories, workspace, created["id"])
    return created


def _search_ids(client: TestClient, workspace: str, query: str) -> "list[str]":
    """The issue ids a workspace search answers."""
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": query})
    assert response.status_code == 200, response.text
    return [row["issue_id"] for row in response.json()["results"]]


def _board_ids(client: TestClient, workspace: str) -> "set[str]":
    """Every card id on the team's board."""
    response = client.get(f"/api/workspaces/{workspace}/board", params={"team_id": TEAM})
    assert response.status_code == 200, response.text
    return {row["id"] for column in response.json()["columns"] for row in column["issues"]}


@pytest.mark.parametrize("subject", [OWNER, ADMIN])
def test_search_and_the_board_skip_it_for_everyone_else(
    client: TestClient, workspace: str, private_ask: Any, subject: str
) -> None:
    """Neither a word search, a key search nor the board shows an outsider the ask."""
    sign_in(client, subject)
    assert _search_ids(client, workspace, "widget") == []
    assert _search_ids(client, workspace, private_ask["key"]) == []
    assert private_ask["id"] not in _board_ids(client, workspace)
    assert "Confidential" not in json.dumps(
        client.get(f"/api/workspaces/{workspace}/board", params={"team_id": TEAM}).json()
    )


@pytest.mark.parametrize("subject", [MEMBER, GUEST])
def test_search_and_the_board_show_it_to_the_requester_and_team_members(
    client: TestClient, workspace: str, private_ask: Any, subject: str
) -> None:
    """The person who asked and the team's explicit members find the ask the usual ways."""
    sign_in(client, subject)
    assert _search_ids(client, workspace, "widget") == [private_ask["id"]]
    assert private_ask["id"] in _search_ids(client, workspace, private_ask["key"])
    assert private_ask["id"] in _board_ids(client, workspace)
