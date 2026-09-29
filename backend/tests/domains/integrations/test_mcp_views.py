"""The saved view and inbox MCP tools: happy paths, role enforcement and identifiers.

Each tool runs the view or inbox route's own `app.common` path, so the refusals
asserted here are the route's: a 404 reads as not visible, a 403 as a credential
that may not write there.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.inbox import Notification, expires_at, inbox_partition
from app.common.db.dynamo.views import SavedView, personal_view_key
from app.common.team_refs import team_not_found_message
from app.domains.integrations.mcp.toolkit import NOT_VISIBLE
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_team_member
from tests.domains.integrations.conftest import OTHER_WORKSPACE, TEAM, WORKSPACE
from tests.domains.integrations.mcp_isolation.views import FOREIGN_NOTIFICATION, seed
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

VIEWS = ("views:read", "views:write")

INBOX = ("notifications:read", "notifications:write")

FORBIDDEN_TEXT = "may not write there"

THEIRS = "01N000000000000000000THEIR"


def put_notification(repositories: Any, recipient_id: str, notification_id: str, *, minutes: int = 0) -> None:
    """Write one unread inbox row straight in, so no consumer has to run."""
    created_at = datetime.now(timezone.utc) - timedelta(hours=1) + timedelta(minutes=minutes)
    repositories.inbox.create(
        Notification(
            ws_user=inbox_partition(WORKSPACE, recipient_id),
            notification_id=notification_id,
            workspace_id=WORKSPACE,
            kind="assigned",
            issue_id="01JB0000000000000000000IS1",
            issue_key="ABC-1",
            issue_title="An issue",
            team_id=TEAM,
            actor_id=OWNER,
            actor_name="Olive Owner",
            recipient_id=recipient_id,
            created_at=created_at,
            unread_at=created_at.isoformat(),
            expires_at=expires_at(created_at),
        )
    )


def personal_view(repositories: Any, owner_id: str, name: str) -> str:
    """One personal view owned by `owner_id`, returning its id."""
    view = SavedView(workspace_id=WORKSPACE, view_key="", name=name, owner_id=owner_id)
    view.view_key = personal_view_key(owner_id, view.view_id)
    repositories.views.create(view)
    return view.view_id


def owners_team_view(client: TestClient, repositories: Any) -> str:
    """A team view on TEAM created by the owner through the tool, returning its id."""
    secret = mint_for(repositories, OWNER, VIEWS)
    return answer(tool(client, secret, "create_view", {"name": "Triage", "team_id": TEAM}))["view_id"]


@pytest.fixture
def inbox(repositories: Any, workspace: str) -> tuple[str, str]:
    """Two unread notifications for the member and one for the owner."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A001", minutes=0)
    put_notification(repositories, MEMBER, "01N0000000000000000000B002", minutes=5)
    put_notification(repositories, OWNER, THEIRS)
    return "01N0000000000000000000A001", "01N0000000000000000000B002"


def test_create_view_personal_and_on_a_team_by_key(client: TestClient, repositories: Any, workspace: str) -> None:
    """A view is personal without a team, and shared on a team named by its key."""
    secret = mint_for(repositories, MEMBER, VIEWS)

    mine = answer(
        tool(
            client,
            secret,
            "create_view",
            {"name": "My bugs", "filter": {"assignee_id": "me", "priority": ["urgent", "high"]}, "layout": "board"},
        )
    )
    shared = answer(tool(client, secret, "create_view", {"name": "Team board", "team_id": "abc"}))

    assert (mine["scope"], mine["owner_id"], mine["layout"], mine["kind"]) == ("personal", MEMBER, "board", "board")
    assert mine["filter"] == {"assignee_id": "me", "priority": ["urgent", "high"]}
    assert (shared["scope"], shared["team_id"]) == ("team", TEAM)


def test_create_view_refuses_what_the_route_refuses(client: TestClient, repositories: Any, workspace: str) -> None:
    """A guest outside a team cannot share a view on it, and a bad filter key is named."""
    guest = mint_for(repositories, GUEST, VIEWS)
    member = mint_for(repositories, MEMBER, VIEWS)

    outside = refusal(tool(client, guest, "create_view", {"name": "Nope", "team_id": "XYZ"}))
    bad_filter = refusal(tool(client, member, "create_view", {"name": "Nope", "filter": {"colour": "red"}}))
    orphan = refusal(tool(client, member, "create_view", {"name": "Nope", "sub_group_by": "label"}))

    assert outside == team_not_found_message("XYZ")
    assert "colour" in bad_filter
    assert "sub_group_by needs group_by" in orphan


def test_update_view_by_name_sets_and_clears_grouping(client: TestClient, repositories: Any, workspace: str) -> None:
    """A view named by its name is patched field by field, and null clears a grouping."""
    secret = mint_for(repositories, MEMBER, VIEWS)
    answer(tool(client, secret, "create_view", {"name": "Mine"}))

    grouped = answer(tool(client, secret, "update_view", {"view_id": "mine", "group_by": "status", "sort": "key_asc"}))
    cleared = answer(tool(client, secret, "update_view", {"view_id": grouped["view_id"], "group_by": None}))
    switch = refusal(tool(client, secret, "update_view", {"view_id": "Mine", "show_completed": None}))

    assert (grouped["group_by"], grouped["sort"], grouped["name"]) == ("status", "key_asc", "Mine")
    assert (cleared["group_by"], cleared["sort"]) == (None, "key_asc")
    assert "show_completed" in switch


def test_update_view_is_the_owners_or_a_team_admins(client: TestClient, repositories: Any, workspace: str) -> None:
    """A member may not change another's team view; a workspace admin and a team admin may."""
    view_id = owners_team_view(client, repositories)

    member = refusal(
        tool(client, mint_for(repositories, MEMBER, VIEWS), "update_view", {"view_id": view_id, "name": "X"})
    )
    admin = answer(tool(client, mint_for(repositories, ADMIN, VIEWS), "update_view", {"view_id": view_id, "name": "A"}))
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "admin")
    promoted = answer(
        tool(client, mint_for(repositories, MEMBER, VIEWS), "update_view", {"view_id": view_id, "name": "B"})
    )

    assert FORBIDDEN_TEXT in member
    assert (admin["name"], promoted["name"]) == ("A", "B")


def test_another_members_personal_view_is_not_visible(client: TestClient, repositories: Any, workspace: str) -> None:
    """A personal view is found only by its owner, by id or by name."""
    view_id = personal_view(repositories, OWNER, "Owner only")
    secret = mint_for(repositories, ADMIN, VIEWS)

    by_id = refusal(tool(client, secret, "update_view", {"view_id": view_id, "name": "Taken"}))
    by_name = refusal(tool(client, secret, "delete_view", {"view_id": "Owner only"}))

    assert by_id == NOT_VISIBLE
    assert by_name == NOT_VISIBLE


def test_ambiguous_view_names_ask_for_an_id(client: TestClient, repositories: Any, workspace: str) -> None:
    """Two readable views sharing a name are not guessed between."""
    personal_view(repositories, MEMBER, "Twin")
    personal_view(repositories, MEMBER, "Twin")

    text = refusal(tool(client, mint_for(repositories, MEMBER, VIEWS), "delete_view", {"view_id": "Twin"}))

    assert "view_id" in text


def test_delete_view(client: TestClient, repositories: Any, workspace: str) -> None:
    """The owner deletes their view by name; a guest in the team may not delete the owner's team view."""
    view_id = owners_team_view(client, repositories)
    personal_view(repositories, MEMBER, "Scratch")

    guest = refusal(tool(client, mint_for(repositories, GUEST, VIEWS), "delete_view", {"view_id": view_id}))
    deleted = answer(tool(client, mint_for(repositories, MEMBER, VIEWS), "delete_view", {"view_id": "scratch"}))

    assert FORBIDDEN_TEXT in guest
    assert deleted["deleted"] is True and deleted["name"] == "Scratch"
    assert repositories.views.list_personal(WORKSPACE, MEMBER) == []
    assert TOOLS_BY_NAME["delete_view"].descriptor()["annotations"]["destructiveHint"] is True


def test_list_notifications_reads_only_the_callers_inbox(
    client: TestClient, repositories: Any, inbox: tuple[str, str]
) -> None:
    """Newest first, the caller's own rows only, with the unread count."""
    secret = mint_for(repositories, MEMBER, INBOX)

    listed = answer(tool(client, secret, "list_notifications", {}))
    paged = answer(tool(client, secret, "list_notifications", {"limit": 1}))
    both = refusal(tool(client, secret, "list_notifications", {"unread": True, "snoozed": True}))

    assert [row["notification_id"] for row in listed["notifications"]] == [inbox[1], inbox[0]]
    assert listed["unread_count"] == 2
    assert paged["next_cursor"] and len(paged["notifications"]) == 1
    assert "cannot be combined" in both


def test_mark_read_unread_and_all(client: TestClient, repositories: Any, inbox: tuple[str, str]) -> None:
    """Marking moves only the caller's rows, and another member's id changes nothing."""
    secret = mint_for(repositories, MEMBER, INBOX)

    one = answer(tool(client, secret, "mark_notification_read", {"notification_ids": inbox[0]}))
    foreign = answer(tool(client, secret, "mark_notification_read", {"notification_ids": [THEIRS]}))
    unread = answer(tool(client, secret, "list_notifications", {"unread": True}))
    back = answer(tool(client, secret, "mark_notification_unread", {"notification_ids": [inbox[0]]}))
    everything = answer(tool(client, secret, "mark_all_notifications_read", {}))

    assert (one["updated"], foreign["updated"]) == (1, 0)
    assert [row["notification_id"] for row in unread["notifications"]] == [inbox[1]]
    assert back["updated"] == 1
    assert everything["updated"] == 2
    assert repositories.inbox.get(WORKSPACE, OWNER, THEIRS).unread is True


def test_snooze_notification(client: TestClient, repositories: Any, inbox: tuple[str, str]) -> None:
    """A snoozed row leaves the inbox and lists under snoozed; a past or naive moment is refused."""
    secret = mint_for(repositories, MEMBER, INBOX)
    until = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()

    snoozed = answer(tool(client, secret, "snooze_notification", {"notification_ids": inbox[1], "until": until}))
    listed = answer(tool(client, secret, "list_notifications", {}))
    hidden = answer(tool(client, secret, "list_notifications", {"snoozed": True}))
    past = refusal(
        tool(client, secret, "snooze_notification", {"notification_ids": inbox[0], "until": "2020-01-01T00:00:00Z"})
    )
    naive = refusal(
        tool(client, secret, "snooze_notification", {"notification_ids": inbox[0], "until": "2099-01-01T00:00"})
    )

    assert snoozed["updated"] == 1
    assert [row["notification_id"] for row in listed["notifications"]] == [inbox[0]]
    assert [row["notification_id"] for row in hidden["notifications"]] == [inbox[1]]
    assert "future" in past
    assert "timezone" in naive


def test_delete_notification(client: TestClient, repositories: Any, inbox: tuple[str, str]) -> None:
    """The caller deletes their own row; another member's id is not visible."""
    secret = mint_for(repositories, MEMBER, INBOX)

    deleted = answer(tool(client, secret, "delete_notification", {"notification_id": inbox[0]}))
    foreign = refusal(tool(client, secret, "delete_notification", {"notification_id": THEIRS}))

    assert deleted["deleted"] is True
    assert repositories.inbox.get(WORKSPACE, MEMBER, inbox[0]) is None
    assert foreign == NOT_VISIBLE
    assert repositories.inbox.get(WORKSPACE, OWNER, THEIRS) is not None
    assert TOOLS_BY_NAME["delete_notification"].descriptor()["annotations"]["destructiveHint"] is True


def test_mark_tools_leave_another_workspaces_notification_alone(
    client: TestClient, repositories: Any, inbox: tuple[str, str]
) -> None:
    """A foreign workspace's id changes nothing there, though the owner holds that inbox too."""
    seed(repositories, OTHER_WORKSPACE, TEAM)
    secret = mint_for(repositories, OWNER, INBOX)
    until = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()

    read = answer(tool(client, secret, "mark_notification_read", {"notification_ids": [FOREIGN_NOTIFICATION]}))
    snoozed = answer(
        tool(client, secret, "snooze_notification", {"notification_ids": [FOREIGN_NOTIFICATION], "until": until})
    )
    answer(tool(client, secret, "mark_all_notifications_read", {}))

    stored = repositories.inbox.get(OTHER_WORKSPACE, OWNER, FOREIGN_NOTIFICATION)
    assert (read["updated"], snoozed["updated"]) == (0, 0)
    assert stored.unread is True and not stored.snoozed()
