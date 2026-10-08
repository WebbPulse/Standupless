"""SLA timers on issues: when they start, move and stop, and the list filter on them.

The properties held follow Linear: an open issue of a ruled priority gets a
deadline when it is created, leaves triage or reopens; a priority change keeps
the start and moves the deadline, or drops it for a priority with no rule;
moving between open statuses keeps it; finishing the issue drops it. The list
answers each issue's SLA status and filters on it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import default_sla_settings, default_triage_settings
from app.common.sla import at_risk_from, sla_status
from tests.domains.helpers import MEMBER, OWNER, add_team_member, sign_in
from tests.domains.issues.conftest import TEAM, WORKSPACE, create_issue

BASE = f"/api/workspaces/{WORKSPACE}/issues"

START = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)


def _enable(repositories: Any, **hours: Any) -> None:
    """Turn `TEAM`'s SLAs on straight in the table, with any hours overridden."""
    settings = default_sla_settings(WORKSPACE, TEAM).model_copy(update={"enabled": True, **hours})
    repositories.team_config.put_sla_settings(settings)


def _at(value: str | None) -> datetime | None:
    """One answered timestamp as a datetime."""
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def _patch(client: TestClient, issue_id: str, **body: Any) -> dict[str, Any]:
    """Patch one issue, failing loudly on a refusal."""
    response = client.patch(f"{BASE}/{issue_id}", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _timed(started: datetime, hours: int) -> Issue:
    """A bare issue carrying a timer of `hours` from `started`."""
    return Issue(
        workspace_id=WORKSPACE,
        team_id=TEAM,
        key="ABC-1",
        number=1,
        title="Timed",
        status_id="s",
        created_by=OWNER,
        sla_started_at=started,
        sla_breaches_at=started + timedelta(hours=hours),
    )


def test_status_reads_against_the_clock() -> None:
    """On track, then at risk for the last quarter of the window, then breached."""
    issue = _timed(START, 72)

    assert sla_status(issue, START) == "on_track"
    assert sla_status(issue, START + timedelta(hours=53)) == "on_track"
    assert sla_status(issue, START + timedelta(hours=54)) == "at_risk"
    assert sla_status(issue, START + timedelta(hours=72)) == "breached"
    assert sla_status(issue.model_copy(update={"sla_breaches_at": None})) == "none"


def test_at_risk_is_capped_at_a_day_before() -> None:
    """A long window turns at risk a day out rather than a quarter of the way from the end."""
    issue = _timed(START, 720)

    assert at_risk_from(START, START + timedelta(hours=720)) == START + timedelta(hours=696)
    assert sla_status(issue, START + timedelta(hours=695)) == "on_track"
    assert sla_status(issue, START + timedelta(hours=697)) == "at_risk"


def test_an_archived_issue_reads_as_none() -> None:
    """Archiving hides the SLA, as the issue has left every open view."""
    issue = _timed(START, 24).model_copy(update={"archived_at": START})

    assert sla_status(issue, START) == "none"


def test_no_timer_while_slas_are_off(client: TestClient, workspace: str) -> None:
    """A team that never turned SLAs on puts no deadline on an urgent issue."""
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE, priority="urgent")

    assert issue["sla_breaches_at"] is None
    assert issue["sla_status"] == "none"


def test_creating_a_ruled_issue_starts_its_timer(client: TestClient, workspace: str, repositories: Any) -> None:
    """An urgent issue breaches a day after it was filed."""
    _enable(repositories)
    sign_in(client, OWNER)
    before = utc_now()
    issue = create_issue(client, WORKSPACE, priority="urgent")

    started, breaches = _at(issue["sla_started_at"]), _at(issue["sla_breaches_at"])
    assert started is not None and breaches is not None
    assert started >= before - timedelta(seconds=1)
    assert breaches - started == timedelta(hours=24)
    assert issue["sla_status"] == "on_track"


def test_an_unruled_priority_gets_no_timer(client: TestClient, workspace: str, repositories: Any) -> None:
    """Medium has no rule by default, and no priority never has one."""
    _enable(repositories)
    sign_in(client, OWNER)

    assert create_issue(client, WORKSPACE, priority="medium")["sla_breaches_at"] is None
    assert create_issue(client, WORKSPACE)["sla_breaches_at"] is None


def test_a_priority_change_keeps_the_start_and_moves_the_deadline(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Lowering urgent to high gives the issue three days from when it was filed."""
    _enable(repositories)
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE, priority="urgent")

    moved = _patch(client, issue["id"], priority="high")

    started = _at(issue["sla_started_at"])
    assert started is not None
    assert moved["sla_started_at"] == issue["sla_started_at"]
    assert _at(moved["sla_breaches_at"]) == started + timedelta(hours=72)


def test_raising_to_a_ruled_priority_starts_a_timer(client: TestClient, workspace: str, repositories: Any) -> None:
    """An issue with no priority gets a deadline once someone marks it high."""
    _enable(repositories)
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE)

    raised = _patch(client, issue["id"], priority="high")

    started, breaches = _at(raised["sla_started_at"]), _at(raised["sla_breaches_at"])
    assert started is not None and breaches is not None
    assert breaches - started == timedelta(hours=72)


def test_a_priority_without_a_rule_drops_the_timer(client: TestClient, workspace: str, repositories: Any) -> None:
    """Moving to low, which has no rule, clears the deadline."""
    _enable(repositories)
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE, priority="urgent")

    lowered = _patch(client, issue["id"], priority="low")

    assert lowered["sla_started_at"] is None
    assert lowered["sla_breaches_at"] is None
    assert lowered["sla_status"] == "none"


def test_moving_between_open_statuses_keeps_the_timer(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Starting work does not reset the clock."""
    _enable(repositories)
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE, priority="urgent", status_id=statuses["unstarted"].status_id)

    started = _patch(client, issue["id"], status_id=statuses["started"].status_id)

    assert started["sla_started_at"] == issue["sla_started_at"]
    assert started["sla_breaches_at"] == issue["sla_breaches_at"]


def test_finishing_drops_the_timer_and_reopening_starts_a_fresh_one(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A completed issue has no SLA, and one reopened gets a whole new window."""
    _enable(repositories)
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE, priority="urgent")

    done = _patch(client, issue["id"], status_id=statuses["completed"].status_id)
    assert done["sla_breaches_at"] is None
    reopened = _patch(client, issue["id"], status_id=statuses["started"].status_id)

    fresh, first = _at(reopened["sla_started_at"]), _at(issue["sla_started_at"])
    assert reopened["sla_breaches_at"] is not None
    assert fresh is not None and first is not None and fresh >= first


def test_an_issue_created_finished_has_no_timer(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Filing an urgent issue straight into cancelled starts nothing."""
    _enable(repositories)
    sign_in(client, OWNER)

    assert (
        create_issue(client, WORKSPACE, priority="urgent", status_id=statuses["cancelled"].status_id)["sla_breaches_at"]
        is None
    )


def test_triage_holds_the_timer_until_accepted(client: TestClient, workspace: str, repositories: Any) -> None:
    """An issue awaiting triage has no SLA; accepting it starts one."""
    _enable(repositories)
    repositories.team_config.put_triage_settings(
        default_triage_settings(WORKSPACE, TEAM).model_copy(update={"enabled": True})
    )
    add_team_member(repositories, WORKSPACE, TEAM, OWNER, "admin")
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE, priority="urgent")
    assert waiting["in_triage"] is True
    assert waiting["sla_breaches_at"] is None

    sign_in(client, OWNER)
    response = client.post(f"{BASE}/{waiting['id']}/triage/accept")

    assert response.status_code == 200, response.text
    assert response.json()["sla_status"] == "on_track"


def _backdate(repositories: Any, issue_id: str, started: datetime, hours: int) -> None:
    """Move an issue's timer into the past straight in the table."""
    row = repositories.issues.get(WORKSPACE, issue_id)
    repositories.issues.replace(
        row.model_copy(update={"sla_started_at": started, "sla_breaches_at": started + timedelta(hours=hours)})
    )


def _listed(client: TestClient, **params: Any) -> set[str]:
    """The ids the issue list answers for these filters."""
    response = client.get(BASE, params={"team_id": TEAM, **params})
    assert response.status_code == 200, response.text
    return {row["id"] for row in response.json()["issues"]}


def test_the_list_filters_on_sla_status(client: TestClient, workspace: str, repositories: Any) -> None:
    """Breached, at risk, on track and none each find their own issues, and they OR together."""
    _enable(repositories)
    sign_in(client, OWNER)
    now = utc_now()
    breached = create_issue(client, WORKSPACE, priority="urgent", title="Breached")
    at_risk = create_issue(client, WORKSPACE, priority="urgent", title="At risk")
    on_track = create_issue(client, WORKSPACE, priority="high", title="On track")
    unruled = create_issue(client, WORKSPACE, priority="low", title="No SLA")
    _backdate(repositories, breached["id"], now - timedelta(hours=30), 24)
    _backdate(repositories, at_risk["id"], now - timedelta(hours=20), 24)

    assert _listed(client, sla_status="breached") == {breached["id"]}
    assert _listed(client, sla_status="at_risk") == {at_risk["id"]}
    assert _listed(client, sla_status="on_track") == {on_track["id"]}
    assert _listed(client, sla_status="none") == {unruled["id"]}
    assert _listed(client, sla_status=["at_risk", "breached"]) == {breached["id"], at_risk["id"]}
    rows = client.get(BASE, params={"team_id": TEAM, "sla_status": "breached"}).json()["issues"]
    assert rows[0]["sla_status"] == "breached"


def test_an_unknown_sla_status_is_refused(client: TestClient, workspace: str) -> None:
    """A misspelt state is a 422 rather than a filter that matches nothing."""
    sign_in(client, OWNER)
    assert client.get(BASE, params={"sla_status": "late"}).status_code == 422
