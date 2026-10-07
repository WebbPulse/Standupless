"""The release MCP tools: an agent records what shipped where as the API does.

Each tool runs the same `app.common.releases` path as its route, so these hold
that a commit reported twice lands on one release, that releases are named by
name as a person would, that only a team administrator changes the pipeline,
and that the tools which lose data say so.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

RELEASES = ("releases:read", "releases:write")


@pytest.mark.parametrize("name", ["remove_issue_from_release", "delete_release"])
def test_destructive_tools_say_so(name: str) -> None:
    """The tools that lose a record carry the destructive hint."""
    descriptor = TOOLS_BY_NAME[name].descriptor()

    assert descriptor["annotations"]["destructiveHint"] is True


@pytest.mark.parametrize("name", ["list_releases", "get_release", "get_release_pipeline"])
def test_reads_take_the_read_scope(name: str) -> None:
    """Reading releases needs only releases:read."""
    assert TOOLS_BY_NAME[name].scopes == ("releases:read",)


def test_one_commit_lands_on_one_release(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Recording a sha twice advances the first release and says it was not new."""
    owner = mint_for(repositories, OWNER, RELEASES)
    stages = [{"name": "Staging", "github_environments": ["staging"]}, {"name": "Production"}]
    answer(tool(client, owner, "set_release_pipeline", {"team_id": "ABC", "stages": stages}))
    secret = mint_for(repositories, MEMBER, RELEASES)
    sha = "c" * 40

    first = answer(
        tool(client, secret, "create_release", {"team_id": "ABC", "sha": sha, "stage": "Staging", "issues": ["ABC-1"]})
    )
    second = answer(tool(client, secret, "create_release", {"team_id": "ABC", "sha": sha, "stage": "Production"}))

    assert first["created"] is True
    assert first["source"] == "api"
    assert [row["key"] for row in first["issues"]] == ["ABC-1"]
    assert second["created"] is False
    assert second["release_id"] == first["release_id"]
    assert second["current_stage"]["name"] == "Production"


def test_a_release_is_named_by_name(client: TestClient, repositories: Any, workspace: str) -> None:
    """An agent names a release the way a person reads it in the list."""
    secret = mint_for(repositories, MEMBER, RELEASES)
    created = answer(tool(client, secret, "create_release", {"team_id": "ABC", "name": "Autumn"}))

    found = answer(tool(client, secret, "get_release", {"team_id": "ABC", "release_id": "autumn"}))
    listed = answer(tool(client, secret, "list_releases", {"team_id": "ABC"}))

    assert found["release_id"] == created["release_id"]
    assert [row["name"] for row in listed["releases"]] == ["Autumn"]
    assert "No release" in refusal(tool(client, secret, "get_release", {"team_id": "ABC", "release_id": "Winter"}))


def test_only_a_team_admin_changes_the_pipeline_or_deletes(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A member records releases; the pipeline and deletes are an administrator's."""
    secret = mint_for(repositories, MEMBER, RELEASES)
    created = answer(tool(client, secret, "create_release", {"team_id": "ABC", "name": "Keep"}))

    refusal(tool(client, secret, "set_release_pipeline", {"team_id": "ABC", "stages": [{"name": "Beta"}]}))
    refusal(tool(client, secret, "delete_release", {"team_id": "ABC", "release_id": created["release_id"]}))

    owner = mint_for(repositories, OWNER, RELEASES)
    deleted = answer(tool(client, owner, "delete_release", {"team_id": "ABC", "release_id": "Keep"}))
    assert deleted["deleted"] is True
    assert repositories.releases.get(WORKSPACE, TEAM, created["release_id"]) is None


def test_a_guest_cannot_reach_a_team_it_is_outside(client: TestClient, repositories: Any, workspace: str) -> None:
    """The other team's releases are as hidden from the guest as the team is."""
    secret = mint_for(repositories, GUEST, RELEASES)

    refusal(tool(client, secret, "list_releases", {"team_id": OTHER_TEAM}))
    refusal(tool(client, secret, "create_release", {"team_id": OTHER_TEAM, "name": "Nope"}))
