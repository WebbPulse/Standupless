"""An issue's description history: versions recorded on save, coalesced, capped and restored.

Each version is the text one save left, so the newest version is always the
current description. Saves by one author close together share a version, the
text an issue was created with and the text a restore replaced are kept apart,
and the oldest versions go once the cap is reached.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import issue_descriptions
from app.common.db.dynamo.activity import DESCRIPTION_VERSIONS_KEPT
from app.common.db.dynamo.base import utc_now
from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, create_issue


class Clock:
    """A settable stand-in for `utc_now` in the version recorder."""

    def __init__(self) -> None:
        """Start at the real current time."""
        self.now = utc_now()

    def __call__(self) -> Any:
        """The time the clock is set to."""
        return self.now

    def advance(self, minutes: float) -> None:
        """Move the clock forward."""
        self.now = self.now + timedelta(minutes=minutes)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    """A clock the recorder reads, so a test can step past the coalescing gap."""
    fake = Clock()
    monkeypatch.setattr(issue_descriptions, "utc_now", fake)
    return fake


def versions(client: TestClient, workspace: str, issue_id: str) -> list[dict[str, Any]]:
    """The issue's description versions, newest first, as the route answers them."""
    response = client.get(f"/api/workspaces/{workspace}/issues/{issue_id}/description-versions")
    assert response.status_code == 200, response.text
    return response.json()["versions"]


def edit(client: TestClient, workspace: str, issue_id: str, body: str) -> None:
    """Save a new description through the patch route."""
    response = client.patch(f"/api/workspaces/{workspace}/issues/{issue_id}", json={"body": body})
    assert response.status_code == 200, response.text


def test_creating_with_a_description_records_it(client: TestClient, workspace: str, statuses: Any) -> None:
    """The text an issue was created with is its first version, by its creator."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, body="Original")

    rows = versions(client, workspace, issue["id"])
    assert [row["body"] for row in rows] == ["Original"]
    assert rows[0]["edited_by"] == OWNER
    assert rows[0]["source"] == "web"


def test_creating_without_a_description_records_nothing(client: TestClient, workspace: str, statuses: Any) -> None:
    """An empty description is not a version."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)

    assert versions(client, workspace, issue["id"]) == []


def test_rapid_edits_by_one_author_share_a_version(
    client: TestClient, workspace: str, statuses: Any, clock: Clock
) -> None:
    """Edits within the gap rewrite the newest version, but never the one created with the issue."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, body="Original")
    edit(client, workspace, issue["id"], "Draft one")
    clock.advance(1)
    edit(client, workspace, issue["id"], "Draft two")
    clock.advance(1)
    edit(client, workspace, issue["id"], "Draft three")

    assert [row["body"] for row in versions(client, workspace, issue["id"])] == ["Draft three", "Original"]


def test_an_edit_after_the_gap_starts_a_new_version(
    client: TestClient, workspace: str, statuses: Any, clock: Clock
) -> None:
    """A pause longer than the gap keeps the earlier sitting as its own version."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, body="Original")
    edit(client, workspace, issue["id"], "First sitting")
    clock.advance(10)
    edit(client, workspace, issue["id"], "Second sitting")

    assert [row["body"] for row in versions(client, workspace, issue["id"])] == [
        "Second sitting",
        "First sitting",
        "Original",
    ]


def test_another_authors_edit_starts_a_new_version(
    client: TestClient, workspace: str, statuses: Any, clock: Clock
) -> None:
    """A second author within the gap does not overwrite the first author's version."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, body="Original")
    edit(client, workspace, issue["id"], "Owner text")
    sign_in(client, MEMBER)
    edit(client, workspace, issue["id"], "Member text")

    rows = versions(client, workspace, issue["id"])
    assert [(row["body"], row["edited_by"]) for row in rows] == [
        ("Member text", MEMBER),
        ("Owner text", OWNER),
        ("Original", OWNER),
    ]


def test_a_description_written_without_a_version_is_kept_before_the_edit(
    client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """Text that changed outside the recorder, such as a sync, is kept so a restore can reach it."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    stored = repositories.issues.get(workspace, issue["id"])
    repositories.issues.replace(stored.model_copy(update={"body": "Synced text"}))

    edit(client, workspace, issue["id"], "Edited text")

    assert [row["body"] for row in versions(client, workspace, issue["id"])] == ["Edited text", "Synced text"]


def test_versions_are_capped_dropping_the_oldest(
    client: TestClient, workspace: str, statuses: Any, clock: Clock
) -> None:
    """Past the cap the oldest version goes, so the newest stay reachable."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, body="Original")
    for number in range(DESCRIPTION_VERSIONS_KEPT + 2):
        clock.advance(10)
        edit(client, workspace, issue["id"], f"Version {number}")

    rows = versions(client, workspace, issue["id"])
    assert len(rows) == DESCRIPTION_VERSIONS_KEPT
    assert rows[0]["body"] == f"Version {DESCRIPTION_VERSIONS_KEPT + 1}"
    assert "Original" not in {row["body"] for row in rows}


def test_restoring_a_version_brings_its_text_back(
    client: TestClient, workspace: str, statuses: Any, clock: Clock
) -> None:
    """A restore writes the old text, keeps the replaced text and records a body change."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, body="Original")
    edit(client, workspace, issue["id"], "Replaced")
    original = versions(client, workspace, issue["id"])[-1]

    response = client.post(
        f"/api/workspaces/{workspace}/issues/{issue['id']}/description-versions/{original['version_id']}/restore"
    )
    assert response.status_code == 200, response.text
    assert response.json()["body"] == "Original"

    assert [row["body"] for row in versions(client, workspace, issue["id"])] == ["Original", "Replaced", "Original"]
    history = client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}/activity").json()["activity"]
    assert any(row["kind"] == "field_changed" and row["field"] == "body" for row in history)


def test_an_unknown_version_is_a_404(client: TestClient, workspace: str, statuses: Any) -> None:
    """A version id the issue never had is not found rather than restoring nothing."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, body="Original")

    response = client.post(
        f"/api/workspaces/{workspace}/issues/{issue['id']}/description-versions/01M0000000000000000000000/restore"
    )
    assert response.status_code == 404, response.text


def test_a_caller_outside_the_team_reaches_no_versions(client: TestClient, workspace: str, statuses: Any) -> None:
    """A guest outside the team can neither list nor restore, and sees the issue as absent."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, team_id=OTHER_TEAM, body="Private")
    version = versions(client, workspace, issue["id"])[0]

    sign_in(client, GUEST)
    path = f"/api/workspaces/{workspace}/issues/{issue['id']}/description-versions"
    assert client.get(path).status_code == 404
    assert client.post(f"{path}/{version['version_id']}/restore").status_code == 404


def test_deleting_the_issue_removes_its_versions(
    client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """The versions go with the issue, so nothing is left under its id."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, body="Original")
    edit(client, workspace, issue["id"], "Edited")

    response = client.delete(f"/api/workspaces/{workspace}/issues/{issue['id']}")
    assert response.status_code == 204, response.text

    assert repositories.activity.list_description_versions(workspace, issue["id"]) == []
