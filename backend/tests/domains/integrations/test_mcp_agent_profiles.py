"""The agent profile tools: save, restore, list, roll back and delete over MCP.

A profile belongs to the person behind the key, so these hold that another member
or an admin of the same workspace reaches none of it, that the same person reaches
it from a key bound to another workspace, and that a workspace key is refused.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.api_keys import service_subject
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_workspace
from tests.domains.integrations.conftest import OTHER_WORKSPACE, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

READ_WRITE = ("settings:read", "settings:write")

FILES = [
    {"root": "home", "path": ".claude/CLAUDE.md", "content": "# Global rules\n"},
    {"root": "memory", "path": "MEMORY.md", "content": "- [Rule](rule.md)\n"},
]


def test_a_profile_saves_restores_and_rolls_back(client: TestClient, repositories: Any, workspace: str) -> None:
    secret = mint_for(repositories, MEMBER, READ_WRITE)

    first = answer(tool(client, secret, "save_agent_profile", {"name": "laptop", "files": FILES, "note": "one"}))
    changed = [{**FILES[0], "content": "# Global rules\nUpdated.\n"}, FILES[1]]
    second = answer(tool(client, secret, "save_agent_profile", {"name": "laptop", "files": changed}))
    latest = answer(tool(client, secret, "get_agent_profile", {"name": "laptop"}))
    older = answer(tool(client, secret, "get_agent_profile", {"name": "laptop", "version": 1}))
    listed = answer(tool(client, secret, "list_agent_profiles"))
    versions = answer(tool(client, secret, "list_agent_profile_versions", {"name": "laptop"}))

    assert (first["version"], second["version"]) == (1, 2)
    assert latest["version"] == 2
    assert latest["files"][0]["content"].endswith("Updated.\n")
    assert older["files"][0]["content"] == "# Global rules\n"
    assert set(latest["roots"]) == {"home", "project", "memory"}
    assert [row["name"] for row in listed["profiles"]] == ["laptop"]
    assert [row["version"] for row in versions["versions"]] == [2, 1]


def test_a_credential_in_a_file_is_refused_by_file_and_line(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    secret = mint_for(repositories, MEMBER, READ_WRITE)
    value = "ghp_" + "Q" * 36
    files = [{"root": "project", "path": "CLAUDE.md", "content": f"intro\ntoken {value}\n"}]

    text = refusal(tool(client, secret, "save_agent_profile", {"name": "laptop", "files": files}))

    assert "project:CLAUDE.md line 2" in text
    assert value not in text
    assert answer(tool(client, secret, "list_agent_profiles"))["profiles"] == []


def test_another_member_and_an_admin_reach_none_of_it(client: TestClient, repositories: Any, workspace: str) -> None:
    mine = mint_for(repositories, MEMBER, READ_WRITE)
    answer(tool(client, mine, "save_agent_profile", {"name": "laptop", "files": FILES}))

    for person in (OWNER, ADMIN):
        theirs = mint_for(repositories, person, READ_WRITE)

        assert answer(tool(client, theirs, "list_agent_profiles"))["profiles"] == []
        assert "laptop" in refusal(tool(client, theirs, "get_agent_profile", {"name": "laptop"}))
        refusal(tool(client, theirs, "delete_agent_profile", {"name": "laptop"}))

    assert answer(tool(client, mine, "get_agent_profile", {"name": "laptop"}))["version"] == 1


def test_the_same_person_reaches_it_from_another_workspace(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    make_workspace(repositories, OTHER_WORKSPACE, "elsewhere", OWNER)
    add_member(repositories, OTHER_WORKSPACE, MEMBER, "member")
    here = mint_for(repositories, MEMBER, READ_WRITE)
    there = mint_for(repositories, MEMBER, READ_WRITE, tenant_id=OTHER_WORKSPACE)
    answer(tool(client, here, "save_agent_profile", {"name": "laptop", "files": FILES}))

    restored = answer(tool(client, there, "get_agent_profile", {"name": "laptop"}))

    assert [item["path"] for item in restored["files"]] == [".claude/CLAUDE.md", "MEMORY.md"]


def test_a_workspace_key_keeps_no_profile(client: TestClient, repositories: Any, workspace: str) -> None:
    secret = mint_for(repositories, service_subject(WORKSPACE), READ_WRITE)

    text = refusal(tool(client, secret, "save_agent_profile", {"name": "laptop", "files": FILES}))

    assert "workspace key" in text


def test_delete_removes_every_version(client: TestClient, repositories: Any, workspace: str) -> None:
    secret = mint_for(repositories, MEMBER, READ_WRITE)
    answer(tool(client, secret, "save_agent_profile", {"name": "laptop", "files": FILES}))

    removed = answer(tool(client, secret, "delete_agent_profile", {"name": "laptop"}))

    assert removed == {"deleted": "laptop", "versions_removed": 1}
    assert answer(tool(client, secret, "list_agent_profiles"))["profiles"] == []
