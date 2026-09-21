"""Attaching an issue to a cycle or a project, from the issues domain's side.

M4 adds `cycle_id` and `project_id` to the issue body. The properties worth
holding are that a target from another team is refused at the write rather than
tolerated on the row, that clearing an attachment writes no attribute so the two
sparse indexes stay sparse, and that the list filters read what the row holds.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.planning.conftest import (
    OTHER_TEAM,
    TEAM,
    WORKSPACE,
    seed_cycle,
    seed_issue,
    seed_project,
)


def test_an_issue_carries_its_cycle_and_project(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """Both attachments are optional fields of the issue body."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    project = seed_project(client, workspace)

    sign_in(issues_client, MEMBER)
    issue = seed_issue(
        issues_client,
        workspace,
        cycle_id=cycle["cycle_id"],
        project_id=project["project_id"],
    )

    assert issue["cycle_id"] == cycle["cycle_id"]
    assert issue["project_id"] == project["project_id"]


def test_a_cycle_from_another_team_is_refused(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """A foreign cycle would count the issue into a bar its own team never sees."""
    sign_in(client, OWNER)
    foreign = seed_cycle(client, workspace, team_id=OTHER_TEAM)

    sign_in(issues_client, OWNER)
    response = issues_client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"team_id": TEAM, "title": "Wrong cycle", "cycle_id": foreign["cycle_id"]},
    )

    assert response.status_code == 422


def test_a_project_that_does_not_exist_is_refused(issues_client: TestClient, workspace: str) -> None:
    """The target is read back rather than trusted."""
    sign_in(issues_client, MEMBER)

    response = issues_client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"team_id": TEAM, "title": "No such", "project_id": "01JB0000000000000000NOPE1"},
    )

    assert response.status_code == 422


def test_a_patch_attaches_and_detaches(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """Attaching later is a patch, and null detaches."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)

    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)

    attached = issues_client.patch(
        f"/api/workspaces/{workspace}/issues/{issue['id']}",
        json={"cycle_id": cycle["cycle_id"]},
    )
    assert attached.status_code == 200
    assert attached.json()["cycle_id"] == cycle["cycle_id"]

    detached = issues_client.patch(
        f"/api/workspaces/{workspace}/issues/{issue['id']}",
        json={"cycle_id": None},
    )
    assert detached.status_code == 200
    assert detached.json()["cycle_id"] is None


def test_an_unattached_issue_writes_no_attribute(issues_client: TestClient, repositories: Any, workspace: str) -> None:
    """Both indexes are sparse, so a null would still index the row."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)

    item = repositories.issues._repository.get({"workspace_id": WORKSPACE, "issue_id": issue["id"]})

    assert "cycle_id" not in item
    assert "project_id" not in item


def test_the_list_filters_on_the_attachment(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """A cycle's issue list is what a planning page reads."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)

    sign_in(issues_client, MEMBER)
    seed_issue(issues_client, workspace, title="In the cycle", cycle_id=cycle["cycle_id"])
    seed_issue(issues_client, workspace, title="Out of it")

    response = issues_client.get(
        f"/api/workspaces/{workspace}/issues",
        params={"team_id": TEAM, "cycle_id": cycle["cycle_id"]},
    )

    assert [row["title"] for row in response.json()["issues"]] == ["In the cycle"]


def test_a_patch_refuses_a_cycle_from_another_team(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """The same rule applies on the patch path as on the create one."""
    sign_in(client, OWNER)
    foreign = seed_cycle(client, workspace, team_id=OTHER_TEAM)

    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace)

    response = issues_client.patch(
        f"/api/workspaces/{workspace}/issues/{issue['id']}",
        json={"cycle_id": foreign["cycle_id"]},
    )

    assert response.status_code == 422
