"""Template sub-issues over MCP: sub_issues on the template tools, and create_issue making them.

An agent saves an issue template with sub-issues the way the settings page does,
and create_issue with that template creates them under the new issue, or only the
ones template_sub_issue_keys names.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER
from tests.domains.integrations.conftest import TEAM
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

SCOPES = ("teams:read", "teams:write", "issues:read", "issues:write")


def _save(client: TestClient, secret: str) -> dict[str, Any]:
    """Save a release template with two sub-issues through the tool and answer it."""
    arguments = {
        "team_id": TEAM,
        "name": "Release",
        "title": "Release",
        "sub_issues": [{"title": "Write notes", "assignee_id": "me"}, {"title": "Tag the build"}],
    }
    return answer(tool(client, secret, "create_template", arguments))


def test_sub_issues_are_saved_and_cleared(client: TestClient, workspace: str, repositories: Any) -> None:
    """sub_issues saves the list with keys and 'me' resolved, and a null on update removes them."""
    secret = mint_for(repositories, MEMBER, SCOPES)

    saved = _save(client, secret)
    cleared = answer(
        tool(client, secret, "update_template", {"team_id": TEAM, "template": "Release", "sub_issues": None})
    )

    assert [item["key"] for item in saved["sub_issues"]] == ["s1", "s2"]
    assert saved["sub_issues"][0]["assignee_id"] == MEMBER
    assert cleared["sub_issues"] == []


def test_create_issue_creates_the_template_sub_issues(client: TestClient, workspace: str, repositories: Any) -> None:
    """Every sub-issue is created under the issue and listed, and the keys argument keeps only some."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    _save(client, secret)

    every = answer(tool(client, secret, "create_issue", {"team_id": TEAM, "template_id": "release"}))
    some = answer(
        tool(
            client,
            secret,
            "create_issue",
            {"team_id": TEAM, "template_id": "release", "template_sub_issue_keys": ["s2"]},
        )
    )
    unknown = refusal(
        tool(
            client,
            secret,
            "create_issue",
            {"team_id": TEAM, "template_id": "release", "template_sub_issue_keys": ["s9"]},
        )
    )

    assert [item["title"] for item in every["sub_issues"]] == ["Write notes", "Tag the build"]
    children = repositories.issues.iter_children(workspace, every["issue_id"])
    assert sorted(child.title for child in children) == ["Tag the build", "Write notes"]
    assert [item["title"] for item in some["sub_issues"]] == ["Tag the build"]
    assert "no sub-issue s9" in unknown
