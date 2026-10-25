"""Project Resources links: titled external links on one project's overview.

The properties worth holding are that links are reached only through a project
the caller can read, that they list in their manual order and reorder by patch,
that only http and https URLs with a host are taken, that a blank title reads as
no title, that a project holds a bounded set, that each add, edit and removal is
recorded in the project's activity, that the project read carries them, and that
deleting the project deletes them.
"""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.dynamodb import new_ulid

from app.common.db.dynamo.planning import PROJECT_LINKS_MAX
from tests.domains.helpers import GUEST, MEMBER, OUTSIDER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, WORKSPACE, seed_project


@pytest.fixture(autouse=True)
def ordered_ids(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Mint activity ids a millisecond apart, so rows written in one millisecond still sort in order."""
    start = datetime.now(UTC)
    counter = itertools.count()
    monkeypatch.setattr(
        "app.common.project_activity.new_planning_id",
        lambda: new_ulid(start + timedelta(milliseconds=next(counter))),
    )
    yield


def _path(workspace: str, project_id: str, link_id: str = "") -> str:
    """A project's link collection, or one link when an id is given."""
    base = f"/api/workspaces/{workspace}/projects/{project_id}/links"
    return f"{base}/{link_id}" if link_id else base


def _seed_link(client: TestClient, workspace: str, project_id: str, **payload: Any) -> "dict[str, Any]":
    """Create one link through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"url": "https://example.com/spec"}
    body.update(payload)
    response = client.post(_path(workspace, project_id), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _activity(client: TestClient, workspace: str, project_id: str) -> "list[dict[str, Any]]":
    """The project's activity feed, newest first."""
    response = client.get(f"/api/workspaces/{workspace}/projects/{project_id}/activity")
    assert response.status_code == 200, response.text
    return response.json()["activity"]


def test_a_link_is_created_with_its_url_title_and_author(client: TestClient, workspace: str) -> None:
    """URL and title are stored as given, trimmed, and the first link lands at the first key."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    body = _seed_link(client, workspace, project_id, url="  https://example.com/spec  ", title="  Spec  ")

    assert body["url"] == "https://example.com/spec"
    assert body["title"] == "Spec"
    assert body["project_id"] == project_id
    assert body["created_by"] == MEMBER
    assert body["sort_order"] == "V"
    assert body["created_at"]


def test_a_blank_title_reads_as_no_title(client: TestClient, workspace: str) -> None:
    """A link without a title is stored with none, so readers show its hostname."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    assert _seed_link(client, workspace, project_id, title="   ")["title"] is None
    assert _seed_link(client, workspace, project_id)["title"] is None


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "example.com",
        "ftp://example.com/file",
        "javascript:alert(1)",
        "data:text/html,hi",
        "mailto:someone@example.com",
        "https://",
        "https:///path",
        "https://exa mple.com",
        "https://example.com/" + "a" * 2048,
    ],
)
def test_only_http_and_https_urls_with_a_host_are_taken(client: TestClient, workspace: str, url: str) -> None:
    """Any other scheme, a missing host or an oversized URL is a 422 naming nothing stored."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    assert client.post(_path(workspace, project_id), json={"url": url}).status_code == 422
    assert client.get(_path(workspace, project_id)).json()["links"] == []


def test_an_overlong_title_is_refused(client: TestClient, workspace: str) -> None:
    """A title is held to its cap."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    response = client.post(_path(workspace, project_id), json={"url": "http://example.com", "title": "x" * 201})

    assert response.status_code == 422


def test_links_list_in_manual_order_and_reorder_by_patch(client: TestClient, workspace: str) -> None:
    """New links land after the last one, and a sort_order patch moves one row."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    first = _seed_link(client, workspace, project_id, title="First")
    second = _seed_link(client, workspace, project_id, title="Second")

    assert second["sort_order"] > first["sort_order"]
    moved = client.patch(_path(workspace, project_id, second["link_id"]), json={"sort_order": "A"})
    assert moved.status_code == 200

    links = client.get(_path(workspace, project_id)).json()["links"]
    assert [row["title"] for row in links] == ["Second", "First"]


def test_a_patch_edits_and_clears_the_title_but_not_the_url(client: TestClient, workspace: str) -> None:
    """A null title clears it; a null or invalid URL or sort order is refused."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    link = _seed_link(client, workspace, project_id, title="Spec")
    path = _path(workspace, project_id, link["link_id"])

    renamed = client.patch(path, json={"title": "Design spec", "url": "http://example.org/design"})
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Design spec"
    assert renamed.json()["url"] == "http://example.org/design"

    cleared = client.patch(path, json={"title": None})
    assert cleared.status_code == 200
    assert cleared.json()["title"] is None
    assert cleared.json()["url"] == "http://example.org/design"

    assert client.patch(path, json={"url": None}).status_code == 422
    assert client.patch(path, json={"url": "ftp://example.org"}).status_code == 422
    assert client.patch(path, json={"sort_order": None}).status_code == 422
    assert client.patch(path, json={"sort_order": "not-base62!"}).status_code == 422


def test_a_project_holds_a_bounded_set_of_links(client: TestClient, repositories: Any, workspace: str) -> None:
    """Past the cap a new link is a 422."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    for index in range(PROJECT_LINKS_MAX):
        _seed_link(client, workspace, project_id, url=f"https://example.com/{index}")

    response = client.post(_path(workspace, project_id), json={"url": "https://example.com/over"})

    assert response.status_code == 422
    assert len(repositories.planning.list_project_links(WORKSPACE, project_id)) == PROJECT_LINKS_MAX


def test_an_unknown_link_or_project_is_a_404(client: TestClient, workspace: str) -> None:
    """A link id is only found under its own project."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    other_id = seed_project(client, workspace, name="Other")["project_id"]
    link = _seed_link(client, workspace, project_id)
    nope = "01JB0000000000000000000NOPE"

    assert client.patch(_path(workspace, project_id, nope), json={"title": "X"}).status_code == 404
    assert client.delete(_path(workspace, project_id, nope)).status_code == 404
    assert client.patch(_path(workspace, other_id, link["link_id"]), json={"title": "X"}).status_code == 404
    assert client.delete(_path(workspace, other_id, link["link_id"])).status_code == 404
    assert client.get(_path(workspace, nope)).status_code == 404
    assert client.post(_path(workspace, nope), json={"url": "https://example.com"}).status_code == 404


def test_a_caller_outside_the_projects_teams_gets_a_404(client: TestClient, workspace: str) -> None:
    """Links follow the project's visibility, so a hidden project hides them too."""
    sign_in(client, OWNER)
    hidden = seed_project(client, workspace, team_id=OTHER_TEAM)
    link = _seed_link(client, workspace, hidden["project_id"])

    sign_in(client, GUEST)
    assert client.get(_path(workspace, hidden["project_id"])).status_code == 404
    assert client.post(_path(workspace, hidden["project_id"]), json={"url": "https://example.com"}).status_code == 404
    assert client.patch(_path(workspace, hidden["project_id"], link["link_id"]), json={"title": "X"}).status_code == 404
    assert client.delete(_path(workspace, hidden["project_id"], link["link_id"])).status_code == 404

    sign_in(client, OUTSIDER)
    assert client.get(_path(workspace, hidden["project_id"])).status_code == 404


def test_a_team_member_edits_the_links_of_a_project_it_can_see(client: TestClient, workspace: str) -> None:
    """A guest on one of the project's teams has the same edit right it has on the project."""
    sign_in(client, OWNER)
    project_id = seed_project(client, workspace)["project_id"]

    sign_in(client, GUEST)
    link = _seed_link(client, workspace, project_id)
    assert client.delete(_path(workspace, project_id, link["link_id"])).status_code == 204
    assert client.get(_path(workspace, project_id)).json()["links"] == []


def test_the_project_read_carries_its_links_in_order(client: TestClient, workspace: str) -> None:
    """A single project read answers its links, and the project list leaves them out."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    _seed_link(client, workspace, project_id, title="Spec")
    _seed_link(client, workspace, project_id, url="https://figma.com/file/1")

    read = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert [(row["title"], row["url"]) for row in read["links"]] == [
        ("Spec", "https://example.com/spec"),
        (None, "https://figma.com/file/1"),
    ]

    patched = client.patch(f"/api/workspaces/{workspace}/projects/{project_id}", json={"name": "Renamed"}).json()
    assert len(patched["links"]) == 2

    listed = client.get(f"/api/workspaces/{workspace}/projects").json()["projects"]
    assert [row["project_id"] for row in listed] == [project_id]
    assert listed[0].get("links") is None


def test_adding_editing_and_removing_a_link_is_recorded(client: TestClient, workspace: str) -> None:
    """Each change leaves one activity row naming the link by its title or hostname."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    link = _seed_link(client, workspace, project_id, url="https://docs.example.com/a")
    path = _path(workspace, project_id, link["link_id"])
    assert client.patch(path, json={"title": "Docs"}).status_code == 200
    assert client.patch(path, json={"sort_order": "A"}).status_code == 200
    assert client.delete(path).status_code == 204

    rows = [row for row in _activity(client, workspace, project_id) if row["kind"].startswith("link_")]

    assert [(row["kind"], row["field"], row["from"], row["to"]) for row in rows] == [
        ("link_removed", None, "Docs", None),
        ("link_changed", "title", None, "Docs"),
        ("link_added", None, None, "docs.example.com"),
    ]
    assert {row["link_id"] for row in rows} == {link["link_id"]}
    assert {row["actor_id"] for row in rows} == {MEMBER}


def test_deleting_a_project_deletes_its_links(client: TestClient, repositories: Any, workspace: str) -> None:
    """No link row outlives its project."""
    sign_in(client, OWNER)
    project_id = seed_project(client, workspace)["project_id"]
    _seed_link(client, workspace, project_id)
    _seed_link(client, workspace, project_id, url="https://example.com/two")

    assert client.delete(f"/api/workspaces/{workspace}/projects/{project_id}").status_code == 204

    assert repositories.planning.list_project_links(WORKSPACE, project_id) == []
