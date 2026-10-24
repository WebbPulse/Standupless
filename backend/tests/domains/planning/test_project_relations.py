"""Project dependencies: one project blocks another.

The properties worth holding are that a link reads from both sides, that a repeat
is harmless, that a self link or a loop is refused, that the list and the project
read carry the blockers and the blocked projects, that a hidden project never
shows up at either end, and that deleting a project takes its links with it.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, seed_project

NOPE = "01JB0000000000000000NOPE01"


def _relations(workspace: str, project_id: str, relation_id: str = "") -> str:
    """One project's relation collection, or one relation when an id is given."""
    base = f"/api/workspaces/{workspace}/projects/{project_id}/relations"
    return f"{base}/{relation_id}" if relation_id else base


def _link(client: TestClient, workspace: str, project_id: str, kind: str, target: str) -> Any:
    """Post one dependency and answer the response."""
    return client.post(_relations(workspace, project_id), json={"type": kind, "target_project_id": target})


def test_a_dependency_reads_from_both_sides(client: TestClient, workspace: str) -> None:
    """`A blocks B` lists on A as blocks and on B as blocked_by, under one id."""
    sign_in(client, MEMBER)
    first = seed_project(client, workspace, name="Foundation")
    second = seed_project(client, workspace, name="Walls")

    created = _link(client, workspace, first["project_id"], "blocks", second["project_id"])
    on_first = client.get(_relations(workspace, first["project_id"])).json()["relations"]
    on_second = client.get(_relations(workspace, second["project_id"])).json()["relations"]

    assert created.status_code == 201
    assert created.json()["type"] == "blocks"
    assert [(row["type"], row["target_project_id"]) for row in on_first] == [("blocks", second["project_id"])]
    assert [(row["type"], row["target_project_id"]) for row in on_second] == [("blocked_by", first["project_id"])]
    assert on_first[0]["relation_id"] == on_second[0]["relation_id"] == created.json()["relation_id"]


def test_blocked_by_is_stored_as_the_inverse(client: TestClient, workspace: str) -> None:
    """Linking from the waiting side lands on the same pair, and a repeat answers it with a 200."""
    sign_in(client, MEMBER)
    first = seed_project(client, workspace, name="Foundation")
    second = seed_project(client, workspace, name="Walls")

    created = _link(client, workspace, second["project_id"], "blocked_by", first["project_id"])
    repeated = _link(client, workspace, first["project_id"], "blocks", second["project_id"])

    assert created.status_code == 201
    assert repeated.status_code == 200
    assert repeated.json()["relation_id"] == created.json()["relation_id"]
    assert len(client.get(_relations(workspace, first["project_id"])).json()["relations"]) == 1


def test_a_self_link_and_a_loop_are_refused(client: TestClient, workspace: str) -> None:
    """Projects that wait on each other could never start."""
    sign_in(client, MEMBER)
    first = seed_project(client, workspace, name="One")
    second = seed_project(client, workspace, name="Two")
    third = seed_project(client, workspace, name="Three")
    assert _link(client, workspace, first["project_id"], "blocks", second["project_id"]).status_code == 201
    assert _link(client, workspace, second["project_id"], "blocks", third["project_id"]).status_code == 201

    self_link = _link(client, workspace, first["project_id"], "blocks", first["project_id"])
    inverse = _link(client, workspace, first["project_id"], "blocked_by", second["project_id"])
    loop = _link(client, workspace, third["project_id"], "blocks", first["project_id"])

    assert self_link.status_code == 422
    assert inverse.status_code == 422
    assert loop.status_code == 422


def test_the_list_and_the_read_carry_both_directions(client: TestClient, workspace: str) -> None:
    """The projects list shows each row's blockers and blocked projects without another call."""
    sign_in(client, MEMBER)
    first = seed_project(client, workspace, name="Foundation", target_date="2026-01-01")
    second = seed_project(client, workspace, name="Walls", target_date="2026-02-01")
    _link(client, workspace, first["project_id"], "blocks", second["project_id"])

    listed = {row["project_id"]: row for row in client.get(f"/api/workspaces/{workspace}/projects").json()["projects"]}
    read = client.get(f"/api/workspaces/{workspace}/projects/{second['project_id']}").json()
    patched = client.patch(
        f"/api/workspaces/{workspace}/projects/{first['project_id']}", json={"name": "Footings"}
    ).json()

    assert listed[first["project_id"]]["blocking_project_ids"] == [second["project_id"]]
    assert listed[first["project_id"]]["blocked_by_project_ids"] == []
    assert listed[second["project_id"]]["blocked_by_project_ids"] == [first["project_id"]]
    assert read["blocked_by_project_ids"] == [first["project_id"]]
    assert patched["blocking_project_ids"] == [second["project_id"]]


def test_a_hidden_project_is_never_an_end(client: TestClient, workspace: str) -> None:
    """A guest sees no link to a project on a team it was not invited to, and cannot link one."""
    sign_in(client, OWNER)
    shared = seed_project(client, workspace, name="Shared")
    hidden = seed_project(client, workspace, name="Hidden", team_id=OTHER_TEAM)
    _link(client, workspace, hidden["project_id"], "blocks", shared["project_id"])

    sign_in(client, GUEST)
    relations = client.get(_relations(workspace, shared["project_id"])).json()["relations"]
    read = client.get(f"/api/workspaces/{workspace}/projects/{shared['project_id']}").json()
    linked = _link(client, workspace, shared["project_id"], "blocks", hidden["project_id"])
    absent = _link(client, workspace, shared["project_id"], "blocks", NOPE)

    assert relations == []
    assert read["blocked_by_project_ids"] == []
    assert linked.status_code == 404
    assert absent.status_code == 404


def test_a_dependency_is_removed_from_either_side(client: TestClient, workspace: str) -> None:
    """The waiting project may drop the link, and an unknown id is a 404."""
    sign_in(client, MEMBER)
    first = seed_project(client, workspace, name="Foundation")
    second = seed_project(client, workspace, name="Walls")
    relation_id = _link(client, workspace, first["project_id"], "blocks", second["project_id"]).json()["relation_id"]

    removed = client.delete(_relations(workspace, second["project_id"], relation_id))
    again = client.delete(_relations(workspace, second["project_id"], relation_id))

    assert removed.status_code == 204
    assert again.status_code == 404
    assert client.get(_relations(workspace, first["project_id"])).json()["relations"] == []


def test_deleting_a_project_takes_its_dependencies(client: TestClient, workspace: str) -> None:
    """A link to a deleted project would point at nothing."""
    sign_in(client, OWNER)
    first = seed_project(client, workspace, name="Foundation")
    second = seed_project(client, workspace, name="Walls")
    _link(client, workspace, first["project_id"], "blocks", second["project_id"])

    deleted = client.delete(f"/api/workspaces/{workspace}/projects/{first['project_id']}")
    read = client.get(f"/api/workspaces/{workspace}/projects/{second['project_id']}").json()

    assert deleted.status_code == 204
    assert read["blocked_by_project_ids"] == []
    assert client.get(_relations(workspace, second["project_id"])).json()["relations"] == []
