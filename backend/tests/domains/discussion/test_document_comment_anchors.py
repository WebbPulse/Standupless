"""Comments pinned to a passage of a document, through the document comment routes."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.discussion.test_document_comments import (
    _base,
    planning_client,
    post,
    seed_document,
    seed_initiative_document,
)
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in

__all__ = ["planning_client"]


def comments_path(workspace: str, document_id: str) -> str:
    """The comments collection of one document."""
    return f"{_base(workspace)}/documents/{document_id}/comments"


def test_an_anchored_document_comment_reads_back_with_its_passage(
    client: TestClient, planning_client: TestClient, workspace: str
) -> None:
    """The anchor is stored on the root, trimmed, and comes back on the create and the list."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, MEMBER)
    anchor = {"quote": "  ship in October ", "prefix": "We ", "suffix": "."}

    created = post(client, workspace, document_id, "Which week?", anchor=anchor)
    listed = client.get(comments_path(workspace, document_id)).json()["comments"]

    expected = {"quote": "ship in October", "prefix": "We ", "suffix": "."}
    assert created["anchor"] == expected
    assert listed[0]["anchor"] == expected


def test_a_plain_document_comment_has_no_anchor(
    client: TestClient, planning_client: TestClient, workspace: str
) -> None:
    """A comment posted without a passage reads back with a null anchor."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, MEMBER)

    assert post(client, workspace, document_id, "Looks good")["anchor"] is None


def test_the_document_anchor_context_is_trimmed(
    client: TestClient, planning_client: TestClient, workspace: str
) -> None:
    """Context past the cap is cut to the characters nearest the passage."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, MEMBER)

    created = post(
        client,
        workspace,
        document_id,
        "Hm",
        anchor={"quote": "October", "prefix": "x" * 10 + "p" * 64, "suffix": "s" * 64 + "y" * 10},
    )

    assert created["anchor"]["prefix"] == "p" * 64
    assert created["anchor"]["suffix"] == "s" * 64


def test_a_blank_or_oversized_document_quote_is_refused(
    client: TestClient, planning_client: TestClient, workspace: str
) -> None:
    """A passage must be real text under the cap."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, MEMBER)
    path = comments_path(workspace, document_id)

    blank = client.post(path, json={"body": "Hi", "anchor": {"quote": "   "}})
    long = client.post(path, json={"body": "Hi", "anchor": {"quote": "q" * 1001}})

    assert blank.status_code == 422, blank.text
    assert long.status_code == 422, long.text


def test_a_document_reply_cannot_carry_an_anchor(
    client: TestClient, planning_client: TestClient, workspace: str
) -> None:
    """A reply belongs to its root's passage, so naming another one is refused."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, MEMBER)
    root = post(client, workspace, document_id, "Root", anchor={"quote": "October"})

    response = client.post(
        comments_path(workspace, document_id),
        json={"body": "Reply", "parent_comment_id": root["comment_id"], "anchor": {"quote": "ship"}},
    )

    assert response.status_code == 422, response.text


def test_an_anchored_thread_resolves_and_keeps_its_passage(
    client: TestClient, planning_client: TestClient, workspace: str
) -> None:
    """Resolving and reopening a passage thread leaves its anchor in place."""
    document_id = seed_document(planning_client, workspace, MEMBER)
    sign_in(client, ADMIN)
    root = post(client, workspace, document_id, "Too late?", anchor={"quote": "October"})
    path = f"{comments_path(workspace, document_id)}/{root['comment_id']}/resolution"

    resolved = client.put(path)
    reopened = client.delete(path)

    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["anchor"]["quote"] == "October"
    assert reopened.json()["anchor"]["quote"] == "October"


def test_an_initiative_document_takes_a_passage_thread(
    client: TestClient, planning_client: TestClient, workspace: str
) -> None:
    """A document under an initiative takes anchored threads as one under a project does."""
    document_id = seed_initiative_document(planning_client, workspace)
    sign_in(client, OWNER)

    created = post(client, workspace, document_id, "Why?", anchor={"quote": "Strategy"})

    assert created["anchor"]["quote"] == "Strategy"
