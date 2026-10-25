"""Comments and subscribers on a document.

A document's thread runs through the same rows an issue's does, so the
properties worth holding are the ones that differ: the thread is reached only
through a document the caller reads, commenting takes the right to edit under
the document's parent, an edit is the author's alone, a delete is the author's
or anyone's who may delete the document, and the document's creator and every
commenter and mention follow it.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.discussion.conftest import OTHER_TEAM, TEAM
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in


@pytest.fixture
def planning_client(repositories: Any) -> Iterator[TestClient]:
    """A client for the planning application, which writes the documents a thread hangs off."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["planning"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def _base(workspace: str) -> str:
    """The workspace's API root."""
    return f"/api/workspaces/{workspace}"


def seed_document(planning_client: TestClient, workspace: str, author: str, team_id: str = TEAM) -> str:
    """One project and one document under it, written through the planning routes as `author`."""
    sign_in(planning_client, author)
    project = planning_client.post(f"{_base(workspace)}/projects", json={"team_id": team_id, "name": "Launch"})
    assert project.status_code == 201, project.text
    created = planning_client.post(
        f"{_base(workspace)}/projects/{project.json()['project_id']}/documents",
        json={"title": "Launch plan", "body": "We ship in October."},
    )
    assert created.status_code == 201, created.text
    return created.json()["document_id"]


def seed_initiative_document(planning_client: TestClient, workspace: str) -> str:
    """One initiative and one document under it, written as the owner."""
    sign_in(planning_client, OWNER)
    initiative = planning_client.post(f"{_base(workspace)}/initiatives", json={"name": "Grow"})
    assert initiative.status_code == 201, initiative.text
    created = planning_client.post(
        f"{_base(workspace)}/initiatives/{initiative.json()['initiative_id']}/documents",
        json={"title": "Strategy"},
    )
    assert created.status_code == 201, created.text
    return created.json()["document_id"]


def post(client: TestClient, workspace: str, document_id: str, body: str, **extra: Any) -> "dict[str, Any]":
    """Post one comment on a document, failing loudly on a refusal."""
    response = client.post(f"{_base(workspace)}/documents/{document_id}/comments", json={"body": body, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def followers(repositories: Any, workspace: str, document_id: str) -> "dict[str, str]":
    """Each follower of one document mapped to the reason they first followed it."""
    return {row.user_id: row.reason for row in repositories.subscriptions.list_for_issue(workspace, document_id)}


def test_a_thread_round_trips_and_subscribes_everyone_in_it(
    client: TestClient, planning_client: TestClient, workspace: str, repositories: Any
) -> None:
    """The creator follows on create, and a commenter and a mention follow on posting."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    assert followers(repositories, workspace, document_id) == {MEMBER: "creator"}

    sign_in(client, ADMIN)
    root = post(client, workspace, document_id, "Looks good, @guest?")
    sign_in(client, MEMBER)
    reply = post(client, workspace, document_id, "Thanks", parent_comment_id=root["comment_id"])

    assert root["document_id"] == document_id
    assert root["team_id"] == ""
    listed = client.get(f"{_base(workspace)}/documents/{document_id}/comments")
    assert listed.status_code == 200, listed.text
    rows = listed.json()["comments"]
    assert [row["comment_id"] for row in rows] == [root["comment_id"], reply["comment_id"]]
    assert rows[0]["reply_count"] == 1
    assert followers(repositories, workspace, document_id) == {
        MEMBER: "creator",
        ADMIN: "commenter",
        GUEST: "mentioned",
    }


def test_a_reply_to_a_reply_is_refused(client: TestClient, planning_client: TestClient, workspace: str) -> None:
    """Replies are one level deep on a document as on an issue."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, MEMBER)
    root = post(client, workspace, document_id, "Root")
    reply = post(client, workspace, document_id, "Reply", parent_comment_id=root["comment_id"])

    response = client.post(
        f"{_base(workspace)}/documents/{document_id}/comments",
        json={"body": "Deeper", "parent_comment_id": reply["comment_id"]},
    )

    assert response.status_code == 409


def test_a_blank_comment_is_refused(client: TestClient, planning_client: TestClient, workspace: str) -> None:
    """Whitespace is not a comment."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, MEMBER)

    response = client.post(f"{_base(workspace)}/documents/{document_id}/comments", json={"body": "   "})

    assert response.status_code == 422


def test_a_document_out_of_sight_is_not_found(client: TestClient, planning_client: TestClient, workspace: str) -> None:
    """A guest reaches neither a project document outside their teams nor an initiative document."""
    outside = seed_document(planning_client, workspace, OWNER, team_id=OTHER_TEAM)
    strategy = seed_initiative_document(planning_client, workspace)
    sign_in(client, OWNER)
    root = post(client, workspace, outside, "Private")

    sign_in(client, GUEST)
    for document_id in (outside, strategy):
        path = f"{_base(workspace)}/documents/{document_id}"
        assert client.get(f"{path}/comments").status_code == 404
        assert client.post(f"{path}/comments", json={"body": "Hi"}).status_code == 404
        assert client.get(f"{path}/subscribers").status_code == 404
        assert client.put(f"{path}/subscribers/me").status_code == 404
    path = f"{_base(workspace)}/documents/{outside}/comments/{root['comment_id']}"
    assert client.patch(path, json={"body": "Mine now"}).status_code == 404
    assert client.delete(path).status_code == 404
    assert client.put(f"{path}/resolution").status_code == 404


def test_an_unknown_document_is_not_found(client: TestClient, workspace: str) -> None:
    """A made up document id has no thread."""
    sign_in(client, MEMBER)

    response = client.get(f"{_base(workspace)}/documents/01JB0000000000000000NODOC1/comments")

    assert response.status_code == 404


def test_only_the_author_edits(client: TestClient, planning_client: TestClient, workspace: str) -> None:
    """Even a workspace admin may not rewrite someone else's words."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, MEMBER)
    created = post(client, workspace, document_id, "First take")
    path = f"{_base(workspace)}/documents/{document_id}/comments/{created['comment_id']}"

    sign_in(client, ADMIN)
    assert client.patch(path, json={"body": "Rewritten"}).status_code == 403

    sign_in(client, MEMBER)
    edited = client.patch(path, json={"body": "Second take"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["body"] == "Second take"
    assert edited.json()["edited_at"] is not None


def test_an_edit_subscribes_only_the_newly_mentioned(
    client: TestClient, planning_client: TestClient, workspace: str, repositories: Any
) -> None:
    """Someone who left the document stays gone when an edit still names them."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, MEMBER)
    created = post(client, workspace, document_id, "cc @admin")
    repositories.subscriptions.unsubscribe(workspace, document_id, ADMIN)

    response = client.patch(
        f"{_base(workspace)}/documents/{document_id}/comments/{created['comment_id']}",
        json={"body": "cc @admin and @guest"},
    )
    assert response.status_code == 200, response.text

    assert followers(repositories, workspace, document_id) == {MEMBER: "creator", GUEST: "mentioned"}


def test_a_delete_takes_the_author_or_a_document_deleter(
    client: TestClient, planning_client: TestClient, workspace: str
) -> None:
    """Another member may not delete a comment, and the document's author may."""
    document_id = seed_document(planning_client, workspace, OWNER)
    sign_in(client, ADMIN)
    first = post(client, workspace, document_id, "One")
    second = post(client, workspace, document_id, "Two")
    base = f"{_base(workspace)}/documents/{document_id}/comments"

    sign_in(client, MEMBER)
    assert client.delete(f"{base}/{first['comment_id']}").status_code == 403

    sign_in(client, ADMIN)
    assert client.delete(f"{base}/{first['comment_id']}").status_code == 204
    sign_in(client, OWNER)
    assert client.delete(f"{base}/{second['comment_id']}").status_code == 204
    assert client.get(base).json()["comments"] == []


def test_deleting_a_root_keeps_its_replies(client: TestClient, planning_client: TestClient, workspace: str) -> None:
    """The replies of a deleted root become roots of their own."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, MEMBER)
    root = post(client, workspace, document_id, "Root")
    reply = post(client, workspace, document_id, "Reply", parent_comment_id=root["comment_id"])
    base = f"{_base(workspace)}/documents/{document_id}/comments"

    assert client.delete(f"{base}/{root['comment_id']}").status_code == 204

    rows = client.get(base).json()["comments"]
    assert [(row["comment_id"], row["parent_comment_id"]) for row in rows] == [(reply["comment_id"], None)]


def test_a_thread_resolves_and_a_reply_reopens_it(
    client: TestClient, planning_client: TestClient, workspace: str
) -> None:
    """Only a root resolves, and replying to a resolved thread reopens it."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, MEMBER)
    root = post(client, workspace, document_id, "Should we cut scope?")
    reply = post(client, workspace, document_id, "Yes", parent_comment_id=root["comment_id"])
    base = f"{_base(workspace)}/documents/{document_id}/comments"

    resolved = client.put(f"{base}/{root['comment_id']}/resolution")
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["resolution"]["resolved_by"] == MEMBER
    assert client.put(f"{base}/{reply['comment_id']}/resolution").status_code == 409

    post(client, workspace, document_id, "Actually no", parent_comment_id=root["comment_id"])
    rows = {row["comment_id"]: row for row in client.get(base).json()["comments"]}
    assert rows[root["comment_id"]]["resolution"] is None

    assert client.put(f"{base}/{root['comment_id']}/resolution").status_code == 200
    reopened = client.delete(f"{base}/{root['comment_id']}/resolution")
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["resolution"] is None


def test_a_follower_subscribes_and_leaves_only_for_themselves(
    client: TestClient, planning_client: TestClient, workspace: str
) -> None:
    """`me` names the caller, and anyone else is refused."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    path = f"{_base(workspace)}/documents/{document_id}/subscribers"

    sign_in(client, ADMIN)
    before = client.get(path)
    assert before.status_code == 200, before.text
    assert before.json()["subscribed"] is False
    assert [row["user_id"] for row in before.json()["subscribers"]] == [MEMBER]

    joined = client.put(f"{path}/me")
    assert joined.status_code == 200, joined.text
    assert joined.json()["subscribed"] is True
    assert {row["user_id"] for row in joined.json()["subscribers"]} == {MEMBER, ADMIN}

    assert client.put(f"{path}/{MEMBER}").status_code == 422
    assert client.delete(f"{path}/{MEMBER}").status_code == 422

    left = client.delete(f"{path}/{ADMIN}")
    assert left.status_code == 200, left.text
    assert left.json()["subscribed"] is False
    assert [row["user_id"] for row in left.json()["subscribers"]] == [MEMBER]


def test_deleting_the_document_drops_its_followers(
    client: TestClient, planning_client: TestClient, workspace: str, repositories: Any
) -> None:
    """No subscription outlives the document it follows."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, ADMIN)
    post(client, workspace, document_id, "Following")

    sign_in(planning_client, MEMBER)
    assert planning_client.delete(f"{_base(workspace)}/documents/{document_id}").status_code == 204

    assert followers(repositories, workspace, document_id) == {}


def test_a_comment_on_a_document_takes_reactions(
    client: TestClient, planning_client: TestClient, workspace: str
) -> None:
    """A reaction names the document, and the same comment named under an issue id is not found."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, MEMBER)
    comment = post(client, workspace, document_id, "Ship it")
    target = {"target_id": comment["comment_id"], "target_kind": "comment"}

    added = client.put(f"{_base(workspace)}/reactions", json={**target, "emoji": "🎉", "document_id": document_id})
    assert added.status_code == 200, added.text
    assert added.json()["count"] == 1

    listed = client.get(f"{_base(workspace)}/reactions", params={**target, "document_id": document_id})
    assert listed.status_code == 200, listed.text
    assert [group["emoji"] for group in listed.json()["reactions"]] == ["🎉"]
    rows = client.get(f"{_base(workspace)}/documents/{document_id}/comments").json()["comments"]
    assert [group["emoji"] for group in rows[0]["reactions"]] == ["🎉"]

    misnamed = client.get(f"{_base(workspace)}/reactions", params={**target, "issue_id": document_id})
    assert misnamed.status_code == 404


def test_a_guest_outside_the_team_cannot_react(client: TestClient, planning_client: TestClient, workspace: str) -> None:
    """A reaction is held to the document's visibility like a comment."""
    document_id = seed_document(planning_client, workspace, OWNER, team_id=OTHER_TEAM)
    sign_in(client, OWNER)
    comment = post(client, workspace, document_id, "Private")

    sign_in(client, GUEST)
    response = client.put(
        f"{_base(workspace)}/reactions",
        json={
            "target_id": comment["comment_id"],
            "target_kind": "comment",
            "emoji": "👍",
            "document_id": document_id,
        },
    )

    assert response.status_code == 404
