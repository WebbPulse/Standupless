"""The async standup digest: its window, its sections, notes, settings and the MCP tool."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import Project, ProjectUpdateRow, project_key, project_update_key
from app.common.db.dynamo.team_config import default_standup_settings
from app.common.standup import StandupWindowError, build_digest, next_digest_date, window_for
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_team_member, sign_in, sign_out
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

PATH = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/standup"

TUESDAY = date(2026, 10, 6)

WINDOW_START = datetime(2026, 10, 5, 13, 0, tzinfo=UTC)

WINDOW_END = datetime(2026, 10, 6, 13, 0, tzinfo=UTC)


def statuses(repositories: Any, team_id: str = TEAM) -> dict[str, str]:
    """The seeded team's status ids by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, team_id)}


def make_issue(repositories: Any, number: int, *, team_id: str = TEAM, prefix: str = "ABC", **fields: Any) -> Issue:
    """One issue in the team, in its unstarted status unless told otherwise."""
    status_id = fields.pop("status_id", None) or statuses(repositories, team_id)["unstarted"]
    return repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            issue_id=f"01JB00000000000000000ISS{number:02d}",
            team_id=team_id,
            key=f"{prefix}-{number}",
            number=number,
            title=f"Issue {number}",
            status_id=status_id,
            created_by=OWNER,
            **fields,
        )
    )


def move(repositories: Any, issue: Issue, category: str, at: datetime, actor: str, kind: str = "user") -> None:
    """Record a status change of `issue` into the team's status of `category` at `at`."""
    row = build_activity(
        WORKSPACE,
        issue.team_id,
        issue.issue_id,
        actor,
        "field_changed",
        actor_kind=kind,
        field="status_id",
        from_value=issue.status_id,
        to_value=statuses(repositories, issue.team_id)[category],
    )
    repositories.activity.record(row.model_copy(update={"created_at": at}))


def eastern(repositories: Any, cadence: str = "daily") -> None:
    """Give the team a 09:00 New York digest."""
    settings = default_standup_settings(WORKSPACE, TEAM).model_copy(
        update={"cadence": cadence, "timezone": "America/New_York"}
    )
    repositories.team_config.put_standup_settings(settings)


def person(digest: Any, user_id: str) -> Any:
    """One person's entry of a digest, from the model or its JSON."""
    people = digest["people"] if isinstance(digest, dict) else digest.people
    for entry in people:
        if (entry["user_id"] if isinstance(entry, dict) else entry.user_id) == user_id:
            return entry
    raise AssertionError(f"{user_id} is not in the digest")


def keys(lines: Any) -> list[str]:
    """The issue keys of one digest section."""
    return [line["key"] if isinstance(line, dict) else line.key for line in lines]


def test_a_daily_window_runs_from_the_previous_weekday_at_send_time() -> None:
    """Tuesday covers Monday 09:00 onward, Monday covers Friday 09:00 onward."""
    assert window_for(TUESDAY, "daily", "09:00", "America/New_York") == (WINDOW_START, WINDOW_END)
    monday_start, monday_end = window_for(date(2026, 10, 5), "daily", "09:00", "America/New_York")
    assert monday_start == datetime(2026, 10, 2, 13, 0, tzinfo=UTC)
    assert monday_end == WINDOW_START


def test_a_weekly_window_is_seven_days() -> None:
    """A weekly digest reaches back one week to the same local time."""
    start, end = window_for(TUESDAY, "weekly", "09:00", "UTC")
    assert end - start == timedelta(days=7)
    assert end == datetime(2026, 10, 6, 9, 0, tzinfo=UTC)


def test_a_window_across_daylight_saving_keeps_local_time() -> None:
    """Over the November change the window is an hour longer in UTC and both ends sit at 09:00 local."""
    start, end = window_for(date(2026, 11, 2), "daily", "09:00", "America/New_York")
    assert start == datetime(2026, 10, 30, 13, 0, tzinfo=UTC)
    assert end == datetime(2026, 11, 2, 14, 0, tzinfo=UTC)
    assert end - start == timedelta(hours=73)


def test_an_unknown_timezone_or_time_is_refused() -> None:
    """A zone the database lacks and a malformed send time raise the window error."""
    with pytest.raises(StandupWindowError):
        window_for(TUESDAY, "daily", "09:00", "Mars/Olympus")
    with pytest.raises(StandupWindowError):
        window_for(TUESDAY, "daily", "nine", "UTC")


def test_the_next_digest_date_skips_weekends_and_cut_digests() -> None:
    """A note written Friday after send time lands in Monday's digest."""
    settings = default_standup_settings(WORKSPACE, TEAM).model_copy(update={"cadence": "daily"})
    friday_evening = datetime(2026, 10, 9, 18, 0, tzinfo=UTC)
    friday_morning = datetime(2026, 10, 9, 8, 0, tzinfo=UTC)
    assert next_digest_date(settings, friday_evening) == date(2026, 10, 12)
    assert next_digest_date(settings, friday_morning) == date(2026, 10, 9)
    weekly = settings.model_copy(update={"cadence": "weekly", "weekday": 2})
    assert next_digest_date(weekly, friday_evening) == date(2026, 10, 14)


def test_the_window_edges_are_start_inclusive_and_end_exclusive(repositories: Any, workspace: str) -> None:
    """A change at the start counts, one at the end and one just before the start do not."""
    eastern(repositories)
    at_start, at_end, before = (make_issue(repositories, n) for n in (1, 2, 3))
    move(repositories, at_start, "completed", WINDOW_START, MEMBER)
    move(repositories, at_end, "completed", WINDOW_END, MEMBER)
    move(repositories, before, "completed", WINDOW_START - timedelta(microseconds=1), MEMBER)

    digest = build_digest(repositories, WORKSPACE, TEAM, TUESDAY)

    assert (digest.window_start, digest.window_end) == (WINDOW_START, WINDOW_END)
    assert keys(person(digest, MEMBER).completed) == ["ABC-1"]


def test_sections_come_from_status_changes_comments_and_open_state(repositories: Any, workspace: str) -> None:
    """Completed beats started for one issue, automation credits the assignee, and open issues carry state."""
    eastern(repositories)
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    inside = WINDOW_START + timedelta(hours=2)
    shipped = make_issue(repositories, 1)
    started = make_issue(repositories, 2, assignee_id=MEMBER)
    merged = make_issue(repositories, 3, assignee_id=GUEST)
    make_issue(repositories, 4, assignee_id=MEMBER, blocked_by_open_count=1)
    make_issue(repositories, 5, assignee_id=MEMBER, due_date="2026-10-05")
    make_issue(repositories, 6, due_date="2026-10-09")
    make_issue(repositories, 7, assignee_id=MEMBER, due_date="2026-10-10")
    elsewhere = make_issue(repositories, 8, team_id=OTHER_TEAM, prefix="XYZ")
    move(repositories, shipped, "started", inside, MEMBER)
    move(repositories, shipped, "completed", inside + timedelta(hours=1), MEMBER)
    move(repositories, started, "started", inside, MEMBER)
    move(repositories, merged, "completed", inside, "github", kind="github")
    move(repositories, elsewhere, "completed", inside, MEMBER)
    for issue_id, team_id in ((started.issue_id, TEAM), (started.issue_id, TEAM), (elsewhere.issue_id, OTHER_TEAM)):
        comment = build_comment(WORKSPACE, issue_id, team_id, MEMBER, "On it")
        repositories.comments.create(comment.model_copy(update={"created_at": inside}))

    digest = build_digest(repositories, WORKSPACE, TEAM, TUESDAY)

    member = person(digest, MEMBER)
    assert keys(member.completed) == ["ABC-1"]
    assert keys(member.started) == ["ABC-2"]
    assert keys(member.commented) == ["ABC-2"]
    assert member.commented[0].count == 2
    assert keys(member.blocked) == ["ABC-4"]
    assert keys(member.overdue) == ["ABC-5"]
    assert member.due_soon == []
    assert keys(person(digest, GUEST).completed) == ["ABC-3"]
    assert keys(person(digest, "").due_soon) == ["ABC-6"]
    assert person(digest, "").display_name == "Unassigned"


def test_project_updates_in_the_window_are_listed(repositories: Any, workspace: str) -> None:
    """An update posted on one of the team's projects in the window belongs to its author."""
    eastern(repositories)
    project = Project(
        workspace_id=WORKSPACE,
        planning_key=project_key("01JB0000000000000000PROJ01"),
        project_id="01JB0000000000000000PROJ01",
        team_ids=[TEAM],
        name="Launch",
        created_by=OWNER,
        last_update_at=WINDOW_START + timedelta(hours=1),
    )
    repositories.planning.create_project(project)
    for update_id, at in (
        ("01JB000000000000000000UPD1", WINDOW_START + timedelta(hours=1)),
        ("01JB000000000000000000UPD2", WINDOW_START - timedelta(hours=1)),
    ):
        repositories.planning.create_project_update(
            ProjectUpdateRow(
                workspace_id=WORKSPACE,
                planning_key=project_update_key(project.project_id, update_id),
                update_id=update_id,
                project_id=project.project_id,
                body="On track",
                health="on_track",
                author_id=ADMIN,
                created_at=at,
            )
        )

    digest = build_digest(repositories, WORKSPACE, TEAM, TUESDAY)

    updates = person(digest, ADMIN).project_updates
    assert [(row.update_id, row.project_name) for row in updates] == [("01JB000000000000000000UPD1", "Launch")]


def test_an_empty_day_lists_members_with_nothing(client: TestClient, workspace: str, repositories: Any) -> None:
    """A team with no activity still answers, with each member present and empty."""
    sign_in(client, GUEST)

    response = client.get(PATH, params={"date": "2026-10-06"})

    assert response.status_code == 200
    body = response.json()
    assert body["date"] == "2026-10-06"
    assert body["cadence"] == "daily"
    guest = person(body, GUEST)
    assert guest["display_name"] == "Gus Guest"
    assert all(guest[section] == [] for section in ("completed", "started", "commented", "blocked"))


def test_the_route_refuses_a_bad_date_and_an_unseen_team(client: TestClient, workspace: str) -> None:
    """A malformed date is a 422, and a guest cannot read a team it is outside of."""
    sign_in(client, GUEST)

    assert client.get(PATH, params={"date": "06/10/2026"}).status_code == 422
    other = client.get(f"/api/workspaces/{WORKSPACE}/teams/{OTHER_TEAM}/standup")
    assert other.status_code in (403, 404)


def test_a_note_lands_in_its_digest(client: TestClient, workspace: str, repositories: Any) -> None:
    """A note written for a date appears beside its author in that date's digest and can be removed."""
    sign_in(client, GUEST)

    written = client.put(
        f"{PATH}/note", json={"body": "  Today I'm on ABC-2, blocked by review  ", "date": "2026-10-06"}
    )
    read = client.get(f"{PATH}/note", params={"date": "2026-10-06"})
    digest = client.get(PATH, params={"date": "2026-10-06"}).json()

    assert written.status_code == 200
    assert written.json()["body"] == "Today I'm on ABC-2, blocked by review"
    assert read.json()["body"] == written.json()["body"]
    assert person(digest, GUEST)["note"] == written.json()["body"]
    assert client.delete(f"{PATH}/note", params={"date": "2026-10-06"}).status_code == 204
    assert client.delete(f"{PATH}/note", params={"date": "2026-10-06"}).status_code == 404
    assert client.get(f"{PATH}/note", params={"date": "2026-10-06"}).json()["body"] is None


def test_a_note_without_a_date_goes_to_the_next_digest(client: TestClient, workspace: str) -> None:
    """Leaving the date out writes to the date the settings name as next."""
    sign_in(client, GUEST)
    next_date = client.get(f"{PATH}/settings").json()["next_digest_date"]

    written = client.put(f"{PATH}/note", json={"body": "Pairing on onboarding"})

    assert written.json()["date"] == next_date


def test_settings_default_off_and_an_admin_changes_them(client: TestClient, workspace: str) -> None:
    """Defaults read as off at 09:00 UTC; an unknown zone is refused and a valid change is stored."""
    sign_in(client, ADMIN)

    default = client.get(f"{PATH}/settings").json()
    refused = client.patch(f"{PATH}/settings", json={"timezone": "Mars/Olympus"})
    saved = client.patch(
        f"{PATH}/settings", json={"cadence": "weekly", "send_time": "16:30", "timezone": "Europe/Berlin"}
    )

    assert (default["cadence"], default["send_time"], default["timezone"]) == ("off", "09:00", "UTC")
    assert refused.status_code == 422
    assert saved.status_code == 200
    assert (saved.json()["cadence"], saved.json()["send_time"], saved.json()["timezone"]) == (
        "weekly",
        "16:30",
        "Europe/Berlin",
    )
    assert client.get(PATH, params={"date": "2026-10-06"}).json()["cadence"] == "weekly"
    assert client.patch(f"{PATH}/settings", json={"send_time": "25:00"}).status_code == 422


def test_the_mcp_tool_returns_the_route_digest(client: TestClient, workspace: str, repositories: Any) -> None:
    """`get_standup` answers the same digest the route does, and the note tool writes the caller's note."""
    secret = mint_for(repositories, GUEST, ("teams:read", "comments:write"))
    answer(tool(client, secret, "set_standup_note", {"team_id": "ABC", "body": "Reviewing", "date": "2026-10-06"}))

    via_tool = answer(tool(client, secret, "get_standup", {"team_id": "ABC", "date": "2026-10-06"}))
    sign_in(client, GUEST)
    via_route = client.get(PATH, params={"date": "2026-10-06"}).json()
    sign_out(client)

    via_tool.pop("generated_at")
    via_route.pop("generated_at")
    assert via_tool == via_route
    assert person(via_tool, GUEST)["note"] == "Reviewing"
    cleared = answer(tool(client, secret, "set_standup_note", {"team_id": "ABC", "body": "", "date": "2026-10-06"}))
    assert cleared["body"] is None


def test_the_settings_tool_needs_team_admin(client: TestClient, workspace: str, repositories: Any) -> None:
    """A team admin changes the schedule through MCP; a bad zone is a tool error."""
    secret = mint_for(repositories, ADMIN, ("teams:write",))

    saved = answer(tool(client, secret, "update_standup_settings", {"team_id": TEAM, "cadence": "daily"}))
    bad = refusal(tool(client, secret, "update_standup_settings", {"team_id": TEAM, "timezone": "Nowhere/Land"}))

    assert saved["cadence"] == "daily"
    assert "timezone" in bad.lower()
