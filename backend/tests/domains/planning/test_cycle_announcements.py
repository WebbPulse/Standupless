"""Queueing the channel posts of a cycle starting and completing, from the cycle close and an early start.

The properties worth holding are that the sweep queues a completion with its
counts taken before the move, and the next cycle's start, only on the day after a
cycle's last day; that a team with the rollover off still hears of both; that an
early start queues both posts under the dates the next sweep derives; and that
nothing is queued without the dispatch queue.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import cycle_announcements
from app.common.core.config import settings
from app.common.cycle_announcements import CHANNEL_CYCLE_JOB, CycleTally, queue_cycle_announcement
from app.common.db.dynamo.team_config import default_cycle_settings
from app.domains.issues.cycle_close import sweep
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.planning.conftest import TEAM, WORKSPACE, seed_cycle, seed_issue


@pytest.fixture
def jobs(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Capture every cycle announcement job instead of sending it to SQS."""
    captured: list[dict[str, Any]] = []

    def record(queue_url: str, envelope: Any, **kwargs: Any) -> str:
        """Keep the payload of one queued job."""
        captured.append(dict(envelope.payload))
        return "message-id"

    monkeypatch.setattr(settings, "WEBHOOK_DISPATCH_QUEUE_URL", "https://sqs.test/dispatch")
    monkeypatch.setattr(cycle_announcements, "enqueue", record)
    return captured


def _statuses(repositories: Any) -> "dict[str, str]":
    """The seeded statuses of TEAM, keyed by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def _seed(client: TestClient, issues_client: TestClient, repositories: Any, workspace: str) -> "tuple[Any, Any]":
    """An ended cycle holding one issue of each category, and the cycle after it."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    ended = seed_cycle(client, workspace, name="Ended", start_date="2026-02-23", end_date="2026-03-08")
    following = seed_cycle(client, workspace, name="Next", start_date="2026-03-09", end_date="2026-03-22")
    statuses = _statuses(repositories)
    for category in ("unstarted", "started", "completed", "cancelled"):
        seed_issue(issues_client, workspace, cycle_id=ended["cycle_id"], status_id=statuses[category])
    return ended, following


def test_the_day_after_a_cycle_the_sweep_queues_its_completion_and_the_next_start(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str, jobs: list[dict[str, Any]]
) -> None:
    """The completion counts three in scope, one done and two rolled over; the next cycle's start follows."""
    ended, following = _seed(client, issues_client, repositories, workspace)

    summary = sweep(repositories, today="2026-03-09")

    assert summary.announced == 1
    assert [job["event"] for job in jobs] == ["cycle_completed", "cycle_started"]
    completed, started = jobs
    assert completed == {
        "kind": CHANNEL_CYCLE_JOB,
        "event": "cycle_completed",
        "workspace_id": WORKSPACE,
        "team_id": TEAM,
        "cycle_id": ended["cycle_id"],
        "date": "2026-03-08",
        "scope": 3,
        "completed": 1,
        "rolled_over": 2,
    }
    assert started["cycle_id"] == following["cycle_id"]
    assert started["date"] == "2026-03-09"


def test_a_later_sweep_queues_nothing(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str, jobs: list[dict[str, Any]]
) -> None:
    """Two days on, the close still runs for a missed move but no post is queued again."""
    _seed(client, issues_client, repositories, workspace)

    summary = sweep(repositories, today="2026-03-10")

    assert summary.announced == 0
    assert jobs == []


def test_a_team_with_the_rollover_off_still_hears_of_the_completion(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str, jobs: list[dict[str, Any]]
) -> None:
    """Nothing moves, so nothing is rolled over, and the next cycle's start is still announced."""
    _seed(client, issues_client, repositories, workspace)
    repositories.team_config.put_cycle_settings(
        default_cycle_settings(WORKSPACE, TEAM).model_copy(update={"move_unfinished": False})
    )

    summary = sweep(repositories, today="2026-03-09")

    assert summary.carried == 0
    assert [job["event"] for job in jobs] == ["cycle_completed", "cycle_started"]
    assert jobs[0]["rolled_over"] == 0
    assert jobs[0]["scope"] == 3


def test_starting_a_cycle_today_queues_both_posts(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str, jobs: list[dict[str, Any]]
) -> None:
    """The ended cycle's completion carries its moved issues, and both dates are the stored ones."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    today = date.today()
    current = seed_cycle(
        client,
        workspace,
        name="Current",
        start_date=(today - timedelta(days=5)).isoformat(),
        end_date=(today + timedelta(days=3)).isoformat(),
    )
    following = seed_cycle(
        client,
        workspace,
        name="Next",
        start_date=(today + timedelta(days=4)).isoformat(),
        end_date=(today + timedelta(days=17)).isoformat(),
    )
    seed_issue(issues_client, workspace, cycle_id=current["cycle_id"], status_id=_statuses(repositories)["started"])

    response = client.post(
        f"/api/workspaces/{workspace}/cycles/{following['cycle_id']}/start-today", json={"team_id": TEAM}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    completed, started = jobs
    assert completed["event"] == "cycle_completed"
    assert completed["cycle_id"] == current["cycle_id"]
    assert completed["date"] == body["ended"]["end_date"]
    assert (completed["scope"], completed["completed"], completed["rolled_over"]) == (1, 0, 1)
    assert started["event"] == "cycle_started"
    assert started["cycle_id"] == following["cycle_id"]
    assert started["date"] == body["cycle"]["start_date"]


def test_nothing_is_queued_without_the_dispatch_queue(
    client: TestClient, repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An environment with no dispatch queue sends nothing."""
    sign_in(client, MEMBER)
    seed_cycle(client, workspace, name="Ended", start_date="2026-02-23", end_date="2026-03-08")
    cycle = repositories.planning.list_for_roadmap(WORKSPACE, TEAM)[0]
    sent: list[Any] = []
    monkeypatch.setattr(settings, "WEBHOOK_DISPATCH_QUEUE_URL", "")

    assert queue_cycle_announcement(cycle, "cycle_completed", CycleTally(), send=sent.append) is False
    assert sent == []
