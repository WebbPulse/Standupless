"""Inbox rows for comments on documents.

A comment on a document reaches the document's followers, the author of the
comment being replied to and anyone it mentions, never the commenter, and only
those who can still read the document's parent. The rows land in the inbox and
nowhere else.
"""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.documents import Document, DocumentBody
from app.common.db.dynamo.planning import Initiative, Project, initiative_key, project_key
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER
from tests.domains.views.conftest import OTHER_TEAM, TEAM
from tests.domains.views.test_notify_consumer import COMMENTS_ARN, _image, _record, inbox_of, put_comment

PROJECT = "01JB000000000000000000PJT1"

OTHER_PROJECT = "01JB000000000000000000PJT2"

INITIATIVE = "01JB000000000000000000INI1"

DOCUMENT = "01JB000000000000000000DOC1"

ROOT = "01C000000000000000000001"

REPLY = "01C000000000000000000002"


def seed_document(
    repositories: Any, workspace: str, *, parent_kind: str = "project", parent_id: str = PROJECT
) -> Document:
    """One document with its parent, written straight into the planning table."""
    if parent_kind == "project":
        repositories.planning.create_project(
            Project(
                workspace_id=workspace,
                planning_key=project_key(parent_id),
                project_id=parent_id,
                team_ids=[TEAM if parent_id == PROJECT else OTHER_TEAM],
                name="Launch",
                created_by=OWNER,
            )
        )
    else:
        repositories.planning.create_initiative(
            Initiative(
                workspace_id=workspace,
                planning_key=initiative_key(parent_id),
                initiative_id=parent_id,
                name="Grow",
                created_by=OWNER,
            )
        )
    document = Document(
        workspace_id=workspace,
        document_id=DOCUMENT,
        parent_kind=parent_kind,
        parent_id=parent_id,
        title="Launch plan",
        author_id=OWNER,
        updated_by=OWNER,
    )
    body = DocumentBody(workspace_id=workspace, document_id=DOCUMENT, parent_kind=parent_kind, parent_id=parent_id)
    return repositories.documents.create(document, body)


def comment_record(
    workspace: str, comment_id: str, author: str, *, mentions: "list[str] | None" = None, parent: str | None = None
) -> "dict[str, Any]":
    """The stream record a new comment on the document produces."""
    return _record(
        COMMENTS_ARN,
        "INSERT",
        new=_image(
            workspace_id=workspace,
            issue_id=DOCUMENT,
            document_id=DOCUMENT,
            team_id="",
            comment_id=comment_id,
            author_id=author,
            parent_comment_id=parent,
            mentions=mentions,
            body="A thought",
        ),
    )


def kinds(repositories: Any, workspace: str, user_id: str) -> list[str]:
    """The kinds of every notification one member holds, newest first."""
    return [row["kind"] for row in inbox_of(repositories, workspace, user_id)]


def follow(repositories: Any, workspace: str, *user_ids: str) -> None:
    """Subscribe people to the document the way the routes do."""
    for user_id in user_ids:
        repositories.subscriptions.subscribe(workspace, DOCUMENT, "", user_id, "manual")


def test_a_comment_reaches_every_follower_but_its_author(workspace: str, repositories: Any) -> None:
    """The row names the document, so the inbox can link to it."""
    seed_document(repositories, workspace)
    follow(repositories, workspace, OWNER, ADMIN, MEMBER)

    handle_record(repositories, comment_record(workspace, ROOT, ADMIN))

    assert kinds(repositories, workspace, OWNER) == ["document_comment"]
    assert kinds(repositories, workspace, MEMBER) == ["document_comment"]
    assert kinds(repositories, workspace, ADMIN) == []
    row = inbox_of(repositories, workspace, OWNER)[0]
    assert row["document_id"] == DOCUMENT
    assert row["document_title"] == "Launch plan"
    assert row["comment_id"] == ROOT
    assert row["actor_id"] == ADMIN


def test_a_mention_and_a_reply_reach_people_who_do_not_follow(workspace: str, repositories: Any) -> None:
    """The mentioned and the author up the thread hear about it once each."""
    seed_document(repositories, workspace)
    put_comment(
        repositories, workspace, DOCUMENT, ROOT, author_id=MEMBER, body="First", team_id="", document_id=DOCUMENT
    )

    handle_record(repositories, comment_record(workspace, REPLY, OWNER, mentions=[ADMIN, MEMBER], parent=ROOT))

    assert kinds(repositories, workspace, ADMIN) == ["document_comment"]
    assert kinds(repositories, workspace, MEMBER) == ["document_comment"]


def test_a_replayed_record_writes_one_row(workspace: str, repositories: Any) -> None:
    """Redelivery of the same insert leaves the inbox as it was."""
    seed_document(repositories, workspace)
    follow(repositories, workspace, MEMBER)

    handle_record(repositories, comment_record(workspace, ROOT, ADMIN))
    handle_record(repositories, comment_record(workspace, ROOT, ADMIN))

    assert kinds(repositories, workspace, MEMBER) == ["document_comment"]


def test_a_follower_who_cannot_read_the_parent_is_dropped(workspace: str, repositories: Any) -> None:
    """A guest outside the project's team hears nothing, even when followed or mentioned."""
    seed_document(repositories, workspace, parent_id=OTHER_PROJECT)
    follow(repositories, workspace, GUEST, MEMBER)

    handle_record(repositories, comment_record(workspace, ROOT, ADMIN, mentions=[GUEST]))

    assert kinds(repositories, workspace, GUEST) == []
    assert kinds(repositories, workspace, MEMBER) == ["document_comment"]


def test_a_guest_never_hears_about_an_initiative_document(workspace: str, repositories: Any) -> None:
    """Initiatives are closed to guests, so their documents are too."""
    seed_document(repositories, workspace, parent_kind="initiative", parent_id=INITIATIVE)
    follow(repositories, workspace, GUEST, MEMBER)

    handle_record(repositories, comment_record(workspace, ROOT, ADMIN))

    assert kinds(repositories, workspace, GUEST) == []
    assert kinds(repositories, workspace, MEMBER) == ["document_comment"]


def test_a_guest_in_the_team_is_notified(workspace: str, repositories: Any) -> None:
    """A guest who reads the project's team reads its documents."""
    seed_document(repositories, workspace)

    handle_record(repositories, comment_record(workspace, ROOT, ADMIN, mentions=[GUEST]))

    assert kinds(repositories, workspace, GUEST) == ["document_comment"]


def test_a_comment_on_a_deleted_document_notifies_nobody(workspace: str, repositories: Any) -> None:
    """A record that outlived its document is dropped."""
    follow(repositories, workspace, MEMBER)

    handle_record(repositories, comment_record(workspace, ROOT, ADMIN, mentions=[MEMBER]))

    assert kinds(repositories, workspace, MEMBER) == []


def test_an_edit_reaches_only_the_newly_mentioned(workspace: str, repositories: Any) -> None:
    """Followers and people already named hear nothing about an edit."""
    seed_document(repositories, workspace)
    follow(repositories, workspace, OWNER)
    base = {
        "workspace_id": workspace,
        "issue_id": DOCUMENT,
        "document_id": DOCUMENT,
        "team_id": "",
        "comment_id": ROOT,
        "author_id": ADMIN,
        "body": "cc",
    }

    handle_record(
        repositories,
        _record(
            COMMENTS_ARN,
            "MODIFY",
            new=_image(**base, mentions=[MEMBER, GUEST], edited_at="2026-10-24T12:00:00+00:00"),
            old=_image(**base, mentions=[MEMBER]),
        ),
    )

    assert kinds(repositories, workspace, GUEST) == ["document_comment"]
    assert kinds(repositories, workspace, MEMBER) == []
    assert kinds(repositories, workspace, OWNER) == []


def test_turning_the_kind_off_keeps_it_out_of_the_inbox(workspace: str, repositories: Any) -> None:
    """The in-app switch for document comments is honoured."""
    seed_document(repositories, workspace)
    follow(repositories, workspace, MEMBER)
    repositories.users.update(MEMBER, notification_preferences={"document_comment": {"in_app": False}})

    handle_record(repositories, comment_record(workspace, ROOT, ADMIN))

    assert kinds(repositories, workspace, MEMBER) == []
