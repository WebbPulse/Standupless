"""Workspace home route: the focus groups, team sections, what shipped and scope.

The properties worth holding are that each assigned issue lands in exactly one
focus group, that shipped counts only issues still completed, and that a guest
never sees a cycle, project or update from a team they are outside.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import PullRequestSummary, PullRequestSummaryEntry
from app.common.db.dynamo.planning import (
    Cycle,
    Project,
    ProjectUpdateRow,
    cycle_key,
    project_key,
    project_update_key,
)
from app.common.db.dynamo.releases import (
    PipelineStage,
    Release,
    ReleasePipeline,
    ReleaseStageReached,
    pipeline_key,
    release_key,
)
from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue


def home(client: TestClient, workspace: str, **params: Any) -> "dict[str, Any]":
    """Read the home, failing loudly on a refusal."""
    response = client.get(f"/api/workspaces/{workspace}/views/home", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def make_cycle(repositories: Any, workspace: str, team_id: str, cycle_id: str, start: date, end: date) -> None:
    """One cycle written straight into the planning table."""
    repositories.planning.create_cycle(
        Cycle(
            workspace_id=workspace,
            planning_key=cycle_key(team_id, cycle_id),
            cycle_id=cycle_id,
            team_id=team_id,
            name=f"Cycle {cycle_id[-2:]}",
            start_date=start.isoformat(),
            end_date=end.isoformat(),
            created_by=OWNER,
        )
    )


def make_project(repositories: Any, workspace: str, project_id: str, team_id: str, **fields: Any) -> None:
    """One project written straight into the planning table."""
    values: "dict[str, Any]" = {"name": f"Project {project_id[-2:]}", "status": "in_progress", "created_by": OWNER}
    values.update(fields)
    repositories.planning.create_project(
        Project(
            workspace_id=workspace,
            planning_key=project_key(project_id),
            project_id=project_id,
            team_ids=[team_id],
            **values,
        )
    )


def test_focus_puts_each_assigned_issue_in_one_group(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """Overdue work needs attention, started work is in progress, unstarted is next, finished is gone."""
    sign_in(issues_client, OWNER)
    yesterday = (date.today() - timedelta(days=2)).isoformat()
    late = seed_issue(
        issues_client,
        workspace,
        title="Late",
        assignee_id=OWNER,
        due_date=yesterday,
        status_id=statuses["started"].status_id,
    )
    started = seed_issue(
        issues_client, workspace, title="Started", assignee_id=OWNER, status_id=statuses["started"].status_id
    )
    unstarted = seed_issue(
        issues_client,
        workspace,
        title="Next",
        assignee_id=OWNER,
        priority="high",
        status_id=statuses["unstarted"].status_id,
    )
    seed_issue(issues_client, workspace, title="Done", assignee_id=OWNER, status_id=statuses["completed"].status_id)
    seed_issue(issues_client, workspace, title="Theirs", assignee_id=MEMBER, status_id=statuses["started"].status_id)

    sign_in(client, OWNER)
    focus = home(client, workspace)["focus"]

    assert [item["issue"]["id"] for item in focus["attention"]] == [late["id"]]
    assert focus["attention"][0]["reasons"] == ["overdue"]
    assert [issue["id"] for issue in focus["in_progress"]] == [started["id"]]
    assert [issue["id"] for issue in focus["up_next"]] == [unstarted["id"]]
    assert focus["open_count"] == 3
    assert focus["attention_count"] == 1
    assert focus["in_progress_count"] == 1
    assert focus["up_next_count"] == 1
    assert focus["truncated"] is False


def test_shipped_counts_issues_completed_in_the_window_and_still_completed(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """An issue moved to done shows, credited to who moved it; one reopened since does not."""
    sign_in(issues_client, OWNER)
    shipped = seed_issue(issues_client, workspace, title="Ship it", status_id=statuses["started"].status_id)
    reopened = seed_issue(issues_client, workspace, title="Reopened", status_id=statuses["started"].status_id)
    for issue in (shipped, reopened):
        response = issues_client.patch(
            f"/api/workspaces/{workspace}/issues/{issue['id']}", json={"status_id": statuses["completed"].status_id}
        )
        assert response.status_code == 200, response.text
    response = issues_client.patch(
        f"/api/workspaces/{workspace}/issues/{reopened['id']}", json={"status_id": statuses["started"].status_id}
    )
    assert response.status_code == 200, response.text

    sign_in(client, OWNER)
    payload = home(client, workspace)["shipped"]

    assert payload["count"] == 1
    assert payload["mine"] == 1
    assert [item["issue"]["id"] for item in payload["items"]] == [shipped["id"]]
    assert payload["items"][0]["completed_by"] == OWNER


def test_cycles_list_only_the_active_cycle_of_teams_in_scope(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """An upcoming cycle is left out, and a guest sees only their own team's cycle."""
    today = date.today()
    make_cycle(
        repositories,
        workspace,
        TEAM,
        "01JB0000000000000000CYCL01",
        today - timedelta(days=3),
        today + timedelta(days=4),
    )
    make_cycle(
        repositories,
        workspace,
        TEAM,
        "01JB0000000000000000CYCL02",
        today + timedelta(days=5),
        today + timedelta(days=12),
    )
    make_cycle(
        repositories,
        workspace,
        OTHER_TEAM,
        "01JB0000000000000000CYCL03",
        today - timedelta(days=1),
        today + timedelta(days=6),
    )

    sign_in(client, OWNER)
    owner_cycles = [cycle["cycle_id"] for cycle in home(client, workspace)["cycles"]]
    sign_in(client, GUEST)
    guest_view = home(client, workspace)

    assert owner_cycles == ["01JB0000000000000000CYCL01", "01JB0000000000000000CYCL03"]
    assert [cycle["cycle_id"] for cycle in guest_view["cycles"]] == ["01JB0000000000000000CYCL01"]
    assert guest_view["team_ids"] == [TEAM]


def test_projects_and_pulse_respect_status_and_visibility(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """Started projects come before planned ones, finished ones are left out, and a guest sees only theirs."""
    now = datetime.now(timezone.utc)
    make_project(
        repositories, workspace, "01JB0000000000000000PROJ01", TEAM, status="planned", target_date="2026-11-01"
    )
    make_project(
        repositories,
        workspace,
        "01JB0000000000000000PROJ02",
        TEAM,
        status="in_progress",
        health="at_risk",
        last_update_at=now - timedelta(hours=2),
    )
    make_project(repositories, workspace, "01JB0000000000000000PROJ03", TEAM, status="completed")
    make_project(
        repositories, workspace, "01JB0000000000000000PROJ04", OTHER_TEAM, last_update_at=now - timedelta(hours=1)
    )
    for project_id in ("01JB0000000000000000PROJ02", "01JB0000000000000000PROJ04"):
        repositories.planning.create_project_update(
            ProjectUpdateRow(
                workspace_id=workspace,
                planning_key=project_update_key(project_id, f"01JB0000000000000000UPD{project_id[-3:]}"),
                update_id=f"01JB0000000000000000UPD{project_id[-3:]}",
                project_id=project_id,
                body="Slipping a week",
                health="at_risk",
                author_id=OWNER,
            )
        )

    sign_in(client, OWNER)
    owner_view = home(client, workspace)
    sign_in(client, GUEST)
    guest_view = home(client, workspace)

    assert [project["project_id"] for project in owner_view["projects"]] == [
        "01JB0000000000000000PROJ02",
        "01JB0000000000000000PROJ04",
        "01JB0000000000000000PROJ01",
    ]
    assert owner_view["projects_total"] == 3
    assert [item["project_id"] for item in owner_view["pulse"]] == [
        "01JB0000000000000000PROJ04",
        "01JB0000000000000000PROJ02",
    ]
    assert owner_view["pulse"][0]["update"]["body"] == "Slipping a week"
    assert [project["project_id"] for project in guest_view["projects"]] == [
        "01JB0000000000000000PROJ02",
        "01JB0000000000000000PROJ01",
    ]
    assert [item["project_id"] for item in guest_view["pulse"]] == ["01JB0000000000000000PROJ02"]


def test_inbox_and_empty_sections_answer_on_a_quiet_workspace(client: TestClient, workspace: str) -> None:
    """A workspace with nothing in it still answers every section, empty."""
    sign_in(client, MEMBER)
    payload = home(client, workspace, tz="America/Los_Angeles")

    assert payload["inbox"] == {"unread_count": 0, "items": []}
    assert payload["focus"]["open_count"] == 0
    assert payload["shipped"]["count"] == 0
    assert payload["cycles"] == []
    assert payload["projects"] == []
    assert payload["pulse"] == []
    assert payload["pull_requests"] == []
    assert payload["releases"] == []


def test_an_unknown_timezone_is_refused(client: TestClient, workspace: str) -> None:
    """A zone name the zone database does not know is a 422, not a silent UTC."""
    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/views/home", params={"tz": "Mars/Olympus"})

    assert response.status_code == 422


def link_pull_requests(repositories: Any, workspace: str, issue_id: str, *entries: PullRequestSummaryEntry) -> None:
    """Store a pull request summary on one issue, as the GitHub consumer would."""
    summary = PullRequestSummary(count=len(entries), pull_requests=list(entries))
    assert repositories.issues.set_pull_request_summary(workspace, issue_id, summary, expected_revision=0)


def pull_request(number: int, state: str, **fields: Any) -> PullRequestSummaryEntry:
    """One pull request summary entry in acme/api."""
    return PullRequestSummaryEntry(
        repository_full_name="acme/api",
        number=number,
        title=f"PR {number}",
        url=f"https://github.com/acme/api/pull/{number}",
        state=state,
        **fields,
    )


def test_pull_requests_list_open_ones_on_the_callers_open_issues(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """Open and draft pull requests show once each, changes requested first; merged, done and others' do not."""
    sign_in(issues_client, OWNER)
    mine = seed_issue(
        issues_client, workspace, title="Mine", assignee_id=OWNER, status_id=statuses["started"].status_id
    )
    also = seed_issue(
        issues_client, workspace, title="Also", assignee_id=OWNER, status_id=statuses["started"].status_id
    )
    done = seed_issue(
        issues_client, workspace, title="Done", assignee_id=OWNER, status_id=statuses["completed"].status_id
    )
    theirs = seed_issue(
        issues_client, workspace, title="Theirs", assignee_id=MEMBER, status_id=statuses["started"].status_id
    )
    link_pull_requests(
        repositories,
        workspace,
        mine["id"],
        pull_request(1, "open", review_state="approved", ci_state="success"),
        pull_request(2, "merged"),
        pull_request(3, "draft"),
    )
    link_pull_requests(
        repositories,
        workspace,
        also["id"],
        pull_request(4, "open", review_state="changes_requested"),
        pull_request(1, "open", review_state="approved"),
    )
    link_pull_requests(repositories, workspace, done["id"], pull_request(5, "open"))
    link_pull_requests(repositories, workspace, theirs["id"], pull_request(6, "open"))

    sign_in(client, OWNER)
    rows = home(client, workspace)["pull_requests"]

    assert [row["pull_request"]["number"] for row in rows] == [4, 1, 3]
    assert rows[0]["issue"]["id"] == also["id"]
    assert rows[1]["pull_request"]["review_state"] == "approved"
    sign_in(client, MEMBER)
    assert [row["pull_request"]["number"] for row in home(client, workspace)["pull_requests"]] == [6]


def make_release(
    repositories: Any, workspace: str, team_id: str, release_id: str, *stages: tuple[str, datetime]
) -> None:
    """One release written straight into the planning table, having reached each named stage."""
    repositories.releases.create(
        Release(
            workspace_id=workspace,
            planning_key=release_key(team_id, release_id),
            release_id=release_id,
            team_id=team_id,
            name=f"Release {release_id[-2:]}",
            source="manual",
            stages=[
                ReleaseStageReached(stage_id=stage_id, name=stage_id.title(), reached_at=at, source="manual")
                for stage_id, at in stages
            ],
        )
    )


def test_releases_list_only_those_that_reached_the_last_stage_this_week(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A release still on staging, one that shipped long ago and another team's are left out of a guest's home."""
    now = datetime.now(timezone.utc)
    repositories.releases.put_pipeline(
        ReleasePipeline(
            workspace_id=workspace,
            planning_key=pipeline_key(TEAM),
            team_id=TEAM,
            stages=[
                PipelineStage(stage_id="staging", name="Staging"),
                PipelineStage(stage_id="production", name="Prod"),
            ],
        )
    )
    make_release(
        repositories,
        workspace,
        TEAM,
        "01JB0000000000000000RELS01",
        ("staging", now - timedelta(days=3)),
        ("production", now - timedelta(days=2)),
    )
    make_release(repositories, workspace, TEAM, "01JB0000000000000000RELS02", ("staging", now - timedelta(hours=3)))
    make_release(repositories, workspace, TEAM, "01JB0000000000000000RELS03", ("production", now - timedelta(hours=1)))
    make_release(repositories, workspace, TEAM, "01JB0000000000000000RELS04", ("production", now - timedelta(days=10)))
    make_release(
        repositories, workspace, OTHER_TEAM, "01JB0000000000000000RELS05", ("production", now - timedelta(hours=2))
    )

    sign_in(client, OWNER)
    owner_view = home(client, workspace)["releases"]
    sign_in(client, GUEST)
    guest_view = home(client, workspace)["releases"]

    assert [row["release_id"] for row in owner_view] == [
        "01JB0000000000000000RELS03",
        "01JB0000000000000000RELS05",
        "01JB0000000000000000RELS01",
    ]
    assert owner_view[0]["current_stage"]["name"] == "Prod"
    assert [row["release_id"] for row in guest_view] == ["01JB0000000000000000RELS03", "01JB0000000000000000RELS01"]
