"""The MCP tools that edit, delete and react to comments and manage issue links.

Each runs the path its HTTP route runs, so these tests hold the rules a person meets
in the UI: only the author edits a comment, the author or a team admin deletes one,
a reaction is the caller's own, and a link may be changed or removed by whoever
added it or a team admin, never an uploaded file.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.attachments import build_attachment
from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

COMMENT_SCOPES = ("comments:write", "issues:read")

LINK_SCOPES = ("issues:read", "issues:write")


def _comment(client: TestClient, secret: str, body: str, parent: str | None = None) -> dict[str, Any]:
    """One comment on `ABC-1` added through the MCP tool."""
    arguments: dict[str, Any] = {"issue_id": "ABC-1", "body": body}
    if parent:
        arguments["parent_comment_id"] = parent
    return answer(tool(client, secret, "add_comment", arguments))


def test_the_author_edits_their_comment_by_issue_key(client: TestClient, repositories: Any, issue: Issue) -> None:
    """The author rewrites their own comment and it reads back edited."""
    secret = mint_for(repositories, MEMBER, COMMENT_SCOPES)
    comment = _comment(client, secret, "First draft")

    edited = answer(
        tool(
            client,
            secret,
            "update_comment",
            {"issue_id": "ABC-1", "comment_id": comment["comment_id"], "body": "Second draft"},
        )
    )
    stored = repositories.comments.get(WORKSPACE, issue.issue_id, comment["comment_id"])

    assert edited["body"] == "Second draft"
    assert edited["edited_at"] is not None
    assert stored.body == "Second draft"


def test_nobody_but_the_author_edits_a_comment(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A team admin is refused an edit too: editing someone's words is the author's alone."""
    comment = _comment(client, mint_for(repositories, MEMBER, COMMENT_SCOPES), "Mine")

    for user_id in (ADMIN, OWNER, GUEST):
        text = refusal(
            tool(
                client,
                mint_for(repositories, user_id, COMMENT_SCOPES),
                "update_comment",
                {"issue_id": issue.issue_id, "comment_id": comment["comment_id"], "body": "Theirs"},
            )
        )
        assert text

    assert repositories.comments.get(WORKSPACE, issue.issue_id, comment["comment_id"]).body == "Mine"


def test_an_empty_edit_is_refused(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A blank body is refused rather than wiping the comment."""
    secret = mint_for(repositories, MEMBER, COMMENT_SCOPES)
    comment = _comment(client, secret, "Keep me")

    refusal(
        tool(client, secret, "update_comment", {"issue_id": "ABC-1", "comment_id": comment["comment_id"], "body": " "})
    )

    assert repositories.comments.get(WORKSPACE, issue.issue_id, comment["comment_id"]).body == "Keep me"


def test_an_unknown_comment_is_refused(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A comment id that is not on the issue is a refusal, not a crash."""
    secret = mint_for(repositories, MEMBER, COMMENT_SCOPES)

    assert refusal(
        tool(
            client,
            secret,
            "update_comment",
            {"issue_id": "ABC-1", "comment_id": "01M0000000000000000000000", "body": "Nope"},
        )
    )


def test_the_author_deletes_and_replies_are_kept(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Deleting a root keeps its replies as roots and drops the comment's reactions."""
    secret = mint_for(repositories, MEMBER, COMMENT_SCOPES)
    root = _comment(client, secret, "Root")
    reply = _comment(client, mint_for(repositories, OWNER, COMMENT_SCOPES), "Reply", root["comment_id"])
    answer(
        tool(
            client,
            secret,
            "add_comment_reaction",
            {"issue_id": "ABC-1", "comment_id": root["comment_id"], "emoji": "👍"},
        )
    )

    deleted = answer(tool(client, secret, "delete_comment", {"issue_id": "ABC-1", "comment_id": root["comment_id"]}))
    listed = answer(tool(client, secret, "list_comments", {"issue_id": issue.issue_id}))

    assert deleted == {
        "deleted": True,
        "comment_id": root["comment_id"],
        "issue_id": issue.issue_id,
        "document_id": None,
    }
    assert repositories.comments.get(WORKSPACE, issue.issue_id, root["comment_id"]) is None
    assert [(row["comment_id"], row["parent_comment_id"]) for row in listed["comments"]] == [
        (reply["comment_id"], None)
    ]
    assert repositories.reactions.list_for_target(WORKSPACE, root["comment_id"]) == []


def test_a_team_admin_deletes_someone_elses_comment(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A workspace admin may remove a comment they did not write."""
    comment = _comment(client, mint_for(repositories, MEMBER, COMMENT_SCOPES), "Off topic")

    answer(
        tool(
            client,
            mint_for(repositories, ADMIN, COMMENT_SCOPES),
            "delete_comment",
            {"issue_id": issue.issue_id, "comment_id": comment["comment_id"]},
        )
    )

    assert repositories.comments.get(WORKSPACE, issue.issue_id, comment["comment_id"]) is None


def test_a_member_cannot_delete_someone_elses_comment(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A team member who is not the author is refused and the comment stays."""
    comment = _comment(client, mint_for(repositories, OWNER, COMMENT_SCOPES), "The owner's")

    refusal(
        tool(
            client,
            mint_for(repositories, GUEST, COMMENT_SCOPES),
            "delete_comment",
            {"issue_id": issue.issue_id, "comment_id": comment["comment_id"]},
        )
    )

    assert repositories.comments.get(WORKSPACE, issue.issue_id, comment["comment_id"]) is not None


def test_reactions_add_and_remove_idempotently(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A second add is the same row, the row names the issue, and a second remove still answers."""
    secret = mint_for(repositories, MEMBER, COMMENT_SCOPES)
    comment = _comment(client, mint_for(repositories, OWNER, COMMENT_SCOPES), "React to me")
    arguments = {"issue_id": "ABC-1", "comment_id": comment["comment_id"], "emoji": "🎉"}

    first = answer(tool(client, secret, "add_comment_reaction", arguments))
    second = answer(tool(client, secret, "add_comment_reaction", arguments))
    rows = repositories.reactions.list_for_target(WORKSPACE, comment["comment_id"])

    assert first == second
    assert second["comment_id"] == comment["comment_id"]
    assert second["count"] == 1
    assert second["user_ids"] == [MEMBER]
    assert second["reacted"] is True
    assert [(row.user_id, row.issue_id, row.team_id, row.target_kind) for row in rows] == [
        (MEMBER, issue.issue_id, TEAM, "comment")
    ]

    removed = answer(tool(client, secret, "remove_comment_reaction", arguments))
    again = answer(tool(client, secret, "remove_comment_reaction", arguments))

    assert removed == again == {"removed": True, "comment_id": comment["comment_id"], "emoji": "🎉"}
    assert repositories.reactions.list_for_target(WORKSPACE, comment["comment_id"]) == []


def test_removing_a_reaction_leaves_other_peoples(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A caller takes back only their own reaction."""
    comment = _comment(client, mint_for(repositories, OWNER, COMMENT_SCOPES), "Popular")
    arguments = {"issue_id": issue.issue_id, "comment_id": comment["comment_id"], "emoji": "👍"}
    answer(tool(client, mint_for(repositories, OWNER, COMMENT_SCOPES), "add_comment_reaction", arguments))

    answer(tool(client, mint_for(repositories, MEMBER, COMMENT_SCOPES), "remove_comment_reaction", arguments))

    assert [row.user_id for row in repositories.reactions.list_for_target(WORKSPACE, comment["comment_id"])] == [OWNER]


def test_an_invalid_emoji_is_refused(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Text that is not one emoji or a shortcode is refused before anything is written."""
    secret = mint_for(repositories, MEMBER, COMMENT_SCOPES)
    comment = _comment(client, secret, "Hello")

    refusal(
        tool(
            client,
            secret,
            "add_comment_reaction",
            {"issue_id": "ABC-1", "comment_id": comment["comment_id"], "emoji": "not an emoji"},
        )
    )

    assert repositories.reactions.list_for_target(WORKSPACE, comment["comment_id"]) == []


def test_links_are_added_listed_changed_and_removed(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A link round trips by issue key, and a cleared title falls back to the host."""
    secret = mint_for(repositories, MEMBER, LINK_SCOPES)

    created = answer(
        tool(
            client,
            secret,
            "create_issue_link",
            {"issue_id": "ABC-1", "url": "https://example.com/spec", "title": "The spec"},
        )
    )
    listed = answer(tool(client, secret, "list_issue_links", {"issue_id": issue.issue_id}))

    assert created["title"] == "The spec"
    assert created["issue_id"] == issue.issue_id
    assert created["created_by"] == MEMBER
    assert created["favicon_url"] == "https://www.google.com/s2/favicons?domain=example.com"
    assert [row["link_id"] for row in listed["links"]] == [created["link_id"]]

    moved = answer(
        tool(
            client,
            secret,
            "update_issue_link",
            {"issue_id": "ABC-1", "link_id": created["link_id"], "url": "https://docs.example.org/spec"},
        )
    )
    retitled = answer(
        tool(client, secret, "update_issue_link", {"issue_id": "ABC-1", "link_id": created["link_id"], "title": None})
    )

    assert moved["url"] == "https://docs.example.org/spec"
    assert moved["title"] == "The spec"
    assert moved["favicon_url"] == "https://www.google.com/s2/favicons?domain=docs.example.org"
    assert retitled["title"] == "docs.example.org"

    deleted = answer(tool(client, secret, "delete_issue_link", {"issue_id": "ABC-1", "link_id": created["link_id"]}))
    after = answer(tool(client, secret, "list_issue_links", {"issue_id": issue.issue_id}))

    assert deleted["deleted"] is True
    assert after["links"] == []
    assert repositories.attachments.get(WORKSPACE, issue.issue_id, created["link_id"]) is None


def test_a_host_title_follows_a_new_url(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A link titled with only its host takes the new host when the URL changes."""
    secret = mint_for(repositories, MEMBER, LINK_SCOPES)
    created = answer(tool(client, secret, "create_issue_link", {"issue_id": "ABC-1", "url": "https://example.com/a"}))

    moved = answer(
        tool(
            client,
            secret,
            "update_issue_link",
            {"issue_id": "ABC-1", "link_id": created["link_id"], "url": "https://example.net/b"},
        )
    )

    assert created["title"] == "example.com"
    assert moved["title"] == "example.net"


def test_a_link_must_be_https(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A plain http URL is refused and nothing is stored."""
    secret = mint_for(repositories, MEMBER, LINK_SCOPES)

    refusal(tool(client, secret, "create_issue_link", {"issue_id": "ABC-1", "url": "http://example.com"}))

    assert answer(tool(client, secret, "list_issue_links", {"issue_id": "ABC-1"}))["links"] == []


def test_an_update_needs_a_url_or_a_title(client: TestClient, repositories: Any, issue: Issue) -> None:
    """An update naming neither field is refused."""
    secret = mint_for(repositories, MEMBER, LINK_SCOPES)
    created = answer(tool(client, secret, "create_issue_link", {"issue_id": "ABC-1", "url": "https://example.com"}))

    assert refusal(tool(client, secret, "update_issue_link", {"issue_id": "ABC-1", "link_id": created["link_id"]}))


def test_only_the_adder_or_an_admin_changes_a_link(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Another member is refused; a workspace admin may change and remove it."""
    created = answer(
        tool(
            client,
            mint_for(repositories, MEMBER, LINK_SCOPES),
            "create_issue_link",
            {"issue_id": "ABC-1", "url": "https://example.com"},
        )
    )
    guest = mint_for(repositories, GUEST, LINK_SCOPES)
    admin = mint_for(repositories, ADMIN, LINK_SCOPES)
    target = {"issue_id": "ABC-1", "link_id": created["link_id"]}

    refusal(tool(client, guest, "update_issue_link", {**target, "title": "Hijacked"}))
    refusal(tool(client, guest, "delete_issue_link", target))
    retitled = answer(tool(client, admin, "update_issue_link", {**target, "title": "Tidied"}))
    answer(tool(client, admin, "delete_issue_link", target))

    assert retitled["title"] == "Tidied"
    assert repositories.attachments.get(WORKSPACE, issue.issue_id, created["link_id"]) is None


def test_an_uploaded_file_is_not_a_link(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A file attachment is neither listed, changed nor removed by the link tools."""
    upload = repositories.attachments.create(
        build_attachment(
            WORKSPACE,
            issue.issue_id,
            TEAM,
            "file",
            "notes.txt",
            MEMBER,
            s3_key=f"{WORKSPACE}/{issue.issue_id}/notes.txt",
            content_type="text/plain",
            size_bytes=5,
        )
    )
    secret = mint_for(repositories, MEMBER, LINK_SCOPES)
    target = {"issue_id": "ABC-1", "link_id": upload.attachment_id}

    listed = answer(tool(client, secret, "list_issue_links", {"issue_id": "ABC-1"}))
    refusal(tool(client, secret, "update_issue_link", {**target, "title": "Renamed"}))
    refusal(tool(client, secret, "delete_issue_link", target))

    assert listed["links"] == []
    assert repositories.attachments.get(WORKSPACE, issue.issue_id, upload.attachment_id).title == "notes.txt"


def test_comment_tools_need_the_comments_scope(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A key without `comments:write` cannot edit, delete or react."""
    comment = _comment(client, mint_for(repositories, MEMBER, COMMENT_SCOPES), "Scoped")
    secret = mint_for(repositories, MEMBER, ("issues:read",))
    target = {"issue_id": "ABC-1", "comment_id": comment["comment_id"]}

    for name, extra in (
        ("update_comment", {"body": "x"}),
        ("delete_comment", {}),
        ("add_comment_reaction", {"emoji": "👍"}),
        ("remove_comment_reaction", {"emoji": "👍"}),
    ):
        body = tool(client, secret, name, {**target, **extra}).json()
        assert "error" in body or body["result"]["isError"] is True, (name, body)

    assert repositories.comments.get(WORKSPACE, issue.issue_id, comment["comment_id"]).body == "Scoped"
