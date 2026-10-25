"""The projects list's health, priority, member, date and update age filters.

The properties worth holding are that each filter keeps what it names and drops
the rest, `none` standing for an empty health or member list, that date bounds
are exclusive and skip undated projects, that update age reads the newest
project update with a never updated project counted as stale, that the filters
combine with each other and with the older ones, that a malformed value is a
422, that a cursor pages the filtered list and restarts on another one, and that the shared module's fixed
healths and priorities stay equal to the schema's.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, get_args

from fastapi.testclient import TestClient

from app.common.api.schemas.planning import ProjectHealthField, ProjectPriorityField
from app.common.db.dynamo.base import utc_now
from app.common.project_filters import PROJECT_HEALTHS, PROJECT_PRIORITIES
from tests.domains.helpers import ADMIN, MEMBER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_project


def _names(client: TestClient, workspace: str, **params: Any) -> set[str]:
    """The project names the list answers for these query parameters."""
    response = client.get(f"/api/workspaces/{workspace}/projects", params=params)
    assert response.status_code == 200, response.text
    return {row["name"] for row in response.json()["projects"]}


def _updated(repositories: Any, project: "dict[str, Any]", days_ago: int) -> None:
    """Mark a project's newest project update as posted this many days ago."""
    repositories.planning.record_project_health(
        WORKSPACE,
        project["project_id"],
        health=None,
        last_update_at=utc_now() - timedelta(days=days_ago),
    )


def test_the_fixed_healths_and_priorities_match_the_schema() -> None:
    """The filter module spells the values itself, so they must not drift from the schema's."""
    assert PROJECT_HEALTHS == frozenset(get_args(ProjectHealthField))
    assert PROJECT_PRIORITIES == frozenset(get_args(ProjectPriorityField))


def test_the_list_filters_by_health(client: TestClient, workspace: str) -> None:
    """`health` keeps any named health, `none` the projects with no health."""
    sign_in(client, ADMIN)
    seed_project(client, workspace, name="Risky", health="at_risk")
    seed_project(client, workspace, name="Fine", health="on_track")
    seed_project(client, workspace, name="Quiet")
    assert _names(client, workspace, health="at_risk") == {"Risky"}
    assert _names(client, workspace, health=["at_risk", "on_track"]) == {"Risky", "Fine"}
    assert _names(client, workspace, health="none") == {"Quiet"}
    assert client.get(f"/api/workspaces/{workspace}/projects", params={"health": "sunny"}).status_code == 422


def test_the_list_filters_by_priority(client: TestClient, workspace: str) -> None:
    """`priority` keeps any named priority, `none` included as a priority of its own."""
    sign_in(client, ADMIN)
    seed_project(client, workspace, name="Urgent", priority="urgent")
    seed_project(client, workspace, name="Low", priority="low")
    seed_project(client, workspace, name="Unset")
    assert _names(client, workspace, priority="urgent") == {"Urgent"}
    assert _names(client, workspace, priority=["urgent", "none"]) == {"Urgent", "Unset"}
    assert client.get(f"/api/workspaces/{workspace}/projects", params={"priority": "p0"}).status_code == 422


def test_the_list_filters_by_member(client: TestClient, workspace: str) -> None:
    """`member_id` keeps projects with any named member, `none` the ones with no members."""
    sign_in(client, ADMIN)
    seed_project(client, workspace, name="Pair", member_ids=[ADMIN, MEMBER])
    seed_project(client, workspace, name="Solo", member_ids=[MEMBER])
    seed_project(client, workspace, name="Empty")
    assert _names(client, workspace, member_id=ADMIN) == {"Pair"}
    assert _names(client, workspace, member_id=MEMBER) == {"Pair", "Solo"}
    assert _names(client, workspace, member_id="none") == {"Empty"}
    assert _names(client, workspace, member_id=["none", ADMIN]) == {"Empty", "Pair"}


def test_the_list_filters_by_start_and_target_date(client: TestClient, workspace: str) -> None:
    """Date bounds are exclusive days and an undated project meets none of them."""
    sign_in(client, ADMIN)
    seed_project(client, workspace, name="Early", start_date="2026-01-10", target_date="2026-03-01")
    seed_project(client, workspace, name="Late", start_date="2026-06-01", target_date="2026-09-30")
    seed_project(client, workspace, name="Undated")
    assert _names(client, workspace, start_date_before="2026-06-01") == {"Early"}
    assert _names(client, workspace, start_date_after="2026-01-10") == {"Late"}
    assert _names(client, workspace, target_date_before="2026-12-31") == {"Early", "Late"}
    assert _names(client, workspace, target_date_after="2026-03-01", target_date_before="2026-10-01") == {"Late"}
    assert _names(client, workspace, start_date_after="2025-01-01") == {"Early", "Late"}
    response = client.get(f"/api/workspaces/{workspace}/projects", params={"start_date_before": "June"})
    assert response.status_code == 422


def test_relative_date_bounds_resolve_against_today(client: TestClient, workspace: str, monkeypatch: Any) -> None:
    """A relative bound resolves against the current UTC day, so a saved bound keeps rolling."""
    monkeypatch.setattr("app.common.project_filters.utc_today", lambda: date(2026, 5, 1))
    sign_in(client, ADMIN)
    seed_project(client, workspace, name="Early", start_date="2026-01-10", target_date="2026-03-01")
    seed_project(client, workspace, name="Late", start_date="2026-06-01", target_date="2026-09-30")
    assert _names(client, workspace, start_date_before="today") == {"Early"}
    assert _names(client, workspace, start_date_after="+1w") == {"Late"}
    assert _names(client, workspace, target_date_after="-2m") == {"Late"}
    assert _names(client, workspace, target_date_after="-4m") == {"Early", "Late"}
    response = client.get(f"/api/workspaces/{workspace}/projects", params={"start_date_before": "+2weeks"})
    assert response.status_code == 422


def test_the_list_filters_by_update_age(client: TestClient, workspace: str, repositories: Any) -> None:
    """`updated_within_days` keeps recent updates, `not_updated_within_days` stale and never updated projects."""
    sign_in(client, ADMIN)
    _updated(repositories, seed_project(client, workspace, name="Fresh"), 2)
    _updated(repositories, seed_project(client, workspace, name="Stale"), 20)
    seed_project(client, workspace, name="Never")
    assert _names(client, workspace, updated_within_days=7) == {"Fresh"}
    assert _names(client, workspace, updated_within_days=30) == {"Fresh", "Stale"}
    assert _names(client, workspace, not_updated_within_days=7) == {"Stale", "Never"}
    assert _names(client, workspace, updated_within_days=30, not_updated_within_days=7) == {"Stale"}
    for params in ({"updated_within_days": 0}, {"not_updated_within_days": "soon"}):
        assert client.get(f"/api/workspaces/{workspace}/projects", params=params).status_code == 422


def test_the_filters_combine_with_each_other_and_the_older_ones(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """At risk projects with no update this week, narrowed to one team, answer exactly that set."""
    sign_in(client, ADMIN)
    _updated(repositories, seed_project(client, workspace, name="Target", health="at_risk", priority="high"), 10)
    _updated(repositories, seed_project(client, workspace, name="Recent", health="at_risk", priority="high"), 1)
    seed_project(client, workspace, name="Healthy", health="on_track", priority="high")
    seed_project(client, workspace, name="Elsewhere", health="at_risk", priority="high", team_id=OTHER_TEAM)
    seed_project(client, workspace, name="Lower", health="at_risk", priority="low")
    combined = {"health": "at_risk", "not_updated_within_days": 7}
    assert _names(client, workspace, **combined) == {"Target", "Elsewhere", "Lower"}
    assert _names(client, workspace, **combined, priority="high") == {"Target", "Elsewhere"}
    assert _names(client, workspace, **combined, priority="high", team_id=TEAM) == {"Target"}


def test_a_cursor_pages_the_filtered_list_and_restarts_elsewhere(client: TestClient, workspace: str) -> None:
    """Paging a health filter walks only its projects, and its cursor read without the filter starts over."""
    sign_in(client, ADMIN)
    for index in range(3):
        seed_project(client, workspace, name=f"Risk {index}", health="at_risk")
    seed_project(client, workspace, name="Calm", health="on_track")
    url = f"/api/workspaces/{workspace}/projects"
    seen: list[str] = []
    cursor = None
    first_cursor = None
    while True:
        params: dict[str, Any] = {"health": "at_risk", "limit": 1}
        if cursor:
            params["cursor"] = cursor
        page = client.get(url, params=params).json()
        seen.extend(row["name"] for row in page["projects"])
        cursor = page["next_cursor"]
        first_cursor = first_cursor or cursor
        if not cursor:
            break
    assert sorted(seen) == ["Risk 0", "Risk 1", "Risk 2"]
    assert first_cursor is not None
    fresh = client.get(url, params={"limit": 1}).json()["projects"]
    crossed = client.get(url, params={"limit": 1, "cursor": first_cursor}).json()["projects"]
    assert [row["name"] for row in crossed] == [row["name"] for row in fresh]
