"""The planning MCP tools: cycle, milestone, project and project update writes.

Each tool runs the same `app.common` path its planning route runs, so these tests
hold that an agent's key does what the signed-in person could over HTTP and no
more: a member plans a cycle but only a team administrator deletes one, only an
administrator of every team deletes a project, and only an update's author or an
admin edits it. Teams, cycles, projects and milestones are named the way a person
would name them, and every destructive tool says so in its annotations.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import ProjectUpdateRow, project_update_key
from app.domains.integrations.mcp.toolkit import NOT_VISIBLE
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_issue
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal, seed_planning

CYCLES = ("cycles:read", "cycles:write")

MILESTONES = ("projects:read", "milestones:read", "milestones:write")

PROJECTS = ("projects:read", "projects:write")

ISSUES = ("issues:read", "issues:write", "cycles:read")

SECOND_ISSUE = "01JB0000000000000000000IS5"


@pytest.fixture
def planning(repositories: Any, workspace: str) -> dict[str, str]:
    """The home workspace's planning rows on the team every role can see."""
    return seed_planning(repositories, workspace, TEAM, "Home")


@pytest.fixture
def elsewhere(repositories: Any, workspace: str) -> dict[str, str]:
    """Planning rows on the team the guest holds no membership in."""
    return seed_planning(repositories, workspace, OTHER_TEAM, "Other")


def post_update(repositories: Any, project_id: str, author_id: str, health: str = "on_track") -> str:
    """One status update on a project by one author, returning its id."""
    update = ProjectUpdateRow(
        workspace_id=WORKSPACE,
        planning_key="",
        project_id=project_id,
        body="Shipping on schedule",
        health=health,
        author_id=author_id,
    )
    update.planning_key = project_update_key(project_id, update.update_id)
    repositories.planning.create_project_update(update)
    return update.update_id


@pytest.mark.parametrize(
    "name",
    [
        "delete_cycle",
        "remove_issues_from_cycle",
        "delete_milestone",
        "delete_project",
        "delete_project_update",
    ],
)
def test_destructive_tools_say_so(name: str) -> None:
    """Every tool that loses data carries the destructive hint and says what is lost."""
    descriptor = TOOLS_BY_NAME[name].descriptor()

    assert descriptor["annotations"]["destructiveHint"] is True
    assert descriptor["annotations"]["readOnlyHint"] is False


@pytest.mark.parametrize(
    ("name", "scopes"),
    [
        ("create_cycle", ("cycles:write",)),
        ("update_cycle", ("cycles:write",)),
        ("delete_cycle", ("cycles:write",)),
        ("add_issues_to_cycle", ("issues:write",)),
        ("remove_issues_from_cycle", ("issues:write",)),
        ("create_milestone", ("milestones:write",)),
        ("update_milestone", ("milestones:write",)),
        ("delete_milestone", ("milestones:write",)),
        ("delete_project", ("projects:write",)),
        ("update_project_update", ("projects:write",)),
        ("delete_project_update", ("projects:write",)),
    ],
)
def test_each_tool_takes_its_routes_scope(name: str, scopes: tuple[str, ...]) -> None:
    """A tool's scopes are exactly those its REST route requires."""
    assert TOOLS_BY_NAME[name].scopes == scopes


def test_create_cycle_accepts_a_team_key(client: TestClient, repositories: Any, workspace: str) -> None:
    """A member plans a cycle on a team named by its key prefix."""
    secret = mint_for(repositories, MEMBER, CYCLES)

    created = answer(
        tool(
            client,
            secret,
            "create_cycle",
            {
                "team_id": "ABC",
                "name": "Sprint 1",
                "start_date": "2026-10-01",
                "end_date": "2026-10-14",
                "goal": "Ship",
            },
        )
    )

    assert created["team_id"] == TEAM
    assert created["goal"] == "Ship"
    assert repositories.planning.get_cycle(WORKSPACE, TEAM, created["cycle_id"]).name == "Sprint 1"


def test_create_cycle_refuses_a_guest_outside_the_team(client: TestClient, repositories: Any, workspace: str) -> None:
    """A guest cannot plan on a team it does not belong to, and learns nothing of it."""
    secret = mint_for(repositories, GUEST, CYCLES)

    text = refusal(
        tool(
            client,
            secret,
            "create_cycle",
            {"team_id": OTHER_TEAM, "name": "Sprint", "start_date": "2026-10-01", "end_date": "2026-10-14"},
        )
    )

    assert text == NOT_VISIBLE


def test_create_cycle_refuses_an_end_before_its_start(client: TestClient, repositories: Any, workspace: str) -> None:
    """The route's date rule holds for a tool call too."""
    secret = mint_for(repositories, MEMBER, CYCLES)

    refusal(
        tool(
            client,
            secret,
            "create_cycle",
            {"team_id": TEAM, "name": "Backwards", "start_date": "2026-10-14", "end_date": "2026-10-01"},
        )
    )


def test_update_cycle_finds_the_cycle_by_name(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """A cycle named by its name is patched, and a null goal clears it."""
    secret = mint_for(repositories, MEMBER, CYCLES)

    updated = answer(
        tool(
            client,
            secret,
            "update_cycle",
            {"team_id": "abc", "cycle_id": "home cycle", "name": "Renamed", "goal": None, "cancelled": True},
        )
    )

    assert updated["cycle_id"] == planning["cycle_id"]
    assert updated["name"] == "Renamed"
    assert updated["cancelled"] is True
    assert updated["goal"] is None


def test_update_cycle_accepts_current(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """`current` names the team's active cycle."""
    secret = mint_for(repositories, MEMBER, CYCLES)

    updated = answer(tool(client, secret, "update_cycle", {"team_id": TEAM, "cycle_id": "current", "goal": "Focus"}))

    assert updated["cycle_id"] == planning["cycle_id"]
    assert updated["goal"] == "Focus"


def test_update_cycle_refuses_a_guest_outside_the_team(
    client: TestClient, repositories: Any, elsewhere: dict[str, str]
) -> None:
    """A guest cannot reach a cycle of a team it does not belong to."""
    secret = mint_for(repositories, GUEST, CYCLES)

    text = refusal(
        tool(client, secret, "update_cycle", {"team_id": OTHER_TEAM, "cycle_id": elsewhere["cycle_id"], "name": "No"})
    )

    assert text == NOT_VISIBLE
    assert repositories.planning.get_cycle(WORKSPACE, OTHER_TEAM, elsewhere["cycle_id"]).name == "Other cycle"


def test_delete_cycle_needs_a_team_admin(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """A plain member is refused as the route refuses, and an admin deletes by name."""
    refused = refusal(
        tool(
            client,
            mint_for(repositories, MEMBER, CYCLES),
            "delete_cycle",
            {"team_id": TEAM, "cycle_id": planning["cycle_id"]},
        )
    )
    deleted = answer(
        tool(
            client, mint_for(repositories, ADMIN, CYCLES), "delete_cycle", {"team_id": "ABC", "cycle_id": "Home cycle"}
        )
    )

    assert refused.startswith("This credential may not write there")
    assert deleted == {"deleted": True, "cycle_id": planning["cycle_id"], "team_id": TEAM}
    assert repositories.planning.get_cycle(WORKSPACE, TEAM, planning["cycle_id"]) is None


def test_add_issues_to_cycle_accepts_issue_keys(
    client: TestClient, repositories: Any, issue: Issue, planning: dict[str, str]
) -> None:
    """Issues named by key join a cycle named by name, the team inferred from the issues."""
    seed_issue(repositories, WORKSPACE, TEAM, SECOND_ISSUE, "ABC", 2)
    secret = mint_for(repositories, MEMBER, ISSUES)

    moved = answer(
        tool(client, secret, "add_issues_to_cycle", {"cycle_id": "Home cycle", "issue_ids": ["ABC-1", "abc-2"]})
    )

    assert moved["cycle_id"] == planning["cycle_id"]
    assert sorted(row["issue_key"] for row in moved["issues"]) == ["ABC-1", "ABC-2"]
    assert repositories.issues.get(WORKSPACE, issue.issue_id).cycle_id == planning["cycle_id"]
    assert repositories.issues.get(WORKSPACE, SECOND_ISSUE).cycle_id == planning["cycle_id"]


def test_add_issues_to_cycle_refuses_a_guest_outside_the_team(
    client: TestClient, repositories: Any, workspace: str, elsewhere: dict[str, str]
) -> None:
    """A guest cannot name an issue on a team it does not belong to."""
    seed_issue(repositories, WORKSPACE, OTHER_TEAM, SECOND_ISSUE, "XYZ", 1)
    secret = mint_for(repositories, GUEST, ISSUES)

    text = refusal(
        tool(client, secret, "add_issues_to_cycle", {"cycle_id": elsewhere["cycle_id"], "issue_ids": ["XYZ-1"]})
    )

    assert text == NOT_VISIBLE
    assert repositories.issues.get(WORKSPACE, SECOND_ISSUE).cycle_id is None


def test_add_issues_to_cycle_refuses_a_cycle_of_another_team(
    client: TestClient, repositories: Any, issue: Issue, elsewhere: dict[str, str]
) -> None:
    """A cycle belongs to one team, so an issue of another cannot join it."""
    secret = mint_for(repositories, MEMBER, ISSUES)

    refusal(
        tool(
            client,
            secret,
            "add_issues_to_cycle",
            {"team_id": "XYZ", "cycle_id": elsewhere["cycle_id"], "issue_ids": ["ABC-1"]},
        )
    )

    assert repositories.issues.get(WORKSPACE, issue.issue_id).cycle_id is None


def test_remove_issues_from_cycle_leaves_other_issues_alone(
    client: TestClient, repositories: Any, issue: Issue, planning: dict[str, str]
) -> None:
    """Only issues in the named cycle are taken out; the rest are reported untouched."""
    repositories.issues.replace(issue.model_copy(update={"cycle_id": planning["cycle_id"]}))
    seed_issue(repositories, WORKSPACE, TEAM, SECOND_ISSUE, "ABC", 2)
    secret = mint_for(repositories, MEMBER, ISSUES)

    removed = answer(
        tool(client, secret, "remove_issues_from_cycle", {"cycle_id": "current", "issue_ids": ["ABC-1", "ABC-2"]})
    )

    assert [row["issue_key"] for row in removed["issues"]] == ["ABC-1"]
    assert removed["not_in_cycle"] == ["ABC-2"]
    assert repositories.issues.get(WORKSPACE, issue.issue_id).cycle_id is None


def test_remove_issues_from_cycle_refuses_a_guest_outside_the_team(
    client: TestClient, repositories: Any, workspace: str, elsewhere: dict[str, str]
) -> None:
    """A guest cannot take an issue of a team it does not belong to out of a cycle."""
    placed = seed_issue(repositories, WORKSPACE, OTHER_TEAM, SECOND_ISSUE, "XYZ", 1)
    repositories.issues.replace(placed.model_copy(update={"cycle_id": elsewhere["cycle_id"]}))
    secret = mint_for(repositories, GUEST, ISSUES)

    text = refusal(
        tool(client, secret, "remove_issues_from_cycle", {"cycle_id": elsewhere["cycle_id"], "issue_ids": ["XYZ-1"]})
    )

    assert text == NOT_VISIBLE
    assert repositories.issues.get(WORKSPACE, SECOND_ISSUE).cycle_id == elsewhere["cycle_id"]


def test_create_milestone_accepts_a_project_name(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """A milestone lands after the project's last one, the project named by name."""
    secret = mint_for(repositories, MEMBER, MILESTONES)

    created = answer(
        tool(
            client,
            secret,
            "create_milestone",
            {"project_id": "home project", "name": "Beta", "target_date": "2026-11-01"},
        )
    )

    assert created["project_id"] == planning["project_id"]
    names = [row.name for row in repositories.planning.list_milestones(WORKSPACE, planning["project_id"])]
    assert names == ["Home milestone", "Beta"]


def test_create_milestone_refuses_a_guest_outside_the_project(
    client: TestClient, repositories: Any, elsewhere: dict[str, str]
) -> None:
    """A guest cannot see a project on a team it does not belong to, by id or by name."""
    secret = mint_for(repositories, GUEST, MILESTONES)

    by_id = refusal(tool(client, secret, "create_milestone", {"project_id": elsewhere["project_id"], "name": "No"}))
    by_name = refusal(tool(client, secret, "create_milestone", {"project_id": "Other project", "name": "No"}))

    assert by_id == by_name == NOT_VISIBLE


def test_update_milestone_accepts_names(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """A milestone named by name within a project named by name is renamed and redated."""
    secret = mint_for(repositories, MEMBER, MILESTONES)

    updated = answer(
        tool(
            client,
            secret,
            "update_milestone",
            {"project_id": "Home project", "milestone_id": "home milestone", "name": "GA", "target_date": "2026-12-01"},
        )
    )

    assert updated["milestone_id"] == planning["milestone_id"]
    assert updated["name"] == "GA"
    assert updated["target_date"] == "2026-12-01"


def test_update_milestone_refuses_a_guest_outside_the_project(
    client: TestClient, repositories: Any, elsewhere: dict[str, str]
) -> None:
    """A guest cannot rename a milestone of a project it cannot see."""
    secret = mint_for(repositories, GUEST, MILESTONES)

    text = refusal(
        tool(
            client,
            secret,
            "update_milestone",
            {"project_id": elsewhere["project_id"], "milestone_id": elsewhere["milestone_id"], "name": "No"},
        )
    )

    assert text == NOT_VISIBLE


def test_delete_milestone_accepts_names(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """A project editor deletes a milestone named by name."""
    secret = mint_for(repositories, MEMBER, MILESTONES)

    deleted = answer(
        tool(client, secret, "delete_milestone", {"project_id": "Home project", "milestone_id": "Home milestone"})
    )

    assert deleted["milestone_id"] == planning["milestone_id"]
    assert repositories.planning.list_milestones(WORKSPACE, planning["project_id"]) == []


def test_delete_milestone_refuses_a_guest_outside_the_project(
    client: TestClient, repositories: Any, elsewhere: dict[str, str]
) -> None:
    """A guest cannot delete a milestone of a project it cannot see."""
    secret = mint_for(repositories, GUEST, MILESTONES)

    text = refusal(
        tool(
            client,
            secret,
            "delete_milestone",
            {"project_id": elsewhere["project_id"], "milestone_id": elsewhere["milestone_id"]},
        )
    )

    assert text == NOT_VISIBLE
    assert len(repositories.planning.list_milestones(WORKSPACE, elsewhere["project_id"])) == 1


def test_delete_project_needs_a_team_admin(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """A plain member is refused as the route refuses; an admin deletes the project by name with its milestones."""
    refused = refusal(
        tool(client, mint_for(repositories, MEMBER, PROJECTS), "delete_project", {"project_id": planning["project_id"]})
    )
    deleted = answer(
        tool(client, mint_for(repositories, OWNER, PROJECTS), "delete_project", {"project_id": "Home Project"})
    )

    assert refused.startswith("This credential may not write there")
    assert deleted == {"deleted": True, "project_id": planning["project_id"]}
    assert repositories.planning.get_project(WORKSPACE, planning["project_id"]) is None
    assert repositories.planning.list_milestones(WORKSPACE, planning["project_id"]) == []


def test_a_project_name_shared_by_two_projects_is_ambiguous(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """A name that matches two visible projects asks for the id instead of guessing."""
    seed_planning(repositories, WORKSPACE, OTHER_TEAM, "Home")
    secret = mint_for(repositories, OWNER, PROJECTS)

    text = refusal(tool(client, secret, "delete_project", {"project_id": "Home project"}))

    assert "pass its id" in text
    assert len(repositories.planning.list_projects(WORKSPACE)) == 2


def test_update_project_update_by_its_author(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """The author edits an update on a project named by name, and the newest health moves the project."""
    update_id = post_update(repositories, planning["project_id"], MEMBER)
    secret = mint_for(repositories, MEMBER, PROJECTS)

    edited = answer(
        tool(
            client,
            secret,
            "update_project_update",
            {"project_id": "Home project", "update_id": update_id, "body": "Slipping", "health": "at_risk"},
        )
    )

    assert edited["body"] == "Slipping"
    assert edited["can_edit"] is True
    assert edited["edited_at"] is not None
    assert repositories.planning.get_project(WORKSPACE, planning["project_id"]).health == "at_risk"


def test_update_project_update_refuses_another_member(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """A member who did not write the update and administers no team may not edit it."""
    update_id = post_update(repositories, planning["project_id"], ADMIN)
    secret = mint_for(repositories, MEMBER, PROJECTS)

    text = refusal(
        tool(
            client,
            secret,
            "update_project_update",
            {"project_id": planning["project_id"], "update_id": update_id, "body": "Rewritten"},
        )
    )

    assert text.startswith("This credential may not write there")
    assert repositories.planning.get_project_update(WORKSPACE, planning["project_id"], update_id).body != "Rewritten"


def test_delete_project_update_as_an_admin(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """An admin deletes someone else's update on a project named by name."""
    update_id = post_update(repositories, planning["project_id"], MEMBER)
    secret = mint_for(repositories, ADMIN, PROJECTS)

    deleted = answer(
        tool(client, secret, "delete_project_update", {"project_id": "home project", "update_id": update_id})
    )

    assert deleted == {"deleted": True, "update_id": update_id, "project_id": planning["project_id"]}
    assert repositories.planning.get_project_update(WORKSPACE, planning["project_id"], update_id) is None


def test_delete_project_update_refuses_another_member(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """A member may not delete an update another person wrote."""
    update_id = post_update(repositories, planning["project_id"], ADMIN)
    secret = mint_for(repositories, MEMBER, PROJECTS)

    text = refusal(
        tool(client, secret, "delete_project_update", {"project_id": planning["project_id"], "update_id": update_id})
    )

    assert text.startswith("This credential may not write there")
    assert repositories.planning.get_project_update(WORKSPACE, planning["project_id"], update_id) is not None


def test_existing_reads_accept_a_team_key_and_a_project_name(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """The read tools take the same human identifiers the writes do."""
    secret = mint_for(repositories, MEMBER, ("cycles:read", "projects:read", "milestones:read"))

    cycles = answer(tool(client, secret, "list_cycles", {"team_id": "ABC"}))
    cycle = answer(tool(client, secret, "get_cycle", {"team_id": "ABC", "cycle_id": "current"}))
    project = answer(tool(client, secret, "get_project", {"project_id": "Home project"}))
    milestones = answer(tool(client, secret, "list_project_milestones", {"project_id": "Home project"}))

    assert [row["cycle_id"] for row in cycles["cycles"]] == [planning["cycle_id"]]
    assert cycle["cycle_id"] == planning["cycle_id"]
    assert project["project_id"] == planning["project_id"]
    assert [row["milestone_id"] for row in milestones["milestones"]] == [planning["milestone_id"]]
