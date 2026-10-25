"""Converting a project milestone into a project of its own, through the milestone route.

The properties worth holding are that the new project copies the milestone's
name, description and target date and the source project's teams, lead and
priority, that the milestone's issues move into it with no milestone, that the
milestone is gone afterwards, that both feeds record the conversion, and that
the conversion follows the same visibility and edit rules as any milestone edit.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, OUTSIDER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_issue, seed_project


def _milestones(workspace: str, project_id: str) -> str:
    """A project's milestone collection."""
    return f"/api/workspaces/{workspace}/projects/{project_id}/milestones"


def _seed_milestone(client: TestClient, workspace: str, project_id: str, **payload: Any) -> "dict[str, Any]":
    """Create one milestone through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "Beta"}
    body.update(payload)
    response = client.post(_milestones(workspace, project_id), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _convert(client: TestClient, workspace: str, project_id: str, milestone_id: str) -> Any:
    """One conversion request, answering the raw response."""
    return client.post(f"{_milestones(workspace, project_id)}/{milestone_id}/convert-to-project")


def _feed(client: TestClient, workspace: str, project_id: str) -> "list[dict[str, Any]]":
    """A project's activity rows, newest first."""
    response = client.get(f"/api/workspaces/{workspace}/projects/{project_id}/activity")
    assert response.status_code == 200, response.text
    return response.json()["activity"]


def test_converting_copies_the_fields_and_moves_the_issues(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """The new project takes the milestone's fields and the source's lead and priority, and gets its issues."""
    sign_in(client, MEMBER)
    source = seed_project(client, workspace, name="Launch", priority="high", lead_id=MEMBER)
    project_id = source["project_id"]
    milestone = _seed_milestone(
        client, workspace, project_id, name="Private beta", description="Invite only", target_date="2026-12-01"
    )
    kept = _seed_milestone(client, workspace, project_id, name="General availability")

    sign_in(issues_client, MEMBER)
    first = seed_issue(
        issues_client, workspace, title="Invites", project_id=project_id, project_milestone_id=milestone["milestone_id"]
    )
    second = seed_issue(
        issues_client,
        workspace,
        title="Waitlist",
        project_id=project_id,
        project_milestone_id=milestone["milestone_id"],
    )
    other = seed_issue(
        issues_client, workspace, title="Pricing", project_id=project_id, project_milestone_id=kept["milestone_id"]
    )
    loose = seed_issue(issues_client, workspace, title="Loose", project_id=project_id)

    response = _convert(client, workspace, project_id, milestone["milestone_id"])

    assert response.status_code == 200, response.text
    body = response.json()
    project = body["project"]
    assert project["name"] == "Private beta"
    assert project["description"] == "Invite only"
    assert project["target_date"] == "2026-12-01"
    assert project["priority"] == "high"
    assert project["lead_id"] == MEMBER
    assert project["team_ids"] == [TEAM]
    assert project["project_id"] != project_id
    assert body["moved_issue_ids"] == [first["id"], second["id"]]

    for issue in (first, second):
        row = repositories.issues.get(WORKSPACE, issue["id"])
        assert row.project_id == project["project_id"]
        assert row.project_milestone_id is None
    assert repositories.issues.get(WORKSPACE, other["id"]).project_milestone_id == kept["milestone_id"]
    assert repositories.issues.get(WORKSPACE, loose["id"]).project_id == project_id

    remaining = client.get(_milestones(workspace, project_id)).json()["milestones"]
    assert [row["milestone_id"] for row in remaining] == [kept["milestone_id"]]
    assert repositories.planning.get_milestone(WORKSPACE, project_id, milestone["milestone_id"]) is None


def test_both_feeds_record_the_conversion(client: TestClient, workspace: str) -> None:
    """The source names the new project and the new project names the source, each naming the milestone."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace, name="Launch")["project_id"]
    milestone = _seed_milestone(client, workspace, project_id, name="Private beta")

    created = _convert(client, workspace, project_id, milestone["milestone_id"]).json()["project"]

    source_rows = [row for row in _feed(client, workspace, project_id) if row["kind"] == "milestone_converted"]
    assert [(row["from"], row["to"], row["milestone_id"], row["actor_id"]) for row in source_rows] == [
        ("Private beta", "Private beta", milestone["milestone_id"], MEMBER)
    ]
    new_rows = [
        row for row in _feed(client, workspace, created["project_id"]) if row["kind"] == "converted_from_milestone"
    ]
    assert [(row["from"], row["to"]) for row in new_rows] == [("Private beta", "Launch")]


def test_issues_in_a_team_the_caller_cannot_see_stay_behind(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """A guest converts only within its own team; the other team's issue keeps the source project."""
    sign_in(client, OWNER)
    project_id = seed_project(client, workspace, team_id=None, team_ids=[TEAM, OTHER_TEAM])["project_id"]
    milestone_id = _seed_milestone(client, workspace, project_id)["milestone_id"]
    sign_in(issues_client, OWNER)
    mine = seed_issue(issues_client, workspace, team_id=TEAM, project_id=project_id, project_milestone_id=milestone_id)
    theirs = seed_issue(
        issues_client, workspace, team_id=OTHER_TEAM, project_id=project_id, project_milestone_id=milestone_id
    )

    sign_in(client, GUEST)
    body = _convert(client, workspace, project_id, milestone_id).json()

    assert body["project"]["team_ids"] == [TEAM]
    assert body["moved_issue_ids"] == [mine["id"]]
    assert repositories.issues.get(WORKSPACE, theirs["id"]).project_id == project_id


def test_converting_a_hidden_or_missing_milestone_is_not_found(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A project the caller cannot read, or an unknown milestone, answers 404 and creates nothing."""
    sign_in(client, OWNER)
    hidden = seed_project(client, workspace, team_id=OTHER_TEAM)["project_id"]
    milestone_id = _seed_milestone(client, workspace, hidden)["milestone_id"]
    visible = seed_project(client, workspace)["project_id"]
    before = len(repositories.planning.list_projects(WORKSPACE))

    sign_in(client, GUEST)
    assert _convert(client, workspace, hidden, milestone_id).status_code == 404
    sign_in(client, OUTSIDER)
    assert _convert(client, workspace, hidden, milestone_id).status_code == 404
    sign_in(client, OWNER)
    assert _convert(client, workspace, visible, milestone_id).status_code == 404

    assert len(repositories.planning.list_projects(WORKSPACE)) == before
    assert repositories.planning.get_milestone(WORKSPACE, hidden, milestone_id) is not None
