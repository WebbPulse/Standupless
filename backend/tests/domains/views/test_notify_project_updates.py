"""The notify consumer's planning route: a posted project update becomes inbox rows.

With no project subscriptions, the audience is the project's lead and members.
The properties held are that each of them is notified once, the author never,
that a recipient must still see one of the project's teams, that only an insert
of an update is news, and that the email carries the project's link.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from webbpulse.dynamodb import table_name
from webbpulse.identity.email import RecordingEmailSender

from app.common.core.config import settings
from app.common.db.dynamo.planning import Project, project_key, project_update_key
from app.common.email import reset_email_sender
from app.domains.views.consumers.notify import handle_record
from app.domains.views.email import render_project_update_notification
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER
from tests.domains.views.conftest import OTHER_TEAM, TEAM
from tests.domains.views.test_notify_consumer import _image, _record, inbox_of

PLANNING_ARN = (
    f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('planning', settings.dynamodb_table_prefix)}/stream/x"
)

PROJECT_ID = "01JB000000000000000000PRJX"

UPDATE_ID = "01JB00000000000000000UPD01"


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def _project(repositories: Any, workspace: str, **fields: Any) -> Project:
    """Store one project row directly, since `views` only ever reads the planning table."""
    values: "dict[str, Any]" = {"team_ids": [TEAM], "name": "Launch", "created_by": OWNER}
    values.update(fields)
    project = Project(workspace_id=workspace, planning_key=project_key(PROJECT_ID), project_id=PROJECT_ID, **values)
    return repositories.planning.create_project(project)


def _posted(workspace: str, event_name: str = "INSERT", kind: str = "project_update", **fields: Any) -> Any:
    """One planning stream record for a posted update, by `OWNER` unless told otherwise."""
    image: "dict[str, Any]" = {
        "workspace_id": workspace,
        "planning_key": project_update_key(PROJECT_ID, UPDATE_ID),
        "kind": kind,
        "project_id": PROJECT_ID,
        "update_id": UPDATE_ID,
        "author_id": OWNER,
        "health": "at_risk",
        "body": "Slipping a week",
        "created_at": "2026-09-20T12:00:00+00:00",
    }
    image.update(fields)
    return _record(PLANNING_ARN, event_name, new=_image(**image))


def test_an_update_notifies_the_lead_and_members_once_each_but_not_its_author(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """The lead is also a member here, and still gets one row; the author gets none."""
    _project(repositories, workspace, lead_id=MEMBER, member_ids=[MEMBER, ADMIN, OWNER])

    handle_record(repositories, _posted(workspace))

    for user_id in (MEMBER, ADMIN):
        rows = inbox_of(repositories, workspace, user_id)
        assert [row["kind"] for row in rows] == ["project_update"]
        assert rows[0]["project_id"] == PROJECT_ID
        assert rows[0]["project_name"] == "Launch"
        assert rows[0]["project_update_id"] == UPDATE_ID
        assert rows[0]["team_id"] == TEAM
        assert rows[0]["actor_name"] == "Olive Owner"
    assert inbox_of(repositories, workspace, OWNER) == []
    assert sorted(item.to for item in recorder.sent) == ["admin@example.com", "member@example.com"]
    assert recorder.sent[0].subject == "[Project] Launch"


def test_a_replayed_update_writes_one_row(repositories: Any, workspace: str) -> None:
    """The id is a function of the record, so a redelivery is a no-op."""
    _project(repositories, workspace, lead_id=MEMBER)

    handle_record(repositories, _posted(workspace))
    handle_record(repositories, _posted(workspace))

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1


def test_a_member_who_sees_none_of_the_projects_teams_is_not_notified(repositories: Any, workspace: str) -> None:
    """The guest belongs to `TEAM` alone, so a project on `OTHER_TEAM` does not reach it."""
    _project(repositories, workspace, team_ids=[OTHER_TEAM], lead_id=GUEST, member_ids=[MEMBER])

    handle_record(repositories, _posted(workspace))

    assert inbox_of(repositories, workspace, GUEST) == []
    assert [row["team_id"] for row in inbox_of(repositories, workspace, MEMBER)] == [OTHER_TEAM]


@pytest.mark.parametrize(
    ("event_name", "kind"),
    [("MODIFY", "project_update"), ("REMOVE", "project_update"), ("INSERT", "project"), ("INSERT", "cycle")],
)
def test_only_a_posted_update_is_news(repositories: Any, workspace: str, event_name: str, kind: str) -> None:
    """An edit, a delete or any other planning row notifies nobody."""
    _project(repositories, workspace, lead_id=MEMBER)

    handle_record(repositories, _posted(workspace, event_name=event_name, kind=kind))

    assert inbox_of(repositories, workspace, MEMBER) == []


def test_an_update_on_a_deleted_project_is_dropped(repositories: Any, workspace: str) -> None:
    """With no project row there is no audience, and the record is not retried."""
    handle_record(repositories, _posted(workspace))

    assert inbox_of(repositories, workspace, MEMBER) == []


def test_turning_the_preference_off_silences_both_channels(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """A recipient who switched project updates off holds no row and gets no mail."""
    _project(repositories, workspace, lead_id=MEMBER)
    repositories.users.update(MEMBER, notification_preferences={"project_update": {"in_app": False, "email": False}})

    handle_record(repositories, _posted(workspace))

    assert inbox_of(repositories, workspace, MEMBER) == []
    assert recorder.sent == []


def test_the_email_links_to_the_projects_updates_and_quotes_the_body() -> None:
    """The link opens the Updates tab, and the body is escaped in the HTML part."""
    message = render_project_update_notification(
        to="member@example.com",
        actor_name="Olive Owner",
        project_id=PROJECT_ID,
        project_name="Launch",
        health="off_track",
        workspace_slug="acme",
        body="<b>late</b>",
    )

    assert message.subject == "[Project] Launch"
    assert f"{settings.frontend_base_url}/w/acme/projects/{PROJECT_ID}?tab=updates" in message.text
    assert "off track" in message.text
    assert "<b>late</b>" in message.text
    assert "&lt;b&gt;late&lt;/b&gt;" in (message.html or "")
