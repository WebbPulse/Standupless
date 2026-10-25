"""`GET /api/users/me`, the route the frontend's auth shell boots from."""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.inbox import NOTIFICATION_KINDS
from tests.domains.helpers import OWNER, make_user, sign_in, sign_in_through_gate

ALL_ON = {"in_app": True, "email": True, "chat": True}


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the identity application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["identity"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def test_an_anonymous_caller_is_refused(client: TestClient) -> None:
    """No claims at all is a 401, never an empty profile."""
    response = client.get("/api/users/me")
    assert response.status_code == 401
    assert response.json()["error_code"] == "NOT_AUTHENTICATED"


def test_the_caller_reads_their_own_row(client: TestClient, repositories: Any) -> None:
    """The body carries exactly the fields the frontend's `UserRead` declares."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)
    response = client.get("/api/users/me")
    assert response.status_code == 200
    assert response.json() == {
        "id": OWNER,
        "email": "owner@example.com",
        "display_name": "Owner",
        "full_name": "",
        "email_verified": False,
        "email_notifications": True,
        "notification_preferences": {kind: ALL_ON for kind in NOTIFICATION_KINDS},
        "avatar_url": None,
        "two_factor": False,
        "timezone": None,
        "pulse_digest": "off",
        "home_view": "home",
        "week_start": "monday",
        "name_display": "username",
        "font_size": "default",
        "projects_display": {
            "layout": "list",
            "group": "status",
            "direction": "asc",
            "rows": "none",
            "order": "target",
            "closed": "fortnight",
            "lead_team": "all",
            "empty": "show",
            "zoom": "month",
            "dependencies": "show",
            "columns": "summary,dependencies,health,priority,status,lead,start,target,teams,progress",
        },
        "projects_display_saved": False,
        "auto_assign_to_self": False,
        "branch_copy_starts": True,
        "branch_copy_assigns": True,
        "auto_grant_new_scopes": False,
    }


def test_two_factor_repeats_the_session_claim(client: TestClient, repositories: Any) -> None:
    """The account page reads the same claim a workspace's authentication policy checks."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER, two_factor=True)
    assert client.get("/api/users/me").json()["two_factor"] is True
    sign_in_through_gate(client, OWNER, two_factor="true")
    assert client.get("/api/users/me").json()["two_factor"] is True


def test_email_notifications_default_on_and_can_be_turned_off(client: TestClient, repositories: Any) -> None:
    """The switch defaults to on and the profile route is what turns it off."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    assert client.get("/api/users/me").json()["email_notifications"] is True

    response = client.patch("/api/users/me/preferences", json={"email_notifications": False})
    assert response.status_code == 200
    assert response.json()["email_notifications"] is False

    assert repositories.users.get(OWNER).email_notifications is False
    assert client.get("/api/users/me").json()["email_notifications"] is False


def test_the_pulse_digest_defaults_off_and_takes_a_cadence(client: TestClient, repositories: Any) -> None:
    """The digest is opt in, takes daily or weekly, and refuses a cadence it does not have."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    assert client.get("/api/users/me").json()["pulse_digest"] == "off"

    response = client.patch("/api/users/me/preferences", json={"pulse_digest": "weekly"})
    assert response.status_code == 200
    assert response.json()["pulse_digest"] == "weekly"
    assert repositories.users.get(OWNER).pulse_digest == "weekly"

    assert client.patch("/api/users/me/preferences", json={"pulse_digest": "hourly"}).status_code == 422
    assert client.patch("/api/users/me/preferences", json={"pulse_digest": "off"}).json()["pulse_digest"] == "off"


def test_interface_preferences_default_and_change_one_at_a_time(client: TestClient, repositories: Any) -> None:
    """Each interface preference saves on its own, keeps the others and refuses a choice it does not have."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    response = client.patch("/api/users/me/preferences", json={"home_view": "inbox"})
    assert response.status_code == 200
    assert response.json()["home_view"] == "inbox"
    assert response.json()["week_start"] == "monday"

    body = client.patch(
        "/api/users/me/preferences",
        json={"week_start": "sunday", "name_display": "full_name", "font_size": "large"},
    ).json()
    assert (body["home_view"], body["week_start"], body["name_display"], body["font_size"]) == (
        "inbox",
        "sunday",
        "full_name",
        "large",
    )
    stored = repositories.users.get(OWNER)
    assert (stored.home_view, stored.week_start, stored.name_display, stored.font_size) == (
        "inbox",
        "sunday",
        "full_name",
        "large",
    )

    for field, value in (
        ("home_view", "board"),
        ("week_start", "friday"),
        ("name_display", "email"),
        ("font_size", "huge"),
    ):
        assert client.patch("/api/users/me/preferences", json={field: value}).status_code == 422


def test_workflow_preferences_default_and_toggle_each_way(client: TestClient, repositories: Any) -> None:
    """Auto assign starts off and the branch copy switches start on; each turns on and off alone and is stored."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)
    fields = ("auto_assign_to_self", "branch_copy_starts", "branch_copy_assigns")

    body = client.get("/api/users/me").json()
    assert tuple(body[field] for field in fields) == (False, True, True)

    body = client.patch("/api/users/me/preferences", json={"auto_assign_to_self": True}).json()
    assert tuple(body[field] for field in fields) == (True, True, True)

    body = client.patch(
        "/api/users/me/preferences", json={"branch_copy_starts": False, "branch_copy_assigns": False}
    ).json()
    assert tuple(body[field] for field in fields) == (True, False, False)
    stored = repositories.users.get(OWNER)
    assert (stored.auto_assign_to_self, stored.branch_copy_starts, stored.branch_copy_assigns) == (True, False, False)

    body = client.patch(
        "/api/users/me/preferences",
        json={"auto_assign_to_self": False, "branch_copy_starts": True, "branch_copy_assigns": True},
    ).json()
    assert tuple(body[field] for field in fields) == (False, True, True)
    assert client.get("/api/users/me").json()["home_view"] == "home"

    assert client.patch("/api/users/me/preferences", json={"branch_copy_starts": "sometimes"}).status_code == 422


def test_a_retired_stored_preference_reads_as_the_default(client: TestClient, repositories: Any) -> None:
    """A value written before a choice was withdrawn reads as the default rather than failing the read."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    repositories.users.update(OWNER, home_view="roadmap", font_size="tiny")
    sign_in(client, OWNER)
    body = client.get("/api/users/me").json()
    assert body["home_view"] == "home"
    assert body["font_size"] == "default"


def test_the_projects_display_is_kept_whole_and_refuses_unknown_choices(client: TestClient, repositories: Any) -> None:
    """The projects list arrangement replaces as a whole, follows the account and refuses a choice it lacks."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    response = client.patch(
        "/api/users/me/preferences",
        json={
            "projects_display": {
                "layout": "board",
                "group": "health",
                "direction": "desc",
                "rows": "lead",
                "closed": "month",
                "lead_team": "lead",
                "empty": "hide",
                "dependencies": "hide",
            }
        },
    )
    assert response.status_code == 200
    assert response.json()["projects_display"] == {
        "layout": "board",
        "group": "health",
        "direction": "desc",
        "rows": "lead",
        "order": "target",
        "closed": "month",
        "lead_team": "lead",
        "empty": "hide",
        "zoom": "month",
        "dependencies": "hide",
        "columns": "summary,dependencies,health,priority,status,lead,start,target,teams,progress",
    }
    assert repositories.users.get(OWNER).projects_display["group"] == "health"
    assert client.get("/api/users/me").json()["projects_display"]["layout"] == "board"

    for field, value in (
        ("layout", "gallery"),
        ("group", "label"),
        ("closed", "year"),
        ("closed", "quarter"),
        ("zoom", "day"),
        ("direction", "up"),
        ("rows", "label"),
        ("lead_team", "yes"),
        ("empty", "true"),
        ("dependencies", "off"),
        ("columns", "health,budget"),
    ):
        refused = client.patch("/api/users/me/preferences", json={"projects_display": {field: value}})
        assert refused.status_code == 422


def test_a_saved_projects_display_is_marked_and_null_forgets_it(client: TestClient, repositories: Any) -> None:
    """An arrangement equal to the built-in one still counts as saved, and null returns the page to the defaults."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    built_in = client.get("/api/users/me").json()["projects_display"]
    saved = client.patch("/api/users/me/preferences", json={"projects_display": built_in})

    assert saved.status_code == 200, saved.text
    assert saved.json()["projects_display_saved"] is True
    assert repositories.users.get(OWNER).projects_display == built_in

    forgotten = client.patch("/api/users/me/preferences", json={"projects_display": None})

    assert forgotten.status_code == 200, forgotten.text
    assert forgotten.json()["projects_display_saved"] is False
    assert forgotten.json()["projects_display"] == built_in
    assert repositories.users.get(OWNER).projects_display == {}
    assert client.patch("/api/users/me/preferences", json={"projects_display": None}).status_code == 200


def test_the_projects_list_columns_are_kept_in_the_list_order(client: TestClient, repositories: Any) -> None:
    """Columns sent as a list or a text store as one text in the list's order, and empty shows the name alone."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    listed = client.patch("/api/users/me/preferences", json={"projects_display": {"columns": ["progress", "lead"]}})
    emptied = client.patch("/api/users/me/preferences", json={"projects_display": {"columns": ""}})

    assert listed.status_code == 200, listed.text
    assert listed.json()["projects_display"]["columns"] == "lead,progress"
    assert emptied.json()["projects_display"]["columns"] == ""
    assert repositories.users.get(OWNER).projects_display["columns"] == ""


def test_a_retired_projects_list_column_is_dropped_on_read(client: TestClient, repositories: Any) -> None:
    """A stored column the list no longer draws falls away and the others stay."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    repositories.users.update(OWNER, projects_display={"rows": "none", "columns": "budget,issues,health"})
    sign_in(client, OWNER)

    assert client.get("/api/users/me").json()["projects_display"]["columns"] == "health,issues"


def test_an_arrangement_saved_before_rows_keeps_summary_and_dependencies(client: TestClient, repositories: Any) -> None:
    """Columns stored before summary and dependencies were choices read with both on, as the list then drew them."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    repositories.users.update(OWNER, projects_display={"columns": "issues,health"})
    sign_in(client, OWNER)

    assert client.get("/api/users/me").json()["projects_display"]["columns"] == "summary,dependencies,health,issues"


def test_a_retired_projects_display_choice_reads_as_the_default(client: TestClient, repositories: Any) -> None:
    """A stored arrangement naming a withdrawn choice reads that field as the default and keeps the rest."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    repositories.users.update(OWNER, projects_display={"layout": "gallery", "group": "initiative"})
    sign_in(client, OWNER)
    display = client.get("/api/users/me").json()["projects_display"]
    assert display["layout"] == "list"
    assert display["group"] == "initiative"


def test_one_kind_can_be_turned_off_per_channel(client: TestClient, repositories: Any) -> None:
    """A partial patch changes the named channel of the named kind and nothing else."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    response = client.patch(
        "/api/users/me/preferences",
        json={"notification_preferences": {"commented": {"email": False}}},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["notification_preferences"]["commented"] == {"in_app": True, "email": False, "chat": True}
    assert body["notification_preferences"]["mentioned"] == ALL_ON
    assert body["email_notifications"] is True

    client.patch(
        "/api/users/me/preferences",
        json={"notification_preferences": {"commented": {"in_app": False}}},
    )
    stored = repositories.users.get(OWNER)
    assert stored.notification_preferences == {"commented": {"email": False, "in_app": False}}
    assert stored.wants_notification("commented", "email") is False
    assert stored.wants_notification("assigned", "email") is True


def test_turning_a_channel_back_on_keeps_the_row_sparse(client: TestClient, repositories: Any) -> None:
    """A switch turned back on is removed rather than stored, so defaults stay on."""
    make_user(repositories, OWNER, "owner@example.com")
    sign_in(client, OWNER)

    client.patch("/api/users/me/preferences", json={"notification_preferences": {"assigned": {"email": False}}})
    client.patch("/api/users/me/preferences", json={"notification_preferences": {"assigned": {"email": True}}})

    assert repositories.users.get(OWNER).notification_preferences == {}


def test_the_global_email_switch_overrides_every_kind(client: TestClient, repositories: Any) -> None:
    """With email off for the account, no kind wants email whatever its own switch says."""
    make_user(repositories, OWNER, "owner@example.com")
    sign_in(client, OWNER)

    client.patch("/api/users/me/preferences", json={"email_notifications": False})

    stored = repositories.users.get(OWNER)
    assert stored.wants_notification("mentioned", "email") is False
    assert stored.wants_notification("mentioned", "in_app") is True


def test_an_unknown_kind_is_refused(client: TestClient, repositories: Any) -> None:
    """Preferences are only accepted for kinds the inbox actually sends."""
    make_user(repositories, OWNER, "owner@example.com")
    sign_in(client, OWNER)

    response = client.patch(
        "/api/users/me/preferences",
        json={"notification_preferences": {"digest": {"email": False}}},
    )
    assert response.status_code == 422


def test_the_timezone_is_stored_and_read_back(client: TestClient, repositories: Any) -> None:
    """The browser's zone is saved on the row the due date sweep reads, and a later patch keeps it."""
    make_user(repositories, OWNER, "owner@example.com")
    sign_in(client, OWNER)

    response = client.patch("/api/users/me/preferences", json={"timezone": "America/Los_Angeles"})
    assert response.status_code == 200
    assert response.json()["timezone"] == "America/Los_Angeles"
    assert repositories.users.get(OWNER).timezone == "America/Los_Angeles"

    client.patch("/api/users/me/preferences", json={"email_notifications": False})
    assert client.get("/api/users/me").json()["timezone"] == "America/Los_Angeles"

    client.patch("/api/users/me/preferences", json={"timezone": "Asia/Tokyo"})
    assert repositories.users.get(OWNER).timezone == "Asia/Tokyo"


def test_an_unknown_timezone_is_refused(client: TestClient, repositories: Any) -> None:
    """Only a name the zone database knows is stored."""
    make_user(repositories, OWNER, "owner@example.com")
    sign_in(client, OWNER)

    response = client.patch("/api/users/me/preferences", json={"timezone": "Mars/Olympus"})

    assert response.status_code == 422
    assert repositories.users.get(OWNER).timezone is None


def test_changing_preferences_needs_a_signed_in_caller(client: TestClient) -> None:
    """The preference is on the caller's own row, so anonymous is a 401."""
    response = client.patch("/api/users/me/preferences", json={"email_notifications": False})
    assert response.status_code == 401


def test_the_staging_gate_shape_reads_the_same_row(client: TestClient, repositories: Any) -> None:
    """Claims arriving under `authorizer.lambda` name the same caller."""
    make_user(repositories, OWNER, "owner@example.com")
    sign_in_through_gate(client, OWNER)
    response = client.get("/api/users/me")
    assert response.status_code == 200
    assert response.json()["id"] == OWNER


def test_a_token_without_a_row_is_not_found(client: TestClient) -> None:
    """A verified subject whose row is gone is a 404, so the session survives."""
    sign_in(client, OWNER)
    response = client.get("/api/users/me")
    assert response.status_code == 404
    assert response.json()["error_code"] == "NOT_FOUND"
