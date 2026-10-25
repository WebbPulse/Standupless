"""Issues in a retired team: readable and searchable, refused every write.

Retirement is set straight on the team row, since the retire route belongs to the
teams domain; what matters here is that the issue write checks read it.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


def test_a_retired_teams_issues_read_but_refuse_writes(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Reads, search and the key lookup keep working, and create, edit and move-in answer 409."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, title="Legacy work")
    other = create_issue(client, workspace, team_id=OTHER_TEAM, title="Active work")
    repositories.teams.set_retired(workspace, TEAM, OWNER)
    base = f"/api/workspaces/{workspace}/issues"

    created = client.post(base, json={"team_id": TEAM, "title": "Nope"})
    edited = client.patch(f"{base}/{issue['id']}", json={"title": "Nope"})
    moved_in = client.post(f"{base}/{other['id']}/move", json={"team_id": TEAM})

    for refused in (created, edited, moved_in):
        assert refused.status_code == 409, refused.text
        assert refused.json()["error_code"] == "TEAM_RETIRED"

    assert client.get(f"{base}/{issue['id']}").json()["title"] == "Legacy work"
    assert client.get(f"{base}/by-key/{issue['key']}").status_code == 200
    listed = client.get(base, params={"team_id": TEAM}).json()["issues"]
    assert [row["id"] for row in listed] == [issue["id"]]

    repositories.teams.set_retired(workspace, TEAM, None)
    assert client.patch(f"{base}/{issue['id']}", json={"title": "Back"}).status_code == 200


def test_a_retired_teams_trash_refuses_delete_restore_and_purge(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Deleting, restoring and purging for good are writes, so a retired team answers 409 to each."""
    sign_in(client, OWNER)
    live = create_issue(client, workspace, title="Still here")
    trashed = create_issue(client, workspace, title="In the trash")
    base = f"/api/workspaces/{workspace}/issues"
    assert client.delete(f"{base}/{trashed['id']}").status_code == 204
    repositories.teams.set_retired(workspace, TEAM, OWNER)

    deleted = client.delete(f"{base}/{live['id']}")
    restored = client.post(f"{base}/{trashed['id']}/restore")
    purged = client.delete(f"{base}/{trashed['id']}/permanent")

    for refused in (deleted, restored, purged):
        assert refused.status_code == 409, refused.text
        assert refused.json()["error_code"] == "TEAM_RETIRED"

    repositories.teams.set_retired(workspace, TEAM, None)
    assert client.post(f"{base}/{trashed['id']}/restore").status_code == 200
