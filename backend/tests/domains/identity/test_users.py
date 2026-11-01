"""`GET /api/users/me`, the route the frontend's auth shell boots from."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.inbox import NOTIFICATION_KINDS
from app.common.db.dynamo.users import DEFAULT_PRIORITY_KINDS, SIDEBAR_ITEMS, channel_default
from app.common.inbox import INBOX_KINDS
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
        "notification_preferences": {
            kind: {channel: channel_default(kind, channel) for channel in ALL_ON} for kind in NOTIFICATION_KINDS
        },
        "priority_inbox": True,
        "priority_kinds": [kind for kind in INBOX_KINDS if kind in DEFAULT_PRIORITY_KINDS],
        "email_format": "digest",
        "notifications_paused_until": None,
        "working_hours": None,
        "urgent_bypasses_pause": False,
        "avatar_url": None,
        "two_factor": False,
        "timezone": None,
        "pulse_digest": "off",
        "home_view": "home",
        "week_start": "monday",
        "name_display": "username",
        "font_size": "default",
        "theme": None,
        "pointer_cursors": False,
        "underline_links": False,
        "code_theme": "app",
        "convert_emoticons": True,
        "activity_filter": "all",
        "sidebar_items": {item: "show" for item in SIDEBAR_ITEMS},
        "sidebar_badge_style": "count",
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
        "initiatives_display": {
            "layout": "list",
            "zoom": "month",
            "grouping": "status",
            "order": "target",
            "completed": "show",
            "columns": "health,team,owner,projects,start,target,progress",
        },
        "initiatives_display_saved": False,
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


def test_the_email_format_defaults_to_a_digest_and_takes_immediate(client: TestClient, repositories: Any) -> None:
    """The format is a digest until the person picks immediate, and refuses a format it does not have."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    assert client.get("/api/users/me").json()["email_format"] == "digest"

    response = client.patch("/api/users/me/preferences", json={"email_format": "immediate"})
    assert response.status_code == 200
    assert response.json()["email_format"] == "immediate"
    assert repositories.users.get(OWNER).email_format == "immediate"

    assert client.patch("/api/users/me/preferences", json={"email_format": "hourly"}).status_code == 422
    assert client.patch("/api/users/me/preferences", json={"email_format": "digest"}).json()["email_format"] == "digest"


def test_a_pause_is_set_read_back_and_resumed(client: TestClient, repositories: Any) -> None:
    """A pause up to thirty days ahead is kept, an explicit null resumes it, and a longer one is refused."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)
    until = (datetime.now(timezone.utc) + timedelta(hours=1)).replace(microsecond=0)

    response = client.patch("/api/users/me/preferences", json={"notifications_paused_until": until.isoformat()})
    assert response.status_code == 200
    assert datetime.fromisoformat(response.json()["notifications_paused_until"]) == until
    assert repositories.users.get(OWNER).notifications_paused_until == until

    too_long = datetime.now(timezone.utc) + timedelta(days=31)
    refused = client.patch("/api/users/me/preferences", json={"notifications_paused_until": too_long.isoformat()})
    assert refused.status_code == 422

    untouched = client.patch("/api/users/me/preferences", json={"email_format": "immediate"})
    assert untouched.json()["notifications_paused_until"] is not None

    resumed = client.patch("/api/users/me/preferences", json={"notifications_paused_until": None})
    assert resumed.json()["notifications_paused_until"] is None
    assert repositories.users.get(OWNER).notifications_paused_until is None


def test_a_pause_that_has_ended_reads_as_none(client: TestClient, repositories: Any) -> None:
    """A stored pause in the past is no pause, so the sidebar never shows a stale indicator."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    repositories.users.update(
        OWNER, notifications_paused_until=(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    )
    sign_in(client, OWNER)

    assert client.get("/api/users/me").json()["notifications_paused_until"] is None


def test_working_hours_are_set_validated_and_cleared(client: TestClient, repositories: Any) -> None:
    """A schedule keeps its days in week order, refuses a day that ends before it starts, and null clears it."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    response = client.patch(
        "/api/users/me/preferences",
        json={"working_hours": {"days": ["fri", "mon"], "start": "08:30", "end": "16:00"}},
    )
    assert response.status_code == 200
    assert response.json()["working_hours"] == {"days": ["mon", "fri"], "start": "08:30", "end": "16:00"}
    assert repositories.users.get(OWNER).working_hours.days == ["mon", "fri"]

    for hours in (
        {"days": ["mon"], "start": "17:00", "end": "09:00"},
        {"days": [], "start": "09:00", "end": "17:00"},
        {"days": ["someday"], "start": "09:00", "end": "17:00"},
        {"days": ["mon"], "start": "9am", "end": "17:00"},
    ):
        assert client.patch("/api/users/me/preferences", json={"working_hours": hours}).status_code == 422

    cleared = client.patch("/api/users/me/preferences", json={"working_hours": None})
    assert cleared.json()["working_hours"] is None
    assert repositories.users.get(OWNER).working_hours is None


def test_urgent_notifications_may_bypass_a_pause(client: TestClient, repositories: Any) -> None:
    """The bypass is off until the person turns it on."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    assert client.get("/api/users/me").json()["urgent_bypasses_pause"] is False
    response = client.patch("/api/users/me/preferences", json={"urgent_bypasses_pause": True})
    assert response.json()["urgent_bypasses_pause"] is True
    assert repositories.users.get(OWNER).urgent_bypasses_pause is True


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


def test_the_activity_filter_defaults_to_all_and_saves_comments_only(client: TestClient, repositories: Any) -> None:
    """The issue activity filter starts on all activity, saves comments only and refuses a filter it does not have."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    assert client.get("/api/users/me").json()["activity_filter"] == "all"

    response = client.patch("/api/users/me/preferences", json={"activity_filter": "comments"})
    assert response.status_code == 200
    assert response.json()["activity_filter"] == "comments"
    assert repositories.users.get(OWNER).activity_filter == "comments"
    assert client.get("/api/users/me").json()["activity_filter"] == "comments"

    assert client.patch("/api/users/me/preferences", json={"activity_filter": "history"}).status_code == 422
    assert client.patch("/api/users/me/preferences", json={"activity_filter": "all"}).json()["activity_filter"] == "all"


def test_the_sidebar_starts_with_every_item_shown_and_count_badges(client: TestClient, repositories: Any) -> None:
    """A person who never customized the sidebar reads every item shown and numbered badges."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    body = client.get("/api/users/me").json()
    assert body["sidebar_items"] == {item: "show" for item in SIDEBAR_ITEMS}
    assert body["sidebar_badge_style"] == "count"


def test_sidebar_items_move_between_shown_more_and_hidden(client: TestClient, repositories: Any) -> None:
    """Each item moves alone to the More menu, to hidden and back, and only moved items are stored."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    response = client.patch("/api/users/me/preferences", json={"sidebar_items": {"customers": "hide"}})
    assert response.status_code == 200
    assert response.json()["sidebar_items"]["customers"] == "hide"
    assert response.json()["sidebar_items"]["roadmap"] == "show"

    response = client.patch("/api/users/me/preferences", json={"sidebar_items": {"roadmap": "more"}})
    assert response.json()["sidebar_items"]["customers"] == "hide"
    assert response.json()["sidebar_items"]["roadmap"] == "more"
    assert repositories.users.get(OWNER).sidebar_items == {"customers": "hide", "roadmap": "more"}

    response = client.patch("/api/users/me/preferences", json={"sidebar_items": {"customers": "show"}})
    assert response.json()["sidebar_items"]["customers"] == "show"
    assert repositories.users.get(OWNER).sidebar_items == {"roadmap": "more"}
    assert client.get("/api/users/me").json()["sidebar_items"]["roadmap"] == "more"


def test_the_sidebar_refuses_an_unknown_item_or_place(client: TestClient, repositories: Any) -> None:
    """An item the sidebar does not have, or a place it cannot sit, is a 422 and changes nothing."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    assert client.patch("/api/users/me/preferences", json={"sidebar_items": {"documents": "hide"}}).status_code == 422
    assert client.patch("/api/users/me/preferences", json={"sidebar_items": {"views": "pinned"}}).status_code == 422
    assert repositories.users.get(OWNER).sidebar_items == {}


def test_the_sidebar_badge_style_switches_to_a_dot_and_back(client: TestClient, repositories: Any) -> None:
    """The badge style saves a dot, refuses a style it does not have and returns to a count."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    response = client.patch("/api/users/me/preferences", json={"sidebar_badge_style": "dot"})
    assert response.status_code == 200
    assert response.json()["sidebar_badge_style"] == "dot"
    assert repositories.users.get(OWNER).sidebar_badge_style == "dot"
    assert client.get("/api/users/me").json()["sidebar_badge_style"] == "dot"

    assert client.patch("/api/users/me/preferences", json={"sidebar_badge_style": "ring"}).status_code == 422
    assert (
        client.patch("/api/users/me/preferences", json={"sidebar_badge_style": "count"}).json()["sidebar_badge_style"]
        == "count"
    )


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


def test_theme_and_pointer_cursors_are_stored_on_the_account(client: TestClient, repositories: Any) -> None:
    """The theme reads null until saved, then follows the account; pointer cursors start off and toggle."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    body = client.get("/api/users/me").json()
    assert (body["theme"], body["pointer_cursors"]) == (None, False)

    body = client.patch("/api/users/me/preferences", json={"theme": "light", "pointer_cursors": True}).json()
    assert (body["theme"], body["pointer_cursors"]) == ("light", True)
    stored = repositories.users.get(OWNER)
    assert (stored.theme, stored.pointer_cursors) == ("light", True)

    body = client.patch("/api/users/me/preferences", json={"theme": "system"}).json()
    assert (body["theme"], body["pointer_cursors"]) == ("system", True)

    assert client.patch("/api/users/me/preferences", json={"theme": "sepia"}).status_code == 422

    repositories.users.update(OWNER, theme="sepia")
    assert client.get("/api/users/me").json()["theme"] is None


def test_underline_links_starts_off_and_toggles(client: TestClient, repositories: Any) -> None:
    """Link underlines read off for a new account and follow the account once turned on."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    assert client.get("/api/users/me").json()["underline_links"] is False

    body = client.patch("/api/users/me/preferences", json={"underline_links": True}).json()
    assert body["underline_links"] is True
    assert repositories.users.get(OWNER).underline_links is True

    body = client.patch("/api/users/me/preferences", json={"font_size": "large"}).json()
    assert body["underline_links"] is True

    assert client.patch("/api/users/me/preferences", json={"underline_links": "sometimes"}).status_code == 422


def test_code_theme_follows_the_app_until_chosen(client: TestClient, repositories: Any) -> None:
    """The code block theme reads `app` for a new account, keeps a chosen theme, and falls back from a retired one."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    assert client.get("/api/users/me").json()["code_theme"] == "app"

    body = client.patch("/api/users/me/preferences", json={"code_theme": "dark_high_contrast"}).json()
    assert body["code_theme"] == "dark_high_contrast"
    assert repositories.users.get(OWNER).code_theme == "dark_high_contrast"

    body = client.patch("/api/users/me/preferences", json={"font_size": "large"}).json()
    assert body["code_theme"] == "dark_high_contrast"

    assert client.patch("/api/users/me/preferences", json={"code_theme": "sepia"}).status_code == 422

    repositories.users.update(OWNER, code_theme="sepia")
    assert client.get("/api/users/me").json()["code_theme"] == "app"


def test_emoticon_conversion_starts_on_and_toggles(client: TestClient, repositories: Any) -> None:
    """Emoticon conversion reads on for a new account and follows the account once turned off."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    assert client.get("/api/users/me").json()["convert_emoticons"] is True

    body = client.patch("/api/users/me/preferences", json={"convert_emoticons": False}).json()
    assert body["convert_emoticons"] is False
    assert repositories.users.get(OWNER).convert_emoticons is False

    body = client.patch("/api/users/me/preferences", json={"font_size": "large"}).json()
    assert body["convert_emoticons"] is False

    assert client.patch("/api/users/me/preferences", json={"convert_emoticons": "sometimes"}).status_code == 422


def test_a_retired_stored_preference_reads_as_the_default(client: TestClient, repositories: Any) -> None:
    """A value written before a choice was withdrawn reads as the default rather than failing the read."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    repositories.users.update(
        OWNER,
        home_view="roadmap",
        font_size="tiny",
        activity_filter="history",
        sidebar_items={"views": "pinned", "documents": "hide"},
        sidebar_badge_style="ring",
    )
    sign_in(client, OWNER)
    body = client.get("/api/users/me").json()
    assert body["home_view"] == "home"
    assert body["font_size"] == "default"
    assert body["activity_filter"] == "all"
    assert body["sidebar_items"]["views"] == "show"
    assert "documents" not in body["sidebar_items"]
    assert body["sidebar_badge_style"] == "count"


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
        ("group", "labels"),
        ("closed", "year"),
        ("closed", "quarter"),
        ("zoom", "day"),
        ("direction", "up"),
        ("rows", "labels"),
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


def test_the_initiatives_display_is_saved_whole_refused_when_unknown_and_forgotten_by_null(
    client: TestClient, repositories: Any
) -> None:
    """The initiatives list arrangement follows the account, refuses a choice it lacks, and null forgets it."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    saved = client.patch(
        "/api/users/me/preferences",
        json={"initiatives_display": {"order": "name", "completed": "hide", "columns": ["progress", "owner"]}},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["initiatives_display"] == {
        "layout": "list",
        "zoom": "month",
        "grouping": "status",
        "order": "name",
        "completed": "hide",
        "columns": "owner,progress",
    }
    assert saved.json()["initiatives_display_saved"] is True
    assert repositories.users.get(OWNER).initiatives_display["order"] == "name"
    assert client.get("/api/users/me").json()["projects_display_saved"] is False

    for field, value in (
        ("order", "priority"),
        ("grouping", "lead"),
        ("completed", "yes"),
        ("layout", "board"),
        ("zoom", "decade"),
        ("columns", "owner,budget"),
    ):
        refused = client.patch("/api/users/me/preferences", json={"initiatives_display": {field: value}})
        assert refused.status_code == 422

    forgotten = client.patch("/api/users/me/preferences", json={"initiatives_display": None})
    assert forgotten.status_code == 200, forgotten.text
    assert forgotten.json()["initiatives_display_saved"] is False
    assert forgotten.json()["initiatives_display"]["order"] == "target"
    assert repositories.users.get(OWNER).initiatives_display == {}


def test_the_initiatives_display_saves_manual_order_and_the_new_groupings(
    client: TestClient, repositories: Any
) -> None:
    """Manual order and the owner, health and target date groupings round trip through the account."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    for grouping in ("owner", "health", "target_date"):
        saved = client.patch(
            "/api/users/me/preferences", json={"initiatives_display": {"grouping": grouping, "order": "manual"}}
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["initiatives_display"]["grouping"] == grouping
        assert saved.json()["initiatives_display"]["order"] == "manual"
        assert client.get("/api/users/me").json()["initiatives_display"]["grouping"] == grouping


def test_a_retired_initiatives_display_choice_reads_as_the_default(client: TestClient, repositories: Any) -> None:
    """A stored choice the list no longer offers reads back as the default rather than failing the read."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)
    repositories.users.update(OWNER, initiatives_display={"order": "priority", "columns": "budget,health"})

    display = client.get("/api/users/me").json()["initiatives_display"]

    assert display == {
        "layout": "list",
        "zoom": "month",
        "grouping": "status",
        "order": "target",
        "completed": "show",
        "columns": "health",
    }


def test_the_initiatives_display_saves_the_timeline_layout_and_its_zoom(client: TestClient, repositories: Any) -> None:
    """The timeline layout, its zoom and the start column round trip through the account."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    saved = client.patch(
        "/api/users/me/preferences",
        json={"initiatives_display": {"layout": "timeline", "zoom": "quarter", "columns": "target,start"}},
    )

    assert saved.status_code == 200, saved.text
    display = client.get("/api/users/me").json()["initiatives_display"]
    assert display["layout"] == "timeline"
    assert display["zoom"] == "quarter"
    assert display["columns"] == "start,target"


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


def test_reactions_default_to_the_inbox_only(client: TestClient, repositories: Any) -> None:
    """Reactions start with email and chat off, and turning email on is what gets stored."""
    make_user(repositories, OWNER, "owner@example.com")
    sign_in(client, OWNER)

    body = client.get("/api/users/me").json()
    assert body["notification_preferences"]["reaction"] == {"in_app": True, "email": False, "chat": False}
    assert repositories.users.get(OWNER).wants_notification("reaction", "email") is False

    client.patch("/api/users/me/preferences", json={"notification_preferences": {"reaction": {"email": True}}})
    stored = repositories.users.get(OWNER)
    assert stored.notification_preferences == {"reaction": {"email": True}}
    assert stored.wants_notification("reaction", "email") is True

    client.patch("/api/users/me/preferences", json={"notification_preferences": {"reaction": {"email": False}}})
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


def test_the_priority_inbox_starts_split_on_the_default_kinds(client: TestClient, repositories: Any) -> None:
    """The split is on by default and its Priority tab holds the default kinds."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    body = client.get("/api/users/me").json()

    assert body["priority_inbox"] is True
    assert set(body["priority_kinds"]) == set(DEFAULT_PRIORITY_KINDS)


def test_the_priority_kinds_are_replaced_whole_and_stored_sparse(client: TestClient, repositories: Any) -> None:
    """Only the kinds that differ from the defaults are stored, so later kinds keep their default."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)
    chosen = [kind for kind in DEFAULT_PRIORITY_KINDS if kind != "reminder"] + ["commented"]

    body = client.patch("/api/users/me/preferences", json={"priority_kinds": chosen}).json()

    assert set(body["priority_kinds"]) == set(chosen)
    assert repositories.users.get(OWNER).priority_kinds == {"commented": True, "reminder": False}

    reset = client.patch("/api/users/me/preferences", json={"priority_kinds": sorted(DEFAULT_PRIORITY_KINDS)}).json()

    assert set(reset["priority_kinds"]) == set(DEFAULT_PRIORITY_KINDS)
    assert repositories.users.get(OWNER).priority_kinds == {}


def test_the_priority_inbox_turns_off_and_refuses_an_unknown_kind(client: TestClient, repositories: Any) -> None:
    """Turning the split off is one flag, and a kind no row can carry is a 422."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    assert client.patch("/api/users/me/preferences", json={"priority_inbox": False}).json()["priority_inbox"] is False
    assert repositories.users.get(OWNER).priority_inbox is False
    assert client.patch("/api/users/me/preferences", json={"priority_kinds": ["nonsense"]}).status_code == 422
