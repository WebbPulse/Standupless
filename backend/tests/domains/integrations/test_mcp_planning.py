"""The planning MCP tools: cycle, milestone, project and project update writes.

Each tool runs the same `app.common` path its planning route runs, so these tests
hold that an agent's key does what the signed-in person could over HTTP and no
more: a member plans a cycle but only a team administrator deletes one, only an
administrator of every team deletes a project, and only an update's author or an
admin edits it. Teams, cycles, projects and milestones are named the way a person
would name them, and every destructive tool says so in its annotations.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import team_writes
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import Cycle, ProjectUpdateRow, cycle_key, project_update_key
from app.common.team_refs import team_not_found_message
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
        "delete_project_link",
        "delete_project",
        "delete_project_update",
        "delete_project_relation",
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
        ("start_cycle_today", ("cycles:write",)),
        ("delete_cycle", ("cycles:write",)),
        ("add_issues_to_cycle", ("issues:write",)),
        ("remove_issues_from_cycle", ("issues:write",)),
        ("create_milestone", ("milestones:write",)),
        ("update_milestone", ("milestones:write",)),
        ("delete_milestone", ("milestones:write",)),
        ("create_project_link", ("projects:write",)),
        ("update_project_link", ("projects:write",)),
        ("delete_project_link", ("projects:write",)),
        ("delete_project", ("projects:write",)),
        ("archive_project", ("projects:write",)),
        ("unarchive_project", ("projects:write",)),
        ("update_project_update", ("projects:write",)),
        ("delete_project_update", ("projects:write",)),
        ("list_project_relations", ("projects:read",)),
        ("create_project_relation", ("projects:write",)),
        ("delete_project_relation", ("projects:write",)),
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

    assert text == team_not_found_message(OTHER_TEAM)


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

    assert text == team_not_found_message(OTHER_TEAM)
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


def test_project_link_tools_add_retitle_and_remove_a_link(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """A link lands on the named project, reads back through get_project, and is named by its URL."""
    secret = mint_for(repositories, MEMBER, PROJECTS)

    created = answer(
        tool(client, secret, "create_project_link", {"project_id": "home project", "url": "https://example.com/spec"})
    )
    assert created["project_id"] == planning["project_id"]
    assert created["title"] is None

    retitled = answer(
        tool(
            client,
            secret,
            "update_project_link",
            {"project_id": "Home project", "link_id": "https://example.com/spec", "title": "Spec"},
        )
    )
    assert retitled["link_id"] == created["link_id"]
    assert retitled["title"] == "Spec"

    project = answer(tool(client, secret, "get_project", {"project_id": planning["project_id"]}))
    assert [(row["title"], row["url"]) for row in project["links"]] == [("Spec", "https://example.com/spec")]

    removed = answer(
        tool(client, secret, "delete_project_link", {"project_id": "Home project", "link_id": created["link_id"]})
    )
    assert removed["deleted"] is True
    assert repositories.planning.list_project_links(WORKSPACE, planning["project_id"]) == []


def test_create_project_link_refuses_a_non_web_url(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """Only http and https URLs are taken, as over HTTP."""
    secret = mint_for(repositories, MEMBER, PROJECTS)

    response = tool(
        client, secret, "create_project_link", {"project_id": planning["project_id"], "url": "javascript:alert(1)"}
    )

    assert response.json()["result"]["isError"] is True
    assert repositories.planning.list_project_links(WORKSPACE, planning["project_id"]) == []


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


def test_archive_project_hides_it_from_list_projects_until_restored(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """An archived project leaves list_projects unless asked for, and a restore brings it back."""
    secret = mint_for(repositories, MEMBER, PROJECTS)

    archived = answer(tool(client, secret, "archive_project", {"project_id": planning["project_id"]}))
    hidden = answer(tool(client, secret, "list_projects", {}))
    shown = answer(tool(client, secret, "list_projects", {"include_archived": True}))
    restored = answer(tool(client, secret, "unarchive_project", {"project_id": planning["project_id"]}))
    listed = answer(tool(client, secret, "list_projects", {}))

    assert archived["archived_at"] is not None
    assert planning["project_id"] not in {row["project_id"] for row in hidden["projects"]}
    assert planning["project_id"] in {row["project_id"] for row in shown["projects"]}
    assert restored["archived_at"] is None
    assert planning["project_id"] in {row["project_id"] for row in listed["projects"]}


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


def test_cycle_and_project_lists_roll_up_only_visible_sub_teams(
    client: TestClient, repositories: Any, planning: dict[str, str], elsewhere: dict[str, str]
) -> None:
    """include_sub_teams adds a public sub-team's cycles and projects and leaves a private one out."""
    team_writes.set_parent(repositories, WORKSPACE, OTHER_TEAM, TEAM)
    secret = mint_for(repositories, MEMBER, ("cycles:read", "projects:read"))
    rolled = {"team_id": TEAM, "include_sub_teams": True}

    def listed() -> tuple[set[str], set[str]]:
        """The cycle and project ids the rolled-up lists answer."""
        cycles = answer(tool(client, secret, "list_cycles", rolled))["cycles"]
        projects = answer(tool(client, secret, "list_projects", rolled))["projects"]
        return {row["cycle_id"] for row in cycles}, {row["project_id"] for row in projects}

    assert listed() == (
        {planning["cycle_id"], elsewhere["cycle_id"]},
        {planning["project_id"], elsewhere["project_id"]},
    )

    repositories.memberships.set_team_private(WORKSPACE, OTHER_TEAM, True)

    assert listed() == ({planning["cycle_id"]}, {planning["project_id"]})


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


def test_update_project_sets_the_update_cadence(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """A project takes its own cadence, null returns it to the workspace default, and list_projects shows due state."""
    secret = mint_for(repositories, MEMBER, PROJECTS)
    project_id = planning["project_id"]

    biweekly = answer(tool(client, secret, "update_project", {"project_id": project_id, "update_interval_days": 14}))
    listed = answer(tool(client, secret, "list_projects", {}))
    inherited = answer(tool(client, secret, "update_project", {"project_id": project_id, "update_interval_days": None}))
    refused = refusal(tool(client, secret, "update_project", {"project_id": project_id, "update_interval_days": 3}))

    assert (biweekly["update_interval_days"], biweekly["update_interval_inherited"]) == (14, False)
    assert biweekly["update_due_state"] == "upcoming"
    assert biweekly["next_update_due_at"] is not None
    [row] = [entry for entry in listed["projects"] if entry["project_id"] == project_id]
    assert row["update_due_state"] == "upcoming"
    assert (inherited["update_interval_days"], inherited["update_interval_inherited"]) == (7, True)
    assert "update_interval_days" in refused
    assert repositories.planning.get_project(WORKSPACE, project_id).update_interval_days is None


def _schedule(repositories: Any) -> dict[str, str]:
    """A previous, current and next cycle of the home team around today, by alias."""
    today = date.today()
    windows = {
        "previous": (today - timedelta(days=20), today - timedelta(days=8)),
        "current": (today - timedelta(days=7), today + timedelta(days=6)),
        "next": (today + timedelta(days=7), today + timedelta(days=20)),
    }
    ids: dict[str, str] = {}
    for alias, (start, end) in windows.items():
        cycle = Cycle(
            workspace_id=WORKSPACE,
            planning_key="",
            team_id=TEAM,
            name=f"{alias.title()} sprint",
            start_date=start.isoformat(),
            end_date=end.isoformat(),
            created_by=OWNER,
        )
        cycle.planning_key = cycle_key(TEAM, cycle.cycle_id)
        repositories.planning.create_cycle(cycle)
        ids[alias] = cycle.cycle_id
    return ids


@pytest.mark.parametrize("alias", ["current", "next", "previous"])
def test_create_and_update_issue_resolve_a_relative_cycle(
    client: TestClient, repositories: Any, issue: Issue, alias: str
) -> None:
    """create_issue and update_issue take current, next and previous as add_issues_to_cycle does."""
    cycles = _schedule(repositories)
    secret = mint_for(repositories, MEMBER, ISSUES)

    created = answer(tool(client, secret, "create_issue", {"team_id": "ABC", "title": "Planned", "cycle_id": alias}))
    updated = answer(tool(client, secret, "update_issue", {"issue_id": "ABC-1", "cycle_id": alias}))

    assert created["cycle_id"] == cycles[alias]
    assert updated["cycle_id"] == cycles[alias]
    assert repositories.issues.get(WORKSPACE, issue.issue_id).cycle_id == cycles[alias]


@pytest.mark.parametrize("alias", ["current", "next", "previous"])
def test_bulk_update_and_add_issues_resolve_a_relative_cycle(
    client: TestClient, repositories: Any, issue: Issue, alias: str
) -> None:
    """bulk_update_issues and add_issues_to_cycle place issues in the same relative cycle."""
    cycles = _schedule(repositories)
    seed_issue(repositories, WORKSPACE, TEAM, SECOND_ISSUE, "ABC", 2)
    secret = mint_for(repositories, MEMBER, ISSUES)

    bulk = answer(tool(client, secret, "bulk_update_issues", {"issue_ids": ["ABC-1"], "cycle_id": alias}))
    added = answer(tool(client, secret, "add_issues_to_cycle", {"cycle_id": alias, "issue_ids": ["ABC-2"]}))

    assert [row["cycle_id"] for row in bulk["issues"]] == [cycles[alias]]
    assert added["cycle_id"] == cycles[alias]
    assert repositories.issues.get(WORKSPACE, SECOND_ISSUE).cycle_id == cycles[alias]


def test_a_relative_cycle_the_team_lacks_is_refused_by_name(
    client: TestClient, repositories: Any, issue: Issue
) -> None:
    """A team with no cycles refuses current, naming the alias and the team."""
    secret = mint_for(repositories, MEMBER, ISSUES)

    created = refusal(tool(client, secret, "create_issue", {"team_id": "ABC", "title": "x", "cycle_id": "current"}))
    added = refusal(tool(client, secret, "add_issues_to_cycle", {"cycle_id": "next", "issue_ids": ["ABC-1"]}))

    assert "Team ABC has no current cycle" in created
    assert "Team ABC has no next cycle" in added


def test_cycle_tools_answer_the_renamed_key(
    client: TestClient, repositories: Any, issue: Issue, planning: dict[str, str]
) -> None:
    """After a team key change, the cycle tools take the old key and answer the new one."""
    seed_issue(repositories, WORKSPACE, TEAM, SECOND_ISSUE, "ABC", 2)
    admin = mint_for(repositories, ADMIN, ("teams:write",))
    answer(tool(client, admin, "update_team", {"team_id": "ABC", "key_prefix": "ALP"}))
    secret = mint_for(repositories, MEMBER, ISSUES)

    added = answer(tool(client, secret, "add_issues_to_cycle", {"cycle_id": "current", "issue_ids": ["ABC-1"]}))
    removed = answer(
        tool(client, secret, "remove_issues_from_cycle", {"cycle_id": "current", "issue_ids": ["ALP-1", "ABC-2"]})
    )

    assert [row["issue_key"] for row in added["issues"]] == ["ALP-1"]
    assert [row["issue_key"] for row in removed["issues"]] == ["ALP-1"]
    assert removed["not_in_cycle"] == ["ALP-2"]


def _open_issue(repositories: Any, project_id: str) -> str:
    """One unstarted issue of TEAM in a project, returning its id."""
    statuses = {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}
    issue = repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            issue_id=SECOND_ISSUE,
            team_id=TEAM,
            key="ABC-7",
            number=7,
            title="Still open",
            status_id=statuses["unstarted"],
            project_id=project_id,
            created_by=OWNER,
        )
    )
    return issue.issue_id


def test_update_project_counts_the_open_issues_a_close_leaves(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """Without a choice the close succeeds and answers the open count."""
    secret = mint_for(repositories, MEMBER, PROJECTS)
    issue_id = _open_issue(repositories, planning["project_id"])

    arguments = {"project_id": planning["project_id"], "status": "completed"}
    closed = answer(tool(client, secret, "update_project", arguments))

    assert closed["status"] == "completed"
    assert closed["open_issue_count"] == 1
    assert repositories.issues.get(WORKSPACE, issue_id).project_id == planning["project_id"]


def test_update_project_moves_the_open_issues_by_project_name(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """A move target is resolved by name as any project reference is."""
    secret = mint_for(repositories, MEMBER, PROJECTS + ISSUES)
    target = seed_planning(repositories, WORKSPACE, TEAM, "Next")
    issue_id = _open_issue(repositories, planning["project_id"])

    moved = answer(
        tool(
            client,
            secret,
            "update_project",
            {
                "project_id": planning["project_id"],
                "status": "completed",
                "open_issues": "move",
                "open_issues_project_id": "Next project",
            },
        )
    )

    assert moved["open_issue_count"] == 0
    assert repositories.issues.get(WORKSPACE, issue_id).project_id == target["project_id"]


def test_update_project_cancels_the_open_issues(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """Each open issue takes its team's canceled status."""
    secret = mint_for(repositories, MEMBER, PROJECTS + ISSUES)
    issue_id = _open_issue(repositories, planning["project_id"])
    cancelled = {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}

    closed = answer(
        tool(
            client,
            secret,
            "update_project",
            {"project_id": planning["project_id"], "status": "canceled", "open_issues": "cancel"},
        )
    )

    assert closed["open_issue_count"] == 0
    assert repositories.issues.get(WORKSPACE, issue_id).status_id == cancelled["cancelled"]


def test_update_project_needs_issue_write_to_sweep_open_issues(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """A key scoped to projects alone may close the project but not rewrite its issues."""
    secret = mint_for(repositories, MEMBER, PROJECTS)
    issue_id = _open_issue(repositories, planning["project_id"])

    refusal(
        tool(
            client,
            secret,
            "update_project",
            {"project_id": planning["project_id"], "status": "canceled", "open_issues": "cancel"},
        )
    )

    assert repositories.planning.get_project(WORKSPACE, planning["project_id"]).status != "canceled"
    assert repositories.issues.get(WORKSPACE, issue_id).project_id == planning["project_id"]


@pytest.mark.parametrize(
    "arguments",
    [
        {"open_issues": "archive"},
        {"open_issues": "move"},
        {"open_issues": "keep", "open_issues_project_id": "Home project"},
        {"open_issues_project_id": "Home project"},
    ],
)
def test_update_project_refuses_a_malformed_open_issues_choice(
    client: TestClient, repositories: Any, planning: dict[str, str], arguments: dict[str, str]
) -> None:
    """An unknown action, a move with no target or a stray target is refused by name."""
    secret = mint_for(repositories, MEMBER, PROJECTS + ISSUES)

    closing = {"project_id": planning["project_id"], "status": "completed", **arguments}
    text = refusal(tool(client, secret, "update_project", closing))

    assert "open_issues" in text


def test_project_dependencies_round_trip_over_mcp(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """An agent links two projects by name, reads the link from both sides and removes it by the other project."""
    secret = mint_for(repositories, MEMBER, PROJECTS)
    second = answer(tool(client, secret, "create_project", {"name": "Second project", "team_ids": [TEAM]}))

    created = answer(
        tool(
            client,
            secret,
            "create_project_relation",
            {"project_id": "Second project", "type": "blocked_by", "target_project_id": "Home project"},
        )
    )
    home = answer(tool(client, secret, "get_project", {"project_id": planning["project_id"]}))
    listed = answer(tool(client, secret, "list_project_relations", {"project_id": planning["project_id"]}))
    looped = refusal(
        tool(
            client,
            secret,
            "create_project_relation",
            {"project_id": "Second project", "type": "blocks", "target_project_id": "Home project"},
        )
    )
    removed = answer(
        tool(
            client,
            secret,
            "delete_project_relation",
            {"project_id": "Home project", "target_project_id": second["project_id"]},
        )
    )

    assert created["type"] == "blocked_by"
    assert home["blocking_project_ids"] == [second["project_id"]]
    assert [(row["type"], row["target_project_id"]) for row in listed["relations"]] == [
        ("blocks", second["project_id"])
    ]
    assert looped
    assert removed["relation_id"] == created["relation_id"]
    assert answer(tool(client, secret, "list_project_relations", {"project_id": "Home project"}))["relations"] == []


def test_list_projects_filters_by_blocked_and_blocking(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """list_projects takes the projects page's blocked and blocking filters and refuses a non boolean."""
    secret = mint_for(repositories, MEMBER, PROJECTS)
    second = answer(tool(client, secret, "create_project", {"name": "Second project", "team_ids": [TEAM]}))
    answer(
        tool(
            client,
            secret,
            "create_project_relation",
            {"project_id": "Second project", "type": "blocked_by", "target_project_id": "Home project"},
        )
    )

    def listed(arguments: dict[str, Any]) -> set[str]:
        """The project ids list_projects answers for these arguments."""
        return {row["project_id"] for row in answer(tool(client, secret, "list_projects", arguments))["projects"]}

    assert listed({"is_blocked": True}) == {second["project_id"]}
    assert listed({"is_blocking": True}) == {planning["project_id"]}
    assert listed({"is_blocked": False, "is_blocking": False}) == set()
    assert "is_blocked" in refusal(tool(client, secret, "list_projects", {"is_blocked": "yes"}))


def test_project_dates_round_trip_their_resolution(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """create_project and update_project take a resolution beside each date and answer it with a label."""
    secret = mint_for(repositories, MEMBER, PROJECTS)

    created = answer(
        tool(
            client,
            secret,
            "create_project",
            {
                "team_ids": [TEAM],
                "name": "Roadmap",
                "start_date": "2026-11-20",
                "start_date_resolution": "month",
                "target_date": "2027-02-01",
                "target_date_resolution": "half",
            },
        )
    )
    updated = answer(
        tool(client, secret, "update_project", {"project_id": created["project_id"], "target_date": "2027-03-03"})
    )
    fetched = answer(tool(client, secret, "get_project", {"project_id": created["project_id"]}))

    assert (created["start_date"], created["start_date_label"]) == ("2026-11-01", "Nov 2026")
    assert (created["target_date"], created["target_date_resolution"]) == ("2027-06-30", "half")
    assert created["target_date_label"] == "H1 2027"
    assert (updated["target_date"], updated["target_date_resolution"]) == ("2027-03-03", "day")
    assert fetched["start_date_resolution"] == "month"
