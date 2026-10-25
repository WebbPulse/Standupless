"""Duplicating an issue and converting an issue into a project, through the issues routes.

A duplicate is checked for what it copies and what it leaves behind, and a
conversion for the project it creates, the sub-issues it moves and the original
it closes, with the activity each write leaves.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import issue_conversion

from app.common.db.dynamo.planning import Project, ProjectMilestone, milestone_key, project_key
from app.common.db.dynamo.team_config import Label, label_key, new_config_id
from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


def _label(repositories: Any, workspace: str, name: str) -> str:
    """Seed one label of `TEAM`, answering its id."""
    label_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=workspace,
            config_key=label_key(TEAM, label_id),
            team_id=TEAM,
            label_id=label_id,
            name=name,
            color="#ff0000",
        )
    )
    return label_id


def _project_with_milestone(repositories: Any, workspace: str) -> tuple[str, str]:
    """Seed a project on `TEAM` with one milestone, answering both ids."""
    repositories.planning.create_project(
        Project(
            workspace_id=workspace,
            planning_key=project_key("PD"),
            project_id="PD",
            team_ids=[TEAM],
            name="Planned",
            created_by=OWNER,
        )
    )
    milestone = ProjectMilestone(
        workspace_id=workspace, planning_key="", project_id="PD", name="Beta", sort_order="m", created_by=OWNER
    )
    milestone.planning_key = milestone_key("PD", milestone.milestone_id)
    repositories.planning.create_milestone(milestone)
    return "PD", milestone.milestone_id


def _post(client: TestClient, workspace: str, issue_id: str, action: str) -> Any:
    """One POST to an issue action route, answering the raw response."""
    return client.post(f"/api/workspaces/{workspace}/issues/{issue_id}/{action}")


def _history(repositories: Any, workspace: str, issue_id: str) -> "list[dict[str, Any]]":
    """The activity rows of one issue, newest first."""
    return [dict(item) for item in repositories.activity.list_for_issue(workspace, issue_id, limit=200).items]


def test_a_duplicate_copies_what_describes_the_work(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The copy keeps the title with a suffix, body, labels, priority, estimate, parent, project and milestone."""
    repositories.teams.update(workspace, TEAM, estimate_scale="tshirt", estimate_extended=False)
    label = _label(repositories, workspace, "Bug")
    project_id, milestone_id = _project_with_milestone(repositories, workspace)
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    issue = create_issue(
        client,
        workspace,
        title="Fix the login",
        body="Steps to reproduce",
        priority="high",
        label_ids=[label],
        estimate="M",
        parent_id=parent["id"],
        project_id=project_id,
        project_milestone_id=milestone_id,
        assignee_id=OWNER,
        due_date="2026-12-01",
        status_id=statuses["started"].status_id,
    )

    response = _post(client, workspace, issue["id"], "duplicate")

    assert response.status_code == 201, response.text
    copy = response.json()
    assert copy["id"] != issue["id"]
    assert copy["key"] != issue["key"]
    assert copy["team_id"] == TEAM
    assert copy["title"] == "Fix the login (copy)"
    assert copy["body"] == "Steps to reproduce"
    assert copy["priority"] == "high"
    assert copy["label_ids"] == [label]
    assert copy["estimate"] == "M"
    assert copy["parent_id"] == parent["id"]
    assert copy["project_id"] == project_id
    assert copy["project_milestone_id"] == milestone_id
    assert copy["assignee_id"] is None
    assert copy["due_date"] is None
    assert copy["status_id"] == create_issue(client, workspace, title="Fresh")["status_id"]
    assert copy["status_id"] != statuses["started"].status_id
    assert [row["kind"] for row in _history(repositories, workspace, copy["id"])][-1] == "created"


def test_a_duplicate_title_stays_within_the_cap(client: TestClient, workspace: str) -> None:
    """A title at the cap is shortened so the suffix still fits."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, title="x" * 200)

    copy = _post(client, workspace, issue["id"], "duplicate").json()

    assert len(copy["title"]) == 200
    assert copy["title"].endswith(" (copy)")


def test_a_duplicate_of_an_invisible_issue_is_not_found(client: TestClient, workspace: str) -> None:
    """A guest cannot copy an issue from a team they cannot see."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, team_id=OTHER_TEAM, title="Elsewhere")
    sign_in(client, GUEST)

    assert _post(client, workspace, issue["id"], "duplicate").status_code == 404


def _children(repositories: Any, workspace: str, issue_id: str) -> "list[Any]":
    """The direct children of one issue, oldest first."""
    return list(repositories.issues.iter_children(workspace, issue_id))


def test_a_duplicate_leaves_sub_issues_behind_by_default(client: TestClient, workspace: str, repositories: Any) -> None:
    """Without the flag, and with it off, only the issue itself is copied."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Checklist")
    create_issue(client, workspace, title="Step", parent_id=parent["id"])

    bare = _post(client, workspace, parent["id"], "duplicate").json()
    off = client.post(
        f"/api/workspaces/{workspace}/issues/{parent['id']}/duplicate", json={"include_sub_issues": False}
    ).json()

    assert _children(repositories, workspace, bare["id"]) == []
    assert _children(repositories, workspace, off["id"]) == []


def test_a_duplicate_with_sub_issues_copies_the_whole_tree(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Open and closed sub-issues, at every depth, are copied in order under the copy by the same rules."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Checklist")
    later = create_issue(client, workspace, title="Later", parent_id=parent["id"], sort_order="b")
    first = create_issue(
        client,
        workspace,
        title="First",
        parent_id=parent["id"],
        sort_order="a",
        assignee_id=MEMBER,
        priority="high",
        status_id=statuses["completed"].status_id,
    )
    create_issue(client, workspace, title="Nested", parent_id=later["id"])

    response = client.post(
        f"/api/workspaces/{workspace}/issues/{parent['id']}/duplicate", json={"include_sub_issues": True}
    )

    assert response.status_code == 201, response.text
    copy = response.json()
    assert copy["title"] == "Checklist (copy)"
    copied = _children(repositories, workspace, copy["id"])
    assert [row.title for row in copied] == ["First", "Later"]
    assert [row.sort_order for row in copied] == ["a", "b"]
    default_status = create_issue(client, workspace, title="Fresh")["status_id"]
    copied_first = copied[0]
    assert copied_first.issue_id != first["id"]
    assert copied_first.priority == "high"
    assert copied_first.assignee_id is None
    assert copied_first.status_id == default_status
    nested = _children(repositories, workspace, copied[1].issue_id)
    assert [row.title for row in nested] == ["Nested"]
    assert [row.title for row in _children(repositories, workspace, parent["id"])] == ["Later", "First"]


def test_a_duplicate_above_the_sub_issue_cap_is_refused_before_anything_is_written(
    client: TestClient, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A tree larger than the cap answers 422 and files no copy at all."""
    monkeypatch.setattr(issue_conversion, "DUPLICATE_SUB_ISSUES_MAX", 2)
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Checklist")
    child = create_issue(client, workspace, title="One", parent_id=parent["id"])
    create_issue(client, workspace, title="Two", parent_id=parent["id"])
    create_issue(client, workspace, title="Deep", parent_id=child["id"])

    response = client.post(
        f"/api/workspaces/{workspace}/issues/{parent['id']}/duplicate", json={"include_sub_issues": True}
    )

    assert response.status_code == 422, response.text
    assert create_issue(client, workspace, title="Next")["number"] == parent["number"] + 4


def test_converting_creates_a_project_and_moves_the_sub_issues(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The project takes the issue's fields, its sub-issues join it, and the issue is closed into it."""
    sign_in(client, OWNER)
    issue = create_issue(
        client,
        workspace,
        title="Rebuild onboarding",
        body="The whole flow",
        priority="urgent",
        assignee_id=MEMBER,
        start_date="2026-11-01",
        due_date="2026-12-01",
        status_id=statuses["started"].status_id,
    )
    first = create_issue(client, workspace, title="Copy", parent_id=issue["id"])
    second = create_issue(client, workspace, title="Design", parent_id=issue["id"])

    response = _post(client, workspace, issue["id"], "convert-to-project")

    assert response.status_code == 200, response.text
    body = response.json()
    project = body["project"]
    assert project["name"] == "Rebuild onboarding"
    assert project["description"] == "The whole flow"
    assert project["priority"] == "urgent"
    assert project["lead_id"] == MEMBER
    assert project["start_date"] == "2026-11-01"
    assert project["target_date"] == "2026-12-01"
    assert project["status"] == "in_progress"
    assert project["team_ids"] == [TEAM]
    assert body["moved_issue_ids"] == [first["id"], second["id"]]
    closed = body["issue"]
    assert closed["project_id"] == project["project_id"]
    assert closed["status_id"] == statuses["completed"].status_id
    for child_id in (first["id"], second["id"]):
        child = repositories.issues.get(workspace, child_id)
        assert child.parent_id is None
        assert child.project_id == project["project_id"]
        fields = {row.get("field") for row in _history(repositories, workspace, child_id)}
        assert {"parent_id", "project_id"} <= fields
    fields = {row.get("field") for row in _history(repositories, workspace, issue["id"])}
    assert {"project_id", "status_id"} <= fields


def test_converting_closes_into_cancelled_without_a_completed_status(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A team with no completed status closes the issue as cancelled instead."""
    repositories.team_config.delete_status(workspace, TEAM, statuses["completed"].status_id)
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, title="No done column")

    body = _post(client, workspace, issue["id"], "convert-to-project").json()

    assert body["issue"]["status_id"] == statuses["cancelled"].status_id
    assert body["project"]["status"] == "backlog"
    assert body["moved_issue_ids"] == []


def test_converting_shortens_a_long_title_and_drops_a_departed_lead(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A title over the project name cap is cut, and an assignee who left the workspace is not made lead."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, title="y" * 150, assignee_id=MEMBER)
    repositories.memberships.delete(workspace, MEMBER)

    body = _post(client, workspace, issue["id"], "convert-to-project").json()

    assert body["project"]["name"] == "y" * 80
    assert body["project"]["lead_id"] is None


def test_converting_an_invisible_issue_is_not_found(client: TestClient, workspace: str, repositories: Any) -> None:
    """A guest cannot convert an issue from a team they cannot see, and no project is created."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, team_id=OTHER_TEAM, title="Elsewhere")
    sign_in(client, GUEST)

    assert _post(client, workspace, issue["id"], "convert-to-project").status_code == 404
    assert repositories.planning.list_projects(workspace) == []
