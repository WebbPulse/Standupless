"""MCP tools under a key restricted to some teams of its workspace.

The tools read through the same `AuthzContext` the REST routes do, so the
restriction carried on the key has to survive the MCP endpoint's own context
resolution. These tests name rows in a team outside the key and hold that each
tool refuses them as not found, and that a listing with no team named leaves
them out, while the listed team keeps answering.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.api_keys import API_KEY_SCOPES, TEAM_IDS_METADATA
from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import MEMBER, OWNER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_issue
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, refusal, seed_planning

SECRET_WORD = "Restricted"

HIDDEN_ISSUE = "01JB0000000000000000000IS8"


def mint_restricted(repositories: Any, team_ids: list[str]) -> str:
    """A member key carrying every scope, limited to `team_ids`, answering its plaintext."""
    from webbpulse.identity.api_keys import mint as mint_key

    return mint_key(
        user_id=MEMBER,
        tenant_id=WORKSPACE,
        scopes=API_KEY_SCOPES,
        name="A team key",
        store=repositories.api_keys,
        created_by=MEMBER,
        metadata={TEAM_IDS_METADATA: team_ids},
    ).plaintext


@pytest.fixture
def hidden(repositories: Any, issue: Issue) -> dict[str, str]:
    """Rows in `OTHER_TEAM`, each named with `SECRET_WORD`, beside the home issue in `TEAM`."""
    row = seed_issue(repositories, WORKSPACE, OTHER_TEAM, HIDDEN_ISSUE, "XYZ", 1)
    repositories.issues.replace(row.model_copy(update={"title": f"{SECRET_WORD} issue"}))
    repositories.comments.create(build_comment(WORKSPACE, HIDDEN_ISSUE, OTHER_TEAM, OWNER, f"{SECRET_WORD} comment"))
    rows = seed_planning(repositories, WORKSPACE, OTHER_TEAM, SECRET_WORD)
    return {"team_id": OTHER_TEAM, "issue_id": HIDDEN_ISSUE, **rows}


def hidden_arguments(name: str, hidden: dict[str, str], home_issue: str) -> dict[str, Any]:
    """Arguments naming the rows outside the key, one set per team-scoped tool."""
    team = hidden["team_id"]
    issue = hidden["issue_id"]
    project = hidden["project_id"]
    return {
        "list_issues": {"team_id": team},
        "search_issues": {"team_id": team, "query": SECRET_WORD},
        "get_issue": {"issue_id": issue},
        "create_issue": {"team_id": team, "title": "Should not land"},
        "update_issue": {"issue_id": issue, "title": "Should not land"},
        "assign_issue": {"issue_id": issue, "assignee_id": "me"},
        "archive_issue": {"issue_id": issue},
        "list_comments": {"issue_id": issue},
        "add_comment": {"issue_id": issue, "body": "Should not land"},
        "list_issue_activity": {"issue_id": issue},
        "create_issue_relation": {"issue_id": home_issue, "type": "blocks", "target_issue_id": issue},
        "get_team": {"team_id": team},
        "list_statuses": {"team_id": team},
        "list_labels": {"team_id": team},
        "create_label": {"team_id": team, "name": "Should not land", "color": "#000000"},
        "list_views": {"scope": "team", "team_id": team},
        "list_cycles": {"team_id": team},
        "get_cycle": {"team_id": team, "cycle_id": hidden["cycle_id"]},
        "get_project": {"project_id": project},
        "update_project": {"project_id": project, "name": "Should not land"},
        "create_project": {"name": "Should not land", "team_ids": [team]},
    }[name]


@pytest.mark.parametrize(
    "name",
    [
        "list_issues",
        "search_issues",
        "get_issue",
        "create_issue",
        "update_issue",
        "assign_issue",
        "archive_issue",
        "list_comments",
        "add_comment",
        "list_issue_activity",
        "create_issue_relation",
        "get_team",
        "list_statuses",
        "list_labels",
        "create_label",
        "list_views",
        "list_cycles",
        "get_cycle",
        "get_project",
        "update_project",
        "create_project",
    ],
)
def test_a_tool_refuses_a_team_outside_the_key(
    client: TestClient, repositories: Any, issue: Issue, hidden: dict[str, str], name: str
) -> None:
    """Naming a row in a team the key does not list is refused, leaks nothing and writes nothing."""
    secret = mint_restricted(repositories, [TEAM])

    text = refusal(tool(client, secret, name, hidden_arguments(name, hidden, issue.issue_id)))

    assert SECRET_WORD not in text
    stored = repositories.issues.get(WORKSPACE, HIDDEN_ISSUE)
    assert stored.title == f"{SECRET_WORD} issue"
    assert stored.assignee_id is None
    assert stored.archived_at is None
    names = {row.name for row in repositories.planning.list_projects(WORKSPACE)}
    assert "Should not land" not in names


@pytest.mark.parametrize("name", ["list_issues", "list_my_issues", "search_issues", "list_projects", "list_teams"])
def test_an_unnarrowed_listing_leaves_out_the_other_teams(
    client: TestClient, repositories: Any, issue: Issue, hidden: dict[str, str], name: str
) -> None:
    """A listing with no team named fans out over the key's teams alone."""
    secret = mint_restricted(repositories, [TEAM])

    found = answer(tool(client, secret, name, {"query": SECRET_WORD} if name == "search_issues" else {}))
    text = json.dumps(found)

    assert SECRET_WORD not in text
    assert OTHER_TEAM not in text
    assert HIDDEN_ISSUE not in text


def test_the_listed_team_keeps_answering(
    client: TestClient, repositories: Any, issue: Issue, hidden: dict[str, str]
) -> None:
    """The team the key lists answers as it would to an unrestricted key."""
    secret = mint_restricted(repositories, [TEAM])

    teams = answer(tool(client, secret, "list_teams", {}))
    found = answer(tool(client, secret, "get_issue", {"issue_key": "ABC-1"}))
    listed = answer(tool(client, secret, "list_issues", {"team_id": TEAM}))

    assert [row["team_id"] for row in teams["teams"]] == [TEAM]
    assert found["issue_id"] == issue.issue_id
    assert [row["issue_id"] for row in listed["issues"]] == [issue.issue_id]
