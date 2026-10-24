"""Project templates: saved beside issue templates, and applied when a project is created from one.

A project template is an issue template row of another kind, so the lists keep
the two apart and a team keeps one default of each. Saving holds every key and
reference strictly; creating a project fills only the fields the create left
out, resolves every date from the creation day, and adds the template's
milestones and issues, sub-issues under their parents.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM

BASE = "/api/workspaces/{workspace}"

BLUEPRINT: dict[str, Any] = {
    "description": "Ship the launch",
    "lead_id": ADMIN,
    "member_ids": [ADMIN, MEMBER],
    "status": "planned",
    "priority": "high",
    "start_offset_days": 0,
    "target_offset_days": 30,
    "milestones": [
        {"key": "alpha", "name": "Alpha", "target_offset_days": 10},
        {"name": "Beta", "description": "Wider rollout", "target_offset_days": 20},
    ],
    "issues": [
        {"key": "plan", "title": "Write the plan", "priority": "urgent", "milestone_key": "alpha"},
        {"title": "Review the plan", "parent_key": "plan", "milestone_key": "alpha", "assignee_id": MEMBER},
        {"title": "Announce", "milestone_key": "m1"},
    ],
}


@pytest.fixture
def teams(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, where templates are kept."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def _base(workspace: str) -> str:
    """The workspace's API root."""
    return BASE.format(workspace=workspace)


def _save(client: TestClient, workspace: str, **fields: Any) -> dict[str, Any]:
    """Save one project template on the team and answer it."""
    body = {"kind": "project", "name": "Launch plan", "project": BLUEPRINT, **fields}
    response = client.post(f"{_base(workspace)}/teams/{TEAM}/templates", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _offset(days: int) -> str:
    """The ISO date `days` after today."""
    return (datetime.now(timezone.utc).date() + timedelta(days=days)).isoformat()


def test_a_project_template_is_kept_apart_from_issue_templates(teams: TestClient, workspace: str) -> None:
    """The issue list leaves a project template out, the project list carries it, keys filled in."""
    sign_in(teams, OWNER)
    teams.post(f"{_base(workspace)}/teams/{TEAM}/templates", json={"name": "Bug", "title": "Bug: "})
    saved = _save(teams, workspace)

    assert saved["kind"] == "project"
    assert [row["key"] for row in saved["project"]["milestones"]] == ["alpha", "m1"]
    assert [row["key"] for row in saved["project"]["issues"]] == ["plan", "i1", "i2"]
    issue_names = [row["name"] for row in teams.get(f"{_base(workspace)}/teams/{TEAM}/templates").json()["templates"]]
    project_list = teams.get(f"{_base(workspace)}/teams/{TEAM}/templates", params={"kind": "project"}).json()
    assert issue_names == ["Bug"]
    assert [row["name"] for row in project_list["templates"]] == ["Launch plan"]
    assert project_list["default_template_id"] is None


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "project", "name": "X", "title": "No issue fields"},
        {"kind": "issue", "name": "X", "project": {"description": "No project here"}},
        {"kind": "project", "name": "X", "project": {"issues": [{"title": "A", "parent_key": "later"}]}},
        {"kind": "project", "name": "X", "project": {"issues": [{"title": "A", "milestone_key": "nope"}]}},
        {"kind": "project", "name": "X", "project": {"milestones": [{"key": "a", "name": "A"}] * 2}},
        {"kind": "project", "name": "X", "project": {"start_offset_days": 9, "target_offset_days": 3}},
        {"kind": "project", "name": "X", "project": {"lead_id": "01JB0000000000000000NOBODY"}},
    ],
)
def test_saving_a_project_template_checks_its_references(
    teams: TestClient, workspace: str, body: dict[str, Any]
) -> None:
    """Issue fields on a project template, and a key or person that names nothing, are refused."""
    sign_in(teams, OWNER)

    response = teams.post(f"{_base(workspace)}/teams/{TEAM}/templates", json=body)

    assert response.status_code == 422, response.text


def test_a_project_template_is_edited_whole_and_deleted(teams: TestClient, workspace: str) -> None:
    """A patch replaces the project blueprint whole, and the template is deleted by id."""
    sign_in(teams, OWNER)
    saved = _save(teams, workspace)
    path = f"{_base(workspace)}/teams/{TEAM}/templates/{saved['id']}"

    patched = teams.patch(path, json={"name": "Lean launch", "project": {"milestones": [{"name": "Only"}]}})

    assert patched.status_code == 200, patched.text
    assert patched.json()["name"] == "Lean launch"
    assert [row["name"] for row in patched.json()["project"]["milestones"]] == ["Only"]
    assert patched.json()["project"]["issues"] == []
    assert teams.patch(path, json={"title": "Nope"}).status_code == 422
    assert teams.delete(path).status_code == 204
    assert teams.get(f"{_base(workspace)}/teams/{TEAM}/templates", params={"kind": "project"}).json()["templates"] == []


def test_a_team_keeps_one_default_of_each_kind(teams: TestClient, workspace: str) -> None:
    """Setting the project default keeps the issue default, and each must be a template of its kind."""
    sign_in(teams, OWNER)
    issue = teams.post(f"{_base(workspace)}/teams/{TEAM}/templates", json={"name": "Bug"}).json()
    project = _save(teams, workspace)
    path = f"{_base(workspace)}/teams/{TEAM}/template-settings"
    assert teams.patch(path, json={"default_template_id": issue["id"]}).status_code == 200

    wrong = teams.patch(path, json={"default_project_template_id": issue["id"]})
    response = teams.patch(path, json={"default_project_template_id": project["id"]})

    assert wrong.status_code == 422
    assert response.status_code == 200, response.text
    assert response.json()["default_template_id"] == issue["id"]
    assert response.json()["effective_default_project_template_id"] == project["id"]
    listed = teams.get(f"{_base(workspace)}/teams/{TEAM}/templates", params={"kind": "project"}).json()
    assert listed["default_template_id"] == project["id"]


def test_a_project_created_from_a_template_starts_with_its_milestones_and_issues(
    client: TestClient, teams: TestClient, workspace: str, repositories: Any
) -> None:
    """Every field left out is filled, dates count from today, and issues land under their milestones."""
    sign_in(teams, OWNER)
    template = _save(teams, workspace)
    sign_in(client, MEMBER)

    response = client.post(
        f"{_base(workspace)}/projects",
        json={"team_ids": [TEAM], "name": "October launch", "priority": "low", "template_id": template["id"]},
    )

    assert response.status_code == 201, response.text
    project = response.json()
    assert project["description"] == "Ship the launch"
    assert project["lead_id"] == ADMIN
    assert sorted(project["member_ids"]) == sorted([ADMIN, MEMBER])
    assert project["status"] == "planned"
    assert project["priority"] == "low"
    assert project["start_date"] == _offset(0)
    assert project["target_date"] == _offset(30)
    milestones = client.get(f"{_base(workspace)}/projects/{project['project_id']}/milestones").json()["milestones"]
    assert [(row["name"], row["target_date"]) for row in milestones] == [
        ("Alpha", _offset(10)),
        ("Beta", _offset(20)),
    ]
    by_name = {row["name"]: row["milestone_id"] for row in milestones}
    issues = {row.title: row for row in repositories.issues.iter_for_project(workspace, TEAM, project["project_id"])}
    assert set(issues) == {"Write the plan", "Review the plan", "Announce"}
    assert issues["Write the plan"].priority == "urgent"
    assert issues["Write the plan"].project_milestone_id == by_name["Alpha"]
    assert issues["Review the plan"].parent_id == issues["Write the plan"].issue_id
    assert issues["Review the plan"].assignee_id == MEMBER
    assert issues["Announce"].project_milestone_id == by_name["Beta"]


def test_a_person_who_left_is_dropped_when_the_template_is_applied(
    client: TestClient, teams: TestClient, workspace: str, repositories: Any
) -> None:
    """A lead removed from the workspace since the template was saved is left off, not refused."""
    sign_in(teams, OWNER)
    template = _save(teams, workspace)
    repositories.memberships.delete(workspace, ADMIN)
    sign_in(client, OWNER)

    response = client.post(
        f"{_base(workspace)}/projects", json={"team_ids": [TEAM], "name": "Later", "template_id": template["id"]}
    )

    assert response.status_code == 201, response.text
    assert response.json()["lead_id"] is None
    assert response.json()["member_ids"] == [MEMBER]


def test_a_template_none_of_the_projects_teams_offer_is_refused(
    client: TestClient, teams: TestClient, workspace: str
) -> None:
    """A project template of another team cannot seed a project that team is not on."""
    sign_in(teams, OWNER)
    template = _save(teams, workspace)
    sign_in(client, OWNER)

    response = client.post(
        f"{_base(workspace)}/projects",
        json={"team_ids": [OTHER_TEAM], "name": "Elsewhere", "template_id": template["id"]},
    )

    assert response.status_code == 422, response.text
