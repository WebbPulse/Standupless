"""Project overview saves made against an older description are refused, not written over it.

The properties held: a project reads with its description's version, a save
sent with the version it read lands, a save sent with a version someone else
moved on from is a `BODY_CHANGED` 409 carrying the current description and its
version, a save with no version writes as before, a patch that leaves the
description alone is never held to the version, and a save that loses a race
after its read is still refused rather than landing.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import project_writes
from app.common.body_versions import BODY_CHANGED, body_version
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.planning.conftest import WORKSPACE, seed_project


def _path(workspace: str, project_id: str) -> str:
    """One project's route."""
    return f"/api/workspaces/{workspace}/projects/{project_id}"


def test_a_project_reads_with_the_version_of_its_description(client: TestClient, workspace: str) -> None:
    """A project answers the version of its description, an empty one included."""
    sign_in(client, MEMBER)

    assert seed_project(client, workspace, description="First")["body_version"] == body_version("First")
    assert seed_project(client, workspace, name="Bare")["body_version"] == body_version("")


def test_a_save_against_the_current_version_lands(client: TestClient, workspace: str) -> None:
    """A save sent with the version it read writes the new description."""
    sign_in(client, MEMBER)
    created = seed_project(client, workspace, description="First")

    saved = client.patch(
        _path(workspace, created["project_id"]),
        json={"description": "Second", "base_body_version": created["body_version"]},
    )

    assert saved.status_code == 200, saved.text
    assert saved.json()["description"] == "Second"
    assert saved.json()["body_version"] == body_version("Second")


def test_a_save_against_a_stale_version_is_refused_with_the_current_description(
    client: TestClient, workspace: str
) -> None:
    """A save from an older version is a 409 carrying the current description, which stays."""
    sign_in(client, MEMBER)
    created = seed_project(client, workspace, description="First")
    path = _path(workspace, created["project_id"])
    theirs = client.patch(path, json={"description": "Theirs", "base_body_version": created["body_version"]})
    assert theirs.status_code == 200, theirs.text

    stale = client.patch(path, json={"description": "Mine", "base_body_version": created["body_version"]})

    assert stale.status_code == 409, stale.text
    assert stale.json()["error_code"] == BODY_CHANGED
    assert stale.json()["details"] == {"body": "Theirs", "body_version": body_version("Theirs")}
    assert client.get(path).json()["description"] == "Theirs"


def test_a_save_without_a_version_writes_as_before(client: TestClient, workspace: str) -> None:
    """A caller that sends no version, such as an older client, still writes."""
    sign_in(client, MEMBER)
    created = seed_project(client, workspace, description="First")
    path = _path(workspace, created["project_id"])
    assert client.patch(path, json={"description": "Theirs"}).status_code == 200

    blind = client.patch(path, json={"description": "Mine"})

    assert blind.status_code == 200, blind.text
    assert blind.json()["description"] == "Mine"


def test_a_property_change_is_never_held_to_the_version(client: TestClient, workspace: str) -> None:
    """A rename sent with a stale version still lands, since it leaves the description alone."""
    sign_in(client, MEMBER)
    created = seed_project(client, workspace, description="First")
    path = _path(workspace, created["project_id"])
    assert client.patch(path, json={"description": "Theirs"}).status_code == 200

    renamed = client.patch(path, json={"name": "Renamed", "base_body_version": created["body_version"]})

    assert renamed.status_code == 200, renamed.text
    assert (renamed.json()["name"], renamed.json()["description"]) == ("Renamed", "Theirs")


def test_an_empty_description_saves_against_its_version(client: TestClient, workspace: str) -> None:
    """A project with no description takes a first one against the empty version."""
    sign_in(client, MEMBER)
    created = seed_project(client, workspace, name="Bare")

    saved = client.patch(
        _path(workspace, created["project_id"]),
        json={"description": "Now written", "base_body_version": created["body_version"]},
    )

    assert saved.status_code == 200, saved.text
    assert saved.json()["description"] == "Now written"


def test_a_save_that_loses_a_race_after_its_read_is_refused(
    client: TestClient, workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A description landing between the read and the write still refuses the save."""
    sign_in(client, MEMBER)
    created = seed_project(client, workspace, description="First")
    original = project_writes.check_project_dates

    def racing(*args: Any, **kwargs: Any) -> Any:
        """Check the dates, then let a teammate's description land before the write."""
        result = original(*args, **kwargs)
        row = repositories.planning.get_project(WORKSPACE, created["project_id"])
        repositories.planning.replace_project(row.model_copy(update={"description": "Theirs"}))
        return result

    monkeypatch.setattr(project_writes, "check_project_dates", racing)
    stale = client.patch(
        _path(workspace, created["project_id"]),
        json={"description": "Mine", "base_body_version": created["body_version"]},
    )

    assert stale.status_code == 409, stale.text
    assert stale.json()["error_code"] == BODY_CHANGED
    assert stale.json()["details"]["body"] == "Theirs"
    stored = repositories.planning.get_project(WORKSPACE, created["project_id"])
    assert stored is not None and stored.description == "Theirs"
