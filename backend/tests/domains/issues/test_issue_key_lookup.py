"""The batch key lookup the issue chips in a body read their titles and statuses from.

One request answers every key a description, comment or document mentions, so a
body with twenty mentions costs one read rather than twenty. Keys that name
nothing the caller may see are left out instead of failing the batch.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common import issue_keys
from tests.domains.helpers import MEMBER, OWNER, add_member, add_team_member, sign_in, sign_out
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


def _lookup(client: TestClient, workspace: str, *keys: str) -> Any:
    """The lookup's response for these keys, in the order given."""
    return client.get(f"/api/workspaces/{workspace}/issues/by-keys", params=[("key", key) for key in keys])


def test_several_keys_answer_in_one_read(client: TestClient, workspace: str, statuses: Any) -> None:
    """Keys across teams, in any case, each answer their issue once."""
    sign_in(client, OWNER)
    first = create_issue(client, workspace, title="First")
    other = create_issue(client, workspace, team_id=OTHER_TEAM, title="Other")

    response = _lookup(client, workspace, "ABC-1", "xyz-1", "abc-1")

    assert response.status_code == 200, response.text
    assert sorted(issue["id"] for issue in response.json()["issues"]) == sorted([first["id"], other["id"]])
    assert response.json()["resolved"] == {"ABC-1": first["id"], "XYZ-1": other["id"]}


def test_a_retired_prefix_resolves_to_the_issue_under_its_current_key(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A key written before a prefix change still names its issue, which answers with the new key."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)
    repositories.teams.change_key_prefix(workspace, TEAM, "NEW")
    issue_keys.clear()

    body = _lookup(client, workspace, "ABC-1").json()

    assert body["resolved"] == {"ABC-1": created["id"]}
    assert [issue["key"] for issue in body["issues"]] == ["NEW-1"]


def test_unknown_and_malformed_keys_are_left_out(client: TestClient, workspace: str, statuses: Any) -> None:
    """A key naming no team, no issue or nothing at all does not fail the batch."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)

    response = _lookup(client, workspace, "ABC-1", "ABC-99", "NOPE-1", "UTF-8x")

    assert response.status_code == 200, response.text
    assert [issue["id"] for issue in response.json()["issues"]] == [created["id"]]


def test_a_deleted_issue_is_left_out(client: TestClient, workspace: str, statuses: Any) -> None:
    """An issue in the trash draws no chip."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)
    assert client.delete(f"/api/workspaces/{workspace}/issues/{created['id']}").status_code in (200, 204)

    response = _lookup(client, workspace, created["key"])

    assert response.status_code == 200, response.text
    assert response.json()["issues"] == []


def test_an_issue_in_a_team_the_caller_cannot_see_is_left_out(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """A private team's issue answers nothing to someone outside the team."""
    insider = "user-lookup-insider"
    add_member(repositories, workspace, insider, "member")
    add_team_member(repositories, workspace, OTHER_TEAM, insider, "member")
    sign_in(client, insider)
    hidden = create_issue(client, workspace, team_id=OTHER_TEAM, title="Private")
    repositories.memberships.set_team_private(workspace, OTHER_TEAM, True)
    sign_out(client)

    sign_in(client, MEMBER)
    response = _lookup(client, workspace, hidden["key"])

    assert response.status_code == 200, response.text
    assert response.json()["issues"] == []


def test_a_lookup_needs_at_least_one_key_and_at_most_a_hundred(
    client: TestClient, workspace: str, statuses: Any
) -> None:
    """An empty batch and an oversized one are refused rather than read."""
    sign_in(client, OWNER)

    assert _lookup(client, workspace).status_code == 422
    assert _lookup(client, workspace, *[f"ABC-{index}" for index in range(1, 102)]).status_code == 422
