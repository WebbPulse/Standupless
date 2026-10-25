"""The notify consumer's planning route for replies on project updates.

A reply reaches the update's author, everyone who replied before and anyone it
mentions, each once and never the person replying. It lands in the inbox only,
under the project, so nothing is mailed, and a recipient must still see one of
the project's teams.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from webbpulse.dynamodb import table_name
from webbpulse.identity.email import RecordingEmailSender

from app.common.core.config import settings
from app.common.db.dynamo.planning import Project, ProjectUpdateRow, project_key, project_update_key
from app.common.db.dynamo.update_threads import build_update_comment, update_comment_key
from app.common.email import reset_email_sender
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER
from tests.domains.views.conftest import OTHER_TEAM, TEAM
from tests.domains.views.test_notify_consumer import _image, _record, flush_digests, inbox_of

PLANNING_ARN = (
    f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('planning', settings.dynamodb_table_prefix)}/stream/x"
)

PROJECT_ID = "01JB000000000000000000PRJR"

UPDATE_ID = "01JB00000000000000000UPDR1"

REPLY_ID = "01JB00000000000000000RPLY1"


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def _seed(repositories: Any, workspace: str, team_ids: list[str] | None = None) -> None:
    """One project and one update on it written by `MEMBER`."""
    project = Project(
        workspace_id=workspace,
        planning_key=project_key(PROJECT_ID),
        project_id=PROJECT_ID,
        team_ids=team_ids or [TEAM],
        name="Launch",
        created_by=OWNER,
    )
    repositories.planning.create_project(project)
    repositories.planning.create_project_update(
        ProjectUpdateRow(
            workspace_id=workspace,
            planning_key=project_update_key(PROJECT_ID, UPDATE_ID),
            update_id=UPDATE_ID,
            project_id=PROJECT_ID,
            body="Shipping on schedule",
            health="on_track",
            author_id=MEMBER,
        )
    )


def _reply(workspace: str, event_name: str = "INSERT", **fields: Any) -> Any:
    """One planning stream record for a reply by `OWNER` unless told otherwise."""
    image: "dict[str, Any]" = {
        "workspace_id": workspace,
        "planning_key": update_comment_key(PROJECT_ID, UPDATE_ID, REPLY_ID),
        "kind": "project_update_comment",
        "comment_id": REPLY_ID,
        "project_id": PROJECT_ID,
        "update_id": UPDATE_ID,
        "author_id": OWNER,
        "body": "Nice work",
        "created_at": "2026-10-20T12:00:00+00:00",
    }
    image.update(fields)
    return _record(PLANNING_ARN, event_name, new=_image(**image))


def test_a_reply_reaches_the_author_earlier_repliers_and_mentions_in_the_inbox_only(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """Each recipient holds one row naming the project, update and reply, and no mail goes out."""
    _seed(repositories, workspace)
    repositories.planning.update_threads.create_comment(
        build_update_comment(workspace, PROJECT_ID, UPDATE_ID, body="First", author_id=ADMIN, mentions=[], source=None)
    )

    handle_record(repositories, _reply(workspace, mentions=[GUEST, MEMBER]))
    flush_digests(repositories)

    for user_id in (MEMBER, ADMIN, GUEST):
        rows = inbox_of(repositories, workspace, user_id)
        assert [row["kind"] for row in rows] == ["project_update_comment"]
        assert rows[0]["project_id"] == PROJECT_ID
        assert rows[0]["project_name"] == "Launch"
        assert rows[0]["project_update_id"] == UPDATE_ID
        assert rows[0]["comment_id"] == REPLY_ID
        assert rows[0]["team_id"] == TEAM
        assert rows[0]["actor_name"] == "Olive Owner"
    assert inbox_of(repositories, workspace, OWNER) == []
    assert recorder.sent == []


def test_the_author_replying_to_their_own_update_is_not_notified(repositories: Any, workspace: str) -> None:
    """The person replying never hears about their own reply."""
    _seed(repositories, workspace)

    handle_record(repositories, _reply(workspace, author_id=MEMBER))

    assert inbox_of(repositories, workspace, MEMBER) == []


def test_a_mention_outside_the_projects_teams_is_dropped(repositories: Any, workspace: str) -> None:
    """The guest belongs to `TEAM` alone, so a reply on an `OTHER_TEAM` project does not reach it."""
    _seed(repositories, workspace, team_ids=[OTHER_TEAM])

    handle_record(repositories, _reply(workspace, mentions=[GUEST]))

    assert inbox_of(repositories, workspace, GUEST) == []
    assert [row["team_id"] for row in inbox_of(repositories, workspace, MEMBER)] == [OTHER_TEAM]


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
    """A recipient who switched replies off holds no row."""
    _seed(repositories, workspace)
    repositories.users.update(MEMBER, notification_preferences={"project_update_comment": {"in_app": False}})

    handle_record(repositories, _reply(workspace))

    assert inbox_of(repositories, workspace, MEMBER) == []
