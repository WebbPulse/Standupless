"""The triage MCP tools: the inbox, its counts, working an issue and the team switch.

Each runs the path the triage routes run, so these hold that an agent sees and
works the inbox exactly as a person does and is refused where a person would be.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_team_member
from tests.domains.integrations.conftest import TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

SCOPES = ("issues:read", "issues:write", "teams:read", "teams:write")


@pytest.fixture(autouse=True)
def standard_plan(repositories: Any, workspace: str) -> None:
    """Triage needs the Standard plan, so every test here runs on it."""
    repositories.workspaces.set_billing(WORKSPACE, plan="standard")


def _file(client: TestClient, secret: str, title: str, **fields: Any) -> dict[str, Any]:
    """File one issue on `TEAM` through the create tool."""
    return answer(tool(client, secret, "create_issue", {"team_id": "ABC", "title": title, **fields}))


def test_a_team_members_new_issue_follows_the_switch(client: TestClient, repositories: Any, workspace: str) -> None:
    """A team member's issue with no status lands in triage while it is on and in the first status while off."""
    add_team_member(repositories, WORKSPACE, TEAM, OWNER, "admin")
    owner = mint_for(repositories, OWNER, SCOPES)

    before = _file(client, owner, "Before")
    answer(tool(client, owner, "update_team_triage_settings", {"team_id": "ABC", "enabled": True}))
    during = _file(client, owner, "During")
    placed = _file(client, owner, "Placed", status_id="Todo")
    answer(tool(client, owner, "update_team_triage_settings", {"team_id": "ABC", "enabled": False}))
    after = _file(client, owner, "After")

    assert before["in_triage"] is False and before["status_id"] != "triage"
    assert during["in_triage"] is True and during["status_id"] == "triage"
    assert placed["in_triage"] is False and placed["status"] == "Todo"
    assert after["in_triage"] is False and after["status"] == before["status"]


def test_create_issue_says_and_does_what_triage_does_to_planned_work(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A member's issue with a project but no status waits in triage, naming Backlog skips it, and the tool says so."""
    add_team_member(repositories, WORKSPACE, TEAM, OWNER, "admin")
    owner = mint_for(repositories, OWNER, (*SCOPES, "projects:read", "projects:write"))
    answer(tool(client, owner, "update_team_triage_settings", {"team_id": "ABC", "enabled": True}))
    project = answer(tool(client, owner, "create_project", {"name": "Launch", "team_ids": [TEAM]}))["project_id"]

    unplaced = _file(client, owner, "Planned", project_id=project)
    placed = _file(client, owner, "Planned too", project_id=project, status_id="Backlog")
    descriptor = TOOLS_BY_NAME["create_issue"].descriptor()

    assert unplaced["in_triage"] is True and unplaced["status_id"] == "triage"
    assert placed["in_triage"] is False and placed["status"] == "Backlog" and placed["project_id"] == project
    assert "waits in triage even when project_id" in descriptor["description"]
    assert "Backlog" in descriptor["description"]
    assert "skips triage" in descriptor["inputSchema"]["properties"]["status_id"]["description"]


def test_the_switch_routes_outside_issues_into_triage(client: TestClient, repositories: Any, workspace: str) -> None:
    """An admin turns triage on, a member outside the team files into it, and get_team says so."""
    add_team_member(repositories, WORKSPACE, TEAM, OWNER, "admin")
    admin = mint_for(repositories, ADMIN, SCOPES)
    member = mint_for(repositories, MEMBER, SCOPES)

    switched = answer(tool(client, admin, "update_team_triage_settings", {"team_id": "ABC", "enabled": True}))
    filed = _file(client, member, "From outside")
    team = answer(tool(client, admin, "get_team", {"team_id": "ABC"}))
    listed = answer(tool(client, admin, "list_triage_issues", {"team_id": "ABC"}))
    summary = answer(tool(client, admin, "get_triage_summary", {}))

    assert switched == {"team_id": TEAM, "enabled": True}
    assert filed["in_triage"] is True
    assert team["triage_settings"] == {"enabled": True}
    assert [row["issue_id"] for row in listed["issues"]] == [filed["issue_id"]]
    assert summary == {"teams": [{"team_id": TEAM, "count": 1}]}


def test_a_member_cannot_flip_the_switch(client: TestClient, repositories: Any, workspace: str) -> None:
    """Changing triage is a team admin's call, as on the route."""
    member = mint_for(repositories, MEMBER, SCOPES)
    assert "may not write" in refusal(
        tool(client, member, "update_team_triage_settings", {"team_id": "ABC", "enabled": True})
    )


def test_triage_issue_works_each_action(client: TestClient, repositories: Any, workspace: str) -> None:
    """Accept, snooze, decline and duplicate each answer the issue as it now stands."""
    add_team_member(repositories, WORKSPACE, TEAM, OWNER, "admin")
    owner = mint_for(repositories, OWNER, SCOPES)
    member = mint_for(repositories, MEMBER, SCOPES)
    answer(tool(client, owner, "update_team_triage_settings", {"team_id": "ABC", "enabled": True}))
    first, second, third, fourth = (_file(client, member, f"Issue {n}") for n in range(4))

    accepted = answer(tool(client, owner, "triage_issue", {"issue_id": first["issue_key"], "action": "accept"}))
    until = (utc_now() + timedelta(days=2)).isoformat()
    snoozed = answer(
        tool(client, owner, "triage_issue", {"issue_id": second["issue_id"], "action": "snooze", "until": until})
    )
    declined = answer(
        tool(client, owner, "triage_issue", {"issue_id": third["issue_id"], "action": "decline", "reason": "No"})
    )
    duplicate = answer(
        tool(
            client,
            owner,
            "triage_issue",
            {"issue_id": fourth["issue_id"], "action": "duplicate", "duplicate_of_id": first["issue_key"]},
        )
    )

    assert accepted["in_triage"] is False and accepted["status"] == "Todo"
    assert snoozed["in_triage"] is True and snoozed["snoozed_until"] is not None
    assert declined["in_triage"] is False and declined["status"] == "Cancelled"
    assert duplicate["in_triage"] is False
    listed = answer(tool(client, owner, "list_triage_issues", {"team_id": "ABC", "snoozed": True}))
    assert [row["issue_id"] for row in listed["issues"]] == [second["issue_id"]]


def test_triage_issue_accept_carries_a_comment(client: TestClient, repositories: Any, workspace: str) -> None:
    """An accept with a comment posts it on the issue as the caller, beside the move."""
    add_team_member(repositories, WORKSPACE, TEAM, OWNER, "admin")
    owner = mint_for(repositories, OWNER, SCOPES)
    member = mint_for(repositories, MEMBER, SCOPES)
    answer(tool(client, owner, "update_team_triage_settings", {"team_id": "ABC", "enabled": True}))
    filed = _file(client, member, "Needs a home")

    accepted = answer(
        tool(
            client,
            owner,
            "triage_issue",
            {"issue_id": filed["issue_key"], "action": "accept", "status_id": "Todo", "comment": "Picked up"},
        )
    )

    assert accepted["in_triage"] is False and accepted["status"] == "Todo"
    comments = repositories.comments.iter_for_issue(WORKSPACE, filed["issue_id"])
    assert [(comment.author_id, comment.body) for comment in comments] == [(OWNER, "Picked up")]


def test_triage_issue_refuses_a_bad_snooze_and_a_settled_issue(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A snooze needs `until`, and an issue not in triage cannot be worked."""
    owner = mint_for(repositories, OWNER, SCOPES)
    settled = _file(client, owner, "Settled")

    assert "until" in refusal(
        tool(client, owner, "triage_issue", {"issue_id": settled["issue_id"], "action": "snooze"})
    )
    assert "not in triage" in refusal(
        tool(client, owner, "triage_issue", {"issue_id": settled["issue_id"], "action": "accept"})
    )


def test_the_switch_needs_a_plan_with_triage(client: TestClient, repositories: Any, workspace: str) -> None:
    """On Free the tool answers the plan refusal and the switch stays off."""
    repositories.workspaces.set_billing(WORKSPACE, plan="free")
    admin = mint_for(repositories, ADMIN, SCOPES)

    refused = refusal(tool(client, admin, "update_team_triage_settings", {"team_id": "ABC", "enabled": True}))

    assert "not included in the Free plan" in refused
    assert "Standard plan" in refused
    assert "PLAN_FEATURE_UNAVAILABLE" in refused
    assert "credential" not in refused
    assert repositories.team_config.get_triage_settings(WORKSPACE, TEAM) is None


def test_triage_reads_and_writes_as_a_status(client: TestClient, repositories: Any, workspace: str) -> None:
    """A waiting issue reports the triage status, and `status_id: triage` files, sends and filters by it."""
    add_team_member(repositories, WORKSPACE, TEAM, OWNER, "admin")
    owner = mint_for(repositories, OWNER, SCOPES)
    answer(tool(client, owner, "update_team_triage_settings", {"team_id": "ABC", "enabled": True}))

    filed = answer(tool(client, owner, "create_issue", {"team_id": "ABC", "title": "Filed", "status_id": "triage"}))
    kept = _file(client, owner, "Kept", status_id="Todo")
    sent = answer(tool(client, owner, "update_issue", {"issue_id": kept["issue_key"], "status_id": "Triage"}))
    read = answer(tool(client, owner, "get_issue", {"issue_id": filed["issue_key"]}))
    listed = answer(tool(client, owner, "list_issues", {"team_id": "ABC", "status_id": "triage"}))
    accepted = answer(tool(client, owner, "update_issue", {"issue_id": filed["issue_key"], "status_id": "Todo"}))

    assert filed["in_triage"] is True and filed["status_id"] == "triage" and filed["status"] == "Triage"
    assert sent["in_triage"] is True and sent["status_id"] == "triage"
    assert read["status_id"] == "triage" and read["status"] == "Triage"
    assert {row["issue_id"] for row in listed["issues"]} == {filed["issue_id"], kept["issue_id"]}
    assert all(row["status_id"] == "triage" and row["in_triage"] for row in listed["issues"])
    assert accepted["in_triage"] is False and accepted["status"] == "Todo"


def test_triage_status_is_refused_where_triage_is_off(client: TestClient, repositories: Any, workspace: str) -> None:
    """A team with triage off has no triage status to name."""
    owner = mint_for(repositories, OWNER, SCOPES)

    refused = refusal(tool(client, owner, "create_issue", {"team_id": "ABC", "title": "A", "status_id": "triage"}))

    assert "triage" in refused
