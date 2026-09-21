"""The roadmap: one timeline over cycles and projects across readable teams.

The properties worth holding are that both entities interleave on the one date a
roadmap draws them at, that undated projects come last rather than first, that a
team the caller cannot read never appears, and that the merged cursor walks the
whole set without repeating or skipping an entry.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, OUTSIDER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, seed_cycle, seed_project


def test_cycles_and_projects_interleave_by_date(client: TestClient, workspace: str) -> None:
    """A cycle is drawn at its end date and a project at its target, in one order."""
    sign_in(client, MEMBER)
    seed_cycle(client, workspace, name="Cycle March", start_date="2026-03-01", end_date="2026-03-14")
    seed_project(client, workspace, name="Project February", target_date="2026-02-01")
    seed_cycle(client, workspace, name="Cycle January", start_date="2026-01-01", end_date="2026-01-14")
    seed_project(client, workspace, name="Project April", target_date="2026-04-01")

    response = client.get(f"/api/workspaces/{workspace}/roadmap")

    assert response.status_code == 200
    entries = response.json()["entries"]
    assert [entry["name"] for entry in entries] == [
        "Cycle January",
        "Project February",
        "Cycle March",
        "Project April",
    ]
    assert [entry["kind"] for entry in entries] == ["cycle", "project", "cycle", "project"]


def test_an_undated_project_sorts_after_every_dated_entry(client: TestClient, workspace: str) -> None:
    """An absent target is not the most urgent thing on the timeline."""
    sign_in(client, MEMBER)
    seed_project(client, workspace, name="Someday")
    seed_cycle(client, workspace, name="Now", start_date="2026-01-01", end_date="2026-01-14")

    response = client.get(f"/api/workspaces/{workspace}/roadmap")

    entries = response.json()["entries"]
    assert [entry["name"] for entry in entries] == ["Now", "Someday"]
    assert entries[-1]["target_date"] is None


def test_the_roadmap_spans_teams(client: TestClient, workspace: str) -> None:
    """One timeline across every readable team, which is what makes it a roadmap."""
    sign_in(client, OWNER)
    seed_project(client, workspace, name="In this team", target_date="2026-02-01")
    seed_project(client, workspace, team_id=OTHER_TEAM, name="In that one", target_date="2026-01-01")

    response = client.get(f"/api/workspaces/{workspace}/roadmap")

    entries = response.json()["entries"]
    assert [entry["name"] for entry in entries] == ["In that one", "In this team"]
    assert {entry["team_id"] for entry in entries} == {TEAM, OTHER_TEAM}


def test_a_team_filter_narrows_the_roadmap(client: TestClient, workspace: str) -> None:
    """A single team is one index query rather than the fan-out."""
    sign_in(client, OWNER)
    seed_project(client, workspace, name="Mine", target_date="2026-02-01")
    seed_project(client, workspace, team_id=OTHER_TEAM, name="Theirs", target_date="2026-01-01")

    response = client.get(f"/api/workspaces/{workspace}/roadmap", params={"team_id": TEAM})

    assert [entry["name"] for entry in response.json()["entries"]] == ["Mine"]


def test_the_kind_filter_narrows_the_roadmap(client: TestClient, workspace: str) -> None:
    """A caller drawing only projects should not pay for the cycles."""
    sign_in(client, MEMBER)
    seed_cycle(client, workspace, name="A cycle", start_date="2026-01-01", end_date="2026-01-14")
    seed_project(client, workspace, name="A project", target_date="2026-01-20")

    response = client.get(f"/api/workspaces/{workspace}/roadmap", params={"kind": "project"})

    entries = response.json()["entries"]
    assert [entry["name"] for entry in entries] == ["A project"]


def test_a_guest_never_sees_a_team_they_are_outside(client: TestClient, workspace: str) -> None:
    """The fan-out reads only visible teams, so nothing is filtered after the read."""
    sign_in(client, OWNER)
    seed_project(client, workspace, name="Visible", target_date="2026-02-01")
    seed_project(client, workspace, team_id=OTHER_TEAM, name="Hidden", target_date="2026-01-01")

    sign_in(client, GUEST)
    response = client.get(f"/api/workspaces/{workspace}/roadmap")

    assert [entry["name"] for entry in response.json()["entries"]] == ["Visible"]


def test_a_guest_naming_an_invisible_team_gets_a_404(client: TestClient, workspace: str) -> None:
    """Invisible and absent look identical, so the team set stays unenumerable."""
    sign_in(client, GUEST)

    response = client.get(f"/api/workspaces/{workspace}/roadmap", params={"team_id": OTHER_TEAM})

    assert response.status_code == 404


def test_a_non_member_of_the_workspace_gets_a_404(client: TestClient, workspace: str) -> None:
    """The workspace itself is unenumerable to somebody outside it."""
    sign_in(client, OUTSIDER)

    response = client.get(f"/api/workspaces/{workspace}/roadmap")

    assert response.status_code == 404


def test_the_cursor_walks_the_whole_roadmap_once(client: TestClient, workspace: str) -> None:
    """A merged page has no single last evaluated key, so the cursor is an offset.

    Walking it page by page has to produce each entry exactly once and in the same
    order one unpaged read would.
    """
    sign_in(client, MEMBER)
    for month in range(1, 6):
        seed_project(client, workspace, name=f"M{month}", target_date=f"2026-0{month}-01")

    seen: list[str] = []
    cursor: str | None = None
    for _ in range(10):
        params = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        page = client.get(f"/api/workspaces/{workspace}/roadmap", params=params).json()
        seen.extend(entry["name"] for entry in page["entries"])
        cursor = page["next_cursor"]
        if not cursor:
            break

    assert seen == ["M1", "M2", "M3", "M4", "M5"]
    assert cursor is None


def test_a_cursor_from_another_query_is_ignored(client: TestClient, workspace: str) -> None:
    """Every cursor carries the scope it was minted under, so a foreign one restarts."""
    sign_in(client, MEMBER)
    seed_project(client, workspace, name="Only one", target_date="2026-01-01")

    response = client.get(
        f"/api/workspaces/{workspace}/roadmap",
        params={"cursor": "bm90LWEtcmVhbC1jdXJzb3I"},
    )

    assert response.status_code == 200
    assert [entry["name"] for entry in response.json()["entries"]] == ["Only one"]


def test_an_empty_workspace_answers_an_empty_roadmap(client: TestClient, workspace: str) -> None:
    """Nothing planned is an empty page rather than an error."""
    sign_in(client, MEMBER)

    response = client.get(f"/api/workspaces/{workspace}/roadmap")

    assert response.status_code == 200
    assert response.json() == {"entries": [], "next_cursor": None}
