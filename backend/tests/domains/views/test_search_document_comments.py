"""Search over comments on documents.

A document comment is posted under the workspace's document slot rather than a
team, and a hit is answered only in a workspace wide search, to a caller who
reads the document's parent, linking back to the document.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.search_index import DOCUMENT_COMMENTS, comment_doc, comment_term, comment_terms
from app.domains.views.consumers.search import handle_record
from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import TEAM
from tests.domains.views.test_notify_document_comments import DOCUMENT, OTHER_PROJECT, seed_document


def _search(client: TestClient, workspace: str, **params: Any) -> "dict[str, Any]":
    """One search, failing loudly on anything but a 200."""
    response = client.get(f"/api/workspaces/{workspace}/search", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _comment(repositories: Any, workspace: str, body: str) -> str:
    """Write one comment on the document and post it the way the search consumer would."""
    comment = repositories.comments.create(build_comment(workspace, DOCUMENT, "", OWNER, body, document_id=DOCUMENT))
    repositories.search_index.apply(
        workspace,
        DOCUMENT_COMMENTS,
        comment_doc(comment.comment_id, DOCUMENT),
        appeared=comment_terms({"body": body}),
        departed=set(),
    )
    return comment.comment_id


def test_the_consumer_posts_a_document_comment_under_the_document_slot(workspace: str, repositories: Any) -> None:
    """No team partition holds it, so a team's search never reads it."""
    image = {
        "workspace_id": {"S": workspace},
        "team_id": {"S": ""},
        "issue_id": {"S": DOCUMENT},
        "document_id": {"S": DOCUMENT},
        "comment_id": {"S": "01C000000000000000000001"},
        "body": {"S": "Traced the widget fault"},
    }

    handle_record(repositories, {"eventName": "INSERT", "eventID": "1", "dynamodb": {"NewImage": image}})

    expected = [comment_doc("01C000000000000000000001", DOCUMENT)]
    assert repositories.search_index.postings(workspace, DOCUMENT_COMMENTS, comment_term("widget")) == expected
    assert repositories.search_index.postings(workspace, TEAM, comment_term("widget")) == []


def test_a_document_comment_match_links_to_its_document(client: TestClient, workspace: str, repositories: Any) -> None:
    """The hit carries the document's id and title and an excerpt around the match."""
    seed_document(repositories, workspace)
    comment_id = _comment(repositories, workspace, "The zephyr rollout slips a week")

    sign_in(client, MEMBER)
    comments = _search(client, workspace, q="zephyr")["comments"]

    assert len(comments) == 1
    hit = comments[0]
    assert hit["comment_id"] == comment_id
    assert hit["document_id"] == DOCUMENT
    assert hit["document_title"] == "Launch plan"
    assert "zephyr" in hit["snippet"]


def test_a_guest_does_not_find_comments_on_documents_out_of_sight(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The document's parent is checked against the parents the caller reads."""
    seed_document(repositories, workspace, parent_id=OTHER_PROJECT)
    _comment(repositories, workspace, "zephyr outside")

    sign_in(client, GUEST)
    assert _search(client, workspace, q="zephyr")["comments"] == []
    sign_in(client, MEMBER)
    assert len(_search(client, workspace, q="zephyr")["comments"]) == 1


def test_a_team_search_skips_document_comments(client: TestClient, workspace: str, repositories: Any) -> None:
    """Documents are answered workspace wide only, as document hits are."""
    seed_document(repositories, workspace)
    _comment(repositories, workspace, "zephyr")

    sign_in(client, MEMBER)

    assert _search(client, workspace, q="zephyr", team_id=TEAM)["comments"] == []


def test_a_comment_whose_document_is_gone_is_skipped(client: TestClient, workspace: str, repositories: Any) -> None:
    """A posting that outlived its document is not answered."""
    repositories.search_index.apply(
        workspace,
        DOCUMENT_COMMENTS,
        comment_doc("01C000000000000000000009", DOCUMENT),
        appeared={comment_term("zephyr")},
        departed=set(),
    )

    sign_in(client, MEMBER)

    assert _search(client, workspace, q="zephyr")["comments"] == []
