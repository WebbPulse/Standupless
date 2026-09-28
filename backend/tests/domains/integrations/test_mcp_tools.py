"""Every MCP tool: its happy path, its scope refusal and its workspace isolation.

Each tool reads and writes through the same `app.common` path its HTTP route runs,
so these tests hold the MCP end of that contract: a tool answers what its route
would to the same caller, refuses before reading when the credential lacks its
scope, and never reaches a row of a workspace other than the one its key is bound
to, even for a person who is a member of both.
"""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.api.schemas.teams import LabelCreate
from app.common.db.dynamo.api_keys import API_KEY_SCOPES, LEGACY_SCOPE_ALIASES
from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import Cycle, Project, ProjectMilestone, cycle_key, milestone_key, project_key
from app.common.db.dynamo.views import SavedView, team_view_key
from app.common.labels import create_label
from app.domains.integrations.mcp.tools import TOOLS, TOOLS_BY_NAME
from app.domains.integrations.mcp.transport import INSUFFICIENT_SCOPE
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OUTSIDER,
    OWNER,
    add_member,
    make_team,
    make_workspace,
)
from tests.domains.integrations.conftest import OTHER_TEAM, OTHER_WORKSPACE, TEAM, WORKSPACE, seed_issue
from tests.domains.integrations.mcp_isolation import ANSWERS_AT_HOME, AREA_ARGUMENTS, AREA_SEEDS
from tests.domains.integrations.test_mcp import tool

FOREIGN_TEAM = "01JB000000000000000000PRJ9"

FOREIGN_ISSUE = "01JB0000000000000000000IS9"

SECRET_WORD = "Classified"


def mint_for(repositories: Any, user_id: str, scopes: tuple[str, ...], tenant_id: str = WORKSPACE) -> str:
    """One API key bound to one workspace, returning its plaintext."""
    from webbpulse.identity.api_keys import mint as mint_key

    return mint_key(
        user_id=user_id,
        tenant_id=tenant_id,
        scopes=scopes,
        name="A tools key",
        store=repositories.api_keys,
        created_by=OWNER,
    ).plaintext


def answer(response: Any) -> Any:
    """The parsed JSON a successful tool call answered."""
    body = response.json()
    assert "error" not in body, body
    assert body["result"]["isError"] is False, body
    return json.loads(body["result"]["content"][0]["text"])


def refusal(response: Any) -> str:
    """The text of a tool call that ran and refused."""
    body = response.json()
    assert "error" not in body, body
    assert body["result"]["isError"] is True, body
    return body["result"]["content"][0]["text"]


def seed_planning(repositories: Any, workspace_id: str, team_id: str, name: str) -> dict[str, str]:
    """One label, cycle, project, milestone and shared view on a team, named `name`."""
    label = create_label(repositories, workspace_id, team_id, LabelCreate(name=f"{name} label", color="#5e6ad2"))
    cycle = Cycle(
        workspace_id=workspace_id,
        planning_key="",
        team_id=team_id,
        name=f"{name} cycle",
        start_date="2026-01-01",
        end_date="2099-12-31",
        created_by=OWNER,
    )
    cycle.planning_key = cycle_key(team_id, cycle.cycle_id)
    repositories.planning.create_cycle(cycle)
    project = Project(
        workspace_id=workspace_id,
        planning_key="",
        team_ids=[team_id],
        name=f"{name} project",
        created_by=OWNER,
    )
    project.planning_key = project_key(project.project_id)
    repositories.planning.create_project(project)
    milestone = ProjectMilestone(
        workspace_id=workspace_id,
        planning_key="",
        project_id=project.project_id,
        name=f"{name} milestone",
        sort_order="V",
        created_by=OWNER,
    )
    milestone.planning_key = milestone_key(project.project_id, milestone.milestone_id)
    repositories.planning.create_milestone(milestone)
    view = SavedView(
        workspace_id=workspace_id,
        view_key="",
        name=f"{name} view",
        team_id=team_id,
        owner_id=OWNER,
    )
    view.view_key = team_view_key(team_id, view.view_id)
    repositories.views.create(view)
    return {
        "label_id": label.label_id,
        "cycle_id": cycle.cycle_id,
        "project_id": project.project_id,
        "milestone_id": milestone.milestone_id,
        "view_id": view.view_id,
    }


@pytest.fixture
def planning(repositories: Any, workspace: str) -> dict[str, str]:
    """The home workspace's planning rows, on the team every role can see."""
    return seed_planning(repositories, workspace, TEAM, "Home")


@pytest.fixture
def foreign(repositories: Any, workspace: str) -> dict[str, str]:
    """A second workspace the owner also belongs to, with one of everything in it.

    Every row carries `SECRET_WORD` in its name, so an answer that leaked any of
    them can be caught by text alone.
    """
    make_workspace(repositories, OTHER_WORKSPACE, "other", OWNER)
    add_member(repositories, OTHER_WORKSPACE, OUTSIDER, "member")
    make_team(repositories, OTHER_WORKSPACE, FOREIGN_TEAM, "OTH")
    issue = seed_issue(repositories, OTHER_WORKSPACE, FOREIGN_TEAM, FOREIGN_ISSUE, "OTH", 1)
    repositories.issues.replace(issue.model_copy(update={"title": f"{SECRET_WORD} issue"}))
    repositories.comments.create(
        build_comment(OTHER_WORKSPACE, FOREIGN_ISSUE, FOREIGN_TEAM, OWNER, f"{SECRET_WORD} comment")
    )
    rows = seed_planning(repositories, OTHER_WORKSPACE, FOREIGN_TEAM, SECRET_WORD)
    for seed in AREA_SEEDS:
        rows.update(seed(repositories, OTHER_WORKSPACE, FOREIGN_TEAM))
    return {"team_id": FOREIGN_TEAM, "issue_id": FOREIGN_ISSUE, **rows}


def test_list_issues_pages_with_a_cursor(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A page of one answers a cursor, and the cursor reaches the next issue."""
    seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS3", "ABC", 2)
    secret = mint_for(repositories, MEMBER, ("issues:read",))

    first = answer(tool(client, secret, "list_issues", {"team_id": TEAM, "limit": 1, "sort": "key_asc"}))
    second = answer(
        tool(
            client,
            secret,
            "list_issues",
            {"team_id": TEAM, "limit": 1, "sort": "key_asc", "cursor": first["next_cursor"]},
        )
    )

    assert [row["issue_key"] for row in first["issues"]] == ["ABC-1"]
    assert [row["issue_key"] for row in second["issues"]] == ["ABC-2"]
    assert second["next_cursor"] is None


def test_list_issues_filters_by_cycle_project_label_and_status(
    client: TestClient, repositories: Any, issue: Issue, planning: dict[str, str]
) -> None:
    """The list filters narrow the same way the HTTP list's do."""
    placed = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS4", "ABC", 2)
    repositories.issues.replace(
        placed.model_copy(
            update={
                "cycle_id": planning["cycle_id"],
                "project_id": planning["project_id"],
                "label_ids": [planning["label_id"]],
            }
        )
    )
    secret = mint_for(repositories, MEMBER, ("issues:read",))

    for arguments in (
        {"cycle_id": planning["cycle_id"]},
        {"project_id": planning["project_id"]},
        {"label_id": [planning["label_id"]]},
        {"status_category": "backlog", "cycle_id": planning["cycle_id"]},
    ):
        found = answer(tool(client, secret, "list_issues", arguments))
        assert [row["issue_id"] for row in found["issues"]] == [placed.issue_id], arguments

    none = answer(tool(client, secret, "list_issues", {"cycle_id": "none"}))
    assert [row["issue_id"] for row in none["issues"]] == [issue.issue_id]


def test_list_my_issues_answers_only_the_callers(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Only issues assigned to the caller come back."""
    mine = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS5", "ABC", 2)
    repositories.issues.replace(mine.model_copy(update={"assignee_id": MEMBER}))
    secret = mint_for(repositories, MEMBER, ("issues:read",))

    found = answer(tool(client, secret, "list_my_issues", {}))

    assert [row["issue_id"] for row in found["issues"]] == [mine.issue_id]


def test_get_issue_reads_by_key(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A key such as ABC-1 resolves to the same issue its id does."""
    secret = mint_for(repositories, MEMBER, ("issues:read",))

    found = answer(tool(client, secret, "get_issue", {"issue_key": "ABC-1"}))

    assert found["issue_id"] == issue.issue_id
    assert found["parent_id"] is None


def test_create_issue_places_it_in_a_cycle_project_and_parent(
    client: TestClient, repositories: Any, issue: Issue, planning: dict[str, str]
) -> None:
    """Create takes the parent by key and the cycle, project and milestone by id."""
    secret = mint_for(repositories, MEMBER, ("issues:write",))

    created = answer(
        tool(
            client,
            secret,
            "create_issue",
            {
                "team_id": TEAM,
                "title": "A child",
                "parent_id": "ABC-1",
                "cycle_id": planning["cycle_id"],
                "project_id": planning["project_id"],
                "project_milestone_id": planning["milestone_id"],
                "assignee_id": "me",
                "label_ids": [planning["label_id"]],
            },
        )
    )

    assert created["issue_id"] != issue.issue_id
    assert created["parent_id"] == issue.issue_id
    assert created["cycle_id"] == planning["cycle_id"]
    assert created["project_milestone_id"] == planning["milestone_id"]
    assert created["assignee_id"] == MEMBER


def test_create_issue_refuses_what_the_route_refuses(client: TestClient, repositories: Any, workspace: str) -> None:
    """A payload the route would 422 is a tool error naming the problem."""
    secret = mint_for(repositories, MEMBER, ("issues:write",))

    blank = refusal(tool(client, secret, "create_issue", {"team_id": TEAM, "title": "   "}))
    unknown_cycle = refusal(tool(client, secret, "create_issue", {"team_id": TEAM, "title": "x", "cycle_id": "nope"}))

    assert "title" in blank
    assert "cycle" in unknown_cycle.lower()


def test_update_issue_sets_and_clears_parent_cycle_and_project(
    client: TestClient, repositories: Any, issue: Issue, planning: dict[str, str]
) -> None:
    """A named field is written, a null clears it, and an absent one is left alone."""
    child = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS6", "ABC", 2)
    secret = mint_for(repositories, MEMBER, ("issues:write",))

    placed = answer(
        tool(
            client,
            secret,
            "update_issue",
            {
                "issue_id": child.issue_id,
                "parent_id": issue.issue_id,
                "cycle_id": planning["cycle_id"],
                "project_id": planning["project_id"],
                "priority": "high",
            },
        )
    )
    cleared = answer(
        tool(
            client,
            secret,
            "update_issue",
            {"issue_id": "ABC-2", "parent_id": None, "cycle_id": None, "project_id": None},
        )
    )

    assert (placed["parent_id"], placed["cycle_id"], placed["project_id"]) == (
        issue.issue_id,
        planning["cycle_id"],
        planning["project_id"],
    )
    assert (cleared["parent_id"], cleared["cycle_id"], cleared["project_id"]) == (None, None, None)
    assert cleared["priority"] == "high"


def test_assign_issue_assigns_and_unassigns(client: TestClient, repositories: Any, issue: Issue) -> None:
    """`me` assigns the caller and a null unassigns."""
    secret = mint_for(repositories, MEMBER, ("issues:write",))

    assigned = answer(tool(client, secret, "assign_issue", {"issue_id": issue.issue_id, "assignee_id": "me"}))
    unassigned = answer(tool(client, secret, "assign_issue", {"issue_id": issue.issue_id, "assignee_id": None}))

    assert assigned["assignee_id"] == MEMBER
    assert unassigned["assignee_id"] is None


def test_archive_and_unarchive_issue(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Archiving hides the issue from list_issues until asked for; unarchiving brings it back."""
    secret = mint_for(repositories, MEMBER, ("issues:read", "issues:write"))

    archived = answer(tool(client, secret, "archive_issue", {"issue_id": "ABC-1"}))
    again = answer(tool(client, secret, "archive_issue", {"issue_id": issue.issue_id}))
    hidden = answer(tool(client, secret, "list_issues", {"team_id": TEAM}))
    shown = answer(tool(client, secret, "list_issues", {"team_id": TEAM, "include_archived": True}))
    found = answer(tool(client, secret, "search_issues", {"team_id": TEAM, "query": issue.title}))
    fetched = answer(tool(client, secret, "get_issue", {"issue_key": "ABC-1"}))
    restored = answer(tool(client, secret, "unarchive_issue", {"issue_id": "ABC-1"}))
    listed = answer(tool(client, secret, "list_issues", {"team_id": TEAM}))

    assert archived["archived_at"] is not None
    assert again["archived_at"] == archived["archived_at"]
    assert issue.issue_id not in {row["issue_id"] for row in hidden["issues"]}
    assert issue.issue_id in {row["issue_id"] for row in shown["issues"]}
    assert issue.issue_id in {row["issue_id"] for row in found["issues"]}
    assert fetched["archived_at"] == archived["archived_at"]
    assert restored["archived_at"] is None
    assert issue.issue_id in {row["issue_id"] for row in listed["issues"]}


def test_include_archived_must_be_a_boolean(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A string where a boolean belongs is refused rather than read as true."""
    secret = mint_for(repositories, MEMBER, ("issues:read",))

    assert "include_archived" in refusal(tool(client, secret, "list_issues", {"include_archived": "yes"}))


def test_comments_add_reply_and_list(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A comment and a reply to it list back in order, the reply naming its parent."""
    secret = mint_for(repositories, MEMBER, ("comments:write", "issues:read"))

    top = answer(tool(client, secret, "add_comment", {"issue_id": "ABC-1", "body": "First"}))
    reply = answer(
        tool(
            client,
            secret,
            "add_comment",
            {"issue_id": issue.issue_id, "body": "Second", "parent_comment_id": top["comment_id"]},
        )
    )
    listed = answer(tool(client, secret, "list_comments", {"issue_id": issue.issue_id}))
    nested = refusal(
        tool(
            client,
            secret,
            "add_comment",
            {"issue_id": issue.issue_id, "body": "Third", "parent_comment_id": reply["comment_id"]},
        )
    )

    assert [row["body"] for row in listed["comments"]] == ["First", "Second"]
    assert listed["comments"][1]["parent_comment_id"] == top["comment_id"]
    assert nested


def test_relations_record_both_directions(client: TestClient, repositories: Any, issue: Issue) -> None:
    """`A blocks B` reads back from B as `blocked_by A`."""
    other = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS7", "ABC", 2)
    secret = mint_for(repositories, MEMBER, ("issues:write", "issues:read"))

    created = answer(
        tool(
            client,
            secret,
            "create_issue_relation",
            {"issue_id": "ABC-1", "type": "blocks", "target_issue_id": "ABC-2"},
        )
    )
    inverse = answer(tool(client, secret, "list_issue_relations", {"issue_id": other.issue_id}))

    assert created["type"] == "blocks"
    assert created["target_issue_key"] == "ABC-2"
    assert [(row["type"], row["target_issue_id"]) for row in inverse["relations"]] == [("blocked_by", issue.issue_id)]


def test_get_team_carries_statuses_labels_and_role(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """One team with everything an agent needs before writing in it."""
    secret = mint_for(repositories, MEMBER, ("teams:read",))

    team = answer(tool(client, secret, "get_team", {"team_id": TEAM}))

    assert team["key_prefix"] == "ABC"
    assert team["caller_role"] == "member"
    assert team["statuses"]
    assert [row["label_id"] for row in team["labels"]] == [planning["label_id"]]


def test_list_teams_and_statuses(client: TestClient, repositories: Any, workspace: str) -> None:
    """The team listing and one team's statuses."""
    secret = mint_for(repositories, MEMBER, ("teams:read",))

    teams = answer(tool(client, secret, "list_teams", {}))
    statuses = answer(tool(client, secret, "list_statuses", {"team_id": TEAM}))

    assert {row["team_id"] for row in teams["teams"]} == {TEAM, OTHER_TEAM}
    assert [row["position"] for row in statuses["statuses"]] == sorted(row["position"] for row in statuses["statuses"])


def test_labels_list_and_create(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """An admin adds a label, a member may not, and the listing carries it."""
    admin = mint_for(repositories, ADMIN, ("issues:write", "teams:read"))
    member = mint_for(repositories, MEMBER, ("issues:write",))

    created = answer(tool(client, admin, "create_label", {"team_id": TEAM, "name": "Bug", "color": "#ff0000"}))
    refused = refusal(tool(client, member, "create_label", {"team_id": TEAM, "name": "Nope", "color": "#00ff00"}))
    listed = answer(tool(client, admin, "list_labels", {"team_id": TEAM}))

    assert created["name"] == "Bug"
    assert "may not write" in refused
    assert {row["name"] for row in listed["labels"]} == {"Bug", "Home label"}


def test_list_users_workspace_and_team(client: TestClient, repositories: Any, workspace: str) -> None:
    """The workspace listing carries every member; a team narrows to its memberships."""
    secret = mint_for(repositories, MEMBER, ("teams:read",))

    everyone = answer(tool(client, secret, "list_users", {}))
    team = answer(tool(client, secret, "list_users", {"team_id": TEAM}))

    assert {row["user_id"] for row in everyone["users"]} == {OWNER, ADMIN, MEMBER, GUEST}
    assert "member@example.com" in {row["email"] for row in everyone["users"]}
    assert [row["user_id"] for row in team["users"]] == [GUEST]


def test_list_views(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """Shared team views are readable, and `mine` leaves them out."""
    secret = mint_for(repositories, MEMBER, ("views:read",))

    everything = answer(tool(client, secret, "list_views", {}))
    mine = answer(tool(client, secret, "list_views", {"scope": "mine"}))

    assert [row["view_id"] for row in everything["views"]] == [planning["view_id"]]
    assert (everything["views"][0]["show_sub_issues"], everything["views"][0]["show_completed"]) == (True, True)
    assert mine["views"] == []


def test_cycles_list_and_get(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """A team's cycles list with derived status, and one reads back by id."""
    secret = mint_for(repositories, MEMBER, ("teams:read",))

    listed = answer(tool(client, secret, "list_cycles", {"team_id": TEAM, "status": "active"}))
    one = answer(tool(client, secret, "get_cycle", {"team_id": TEAM, "cycle_id": planning["cycle_id"]}))

    assert [row["cycle_id"] for row in listed["cycles"]] == [planning["cycle_id"]]
    assert one["status"] == "active"


def test_projects_list_get_and_milestones(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """Projects list, one reads back with its milestones, and milestones list alone."""
    secret = mint_for(repositories, MEMBER, ("teams:read",))

    listed = answer(tool(client, secret, "list_projects", {"team_id": TEAM}))
    one = answer(tool(client, secret, "get_project", {"project_id": planning["project_id"]}))
    milestones = answer(tool(client, secret, "list_project_milestones", {"project_id": planning["project_id"]}))

    assert [row["project_id"] for row in listed["projects"]] == [planning["project_id"]]
    assert [row["milestone_id"] for row in one["milestones"]] == [planning["milestone_id"]]
    assert [row["milestone_id"] for row in milestones["milestones"]] == [planning["milestone_id"]]


def test_projects_create_and_update(client: TestClient, repositories: Any, workspace: str) -> None:
    """A member creates a project on their team and then renames and dates it."""
    secret = mint_for(repositories, MEMBER, ("issues:write",))

    created = answer(tool(client, secret, "create_project", {"name": "Launch", "team_ids": [TEAM]}))
    updated = answer(
        tool(
            client,
            secret,
            "update_project",
            {"project_id": created["project_id"], "name": "Launch v2", "target_date": "2026-12-01", "lead_id": "me"},
        )
    )
    cleared = answer(tool(client, secret, "update_project", {"project_id": created["project_id"], "lead_id": None}))

    assert created["status"] == "backlog"
    assert (updated["name"], updated["target_date"], updated["lead_id"]) == ("Launch v2", "2026-12-01", MEMBER)
    assert cleared["lead_id"] is None


def test_projects_carry_health_priority_look_and_members(client: TestClient, repositories: Any, workspace: str) -> None:
    """The Linear project properties are written and cleared through the tools like the route."""
    secret = mint_for(repositories, MEMBER, ("issues:write",))

    created = answer(
        tool(
            client,
            secret,
            "create_project",
            {
                "name": "Styled",
                "team_ids": [TEAM],
                "icon": "rocket",
                "color": "#A855F7",
                "health": "at_risk",
                "priority": "high",
                "member_ids": ["me"],
            },
        )
    )
    cleared = answer(
        tool(
            client,
            secret,
            "update_project",
            {"project_id": created["project_id"], "health": None, "icon": None, "member_ids": []},
        )
    )
    refused = refusal(tool(client, secret, "create_project", {"name": "Bad", "team_ids": [TEAM], "health": "fine"}))

    assert (created["icon"], created["color"], created["health"], created["priority"]) == (
        "rocket",
        "#a855f7",
        "at_risk",
        "high",
    )
    assert created["member_ids"] == [MEMBER]
    assert (cleared["health"], cleared["icon"], cleared["color"], cleared["member_ids"]) == (None, None, "#a855f7", [])
    assert refused


def test_project_updates_are_posted_and_listed_newest_first(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """Posting through the tool sets the project's health, and the feed reads it back."""
    writer = mint_for(repositories, MEMBER, ("issues:write",))
    reader = mint_for(repositories, MEMBER, ("teams:read",))
    project_id = planning["project_id"]

    first = answer(
        tool(
            client, writer, "create_project_update", {"project_id": project_id, "body": "Kickoff", "health": "on_track"}
        )
    )
    second = answer(
        tool(client, writer, "create_project_update", {"project_id": project_id, "body": "Late", "health": "at_risk"})
    )
    refused = refusal(
        tool(client, writer, "create_project_update", {"project_id": project_id, "body": "x", "health": "fine"})
    )
    listed = answer(tool(client, reader, "list_project_updates", {"project_id": project_id}))

    assert (first["health"], first["author_id"]) == ("on_track", MEMBER)
    assert {row["update_id"] for row in listed["updates"]} == {first["update_id"], second["update_id"]}
    assert listed["updates"][0]["created_at"] >= listed["updates"][1]["created_at"]
    assert repositories.planning.get_project(WORKSPACE, project_id).health == "at_risk"
    assert refused


def test_a_guest_cannot_create_a_project_on_a_team_they_cannot_see(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The guest's membership bounds a project write exactly as it bounds the route."""
    secret = mint_for(repositories, GUEST, ("issues:write",))

    refused = refusal(tool(client, secret, "create_project", {"name": "Nope", "team_ids": [OTHER_TEAM]}))

    assert refused


@pytest.mark.parametrize("name", sorted(TOOLS_BY_NAME))
def test_every_tool_refuses_a_credential_without_its_scope(
    client: TestClient, repositories: Any, workspace: str, name: str
) -> None:
    """A key carrying every scope but the tool's own, and its legacy alias, is refused."""
    needed = TOOLS_BY_NAME[name].scopes
    withheld = set(needed) | {LEGACY_SCOPE_ALIASES[scope] for scope in needed if scope in LEGACY_SCOPE_ALIASES}
    secret = mint_for(repositories, OWNER, tuple(scope for scope in API_KEY_SCOPES if scope not in withheld))

    body = tool(client, secret, name, {}).json()

    assert body["error"]["code"] == INSUFFICIENT_SCOPE
    assert set(needed) <= set(body["error"]["data"]["required"])


def foreign_arguments(name: str, foreign: dict[str, str], home_issue: str) -> dict[str, Any]:
    """Arguments naming the other workspace's rows, one set per tool.

    A tool missing here fails with a `KeyError`, so a new tool cannot skip its
    isolation case.
    """
    team = foreign["team_id"]
    issue = foreign["issue_id"]
    merged: dict[str, dict[str, Any]] = {
        "list_issues": {"team_id": team},
        "list_my_issues": {"team_id": team},
        "search_issues": {"team_id": team, "query": SECRET_WORD},
        "get_issue": {"issue_id": issue},
        "create_issue": {"team_id": team, "title": "Should not land"},
        "update_issue": {"issue_id": issue, "title": "Should not land"},
        "assign_issue": {"issue_id": issue, "assignee_id": "me"},
        "archive_issue": {"issue_id": issue},
        "unarchive_issue": {"issue_id": issue},
        "list_comments": {"issue_id": issue},
        "add_comment": {"issue_id": issue, "body": "Should not land"},
        "list_issue_relations": {"issue_id": issue},
        "create_issue_relation": {"issue_id": home_issue, "type": "blocks", "target_issue_id": issue},
        "list_teams": {},
        "get_team": {"team_id": team},
        "list_statuses": {"team_id": team},
        "list_labels": {"team_id": team},
        "create_label": {"team_id": team, "name": "Should not land", "color": "#000000"},
        "list_users": {"team_id": team},
        "list_views": {"scope": "team", "team_id": team},
        "list_cycles": {"team_id": team},
        "get_cycle": {"team_id": team, "cycle_id": foreign["cycle_id"]},
        "list_projects": {"team_id": team},
        "get_project": {"project_id": foreign["project_id"]},
        "create_project": {"name": "Should not land", "team_ids": [team]},
        "update_project": {"project_id": foreign["project_id"], "name": "Should not land"},
        "list_project_milestones": {"project_id": foreign["project_id"]},
        "list_project_updates": {"project_id": foreign["project_id"]},
        "create_project_update": {
            "project_id": foreign["project_id"],
            "body": "Should not land",
            "health": "off_track",
        },
    }
    for area in AREA_ARGUMENTS:
        merged.update(area(foreign, home_issue))
    return merged[name]


@pytest.mark.parametrize("name", sorted(TOOLS_BY_NAME))
def test_every_tool_stays_inside_its_keys_workspace(
    client: TestClient, repositories: Any, issue: Issue, foreign: dict[str, str], name: str
) -> None:
    """A key bound to one workspace never reads or writes another's rows.

    The owner belongs to both workspaces, so only the key's tenant binding stands
    between the call and the other workspace's rows. Naming those rows answers the
    same not-found an absent id does, and nothing from them appears in the answer.
    """
    secret = mint_for(repositories, OWNER, API_KEY_SCOPES)

    body = tool(client, secret, name, foreign_arguments(name, foreign, issue.issue_id)).json()
    text = body["result"]["content"][0]["text"]

    assert SECRET_WORD not in text
    assert FOREIGN_ISSUE not in text
    if name != "list_teams" and name not in ANSWERS_AT_HOME:
        assert body["result"]["isError"] is True, text

    stored = repositories.issues.get(OTHER_WORKSPACE, FOREIGN_ISSUE)
    assert stored.title == f"{SECRET_WORD} issue"
    assert stored.assignee_id is None
    assert repositories.team_config.list_labels(OTHER_WORKSPACE, FOREIGN_TEAM)[0].name == f"{SECRET_WORD} label"
    projects = repositories.planning.list_projects(OTHER_WORKSPACE)
    assert [row.name for row in projects] == [f"{SECRET_WORD} project"]


@pytest.mark.parametrize(
    "name",
    ["list_issues", "list_my_issues", "search_issues", "list_labels", "list_users", "list_views", "list_projects"],
)
def test_an_unnarrowed_listing_leaks_nothing_from_another_workspace(
    client: TestClient, repositories: Any, issue: Issue, foreign: dict[str, str], name: str
) -> None:
    """A listing with no team named still reads only the key's own workspace."""
    secret = mint_for(repositories, OWNER, API_KEY_SCOPES)

    found = answer(tool(client, secret, name, {"query": SECRET_WORD} if name == "search_issues" else {}))
    text = json.dumps(found)

    assert SECRET_WORD not in text
    assert FOREIGN_TEAM not in text
    assert OUTSIDER not in text


def test_every_tool_has_an_isolation_case() -> None:
    """A new tool must name its foreign arguments, so its isolation is tested too."""
    blank: dict[str, str] = defaultdict(str)
    for row in TOOLS:
        assert isinstance(foreign_arguments(row.name, blank, ""), dict)
