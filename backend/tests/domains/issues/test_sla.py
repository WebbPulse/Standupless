"""SLA timers on issues: when they start, move and stop, and the list filter on them.

The properties held follow Linear: an open issue of a ruled priority gets a
deadline when it is created, leaves triage or reopens; a priority change keeps
the start and moves the deadline, or drops it for a priority with no rule;
moving between open statuses keeps it; finishing the issue drops it. The list
answers each issue's SLA status and filters on it. Time in a status the team
pauses does not count, and leaving it resumes with the time that was left.
A team counting from creation keeps the timer through triage, from `created_at`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import default_sla_settings, default_triage_settings
from app.common.sla import apply_sla, at_risk_from, sla_breach_key, sla_status
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


def test_the_breach_key_puts_running_timers_first_and_archived_last() -> None:
    """A running timer sorts by its deadline; none, or an archived issue's, sorts after every running one."""
    soon = _timed(START, 1)
    later = _timed(START, 48).model_copy(update={"issue_id": "later"})
    bare = soon.model_copy(update={"issue_id": "bare", "sla_started_at": None, "sla_breaches_at": None})
    archived = soon.model_copy(update={"issue_id": "archived", "archived_at": START})

    ordered = sorted([bare, later, archived, soon], key=sla_breach_key)

    assert ordered[:2] == [soon, later]
    assert {issue.issue_id for issue in ordered[2:]} == {"bare", "archived"}


def test_the_list_sorts_by_sla_breach(client: TestClient, workspace: str, repositories: Any) -> None:
    """Soonest breach first, already breached ahead of the rest, issues without a running SLA last."""
    _enable(repositories)
    sign_in(client, OWNER)
    now = utc_now()
    unruled = create_issue(client, WORKSPACE, priority="low", title="No SLA")
    on_track = create_issue(client, WORKSPACE, priority="high", title="On track")
    at_risk = create_issue(client, WORKSPACE, priority="urgent", title="At risk")
    breached = create_issue(client, WORKSPACE, priority="urgent", title="Breached")
    _backdate(repositories, breached["id"], now - timedelta(hours=30), 24)
    _backdate(repositories, at_risk["id"], now - timedelta(hours=20), 24)

    response = client.get(BASE, params={"team_id": TEAM, "sort": "sla_asc", "limit": 100})

    assert response.status_code == 200, response.text
    assert [row["id"] for row in response.json()["issues"]] == [
        breached["id"],
        at_risk["id"],
        on_track["id"],
        unruled["id"],
    ]


def _in(status_id: str, priority: str = "urgent") -> Issue:
    """A bare issue of `TEAM` in one status, with no timer yet."""
    return Issue(
        workspace_id=WORKSPACE,
        team_id=TEAM,
        key="ABC-9",
        number=9,
        title="Paused",
        status_id=status_id,
        priority=priority,
        created_by=OWNER,
    )


def _move(repositories: Any, issue: Issue, at: datetime, **changes: Any) -> Issue:
    """`issue` with `changes` applied and its timer recomputed at `at`."""
    moved = issue.model_copy(update=changes)
    apply_sla(repositories, issue, moved, at)
    return moved


def test_a_paused_status_stops_the_clock_and_leaving_resumes_with_the_time_left(
    workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Six hours used, two days paused, then the remaining eighteen hours run from the resume."""
    todo, staging = statuses["unstarted"].status_id, statuses["started"].status_id
    _enable(repositories, paused_status_ids=[staging])
    issue = _in(todo)
    apply_sla(repositories, None, issue, START)

    paused = _move(repositories, issue, START + timedelta(hours=6), status_id=staging)
    assert paused.sla_paused_at == START + timedelta(hours=6)
    assert paused.sla_breaches_at == START + timedelta(hours=24)
    assert sla_status(paused, START + timedelta(hours=48)) == "on_track"

    resumed = _move(repositories, paused, START + timedelta(hours=48), status_id=todo)
    assert resumed.sla_paused_at is None
    assert resumed.sla_started_at == START + timedelta(hours=42)
    assert resumed.sla_breaches_at == START + timedelta(hours=66)
    assert sla_status(resumed, START + timedelta(hours=59)) == "on_track"
    assert sla_status(resumed, START + timedelta(hours=60)) == "at_risk"
    assert sla_status(resumed, START + timedelta(hours=66)) == "breached"


def test_without_the_pause_the_same_moves_breach(workspace: str, repositories: Any, statuses: "dict[str, Any]") -> None:
    """The control: a team that pauses nothing reads the same issue as breached two days in."""
    todo, staging = statuses["unstarted"].status_id, statuses["started"].status_id
    _enable(repositories)
    issue = _in(todo)
    apply_sla(repositories, None, issue, START)

    staged = _move(repositories, issue, START + timedelta(hours=6), status_id=staging)

    assert staged.sla_paused_at is None
    assert sla_status(staged, START + timedelta(hours=48)) == "breached"


def test_a_breach_the_pause_held_off(workspace: str, repositories: Any, statuses: "dict[str, Any]") -> None:
    """An issue whose deadline passed while paused is not breached on leaving, only once its time runs out."""
    todo, staging = statuses["unstarted"].status_id, statuses["started"].status_id
    _enable(repositories, paused_status_ids=[staging])
    issue = _in(todo)
    apply_sla(repositories, None, issue, START)

    paused = _move(repositories, issue, START + timedelta(hours=20), status_id=staging)
    assert sla_status(paused, START + timedelta(hours=30)) == "at_risk"
    resumed = _move(repositories, paused, START + timedelta(hours=100), status_id=todo)

    assert sla_status(resumed, START + timedelta(hours=100)) == "at_risk"
    assert sla_status(resumed, START + timedelta(hours=103, minutes=59)) == "at_risk"
    assert sla_status(resumed, START + timedelta(hours=104)) == "breached"


def test_moving_between_paused_statuses_keeps_the_first_pause(
    workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """The pause runs from when the issue first entered a paused status."""
    backlog, staging = statuses["backlog"].status_id, statuses["started"].status_id
    _enable(repositories, paused_status_ids=[backlog, staging])
    issue = _in(statuses["unstarted"].status_id)
    apply_sla(repositories, None, issue, START)

    first = _move(repositories, issue, START + timedelta(hours=2), status_id=backlog)
    second = _move(repositories, first, START + timedelta(hours=5), status_id=staging)

    assert second.sla_paused_at == START + timedelta(hours=2)


def test_an_issue_filed_into_a_paused_status_starts_paused(
    workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """The timer starts with its whole window and stands still until the issue moves on."""
    staging = statuses["started"].status_id
    _enable(repositories, paused_status_ids=[staging])
    issue = _in(staging)

    apply_sla(repositories, None, issue, START)
    resumed = _move(repositories, issue, START + timedelta(hours=10), status_id=statuses["unstarted"].status_id)

    assert issue.sla_paused_at == START
    assert resumed.sla_breaches_at == START + timedelta(hours=34)


def test_a_priority_change_while_paused_counts_from_the_shifted_start(
    workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Paused time stays out of the window when the deadline moves to the new priority's hours."""
    todo, staging = statuses["unstarted"].status_id, statuses["started"].status_id
    _enable(repositories, paused_status_ids=[staging])
    issue = _in(todo)
    apply_sla(repositories, None, issue, START)
    paused = _move(repositories, issue, START + timedelta(hours=4), status_id=staging)
    resumed = _move(repositories, paused, START + timedelta(hours=14), status_id=todo)

    raised = _move(repositories, resumed, START + timedelta(hours=15), priority="high")

    assert raised.sla_breaches_at == START + timedelta(hours=82)


def test_finishing_a_paused_issue_drops_the_pause(
    workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A completed issue carries no timer and no pause."""
    staging = statuses["started"].status_id
    _enable(repositories, paused_status_ids=[staging])
    issue = _in(staging)
    apply_sla(repositories, None, issue, START)

    done = _move(repositories, issue, START + timedelta(hours=1), status_id=statuses["completed"].status_id)

    assert (done.sla_started_at, done.sla_breaches_at, done.sla_paused_at) == (None, None, None)


def test_a_paused_timer_sorts_by_the_deadline_it_would_have_now() -> None:
    """Paused an hour after a day-long start, it sorts after a timer breaching in two hours from now."""
    now = utc_now()
    paused = _timed(now - timedelta(hours=10), 24).model_copy(
        update={"issue_id": "paused", "sla_paused_at": now - timedelta(hours=9)}
    )
    soon = _timed(now - timedelta(hours=22), 24).model_copy(update={"issue_id": "soon"})

    assert [issue.issue_id for issue in sorted([paused, soon], key=sla_breach_key)] == ["soon", "paused"]


def test_the_route_answers_the_pause(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Moving into a paused status answers `sla_paused_at`, and moving out clears it and pushes the deadline."""
    todo, staging = statuses["unstarted"].status_id, statuses["started"].status_id
    _enable(repositories, paused_status_ids=[staging])
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE, priority="urgent", status_id=todo)

    paused = _patch(client, issue["id"], status_id=staging)
    resumed = _patch(client, issue["id"], status_id=todo)

    assert paused["sla_paused_at"] is not None
    assert paused["sla_breaches_at"] == issue["sla_breaches_at"]
    breaches, first = _at(resumed["sla_breaches_at"]), _at(issue["sla_breaches_at"])
    assert resumed["sla_paused_at"] is None
    assert breaches is not None and first is not None and breaches >= first


MODES = ("on_triage_exit", "on_creation")


def _triaged(status_id: str, priority: str = "urgent") -> Issue:
    """A bare issue of `TEAM` waiting in triage, filed at `START`, with no timer yet."""
    return _in(status_id, priority).model_copy(update={"in_triage": True, "created_at": START})


@pytest.mark.parametrize("mode", MODES)
def test_an_issue_filed_into_triage(workspace: str, repositories: Any, statuses: "dict[str, Any]", mode: str) -> None:
    """Waiting in triage holds the timer by default; creation mode starts it at filing."""
    _enable(repositories, start_mode=mode)
    issue = _triaged(statuses["unstarted"].status_id)

    apply_sla(repositories, None, issue, START)

    if mode == "on_creation":
        assert (issue.sla_started_at, issue.sla_breaches_at) == (START, START + timedelta(hours=24))
    else:
        assert (issue.sla_started_at, issue.sla_breaches_at) == (None, None)


@pytest.mark.parametrize("mode", MODES)
def test_accepting_from_triage(workspace: str, repositories: Any, statuses: "dict[str, Any]", mode: str) -> None:
    """Accepting starts the timer by default; creation mode keeps the one running since filing."""
    todo = statuses["unstarted"].status_id
    _enable(repositories, start_mode=mode)
    issue = _triaged(todo)
    apply_sla(repositories, None, issue, START)

    accepted = _move(repositories, issue, START + timedelta(hours=5), in_triage=False, status_id=todo)

    expected = START if mode == "on_creation" else START + timedelta(hours=5)
    assert accepted.sla_started_at == expected
    assert accepted.sla_breaches_at == expected + timedelta(hours=24)


@pytest.mark.parametrize("mode", MODES)
def test_declining_from_triage_drops_the_timer(
    workspace: str, repositories: Any, statuses: "dict[str, Any]", mode: str
) -> None:
    """A declined issue lands cancelled and carries no timer in either mode."""
    _enable(repositories, start_mode=mode)
    issue = _triaged(statuses["unstarted"].status_id)
    apply_sla(repositories, None, issue, START)

    declined = _move(
        repositories, issue, START + timedelta(hours=1), in_triage=False, status_id=statuses["cancelled"].status_id
    )

    assert (declined.sla_started_at, declined.sla_breaches_at, declined.sla_paused_at) == (None, None, None)


@pytest.mark.parametrize("mode", MODES)
def test_reopening_starts_a_fresh_window(
    workspace: str, repositories: Any, statuses: "dict[str, Any]", mode: str
) -> None:
    """A reopened issue counts from the reopen, not from when it was filed, in either mode."""
    todo = statuses["unstarted"].status_id
    _enable(repositories, start_mode=mode)
    issue = _in(todo).model_copy(update={"created_at": START})
    apply_sla(repositories, None, issue, START)
    done = _move(repositories, issue, START + timedelta(hours=2), status_id=statuses["completed"].status_id)

    reopened = _move(repositories, done, START + timedelta(hours=10), status_id=todo)

    assert done.sla_breaches_at is None
    assert reopened.sla_started_at == START + timedelta(hours=10)
    assert reopened.sla_breaches_at == START + timedelta(hours=34)


@pytest.mark.parametrize("mode", MODES)
def test_setting_a_priority_in_triage(workspace: str, repositories: Any, statuses: "dict[str, Any]", mode: str) -> None:
    """Creation mode counts a late priority from filing; the default waits for the accept."""
    todo = statuses["unstarted"].status_id
    _enable(repositories, start_mode=mode)
    issue = _triaged(todo, priority="none")
    apply_sla(repositories, None, issue, START)

    ruled = _move(repositories, issue, START + timedelta(hours=3), priority="urgent")
    accepted = _move(repositories, ruled, START + timedelta(hours=5), in_triage=False)

    if mode == "on_creation":
        assert (ruled.sla_started_at, ruled.sla_breaches_at) == (START, START + timedelta(hours=24))
        assert accepted.sla_started_at == START
    else:
        assert ruled.sla_breaches_at is None
        assert accepted.sla_started_at == START + timedelta(hours=5)


@pytest.mark.parametrize("mode", MODES)
def test_sending_back_to_triage(workspace: str, repositories: Any, statuses: "dict[str, Any]", mode: str) -> None:
    """Re-triaging drops the timer by default and keeps it in creation mode."""
    _enable(repositories, start_mode=mode)
    issue = _in(statuses["unstarted"].status_id).model_copy(update={"created_at": START})
    apply_sla(repositories, None, issue, START)

    waiting = _move(repositories, issue, START + timedelta(hours=2), in_triage=True)

    if mode == "on_creation":
        assert (waiting.sla_started_at, waiting.sla_breaches_at) == (START, START + timedelta(hours=24))
    else:
        assert waiting.sla_breaches_at is None


@pytest.mark.parametrize("mode", MODES)
def test_a_paused_status_after_triage(workspace: str, repositories: Any, statuses: "dict[str, Any]", mode: str) -> None:
    """Accepted into a paused status, the clock stands still and resumes with the time it had left."""
    todo, staging = statuses["unstarted"].status_id, statuses["started"].status_id
    _enable(repositories, start_mode=mode, paused_status_ids=[staging])
    issue = _triaged(todo)
    apply_sla(repositories, None, issue, START)

    paused = _move(repositories, issue, START + timedelta(hours=6), in_triage=False, status_id=staging)
    resumed = _move(repositories, paused, START + timedelta(hours=10), status_id=todo)

    assert paused.sla_paused_at == START + timedelta(hours=6)
    assert resumed.sla_paused_at is None
    expected = START + timedelta(hours=28) if mode == "on_creation" else START + timedelta(hours=34)
    assert resumed.sla_breaches_at == expected


def test_archiving_drops_a_timer_started_in_triage(
    workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """An archived issue reads as no SLA in creation mode, and its next watched change drops the timer."""
    _enable(repositories, start_mode="on_creation")
    issue = _triaged(statuses["unstarted"].status_id)
    apply_sla(repositories, None, issue, START)
    archived = issue.model_copy(update={"archived_at": START + timedelta(hours=1)})

    moved = _move(repositories, archived, START + timedelta(hours=2), priority="high")

    assert sla_status(archived, START + timedelta(hours=1)) == "none"
    assert (moved.sla_started_at, moved.sla_breaches_at) == (None, None)


def test_changing_the_mode_leaves_a_running_timer_alone(
    workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A timer started at the accept keeps that start after the team switches to creation mode."""
    todo = statuses["unstarted"].status_id
    _enable(repositories)
    issue = _triaged(todo)
    apply_sla(repositories, None, issue, START)
    accepted = _move(repositories, issue, START + timedelta(hours=5), in_triage=False, status_id=todo)

    _enable(repositories, start_mode="on_creation")
    raised = _move(repositories, accepted, START + timedelta(hours=7), priority="high")

    assert raised.sla_started_at == START + timedelta(hours=5)
    assert raised.sla_breaches_at == START + timedelta(hours=77)


def test_creation_mode_times_a_waiting_issue_through_the_routes(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """An issue filed into triage answers a running timer, and accepting it keeps the start."""
    _enable(repositories, start_mode="on_creation")
    repositories.team_config.put_triage_settings(
        default_triage_settings(WORKSPACE, TEAM).model_copy(update={"enabled": True})
    )
    add_team_member(repositories, WORKSPACE, TEAM, OWNER, "admin")
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE, priority="urgent")
    assert waiting["in_triage"] is True
    assert waiting["sla_status"] == "on_track"

    sign_in(client, OWNER)
    response = client.post(f"{BASE}/{waiting['id']}/triage/accept")

    assert response.status_code == 200, response.text
    assert response.json()["sla_started_at"] == waiting["sla_started_at"]
