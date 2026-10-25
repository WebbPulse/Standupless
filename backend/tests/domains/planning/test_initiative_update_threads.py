"""Replies and reactions on initiative updates.

The properties held are that anyone who may read the initiative may reply and
react while a guest is refused and a private lead team hides the thread, that
only a reply's author, the initiative's owner or a workspace admin edits or
deletes it, that the feed carries each update's reaction groups and reply count,
that the thread lives under its own key root rather than a project's, and that
deleting an update or its initiative removes its thread.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, add_member, add_team_member, make_user, sign_in
from tests.domains.planning.conftest import TEAM, WORKSPACE

PEER = "01JB000000000000000000PEER"


@pytest.fixture
def peer(repositories: Any, workspace: str) -> str:
    """A second plain member, who neither wrote the update nor owns the initiative."""
    add_member(repositories, WORKSPACE, PEER, "member")
    make_user(repositories, PEER, "peer@example.com", "Pat Peer")
    return PEER


def _base(workspace: str) -> str:
    """The workspace's initiatives collection."""
    return f"/api/workspaces/{workspace}/initiatives"


def _create(client: TestClient, workspace: str, **payload: Any) -> str:
    """Create one initiative through the route, answering its id."""
    body: "dict[str, Any]" = {"name": "Expand to Europe"}
    body.update(payload)
    response = client.post(_base(workspace), json=body)
    assert response.status_code == 201, response.text
    return response.json()["initiative_id"]


def _updates(workspace: str, initiative_id: str) -> str:
    """An initiative's update feed."""
    return f"{_base(workspace)}/{initiative_id}/updates"


def _comments(workspace: str, initiative_id: str, update_id: str, comment_id: str = "") -> str:
    """An update's replies, or one reply when an id is given."""
    base = f"{_updates(workspace, initiative_id)}/{update_id}/comments"
    return f"{base}/{comment_id}" if comment_id else base


def _reactions(workspace: str, initiative_id: str, update_id: str) -> str:
    """An update's reactions."""
    return f"{_updates(workspace, initiative_id)}/{update_id}/reactions"


def _post_update(client: TestClient, workspace: str, initiative_id: str) -> str:
    """Post one update through the route, answering its id."""
    response = client.post(_updates(workspace, initiative_id), json={"body": "On track", "health": "on_track"})
    assert response.status_code == 201, response.text
    return response.json()["update_id"]


def _reply(client: TestClient, workspace: str, initiative_id: str, update_id: str, body: str) -> "dict[str, Any]":
    """Reply on one update through the route, failing loudly on a refusal."""
    response = client.post(_comments(workspace, initiative_id, update_id), json={"body": body})
    assert response.status_code == 201, response.text
    return response.json()


def _feed(client: TestClient, workspace: str, initiative_id: str) -> list["dict[str, Any]"]:
    """The initiative's updates as the feed reads them."""
    response = client.get(_updates(workspace, initiative_id))
    assert response.status_code == 200, response.text
    return response.json()["updates"]


def test_a_reader_replies_edits_and_deletes_and_the_feed_counts(client: TestClient, workspace: str, peer: str) -> None:
    """A member replies on someone else's update, the thread lists oldest first and names the initiative."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)
    update_id = _post_update(client, workspace, initiative_id)

    sign_in(client, peer)
    first = _reply(client, workspace, initiative_id, update_id, "Looks good @admin")
    second = _reply(client, workspace, initiative_id, update_id, "Second")

    assert first["author_id"] == peer
    assert first["initiative_id"] == initiative_id
    assert first["project_id"] is None
    assert first["mentions"] == [ADMIN]
    assert first["can_edit"] is True
    listed = client.get(_comments(workspace, initiative_id, update_id)).json()["comments"]
    assert [row["comment_id"] for row in listed] == [first["comment_id"], second["comment_id"]]
    assert _feed(client, workspace, initiative_id)[0]["comment_count"] == 2

    path = _comments(workspace, initiative_id, update_id, first["comment_id"])
    edited = client.patch(path, json={"body": "Edited"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["edited_at"] is not None
    assert client.delete(path).status_code == 204
    assert _feed(client, workspace, initiative_id)[0]["comment_count"] == 1


def test_a_reply_needs_a_body(client: TestClient, workspace: str) -> None:
    """A blank reply is refused."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)
    update_id = _post_update(client, workspace, initiative_id)

    assert client.post(_comments(workspace, initiative_id, update_id), json={"body": "   "}).status_code == 422


def test_only_the_author_the_owner_or_an_admin_moderates_a_reply(client: TestClient, workspace: str, peer: str) -> None:
    """Another member reads the reply but may not change it; the initiative's owner and an admin may."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace, owner_id=peer)
    update_id = _post_update(client, workspace, initiative_id)
    reply = _reply(client, workspace, initiative_id, update_id, "Mine")
    path = _comments(workspace, initiative_id, update_id, reply["comment_id"])
    other = _create(client, workspace, name="Other")
    other_update = _post_update(client, workspace, other)
    stranger = _reply(client, workspace, other, other_update, "Not the owner's")
    stranger_path = _comments(workspace, other, other_update, stranger["comment_id"])

    sign_in(client, peer)
    assert client.patch(stranger_path, json={"body": "Taken over"}).status_code == 403
    assert client.delete(stranger_path).status_code == 403
    listed = client.get(_comments(workspace, initiative_id, update_id)).json()["comments"]
    assert [row["can_edit"] for row in listed] == [True]
    assert client.patch(path, json={"body": "Owner edit"}).status_code == 200

    sign_in(client, ADMIN)
    assert client.delete(path).status_code == 204
    assert client.delete(stranger_path).status_code == 204


def test_a_guest_is_refused_and_a_private_lead_team_hides_the_thread(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A guest gets the initiative routes' 403, and an outsider to a private lead team a 404."""
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    sign_in(client, MEMBER)
    hidden = _create(client, workspace, name="Secret", team_id=TEAM)
    update_id = _post_update(client, workspace, hidden)
    reply = _reply(client, workspace, hidden, update_id, "Private")
    nope = "01JB0000000000000000NOPE01"
    assert client.get(_comments(workspace, hidden, nope)).status_code == 404
    assert client.patch(_comments(workspace, hidden, update_id, nope), json={"body": "X"}).status_code == 404

    sign_in(client, GUEST)
    assert client.get(_comments(workspace, hidden, update_id)).status_code == 403
    assert client.post(_comments(workspace, hidden, update_id), json={"body": "X"}).status_code == 403
    assert client.put(_reactions(workspace, hidden, update_id), json={"emoji": "👍"}).status_code == 403

    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)
    sign_in(client, ADMIN)
    assert client.get(_comments(workspace, hidden, update_id)).status_code == 404
    assert client.post(_comments(workspace, hidden, update_id), json={"body": "X"}).status_code == 404
    assert client.delete(_comments(workspace, hidden, update_id, reply["comment_id"])).status_code == 404
    assert client.put(_reactions(workspace, hidden, update_id), json={"emoji": "👍"}).status_code == 404


def test_reactions_toggle_on_an_update_and_on_a_reply(client: TestClient, workspace: str, peer: str) -> None:
    """A reaction counts once per person, marks the viewer's own, shows in the feed and comes off again."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)
    update_id = _post_update(client, workspace, initiative_id)
    reply = _reply(client, workspace, initiative_id, update_id, "Nice")
    path = _reactions(workspace, initiative_id, update_id)

    added = client.put(path, json={"emoji": "👍"})
    assert added.status_code == 200, added.text
    assert added.json()["count"] == 1
    assert added.json()["reacted"] is True
    assert client.put(path, json={"emoji": "👍"}).json()["count"] == 1
    assert client.put(path, json={"emoji": "🎉", "comment_id": reply["comment_id"]}).status_code == 200
    assert client.put(path, json={"emoji": "👍", "comment_id": "01JB0000000000000000NOPE01"}).status_code == 404

    sign_in(client, peer)
    assert client.put(path, json={"emoji": "👍"}).json()["count"] == 2
    groups = _feed(client, workspace, initiative_id)[0]["reactions"]
    assert [(row["emoji"], row["count"], row["reacted"]) for row in groups] == [("👍", 2, True)]
    replies = client.get(_comments(workspace, initiative_id, update_id)).json()["comments"]
    assert [(row["emoji"], row["reacted"]) for row in replies[0]["reactions"]] == [("🎉", False)]

    assert client.delete(path, params={"emoji": "👍"}).status_code == 204
    groups = _feed(client, workspace, initiative_id)[0]["reactions"]
    assert [(row["emoji"], row["count"], row["reacted"]) for row in groups] == [("👍", 1, False)]


def test_the_thread_lives_apart_from_project_threads(client: TestClient, repositories: Any, workspace: str) -> None:
    """The initiative's replies sit under their own key root, so the project store never reads them."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)
    update_id = _post_update(client, workspace, initiative_id)
    _reply(client, workspace, initiative_id, update_id, "Reply")
    client.put(_reactions(workspace, initiative_id, update_id), json={"emoji": "👍"})

    own = repositories.planning.initiative_update_threads.read(WORKSPACE, initiative_id, update_id)
    assert len(own.comments) == 1 and len(own.reactions) == 1
    assert own.comments[0].initiative_id == initiative_id
    project_side = repositories.planning.update_threads.read(WORKSPACE, initiative_id, update_id)
    assert project_side.comments == [] and project_side.reactions == []


def test_deleting_an_update_or_its_initiative_removes_the_thread(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """Replies and reactions go with their update, another update's stay, and none outlive the initiative."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)
    doomed = _post_update(client, workspace, initiative_id)
    kept = _post_update(client, workspace, initiative_id)
    for update_id in (doomed, kept):
        _reply(client, workspace, initiative_id, update_id, "Reply")
        client.put(_reactions(workspace, initiative_id, update_id), json={"emoji": "👍"})

    assert client.delete(f"{_updates(workspace, initiative_id)}/{doomed}").status_code == 204

    store = repositories.planning.initiative_update_threads
    gone = store.read(WORKSPACE, initiative_id, doomed)
    assert gone.comments == [] and gone.reactions == []
    still = store.read(WORKSPACE, initiative_id, kept)
    assert len(still.comments) == 1 and len(still.reactions) == 1

    assert client.delete(f"{_base(workspace)}/{initiative_id}").status_code == 204
    after = store.read(WORKSPACE, initiative_id, kept)
    assert after.comments == [] and after.reactions == []
