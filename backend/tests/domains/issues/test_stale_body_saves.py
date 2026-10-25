"""Description saves made against an older description are refused, not written over it.

The properties held: a save sent with the version it read lands, a save sent
with a version someone else moved on from is a `BODY_CHANGED` 409 carrying the
current description and its version, a save with no version writes as before,
a patch that leaves the description alone is never held to the version, and a
save that loses a race after its read is still refused rather than landing.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import issue_writes
from app.common.body_versions import BODY_CHANGED, body_version
from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.issues.conftest import WORKSPACE, create_issue


def _path(workspace: str, issue_id: str) -> str:
    """One issue's route."""
    return f"/api/workspaces/{workspace}/issues/{issue_id}"


def test_an_issue_reads_with_the_version_of_its_description(client: TestClient, workspace: str) -> None:
    """An issue answers the version of its description, an empty one included."""
    sign_in(client, MEMBER)
    created = create_issue(client, workspace, body="First")

    assert created["body_version"] == body_version("First")
    assert create_issue(client, workspace)["body_version"] == body_version("")


def test_a_save_against_the_current_version_lands(client: TestClient, workspace: str) -> None:
    """A save sent with the version it read writes the new description."""
    sign_in(client, MEMBER)
    created = create_issue(client, workspace, body="First")

    saved = client.patch(
        _path(workspace, created["id"]), json={"body": "Second", "base_body_version": created["body_version"]}
    )

    assert saved.status_code == 200, saved.text
    assert saved.json()["body"] == "Second"
    assert saved.json()["body_version"] == body_version("Second")


def test_a_save_against_a_stale_version_is_refused_with_the_current_body(client: TestClient, workspace: str) -> None:
    """A save from an older version is a 409 carrying the current description, which stays."""
    sign_in(client, MEMBER)
    created = create_issue(client, workspace, body="First")
    path = _path(workspace, created["id"])
    assert client.patch(path, json={"body": "Theirs", "base_body_version": created["body_version"]}).status_code == 200

    stale = client.patch(path, json={"body": "Mine", "base_body_version": created["body_version"]})

    assert stale.status_code == 409, stale.text
    assert stale.json()["error_code"] == BODY_CHANGED
    assert stale.json()["details"] == {"body": "Theirs", "body_version": body_version("Theirs")}
    assert client.get(path).json()["body"] == "Theirs"


def test_a_save_without_a_version_writes_as_before(client: TestClient, workspace: str) -> None:
    """A caller that sends no version, such as an older client, still writes."""
    sign_in(client, MEMBER)
    created = create_issue(client, workspace, body="First")
    path = _path(workspace, created["id"])
    assert client.patch(path, json={"body": "Theirs"}).status_code == 200

    blind = client.patch(path, json={"body": "Mine"})

    assert blind.status_code == 200, blind.text
    assert blind.json()["body"] == "Mine"


def test_a_property_change_is_never_held_to_the_version(client: TestClient, workspace: str) -> None:
    """A title change sent with a stale version still lands, since it leaves the description alone."""
    sign_in(client, MEMBER)
    created = create_issue(client, workspace, body="First")
    path = _path(workspace, created["id"])
    assert client.patch(path, json={"body": "Theirs"}).status_code == 200

    renamed = client.patch(path, json={"title": "Renamed", "base_body_version": created["body_version"]})

    assert renamed.status_code == 200, renamed.text
    assert (renamed.json()["title"], renamed.json()["body"]) == ("Renamed", "Theirs")


def test_a_rename_does_not_make_an_open_editor_stale(client: TestClient, workspace: str) -> None:
    """A property edit made meanwhile leaves the version the editor holds current."""
    sign_in(client, MEMBER)
    created = create_issue(client, workspace, body="First")
    path = _path(workspace, created["id"])
    assert client.patch(path, json={"title": "Renamed", "priority": "high"}).status_code == 200

    saved = client.patch(path, json={"body": "Second", "base_body_version": created["body_version"]})

    assert saved.status_code == 200, saved.text
    assert saved.json()["body"] == "Second"


def test_an_empty_description_saves_against_its_version(client: TestClient, workspace: str) -> None:
    """An issue with no description takes a first one against the empty version."""
    sign_in(client, MEMBER)
    created = create_issue(client, workspace)

    saved = client.patch(
        _path(workspace, created["id"]), json={"body": "Now written", "base_body_version": created["body_version"]}
    )

    assert saved.status_code == 200, saved.text
    assert saved.json()["body"] == "Now written"


def test_a_save_that_loses_a_race_after_its_read_is_refused(
    client: TestClient, workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A description landing between the read and the write still refuses the save."""
    sign_in(client, MEMBER)
    created = create_issue(client, workspace, body="First")
    original = issue_writes.apply_patch

    def racing(*args: Any, **kwargs: Any) -> Issue:
        """Plan the patch, then let a teammate's description land before it is written."""
        planned = original(*args, **kwargs)
        row = repositories.issues.get(WORKSPACE, created["id"])
        repositories.issues.replace(row.model_copy(update={"body": "Theirs"}))
        return planned

    monkeypatch.setattr(issue_writes, "apply_patch", racing)
    stale = client.patch(
        _path(workspace, created["id"]), json={"body": "Mine", "base_body_version": created["body_version"]}
    )

    assert stale.status_code == 409, stale.text
    assert stale.json()["error_code"] == BODY_CHANGED
    assert stale.json()["details"]["body"] == "Theirs"
    stored = repositories.issues.get(WORKSPACE, created["id"])
    assert stored is not None and stored.body == "Theirs"
