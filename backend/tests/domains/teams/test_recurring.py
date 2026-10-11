"""Recurring issue routes: who keeps them, what a schedule must name, and how pause and resume move it.

A team member keeps the team's schedules. A schedule names a template the team
offers and a rule that can run, defaults to the team's standup timezone, and
answers its next run truthfully: none while paused, and from now on a resume.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.team_config import StandupSettings, standup_settings_key
from tests.domains.helpers import GUEST, OWNER, add_member, add_team_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000TEM1"

OTHER = "01JB000000000000000000TEM2"

WRITER = "01JB00000000000000000WRITR"

BASE = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}"


@pytest.fixture
def teams(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, where schedules are kept, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A team with a writer, a second team, and a guest of the second team only."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, WRITER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_team(repositories, WORKSPACE, TEAM, "ENG")
    make_team(repositories, WORKSPACE, OTHER, "OPS")
    add_team_member(repositories, WORKSPACE, TEAM, WRITER, "member")
    add_team_member(repositories, WORKSPACE, OTHER, GUEST, "member")
    return WORKSPACE


def _template(client: TestClient, team_id: str = TEAM, name: str = "Weekly review") -> str:
    """Save one team template and answer its id."""
    response = client.post(
        f"/api/workspaces/{WORKSPACE}/teams/{team_id}/templates", json={"name": name, "title": "Review"}
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def _create(client: TestClient, **fields: Any) -> dict[str, Any]:
    """Create one schedule and answer it."""
    response = client.post(f"{BASE}/recurring-issues", json=fields)
    assert response.status_code == 201, response.text
    return response.json()


def _at(value: str) -> datetime:
    """An API timestamp as an aware datetime."""
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def test_a_member_creates_lists_and_deletes_a_schedule(teams: TestClient, workspace: str) -> None:
    """A weekly schedule answers its template name, a next run and a preview, and deletes cleanly."""
    sign_in(teams, WRITER)
    template_id = _template(teams)
    created = _create(
        teams, template_id=template_id, frequency="weekly", weekdays=[4, 0, 4], time="10:30", timezone="UTC"
    )

    assert created["template_name"] == "Weekly review"
    assert created["weekdays"] == [0, 4]
    assert created["paused"] is False
    assert created["created_by"] == WRITER
    next_run = _at(created["next_run_at"])
    assert (next_run.hour, next_run.minute) == (10, 30)
    assert next_run.weekday() in (0, 4)
    assert len(created["upcoming_runs"]) == 3
    assert all(_at(run) > next_run for run in created["upcoming_runs"])

    listed = teams.get(f"{BASE}/recurring-issues")
    assert listed.status_code == 200, listed.text
    assert [row["id"] for row in listed.json()["recurring_issues"]] == [created["id"]]
    assert listed.json()["default_timezone"] == "UTC"

    one = teams.get(f"{BASE}/recurring-issues/{created['id']}")
    assert one.status_code == 200, one.text

    deleted = teams.delete(f"{BASE}/recurring-issues/{created['id']}")
    assert deleted.status_code == 204, deleted.text
    gone = teams.get(f"{BASE}/recurring-issues/{created['id']}")
    assert gone.status_code == 404, gone.text


def test_the_timezone_defaults_to_the_team_standup_timezone(
    teams: TestClient, workspace: str, repositories: Any
) -> None:
    """A schedule with no timezone takes the one the team's standup runs in."""
    repositories.team_config.put_standup_settings(
        StandupSettings(
            workspace_id=WORKSPACE,
            config_key=standup_settings_key(TEAM),
            team_id=TEAM,
            timezone="America/New_York",
        )
    )
    sign_in(teams, WRITER)
    created = _create(teams, template_id=_template(teams), frequency="daily")

    assert created["timezone"] == "America/New_York"
    assert created["time"] == "09:00"
    assert _at(created["next_run_at"]).hour in (13, 14)
    assert teams.get(f"{BASE}/recurring-issues").json()["default_timezone"] == "America/New_York"


@pytest.mark.parametrize(
    "fields",
    [
        {"frequency": "weekly"},
        {"frequency": "monthly"},
        {"frequency": "daily", "timezone": "Mars/Olympus"},
        {"frequency": "daily", "time": "25:00"},
        {"frequency": "daily", "weekdays": [7]},
        {"frequency": "yearly"},
    ],
)
def test_a_rule_that_cannot_run_is_refused(teams: TestClient, workspace: str, fields: dict[str, Any]) -> None:
    """A weekly schedule with no weekdays, a monthly one with no day, or a bad zone is a 422."""
    sign_in(teams, WRITER)
    response = teams.post(f"{BASE}/recurring-issues", json={"template_id": _template(teams), **fields})
    assert response.status_code == 422, response.text


def test_the_template_must_be_one_the_team_offers(teams: TestClient, workspace: str, repositories: Any) -> None:
    """An unknown template, or another team's, is a 422."""
    add_team_member(repositories, WORKSPACE, OTHER, WRITER, "member")
    sign_in(teams, WRITER)
    foreign = _template(teams, OTHER, "Ops review")
    for template_id in ("nope", foreign):
        response = teams.post(f"{BASE}/recurring-issues", json={"template_id": template_id, "frequency": "daily"})
        assert response.status_code == 422, response.text


def test_a_guest_outside_the_team_cannot_see_or_write_schedules(teams: TestClient, workspace: str) -> None:
    """A guest of another team gets a 404 on both the list and a create."""
    sign_in(teams, WRITER)
    template_id = _template(teams)
    sign_in(teams, GUEST)
    assert teams.get(f"{BASE}/recurring-issues").status_code == 404
    refused = teams.post(f"{BASE}/recurring-issues", json={"template_id": template_id, "frequency": "daily"})
    assert refused.status_code == 404, refused.text


def test_pause_clears_the_next_run_and_resume_sets_it_from_now(teams: TestClient, workspace: str) -> None:
    """A paused schedule shows no next run or preview; resuming schedules it again."""
    sign_in(teams, WRITER)
    created = _create(teams, template_id=_template(teams), frequency="monthly", day_of_month=31)
    path = f"{BASE}/recurring-issues/{created['id']}"

    paused = teams.patch(path, json={"paused": True})
    assert paused.status_code == 200, paused.text
    assert paused.json()["paused"] is True
    assert paused.json()["next_run_at"] is None
    assert paused.json()["upcoming_runs"] == []

    resumed = teams.patch(path, json={"paused": False})
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["paused"] is False
    assert resumed.json()["next_run_at"] is not None
    assert resumed.json()["paused_reason"] is None


def test_a_rule_edit_moves_the_next_run(teams: TestClient, workspace: str) -> None:
    """Changing the time reschedules; a null rule field is refused."""
    sign_in(teams, WRITER)
    created = _create(teams, template_id=_template(teams), frequency="daily", time="09:00", timezone="UTC")
    path = f"{BASE}/recurring-issues/{created['id']}"

    moved = teams.patch(path, json={"time": "17:45"})
    assert moved.status_code == 200, moved.text
    assert (_at(moved.json()["next_run_at"]).hour, _at(moved.json()["next_run_at"]).minute) == (17, 45)

    refused = teams.patch(path, json={"frequency": None})
    assert refused.status_code == 422, refused.text


def test_a_created_paused_schedule_has_no_next_run(teams: TestClient, workspace: str) -> None:
    """A schedule saved paused waits for a resume."""
    sign_in(teams, WRITER)
    created = _create(teams, template_id=_template(teams), frequency="daily", paused=True)
    assert created["paused"] is True
    assert created["next_run_at"] is None


def test_a_team_keeps_a_bounded_number_of_schedules(teams: TestClient, workspace: str, monkeypatch: Any) -> None:
    """Past the cap a create is a 422."""
    monkeypatch.setattr("app.common.recurring_issues.MAX_PER_TEAM", 1)
    sign_in(teams, WRITER)
    template_id = _template(teams)
    _create(teams, template_id=template_id, frequency="daily")
    refused = teams.post(f"{BASE}/recurring-issues", json={"template_id": template_id, "frequency": "daily"})
    assert refused.status_code == 422, refused.text
