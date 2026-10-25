"""Insights time measures: cycle, lead and triage time and issue age, with percentiles and points.

The properties worth holding are that each measure keeps only the issues it
applies to, that durations read from the issue's own stamps in hours, that the
percentiles interpolate deterministically, and that the count and points
measures answer exactly what they did before.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.common.insights import issue_hours, percentile, summarize_hours
from app.common.sla import stamp_triage
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.views.conftest import TEAM, seed_issue

BASE = datetime(2026, 10, 1, tzinfo=timezone.utc)


def insights(client: TestClient, workspace: str, **params: Any) -> "dict[str, Any]":
    """Read one breakdown, failing loudly on a refusal."""
    response = client.get(f"/api/workspaces/{workspace}/views/insights", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def stamp(repositories: Any, workspace: str, issue_id: str, **moments: Any) -> None:
    """Overwrite lifecycle stamps on one stored issue."""
    stored = repositories.issues.get(workspace, issue_id)
    repositories.issues.replace(stored.model_copy(update=moments))


def bare_issue(**fields: Any) -> Issue:
    """An unsaved issue for pure duration checks."""
    base: "dict[str, Any]" = {
        "workspace_id": "ws",
        "team_id": "team",
        "key": "ABC-1",
        "number": 1,
        "title": "One",
        "status_id": "status",
        "created_by": "user",
        "created_at": BASE,
    }
    base.update(fields)
    return Issue(**base)


def test_percentiles_interpolate_between_ranks() -> None:
    """Quartiles and the 95th percentile follow linear interpolation over the sorted set."""
    ordered = [1.0, 2.0, 3.0, 4.0, 5.0]
    assert percentile(ordered, 0.5) == 3.0
    assert percentile(ordered, 0.25) == 2.0
    assert percentile(ordered, 0.95) == pytest.approx(4.8)
    assert percentile([7.0], 0.95) == 7.0

    summary = summarize_hours([5.0, 1.0, 3.0, 2.0, 4.0])
    assert summary.count == 5
    assert summary.average == 3.0
    assert (summary.p25, summary.p50, summary.p75, summary.p95) == (2.0, 3.0, 4.0, 4.8)
    assert (summary.minimum, summary.maximum) == (1.0, 5.0)
    empty = summarize_hours([])
    assert empty.count == 0 and empty.p50 is None


def test_each_measure_reads_its_own_stamps_and_skips_issues_it_does_not_cover() -> None:
    """Cycle needs a start and a completion, lead a completion, triage both triage stamps."""
    now = BASE + timedelta(hours=100)
    done = bare_issue(started_at=BASE + timedelta(hours=10), completed_at=BASE + timedelta(hours=34))
    assert issue_hours(done, "cycle_time", now) == 24.0
    assert issue_hours(done, "lead_time", now) == 34.0
    assert issue_hours(done, "triage_time", now) is None
    assert issue_hours(done, "issue_age", now) == 100.0

    never_started = bare_issue(completed_at=BASE + timedelta(hours=5))
    assert issue_hours(never_started, "cycle_time", now) is None
    assert issue_hours(never_started, "lead_time", now) == 5.0

    open_issue = bare_issue(started_at=BASE)
    assert issue_hours(open_issue, "cycle_time", now) is None
    assert issue_hours(open_issue, "lead_time", now) is None

    triaged = bare_issue(triage_entered_at=BASE, triaged_at=BASE + timedelta(minutes=90))
    assert issue_hours(triaged, "triage_time", now) == 1.5


def test_stamp_triage_marks_entry_and_exit() -> None:
    """Entering triage stamps the entry and clears an old exit; leaving stamps the exit and keeps the entry."""
    entered_at = BASE + timedelta(hours=1)
    created = bare_issue(in_triage=True)
    stamp_triage(None, created, entered_at)
    assert created.triage_entered_at == entered_at
    assert created.triaged_at is None

    left_at = BASE + timedelta(hours=3)
    accepted = created.model_copy(update={"in_triage": False})
    stamp_triage(created, accepted, left_at)
    assert accepted.triage_entered_at == entered_at
    assert accepted.triaged_at == left_at

    back_at = BASE + timedelta(hours=5)
    resent = accepted.model_copy(update={"in_triage": True})
    stamp_triage(accepted, resent, back_at)
    assert resent.triage_entered_at == back_at
    assert resent.triaged_at is None

    untouched = bare_issue()
    stamp_triage(None, untouched, back_at)
    assert untouched.triage_entered_at is None and untouched.triaged_at is None


def test_cycle_time_answers_points_and_percentiles_per_bucket(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Only completed, started issues are measured, each answers a point, and each bucket its own percentiles."""
    sign_in(issues_client, OWNER)
    done = statuses["completed"].status_id
    fast = seed_issue(issues_client, workspace, title="Fast", assignee_id=MEMBER, status_id=done)
    slow = seed_issue(issues_client, workspace, title="Slow", assignee_id=MEMBER, status_id=done)
    mine = seed_issue(issues_client, workspace, title="Mine", assignee_id=OWNER, status_id=done)
    seed_issue(issues_client, workspace, title="Open", assignee_id=OWNER)
    stamp(repositories, workspace, fast["id"], started_at=BASE, completed_at=BASE + timedelta(hours=2))
    stamp(repositories, workspace, slow["id"], started_at=BASE, completed_at=BASE + timedelta(hours=10))
    stamp(repositories, workspace, mine["id"], started_at=BASE, completed_at=BASE + timedelta(hours=48))

    sign_in(client, OWNER)
    payload = insights(client, workspace, team_id=TEAM, group_by="assignee", measure="cycle_time")

    assert payload["measure"] == "cycle_time"
    assert payload["issue_count"] == 3
    assert payload["durations"]["count"] == 3
    assert payload["durations"]["p50"] == 10.0
    assert payload["durations"]["maximum"] == 48.0
    groups = {group["key"]: group for group in payload["groups"]}
    assert groups[MEMBER]["issue_count"] == 2
    assert groups[MEMBER]["durations"]["p50"] == 6.0
    assert groups[OWNER]["durations"]["p95"] == 48.0
    points = {point["key"]: point for point in payload["points"]}
    assert set(points) == {fast["key"], slow["key"], mine["key"]}
    assert points[fast["key"]]["hours"] == 2.0
    assert points[fast["key"]]["group"] == MEMBER
    assert points[fast["key"]]["title"] == "Fast"


def test_lead_time_and_issue_age_follow_their_own_filters(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Lead time keeps completed issues only, while issue age measures every issue the filter keeps."""
    sign_in(issues_client, OWNER)
    done = seed_issue(issues_client, workspace, title="Done", status_id=statuses["completed"].status_id)
    seed_issue(issues_client, workspace, title="Open")
    stamp(repositories, workspace, done["id"], created_at=BASE, completed_at=BASE + timedelta(days=3))

    sign_in(client, OWNER)
    lead = insights(client, workspace, team_id=TEAM, measure="lead_time", segment_by="priority")
    assert lead["issue_count"] == 1
    assert lead["points"][0]["hours"] == 72.0
    assert lead["points"][0]["segment"] == "none"
    assert lead["groups"][0]["segments"][0]["durations"]["p50"] == 72.0

    age = insights(client, workspace, team_id=TEAM, measure="issue_age")
    assert age["issue_count"] == 2
    assert len(age["points"]) == 2
    assert all(point["hours"] >= 0 for point in age["points"])


def test_triage_time_measures_only_issues_that_left_triage(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """An issue with no triage stamps is left out rather than counted as zero."""
    sign_in(issues_client, OWNER)
    triaged = seed_issue(issues_client, workspace, title="Triaged")
    seed_issue(issues_client, workspace, title="Never triaged")
    stamp(repositories, workspace, triaged["id"], triage_entered_at=BASE, triaged_at=BASE + timedelta(hours=5))

    sign_in(client, OWNER)
    payload = insights(client, workspace, team_id=TEAM, measure="triage_time")
    assert payload["issue_count"] == 1
    assert payload["durations"]["p50"] == 5.0
    assert [point["key"] for point in payload["points"]] == [triaged["key"]]


def test_count_measure_answers_no_durations_or_points(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """The bar chart measures are unchanged: no durations and no points."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="One")

    sign_in(client, OWNER)
    payload = insights(client, workspace, team_id=TEAM)
    assert payload["durations"] is None
    assert payload["points"] == []
    assert payload["groups"][0]["durations"] is None
