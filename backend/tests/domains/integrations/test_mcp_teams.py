"""The team, member, status and label MCP tools: writes held to the routes' own rules.

Each write runs the `app.common` path its REST route runs and the route's own
capability check, so these tests hold that a tool succeeds where the route would,
refuses a lower role with the route's outcome, and takes the human identifiers a
person writes: a team key or name, an email or `me`, a status or label name.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import team_purge
from app.common.api.schemas.teams import LabelCreate
from app.common.labels import create_label
from app.common.team_refs import team_not_found_message
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from app.domains.integrations.mcp.transport import INSUFFICIENT_SCOPE
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, OWNER, add_team_member
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

NOT_VISIBLE = "Not found, or not visible to this credential"

FORBIDDEN = "may not write"


@pytest.mark.parametrize(
    "name",
    ["remove_team_member", "leave_team", "delete_status", "delete_label", "delete_team"],
)
def test_destructive_tools_carry_the_hint(name: str) -> None:
    """Every tool that removes something tells the client to ask first."""
    assert TOOLS_BY_NAME[name].descriptor()["annotations"]["destructiveHint"] is True


def test_create_team_makes_the_caller_admin_and_seeds_statuses(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A member creates a team, lands as its admin, and the prefix then reads by key."""
    secret = mint_for(repositories, MEMBER, ("teams:write", "teams:read"))

    created = answer(tool(client, secret, "create_team", {"name": "Platform", "key_prefix": "PLT"}))
    read = answer(tool(client, secret, "get_team", {"team_id": "PLT"}))

    assert created["caller_role"] == "admin"
    assert created["statuses"]
    assert read["team_id"] == created["team_id"]
    assert read["caller_role"] == "admin"


def test_create_team_refuses_a_guest_and_a_taken_prefix(client: TestClient, repositories: Any, workspace: str) -> None:
    """A guest may not create a team, and a prefix in use is the route's conflict."""
    guest = mint_for(repositories, GUEST, ("teams:write",))
    member = mint_for(repositories, MEMBER, ("teams:write",))

    assert FORBIDDEN in refusal(tool(client, guest, "create_team", {"name": "Nope", "key_prefix": "NOP"}))
    assert "in use" in refusal(tool(client, member, "create_team", {"name": "Dup", "key_prefix": "ABC"}))
    assert "key_prefix" in refusal(tool(client, member, "create_team", {"name": "Bad", "key_prefix": "abc"}))


def test_update_team_by_name_and_key(client: TestClient, repositories: Any, workspace: str) -> None:
    """A workspace admin renames a team by its name and moves its prefix by its key."""
    secret = mint_for(repositories, ADMIN, ("teams:write",))

    renamed = answer(tool(client, secret, "update_team", {"team_id": "Abc", "name": "Alpha"}))
    moved = answer(tool(client, secret, "update_team", {"team_id": "abc", "key_prefix": "ALP"}))

    assert renamed["name"] == "Alpha"
    assert moved["key_prefix"] == "ALP"
    assert moved["retired_key_prefixes"] == ["ABC"]
    assert repositories.teams.get(WORKSPACE, TEAM).key_prefix == "ALP"


def test_update_team_turns_pull_request_label_sync_off_and_on(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The label sync setting reads back from the tool and lands on the team row."""
    secret = mint_for(repositories, ADMIN, ("teams:write",))

    off = answer(tool(client, secret, "update_team", {"team_id": "ABC", "sync_pr_labels": False}))
    assert off["sync_pr_labels"] is False
    assert repositories.teams.get(WORKSPACE, TEAM).sync_pr_labels is False

    on = answer(tool(client, secret, "update_team", {"team_id": "ABC", "sync_pr_labels": True}))
    assert on["sync_pr_labels"] is True


def test_update_team_sets_the_estimate_settings(client: TestClient, repositories: Any, workspace: str) -> None:
    """The scale and its three toggles read back from the tool and land on the team row."""
    secret = mint_for(repositories, ADMIN, ("teams:write",))

    updated = answer(
        tool(
            client,
            secret,
            "update_team",
            {
                "team_id": "ABC",
                "estimate_scale": "exponential",
                "estimate_extended": True,
                "estimate_allow_zero": True,
                "estimate_count_unestimated": True,
            },
        )
    )

    assert updated["estimate_scale"] == "exponential"
    assert updated["estimate_extended"] is True
    assert updated["estimate_allow_zero"] is True
    assert updated["estimate_count_unestimated"] is True
    team = repositories.teams.get(WORKSPACE, TEAM)
    assert team.estimate_scale == "exponential"
    assert team.estimate_count_unestimated is True


def test_update_team_holds_the_route_roles(client: TestClient, repositories: Any, workspace: str) -> None:
    """A member is refused as the route refuses, a guest outside the team sees nothing."""
    member = mint_for(repositories, MEMBER, ("teams:write",))
    guest = mint_for(repositories, GUEST, ("teams:write",))

    assert FORBIDDEN in refusal(tool(client, member, "update_team", {"team_id": "ABC", "name": "No"}))
    assert refusal(tool(client, guest, "update_team", {"team_id": "XYZ", "name": "No"})) == team_not_found_message(
        "XYZ"
    )
    assert repositories.teams.get(WORKSPACE, TEAM).name == "Abc"


def test_a_team_admin_membership_lifts_a_member(client: TestClient, repositories: Any, workspace: str) -> None:
    """An explicit team admin membership is what the route honours, so the tool does too."""
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "admin")
    secret = mint_for(repositories, MEMBER, ("teams:write",))

    updated = answer(tool(client, secret, "update_team", {"team_id": TEAM, "description": "Core"}))

    assert updated["description"] == "Core"


def test_delete_team_is_idempotent_and_destructive() -> None:
    """A repeat delete changes nothing further, and the client is told to ask first."""
    annotations = TOOLS_BY_NAME["delete_team"].descriptor()["annotations"]

    assert annotations["destructiveHint"] is True
    assert annotations["idempotentHint"] is True
    assert annotations["readOnlyHint"] is False
    assert "Permanently delete" in TOOLS_BY_NAME["delete_team"].description


def test_delete_team_runs_the_route_path(
    client: TestClient, repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A workspace admin deletes a team by key: it is hidden, its rows purged, the chain started."""
    started: list[tuple[str, str]] = []
    monkeypatch.setattr(team_purge, "start", lambda workspace_id, team_id: started.append((workspace_id, team_id)))
    secret = mint_for(repositories, ADMIN, ("teams:write", "teams:read", "admin"))

    deleted = answer(tool(client, secret, "delete_team", {"team_id": "abc"}))
    listed = answer(tool(client, secret, "list_teams"))
    again = refusal(tool(client, secret, "delete_team", {"team_id": TEAM}))

    assert deleted == {"deleted": True, "team_id": TEAM, "name": "Abc", "key_prefix": "ABC"}
    assert started == [(WORKSPACE, TEAM)]
    assert repositories.teams.get(WORKSPACE, TEAM) is None
    assert repositories.team_config.list_statuses(WORKSPACE, TEAM) == []
    assert repositories.memberships.list_team_members(WORKSPACE, TEAM) == []
    assert [row["team_id"] for row in listed["teams"]] == [OTHER_TEAM]
    assert again == team_not_found_message(TEAM)


def test_delete_team_holds_the_route_roles(client: TestClient, repositories: Any, workspace: str) -> None:
    """A team admin or guest never holds a live `admin`, so only an owner or admin may delete."""
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "admin")
    member = mint_for(repositories, MEMBER, ("teams:write", "admin"))
    guest = mint_for(repositories, GUEST, ("teams:write", "admin"))
    owner = mint_for(repositories, OWNER, ("teams:write", "admin"))

    for secret in (member, guest):
        body = tool(client, secret, "delete_team", {"team_id": "ABC"}).json()
        assert body["error"]["code"] == INSUFFICIENT_SCOPE
    assert repositories.teams.get(WORKSPACE, TEAM) is not None
    assert answer(tool(client, owner, "delete_team", {"team_id": "XYZ"}))["deleted"] is True
    assert repositories.teams.get(WORKSPACE, OTHER_TEAM) is None


def test_delete_team_needs_the_admin_scope(client: TestClient, repositories: Any, workspace: str) -> None:
    """Without `admin` beside `teams:write` the credential is refused before the tool runs."""
    secret = mint_for(repositories, ADMIN, ("teams:write",))

    body = tool(client, secret, "delete_team", {"team_id": "ABC"}).json()

    assert body["error"]["code"] == INSUFFICIENT_SCOPE
    assert repositories.teams.get(WORKSPACE, TEAM) is not None


def test_cycle_settings_enable_and_create_cycles(client: TestClient, repositories: Any, workspace: str) -> None:
    """Turning cycles on saves the settings and creates the due cycles at once."""
    admin = mint_for(repositories, ADMIN, ("teams:write", "teams:read"))
    member = mint_for(repositories, MEMBER, ("teams:write",))

    saved = answer(
        tool(client, admin, "update_team_cycle_settings", {"team_id": "ABC", "enabled": True, "duration_weeks": 2})
    )
    team = answer(tool(client, admin, "get_team", {"team_id": "ABC"}))
    refused = refusal(tool(client, member, "update_team_cycle_settings", {"team_id": "ABC", "enabled": False}))

    assert (saved["enabled"], saved["duration_weeks"]) == (True, 2)
    assert team["cycle_settings"]["enabled"] is True
    assert repositories.planning.list_cycles(WORKSPACE, TEAM)
    assert FORBIDDEN in refused


def test_archive_settings_set_and_validate(client: TestClient, repositories: Any, workspace: str) -> None:
    """The period is one of the route's choices, and a member may not change it."""
    admin = mint_for(repositories, ADMIN, ("teams:write", "teams:read"))
    member = mint_for(repositories, MEMBER, ("teams:write",))

    saved = answer(tool(client, admin, "update_team_archive_settings", {"team_id": "Abc", "period_months": 3}))
    invalid = refusal(tool(client, admin, "update_team_archive_settings", {"team_id": "ABC", "period_months": 4}))
    refused = refusal(tool(client, member, "update_team_archive_settings", {"team_id": "ABC", "period_months": 1}))
    team = answer(tool(client, admin, "get_team", {"team_id": TEAM}))

    assert saved["period_months"] == 3
    assert "period_months" in invalid
    assert FORBIDDEN in refused
    assert team["archive_settings"]["period_months"] == 3


def test_sla_settings_set_clear_and_validate(client: TestClient, repositories: Any, workspace: str) -> None:
    """An admin turns SLAs on and clears a rule with null; hours are bounded and members are refused."""
    admin = mint_for(repositories, ADMIN, ("teams:write", "teams:read"))
    member = mint_for(repositories, MEMBER, ("teams:write",))

    saved = answer(
        tool(
            client,
            admin,
            "update_team_sla_settings",
            {"team_id": "ABC", "enabled": True, "medium_hours": 120, "high_hours": None},
        )
    )
    invalid = refusal(tool(client, admin, "update_team_sla_settings", {"team_id": "ABC", "urgent_hours": 0}))
    refused = refusal(tool(client, member, "update_team_sla_settings", {"team_id": "ABC", "enabled": False}))
    team = answer(tool(client, admin, "get_team", {"team_id": TEAM}))

    assert (saved["enabled"], saved["urgent_hours"]) == (True, 24)
    assert (saved["high_hours"], saved["medium_hours"]) == (None, 120)
    assert "urgent_hours" in invalid
    assert FORBIDDEN in refused
    assert team["sla_settings"]["medium_hours"] == 120


def test_auto_close_settings_set_clear_and_validate(client: TestClient, repositories: Any, workspace: str) -> None:
    """The period is one of the route's choices, the status must be cancelled, and a member may not change it."""
    admin = mint_for(repositories, ADMIN, ("teams:write", "teams:read"))
    member = mint_for(repositories, MEMBER, ("teams:write",))
    cancelled = next(
        row for row in repositories.team_config.list_statuses(WORKSPACE, TEAM) if row.category == "cancelled"
    )
    backlog = next(row for row in repositories.team_config.list_statuses(WORKSPACE, TEAM) if row.category == "backlog")

    saved = answer(
        tool(
            client,
            admin,
            "update_team_auto_close_settings",
            {"team_id": "ABC", "period_months": 3, "status": cancelled.name},
        )
    )
    team = answer(tool(client, admin, "get_team", {"team_id": TEAM}))
    invalid = refusal(tool(client, admin, "update_team_auto_close_settings", {"team_id": "ABC", "period_months": 4}))
    open_status = refusal(
        tool(client, admin, "update_team_auto_close_settings", {"team_id": "ABC", "status": backlog.status_id})
    )
    refused = refusal(tool(client, member, "update_team_auto_close_settings", {"team_id": "ABC", "period_months": 1}))
    cleared = answer(tool(client, admin, "update_team_auto_close_settings", {"team_id": "ABC", "period_months": None}))

    assert (saved["enabled"], saved["period_months"], saved["status_id"]) == (True, 3, cancelled.status_id)
    assert team["auto_close_settings"]["period_months"] == 3
    assert "period_months" in invalid
    assert "cancelled" in open_status
    assert FORBIDDEN in refused
    assert (cleared["enabled"], cleared["period_months"], cleared["status_id"]) == (False, None, cancelled.status_id)


def test_list_team_members_by_key(client: TestClient, repositories: Any, workspace: str) -> None:
    """A guest reads the members of its own team and nothing of another."""
    secret = mint_for(repositories, GUEST, ("members:read",))

    members = answer(tool(client, secret, "list_team_members", {"team_id": "ABC"}))

    assert [row["user_id"] for row in members["members"]] == [GUEST]
    assert refusal(tool(client, secret, "list_team_members", {"team_id": "XYZ"})) == team_not_found_message("XYZ")


def test_add_and_update_team_member_by_email(client: TestClient, repositories: Any, workspace: str) -> None:
    """An admin adds a member by email, promotes them, and outsiders are the route's 400."""
    secret = mint_for(repositories, ADMIN, ("members:write",))

    added = answer(tool(client, secret, "add_team_member", {"team_id": "XYZ", "user": "member@example.com"}))
    promoted = answer(
        tool(client, secret, "update_team_member_role", {"team_id": "XYZ", "user": MEMBER, "role": "admin"})
    )
    outsider = refusal(tool(client, secret, "add_team_member", {"team_id": "XYZ", "user": "outsider@example.com"}))
    absent = refusal(
        tool(client, secret, "update_team_member_role", {"team_id": "XYZ", "user": GUEST, "role": "admin"})
    )

    assert (added["user_id"], added["role"]) == (MEMBER, "member")
    assert promoted["role"] == "admin"
    assert "not a member of this workspace" in outsider
    assert absent == NOT_VISIBLE
    assert repositories.memberships.get_team_membership(WORKSPACE, OTHER_TEAM, OUTSIDER) is None


def test_member_writes_refuse_a_non_admin(client: TestClient, repositories: Any, workspace: str) -> None:
    """A member cannot add, promote or remove anyone, exactly as the routes refuse."""
    secret = mint_for(repositories, MEMBER, ("members:write",))

    assert FORBIDDEN in refusal(tool(client, secret, "add_team_member", {"team_id": "ABC", "user": "me"}))
    assert FORBIDDEN in refusal(
        tool(client, secret, "update_team_member_role", {"team_id": "ABC", "user": GUEST, "role": "admin"})
    )
    assert FORBIDDEN in refusal(tool(client, secret, "remove_team_member", {"team_id": "ABC", "user": GUEST}))
    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, GUEST) is not None


def test_remove_team_member_and_the_last_admin(client: TestClient, repositories: Any, workspace: str) -> None:
    """An admin removes a guest by email, and the team's only admin cannot be removed."""
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "admin")
    secret = mint_for(repositories, ADMIN, ("members:write",))

    removed = answer(tool(client, secret, "remove_team_member", {"team_id": "ABC", "user": "guest@example.com"}))
    last = refusal(tool(client, secret, "remove_team_member", {"team_id": "ABC", "user": MEMBER}))
    demote = refusal(
        tool(client, secret, "update_team_member_role", {"team_id": "ABC", "user": MEMBER, "role": "member"})
    )

    assert removed["user_id"] == GUEST
    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, GUEST) is None
    assert "at least one admin" in last
    assert "at least one admin" in demote


def test_join_and_leave_team(client: TestClient, repositories: Any, workspace: str) -> None:
    """A member joins a team by name and leaves it; a guest cannot join a team it cannot see."""
    member = mint_for(repositories, MEMBER, ("members:write",))
    guest = mint_for(repositories, GUEST, ("members:write",))

    joined = answer(tool(client, member, "join_team", {"team_id": "Xyz"}))
    again = answer(tool(client, member, "join_team", {"team_id": "XYZ"}))
    left = answer(tool(client, member, "leave_team", {"team_id": "XYZ"}))
    not_in = refusal(tool(client, member, "leave_team", {"team_id": "XYZ"}))

    assert (joined["user_id"], joined["role"]) == (MEMBER, "member")
    assert again["added_at"] == joined["added_at"]
    assert left["left"] is True
    assert not_in == NOT_VISIBLE
    assert refusal(tool(client, guest, "join_team", {"team_id": "XYZ"})) == team_not_found_message("XYZ")


def test_the_last_admin_cannot_leave(client: TestClient, repositories: Any, workspace: str) -> None:
    """Leaving is refused for a team's only admin, as the route refuses it."""
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "admin")
    secret = mint_for(repositories, MEMBER, ("members:write",))

    assert "at least one admin" in refusal(tool(client, secret, "leave_team", {"team_id": "ABC"}))


def test_status_create_update_and_delete_by_name(client: TestClient, repositories: Any, workspace: str) -> None:
    """An admin adds a status, renames and moves it by name, then deletes it by name."""
    secret = mint_for(repositories, ADMIN, ("statuses:write", "statuses:read"))

    created = answer(tool(client, secret, "create_status", {"team_id": "ABC", "name": "Review", "category": "started"}))
    updated = answer(
        tool(
            client, secret, "update_status", {"team_id": "ABC", "status": "review", "name": "In review", "position": 0}
        )
    )
    deleted = answer(tool(client, secret, "delete_status", {"team_id": "ABC", "status": "In Review"}))
    listed = answer(tool(client, secret, "list_statuses", {"team_id": "abc"}))

    assert created["category"] == "started"
    assert (updated["status_id"], updated["name"], updated["position"]) == (created["status_id"], "In review", 0)
    assert deleted["status_id"] == created["status_id"]
    assert created["status_id"] not in {row["status_id"] for row in listed["statuses"]}


def test_status_tools_carry_color_and_icon(client: TestClient, repositories: Any, workspace: str) -> None:
    """The tools take both fields, clear them with null and refuse an icon from another category."""
    secret = mint_for(repositories, ADMIN, ("statuses:write", "statuses:read"))

    created = answer(
        tool(
            client,
            secret,
            "create_status",
            {"team_id": "ABC", "name": "Staged", "category": "started", "color": "teal", "icon": "three_quarters"},
        )
    )
    cleared = answer(tool(client, secret, "update_status", {"team_id": "ABC", "status": "Staged", "icon": None}))
    refused = refusal(tool(client, secret, "update_status", {"team_id": "ABC", "status": "Staged", "icon": "cross"}))

    assert (created["color"], created["icon"]) == ("teal", "three_quarters")
    assert (cleared["color"], cleared["icon"]) == ("teal", None)
    assert "does not fit" in refused


def test_status_delete_keeps_one_per_category(client: TestClient, repositories: Any, workspace: str) -> None:
    """The last status of a category is the route's conflict."""
    secret = mint_for(repositories, ADMIN, ("statuses:write",))
    rows = repositories.team_config.list_statuses(WORKSPACE, TEAM)
    categories = [row.category for row in rows]
    only = next(row for row in rows if categories.count(row.category) == 1)

    refused = refusal(tool(client, secret, "delete_status", {"team_id": "ABC", "status": only.status_id}))

    assert "one status in each category" in refused
    assert repositories.team_config.get_status(WORKSPACE, TEAM, only.status_id) is not None


def test_status_writes_refuse_a_member_and_unknown_names(client: TestClient, repositories: Any, workspace: str) -> None:
    """A member may not change a team's workflow, and an unknown status is not found."""
    member = mint_for(repositories, MEMBER, ("statuses:write",))
    admin = mint_for(repositories, ADMIN, ("statuses:write",))

    assert FORBIDDEN in refusal(
        tool(client, member, "create_status", {"team_id": "ABC", "name": "No", "category": "started"})
    )
    assert FORBIDDEN in refusal(tool(client, member, "delete_status", {"team_id": "ABC", "status": "Backlog"}))
    assert refusal(tool(client, admin, "update_status", {"team_id": "ABC", "status": "Nowhere"})) == NOT_VISIBLE


def test_label_update_and_delete_by_name(client: TestClient, repositories: Any, workspace: str) -> None:
    """An admin recolours and renames a label by name, then deletes it; a member may not."""
    create_label(repositories, WORKSPACE, TEAM, LabelCreate(name="Bug", color="#ff0000"))
    admin = mint_for(repositories, ADMIN, ("labels:write",))
    member = mint_for(repositories, MEMBER, ("labels:write",))

    refused = refusal(tool(client, member, "update_label", {"team_id": "ABC", "label": "bug", "name": "No"}))
    updated = answer(
        tool(client, admin, "update_label", {"team_id": "ABC", "label": "bug", "name": "Defect", "color": "#00FF00"})
    )
    blocked = refusal(tool(client, member, "delete_label", {"team_id": "ABC", "label": "Defect"}))
    deleted = answer(tool(client, admin, "delete_label", {"team_id": "Abc", "label": "defect"}))

    assert FORBIDDEN in refused
    assert (updated["name"], updated["color"]) == ("Defect", "#00ff00")
    assert FORBIDDEN in blocked
    assert deleted["label_id"] == updated["label_id"]
    assert repositories.team_config.list_labels(WORKSPACE, TEAM) == []


def test_label_writes_hide_a_team_from_a_guest(client: TestClient, repositories: Any, workspace: str) -> None:
    """A guest naming a team it is outside gets the same not-found as an absent team."""
    create_label(repositories, WORKSPACE, OTHER_TEAM, LabelCreate(name="Bug", color="#ff0000"))
    secret = mint_for(repositories, GUEST, ("labels:write",))

    assert refusal(tool(client, secret, "delete_label", {"team_id": "XYZ", "label": "Bug"})) == team_not_found_message(
        "XYZ"
    )
    assert len(repositories.team_config.list_labels(WORKSPACE, OTHER_TEAM)) == 1


def test_existing_team_tools_take_a_key_or_name(client: TestClient, repositories: Any, workspace: str) -> None:
    """The reads and the label create name a team the way a person would."""
    secret = mint_for(repositories, ADMIN, ("teams:read", "statuses:read", "labels:read", "labels:write"))

    team = answer(tool(client, secret, "get_team", {"team_id": "ABC"}))
    statuses = answer(tool(client, secret, "list_statuses", {"team_id": "Abc"}))
    label = answer(tool(client, secret, "create_label", {"team_id": "xyz", "name": "Ops", "color": "#123456"}))
    labels = answer(tool(client, secret, "list_labels", {"team_id": "Xyz"}))
    users = answer(tool(client, secret, "list_users", {"team_id": "ABC"}))

    assert team["team_id"] == TEAM
    assert statuses["statuses"]
    assert label["team_id"] == OTHER_TEAM
    assert [row["name"] for row in labels["labels"]] == ["Ops"]
    assert [row["user_id"] for row in users["users"]] == [GUEST]


def test_label_tools_create_and_move_labels_by_group(client: TestClient, repositories: Any, workspace: str) -> None:
    """A group is created, a label goes in by group name, is named by its path, and an empty group ungroups it."""
    admin = mint_for(repositories, ADMIN, ("labels:write", "labels:read"))

    group = answer(
        tool(client, admin, "create_label", {"team_id": "ABC", "name": "Area", "color": "#ff0000", "is_group": True})
    )
    child = answer(
        tool(client, admin, "create_label", {"team_id": "ABC", "name": "Frontend", "color": "#ff0000", "group": "area"})
    )
    renamed = answer(tool(client, admin, "update_label", {"team_id": "ABC", "label": "Area/Frontend", "name": "Web"}))
    ungrouped = answer(tool(client, admin, "update_label", {"team_id": "ABC", "label": "Area/Web", "group": None}))
    regrouped = answer(tool(client, admin, "update_label", {"team_id": "ABC", "label": "Web", "group": "Area"}))
    nested = refusal(
        tool(
            client,
            admin,
            "create_label",
            {"team_id": "ABC", "name": "Inner", "color": "#ff0000", "is_group": True, "group": "Area"},
        )
    )
    listed = answer(tool(client, admin, "list_labels", {"team_id": "ABC"}))["labels"]

    assert (group["is_group"], group["parent_id"]) == (True, None)
    assert child["parent_id"] == group["label_id"]
    assert (renamed["name"], renamed["parent_id"]) == ("Web", group["label_id"])
    assert ungrouped["parent_id"] is None
    assert regrouped["parent_id"] == group["label_id"]
    assert "cannot sit inside another group" in nested
    assert {row["label_id"]: row["parent_id"] for row in listed}[child["label_id"]] == group["label_id"]


def test_deleting_a_group_by_tool_keeps_its_children(client: TestClient, repositories: Any, workspace: str) -> None:
    """The children stay as plain labels."""
    admin = mint_for(repositories, ADMIN, ("labels:write", "labels:read"))
    answer(
        tool(client, admin, "create_label", {"team_id": "ABC", "name": "Area", "color": "#ff0000", "is_group": True})
    )
    child = answer(
        tool(client, admin, "create_label", {"team_id": "ABC", "name": "Frontend", "color": "#ff0000", "group": "Area"})
    )
    answer(tool(client, admin, "delete_label", {"team_id": "ABC", "label": "Area"}))
    listed = answer(tool(client, admin, "list_labels", {"team_id": "ABC"}))["labels"]
    assert [(row["label_id"], row["parent_id"]) for row in listed] == [(child["label_id"], None)]
