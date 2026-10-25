"""The notify consumer's planning route for replies on initiative updates.

A reply reaches the update's author, the initiative's owner, everyone who
replied before and anyone it mentions, each once and never the person replying.
It lands in the inbox only, under the project update reply kind with the
initiative's fields and no team, and a recipient must still be able to read the
initiative, so a guest is never told.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from webbpulse.dynamodb import table_name
from webbpulse.identity.email import RecordingEmailSender

from app.common.core.config import settings
from app.common.db.dynamo.planning import Initiative, InitiativeUpdateRow, initiative_key, initiative_update_key
from app.common.db.dynamo.update_threads import INITIATIVE_THREADS, build_update_comment, update_comment_key
from app.common.email import reset_email_sender
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, make_user
from tests.domains.views.test_notify_consumer import _image, _record, flush_digests, inbox_of

PLANNING_ARN = (
    f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('planning', settings.dynamodb_table_prefix)}/stream/x"
)

INITIATIVE_ID = "01JB000000000000000000INIR"

UPDATE_ID = "01JB00000000000000000UPDI1"

REPLY_ID = "01JB00000000000000000RPLI1"

PEER = "01JB000000000000000000PEER"


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def _seed(repositories: Any, workspace: str) -> None:
    """One initiative owned by `OWNER` and one update on it written by `MEMBER`."""
    repositories.planning.create_initiative(
        Initiative(
            workspace_id=workspace,
            planning_key=initiative_key(INITIATIVE_ID),
            initiative_id=INITIATIVE_ID,
            name="Expand to Europe",
            owner_id=OWNER,
            created_by=MEMBER,
        )
    )
    repositories.planning.create_initiative_update(
        InitiativeUpdateRow(
            workspace_id=workspace,
            planning_key=initiative_update_key(INITIATIVE_ID, UPDATE_ID),
            update_id=UPDATE_ID,
            initiative_id=INITIATIVE_ID,
            body="On track",
            health="on_track",
            author_id=MEMBER,
        )
    )


def _reply(workspace: str, event_name: str = "INSERT", **fields: Any) -> Any:
    """One planning stream record for a reply by `ADMIN` unless told otherwise."""
    image: "dict[str, Any]" = {
        "workspace_id": workspace,
        "planning_key": update_comment_key(INITIATIVE_ID, UPDATE_ID, REPLY_ID, INITIATIVE_THREADS),
        "kind": "initiative_update_comment",
        "comment_id": REPLY_ID,
        "initiative_id": INITIATIVE_ID,
        "update_id": UPDATE_ID,
        "author_id": ADMIN,
        "body": "Nice work",
        "created_at": "2026-10-20T12:00:00+00:00",
    }
    image.update(fields)
    return _record(PLANNING_ARN, event_name, new=_image(**image))


def test_a_reply_reaches_the_author_owner_earlier_repliers_and_mentions(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """Each recipient holds one row naming the initiative, update and reply; a guest and the replier hold none."""
    _seed(repositories, workspace)
    add_member(repositories, workspace, PEER, "member")
    make_user(repositories, PEER, "peer@example.com", "Pat Peer")
    repositories.planning.initiative_update_threads.create_comment(
        build_update_comment(
            workspace,
            INITIATIVE_ID,
            UPDATE_ID,
            body="First",
            author_id=PEER,
            mentions=[],
            source=None,
            subject=INITIATIVE_THREADS,
        )
    )

    handle_record(repositories, _reply(workspace, mentions=[GUEST, MEMBER]))
    flush_digests(repositories)

    for user_id in (MEMBER, OWNER, PEER):
        rows = inbox_of(repositories, workspace, user_id)
        assert [row["kind"] for row in rows] == ["project_update_comment"]
        assert rows[0]["initiative_id"] == INITIATIVE_ID
        assert rows[0]["initiative_name"] == "Expand to Europe"
        assert rows[0]["project_update_id"] == UPDATE_ID
        assert rows[0]["comment_id"] == REPLY_ID
        assert rows[0]["team_id"] == ""
        assert not rows[0].get("project_id")
    assert inbox_of(repositories, workspace, ADMIN) == []
    assert inbox_of(repositories, workspace, GUEST) == []
    assert recorder.sent == []


def test_the_owner_replying_is_not_notified(repositories: Any, workspace: str) -> None:
    """The person replying never hears about their own reply, and the author still does."""
    _seed(repositories, workspace)

    handle_record(repositories, _reply(workspace, author_id=OWNER))

    assert inbox_of(repositories, workspace, OWNER) == []
    assert len(inbox_of(repositories, workspace, MEMBER)) == 1


@pytest.mark.parametrize("event_name", ["MODIFY", "REMOVE"])
def test_an_edit_or_delete_of_a_reply_is_not_news(repositories: Any, workspace: str, event_name: str) -> None:
    """Only a new reply notifies."""
    _seed(repositories, workspace)

    handle_record(repositories, _reply(workspace, event_name=event_name))

    assert inbox_of(repositories, workspace, MEMBER) == []


def test_a_replayed_reply_writes_one_row(repositories: Any, workspace: str) -> None:
    """The id is a function of the record, so a redelivery is a no-op."""
    _seed(repositories, workspace)

    handle_record(repositories, _reply(workspace))
    handle_record(repositories, _reply(workspace))

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1


def test_turning_the_preference_off_silences_replies(repositories: Any, workspace: str) -> None:
    """The project update reply preference covers initiative replies too."""
    _seed(repositories, workspace)
    repositories.users.update(MEMBER, notification_preferences={"project_update_comment": {"in_app": False}})

    handle_record(repositories, _reply(workspace))

    assert inbox_of(repositories, workspace, MEMBER) == []
    assert len(inbox_of(repositories, workspace, OWNER)) == 1


def test_a_reply_on_a_missing_update_is_dropped(repositories: Any, workspace: str) -> None:
    """A record naming an update that no longer exists writes nothing."""
    _seed(repositories, workspace)

    handle_record(repositories, _reply(workspace, update_id="01JB00000000000000000GONE1"))

    assert inbox_of(repositories, workspace, MEMBER) == []
