"""Replies and reactions on project updates.

The properties held are that anyone who may read the project may reply and react,
that only a reply's author or an admin edits or deletes it, that the feed carries
each update's reaction groups and reply count, that a reaction is a toggle on an
update or a reply, and that deleting an update or its project removes its thread.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.core.constants import ISSUE_BODY_MAX_BYTES

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, OWNER, add_team_member, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_project


def _updates(workspace: str, project_id: str) -> str:
    """A project's update feed."""
    return f"/api/workspaces/{workspace}/projects/{project_id}/updates"


def _comments(workspace: str, project_id: str, update_id: str, comment_id: str = "") -> str:
    """An update's replies, or one reply when an id is given."""
    base = f"{_updates(workspace, project_id)}/{update_id}/comments"
    return f"{base}/{comment_id}" if comment_id else base


def _reactions(workspace: str, project_id: str, update_id: str) -> str:
    """An update's reactions."""
    return f"{_updates(workspace, project_id)}/{update_id}/reactions"


def _post_update(client: TestClient, workspace: str, project_id: str) -> "dict[str, Any]":
    """Post one update through the route, failing loudly on a refusal."""
    response = client.post(_updates(workspace, project_id), json={"body": "All good", "health": "on_track"})
    assert response.status_code == 201, response.text
    return response.json()


def _reply(client: TestClient, workspace: str, project_id: str, update_id: str, body: str) -> "dict[str, Any]":
    """Reply on one update through the route, failing loudly on a refusal."""
    response = client.post(_comments(workspace, project_id, update_id), json={"body": body})
    assert response.status_code == 201, response.text
    return response.json()


def _feed(client: TestClient, workspace: str, project_id: str) -> list["dict[str, Any]"]:
    """The project's updates as the feed reads them."""
    response = client.get(_updates(workspace, project_id))
    assert response.status_code == 200, response.text
    return response.json()["updates"]


def test_a_reader_replies_and_the_thread_lists_oldest_first(client: TestClient, workspace: str) -> None:
    """A team member replies on someone else's update, mentions resolve, and the feed counts replies."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    update = _post_update(client, workspace, project_id)

    sign_in(client, GUEST)
    first = _reply(client, workspace, project_id, update["update_id"], "Looks good @admin")
    second = _reply(client, workspace, project_id, update["update_id"], "Second")

    assert first["author_id"] == GUEST
    assert first["mentions"] == [ADMIN]
    assert first["can_edit"] is True
    assert first["source"] == "web"
    listed = client.get(_comments(workspace, project_id, update["update_id"])).json()["comments"]
    assert [row["comment_id"] for row in listed] == [first["comment_id"], second["comment_id"]]
    assert listed[0]["author"]["display_name"] == "Gale Guest"
    assert _feed(client, workspace, project_id)[0]["comment_count"] == 2


def test_a_reply_needs_a_body(client: TestClient, workspace: str) -> None:
    """A blank or oversized reply is refused."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    update = _post_update(client, workspace, project_id)
    path = _comments(workspace, project_id, update["update_id"])

    assert client.post(path, json={"body": "   "}).status_code == 422
    assert client.post(path, json={"body": "x" * (ISSUE_BODY_MAX_BYTES + 1)}).status_code == 422


def test_only_the_author_or_an_admin_edits_or_deletes_a_reply(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """Another member reads the reply but may not change it; team and workspace admins moderate."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    update = _post_update(client, workspace, project_id)
    reply = _reply(client, workspace, project_id, update["update_id"], "Mine")
    path = _comments(workspace, project_id, update["update_id"], reply["comment_id"])

    edited = client.patch(path, json={"body": "Mine, edited"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["edited_at"] is not None

    sign_in(client, GUEST)
    listed = client.get(_comments(workspace, project_id, update["update_id"])).json()["comments"]
    assert [row["can_edit"] for row in listed] == [False]
    assert client.patch(path, json={"body": "Taken over"}).status_code == 403
    assert client.delete(path).status_code == 403

    add_team_member(repositories, WORKSPACE, TEAM, GUEST, "admin")
    assert client.patch(path, json={"body": "Moderated"}).status_code == 200

    sign_in(client, ADMIN)
    assert client.delete(path).status_code == 204
    assert client.get(_comments(workspace, project_id, update["update_id"])).json()["comments"] == []


def test_a_hidden_project_or_unknown_update_or_reply_is_a_404(client: TestClient, workspace: str) -> None:
    """A thread follows its project's visibility."""
    sign_in(client, OWNER)
    hidden = seed_project(client, workspace, team_id=OTHER_TEAM)["project_id"]
    update = _post_update(client, workspace, hidden)
    reply = _reply(client, workspace, hidden, update["update_id"], "Private")
    nope = "01JB0000000000000000NOPE01"
    assert client.get(_comments(workspace, hidden, nope)).status_code == 404
    assert client.patch(_comments(workspace, hidden, update["update_id"], nope), json={"body": "X"}).status_code == 404

    for user_id in (GUEST, OUTSIDER):
        sign_in(client, user_id)
        assert client.get(_comments(workspace, hidden, update["update_id"])).status_code == 404
        assert client.post(_comments(workspace, hidden, update["update_id"]), json={"body": "X"}).status_code == 404
        assert client.delete(_comments(workspace, hidden, update["update_id"], reply["comment_id"])).status_code == 404
        assert client.put(_reactions(workspace, hidden, update["update_id"]), json={"emoji": "👍"}).status_code == 404


def test_reactions_toggle_on_an_update_and_on_a_reply(client: TestClient, workspace: str) -> None:
    """A reaction counts once per person, marks the viewer's own, and comes off again."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    update = _post_update(client, workspace, project_id)
    reply = _reply(client, workspace, project_id, update["update_id"], "Nice")
    path = _reactions(workspace, project_id, update["update_id"])

    added = client.put(path, json={"emoji": "👍"})
    assert added.status_code == 200, added.text
    assert added.json()["count"] == 1
    assert added.json()["reacted"] is True
    assert client.put(path, json={"emoji": "👍"}).json()["count"] == 1
    assert client.put(path, json={"emoji": "🎉", "comment_id": reply["comment_id"]}).status_code == 200

    sign_in(client, GUEST)
    assert client.put(path, json={"emoji": "👍"}).json()["count"] == 2
    groups = _feed(client, workspace, project_id)[0]["reactions"]
    assert [(row["emoji"], row["count"], row["reacted"]) for row in groups] == [("👍", 2, True)]
    replies = client.get(_comments(workspace, project_id, update["update_id"])).json()["comments"]
    assert [(row["emoji"], row["reacted"]) for row in replies[0]["reactions"]] == [("🎉", False)]

    assert client.delete(path, params={"emoji": "👍"}).status_code == 204
    groups = _feed(client, workspace, project_id)[0]["reactions"]
    assert [(row["emoji"], row["count"], row["reacted"]) for row in groups] == [("👍", 1, False)]


def test_a_reaction_must_be_one_emoji_on_a_real_reply(client: TestClient, workspace: str) -> None:
    """Text is not a reaction, and a reply that does not exist cannot be reacted to."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    update = _post_update(client, workspace, project_id)
    path = _reactions(workspace, project_id, update["update_id"])

    assert client.put(path, json={"emoji": "yes"}).status_code == 422
    assert client.put(path, json={"emoji": "👍", "comment_id": "01JB0000000000000000NOPE01"}).status_code == 404


def test_deleting_a_reply_removes_its_reactions(client: TestClient, repositories: Any, workspace: str) -> None:
    """No reaction outlives the reply it was on."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    update = _post_update(client, workspace, project_id)
    reply = _reply(client, workspace, project_id, update["update_id"], "Nice")
    client.put(
        _reactions(workspace, project_id, update["update_id"]), json={"emoji": "👍", "comment_id": reply["comment_id"]}
    )

    assert client.delete(_comments(workspace, project_id, update["update_id"], reply["comment_id"])).status_code == 204

    thread = repositories.planning.update_threads.read(WORKSPACE, project_id, update["update_id"])
    assert thread.comments == []
    assert thread.reactions == []


def test_deleting_an_update_removes_its_thread(client: TestClient, repositories: Any, workspace: str) -> None:
    """Replies and reactions go with their update, and another update's thread stays."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    doomed = _post_update(client, workspace, project_id)
    kept = _post_update(client, workspace, project_id)
    for update in (doomed, kept):
        _reply(client, workspace, project_id, update["update_id"], "Reply")
        client.put(_reactions(workspace, project_id, update["update_id"]), json={"emoji": "👍"})

    assert client.delete(f"{_updates(workspace, project_id)}/{doomed['update_id']}").status_code == 204

    gone = repositories.planning.update_threads.read(WORKSPACE, project_id, doomed["update_id"])
    assert gone.comments == [] and gone.reactions == []
    still = repositories.planning.update_threads.read(WORKSPACE, project_id, kept["update_id"])
    assert len(still.comments) == 1 and len(still.reactions) == 1


def test_deleting_a_project_removes_every_update_thread(client: TestClient, repositories: Any, workspace: str) -> None:
    """No reply or reaction outlives its project."""
    sign_in(client, OWNER)
    project_id = seed_project(client, workspace)["project_id"]
    update = _post_update(client, workspace, project_id)
    _reply(client, workspace, project_id, update["update_id"], "Reply")
    client.put(_reactions(workspace, project_id, update["update_id"]), json={"emoji": "👍"})

    assert client.delete(f"/api/workspaces/{workspace}/projects/{project_id}").status_code == 204

    thread = repositories.planning.update_threads.read(WORKSPACE, project_id, update["update_id"])
    assert thread.comments == [] and thread.reactions == []
