"""Reminders on projects, initiatives and documents: the entity routes and their delivery.

The properties worth holding are that each kind of subject takes one reminder per
member through the same store the issue reminders use, that the issue routes keep
reading issue reminders alone, and that a due reminder becomes exactly one inbox
row naming its subject, in the inbox only, or none once the member cannot read it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.identity.email import RecordingEmailSender

from app.common.db.dynamo.documents import Document, DocumentBody
from app.common.db.dynamo.planning import Initiative, Project, initiative_key, project_key
from app.common.email import reset_email_sender
from app.domains.views.consumers.digest import NOTIFY_DIGEST_SOURCE
from app.domains.views.consumers.issue_reminders import run_issue_reminders
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue
from tests.domains.views.test_notify_consumer import flush_digests, inbox_of

PROJECT = "01JB000000000000000000RPJ1"

HIDDEN_PROJECT = "01JB000000000000000000RPJ2"

INITIATIVE = "01JB000000000000000000RIN1"

DOCUMENT = "01JB000000000000000000RDC1"


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


@pytest.fixture
def subjects(repositories: Any, workspace: str) -> dict[str, str]:
    """One project on `TEAM`, one on `OTHER_TEAM`, one initiative and one document on the first project."""
    for project_id, team_id, name in ((PROJECT, TEAM, "Launch"), (HIDDEN_PROJECT, OTHER_TEAM, "Secret")):
        repositories.planning.create_project(
            Project(
                workspace_id=workspace,
                planning_key=project_key(project_id),
                project_id=project_id,
                team_ids=[team_id],
                name=name,
                created_by=OWNER,
            )
        )
    repositories.planning.create_initiative(
        Initiative(
            workspace_id=workspace,
            planning_key=initiative_key(INITIATIVE),
            initiative_id=INITIATIVE,
            name="Grow",
            created_by=OWNER,
        )
    )
    repositories.documents.create(
        Document(
            workspace_id=workspace,
            document_id=DOCUMENT,
            parent_kind="project",
            parent_id=PROJECT,
            title="Launch plan",
            author_id=OWNER,
            updated_by=OWNER,
        ),
        DocumentBody(workspace_id=workspace, document_id=DOCUMENT, parent_kind="project", parent_id=PROJECT),
    )
    return {"project": PROJECT, "initiative": INITIATIVE, "document": DOCUMENT}


def _soon(minutes: int = 30) -> datetime:
    """A moment a little in the future, comfortably past the one minute floor."""
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


def _path(workspace: str, entity_type: str, entity_id: str) -> str:
    """The entity reminder route for one subject."""
    return f"/api/workspaces/{workspace}/inbox/entity-reminders/{entity_type}/{entity_id}"


def _set(client: TestClient, workspace: str, entity_type: str, entity_id: str, moment: datetime) -> Any:
    """Set the signed in caller's reminder on one subject."""
    return client.put(_path(workspace, entity_type, entity_id), json={"remind_at": moment.isoformat()})


def _listed(client: TestClient, workspace: str, **params: str) -> list[dict[str, Any]]:
    """The signed in caller's entity reminders."""
    response = client.get(f"/api/workspaces/{workspace}/inbox/entity-reminders", params=params)
    assert response.status_code == 200, response.text
    return list(response.json()["reminders"])


def _reminder_rows(repositories: Any, workspace: str, user_id: str) -> list[dict[str, Any]]:
    """The `reminder` notifications one member holds."""
    return [row for row in inbox_of(repositories, workspace, user_id) if row["kind"] == "reminder"]


@pytest.mark.parametrize(
    ("entity_type", "title"), [("project", "Launch"), ("initiative", "Grow"), ("document", "Launch plan")]
)
def test_a_reminder_on_each_kind_reads_back_with_its_title(
    client: TestClient, workspace: str, subjects: dict[str, str], entity_type: str, title: str
) -> None:
    """A reminder set on a project, initiative or document lists with the subject's title."""
    moment = _soon()
    sign_in(client, MEMBER)

    response = _set(client, workspace, entity_type, subjects[entity_type], moment)
    listed = _listed(client, workspace, entity_type=entity_type, entity_id=subjects[entity_type])

    assert response.status_code == 200, response.text
    assert response.json()["title"] == title
    assert response.json()["issue_key"] is None
    assert [(row["entity_type"], row["entity_id"]) for row in listed] == [(entity_type, subjects[entity_type])]
    assert datetime.fromisoformat(listed[0]["remind_at"]) == moment


def test_setting_again_replaces_the_reminder(
    client: TestClient, workspace: str, subjects: dict[str, str], repositories: Any
) -> None:
    """One reminder per subject: a second set moves it rather than adding another."""
    first, second = _soon(30), _soon(90)
    sign_in(client, MEMBER)

    _set(client, workspace, "project", PROJECT, first)
    _set(client, workspace, "project", PROJECT, second)

    assert [datetime.fromisoformat(row["remind_at"]) for row in _listed(client, workspace)] == [second]
    assert len(repositories.inbox.reminders.due(second + timedelta(minutes=1), limit=10)) == 1


def test_the_issue_routes_list_issue_reminders_alone(
    client: TestClient, issues_client: TestClient, workspace: str, subjects: dict[str, str]
) -> None:
    """A project reminder stays out of the issue list, while the entity list holds both."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Follow up")
    sign_in(client, MEMBER)
    client.put(f"/api/workspaces/{workspace}/inbox/reminders/{issue['id']}", json={"remind_at": _soon(10).isoformat()})
    _set(client, workspace, "project", PROJECT, _soon(20))

    issue_list = client.get(f"/api/workspaces/{workspace}/inbox/reminders").json()["reminders"]
    every = _listed(client, workspace)

    assert [row["issue_id"] for row in issue_list] == [issue["id"]]
    assert [(row["entity_type"], row["entity_id"]) for row in every] == [("issue", issue["id"]), ("project", PROJECT)]
    assert every[0]["issue_key"] == issue["key"]
    assert [row["entity_type"] for row in _listed(client, workspace, entity_type="project")] == ["project"]


def test_cancelling_removes_the_reminder_and_its_delivery(
    client: TestClient, workspace: str, subjects: dict[str, str], repositories: Any
) -> None:
    """A cancelled reminder neither lists nor ever lands, and a second cancel is a 404."""
    moment = _soon()
    sign_in(client, MEMBER)
    _set(client, workspace, "initiative", INITIATIVE, moment)

    cancelled = client.delete(_path(workspace, "initiative", INITIATIVE))
    again = client.delete(_path(workspace, "initiative", INITIATIVE))
    run_issue_reminders(repositories, moment + timedelta(minutes=1))

    assert cancelled.status_code == 204
    assert again.status_code == 404
    assert _listed(client, workspace) == []
    assert _reminder_rows(repositories, workspace, MEMBER) == []


def test_a_reminder_is_the_callers_own(client: TestClient, workspace: str, subjects: dict[str, str]) -> None:
    """Another member sees none of it and cannot cancel it."""
    sign_in(client, MEMBER)
    _set(client, workspace, "document", DOCUMENT, _soon())

    sign_in(client, OWNER)

    assert _listed(client, workspace) == []
    assert client.delete(_path(workspace, "document", DOCUMENT)).status_code == 404


def test_a_subject_out_of_sight_cannot_be_reminded(
    client: TestClient, workspace: str, subjects: dict[str, str]
) -> None:
    """A guest gets a 404 for a project outside their team and is refused initiatives."""
    sign_in(client, GUEST)

    assert _set(client, workspace, "project", HIDDEN_PROJECT, _soon()).status_code == 404
    assert _set(client, workspace, "initiative", INITIATIVE, _soon()).status_code in (403, 404)
    assert _set(client, workspace, "document", "01JB000000000000000000NONE", _soon()).status_code == 404


def test_an_unknown_kind_is_refused(client: TestClient, workspace: str, subjects: dict[str, str]) -> None:
    """Only issues, projects, initiatives and documents take reminders."""
    sign_in(client, MEMBER)

    assert _set(client, workspace, "cycle", PROJECT, _soon()).status_code == 422
    narrowed = client.get(f"/api/workspaces/{workspace}/inbox/entity-reminders", params={"entity_id": PROJECT})

    assert narrowed.status_code == 422


def test_the_moment_must_be_in_range(client: TestClient, workspace: str, subjects: dict[str, str]) -> None:
    """A past moment is refused for an entity as for an issue."""
    sign_in(client, MEMBER)

    response = _set(client, workspace, "project", PROJECT, datetime(2020, 1, 1, tzinfo=timezone.utc))

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("entity_type", "field", "value"),
    [
        ("project", "project_name", "Launch"),
        ("initiative", "initiative_name", "Grow"),
        ("document", "document_title", "Launch plan"),
    ],
)
def test_a_due_reminder_lands_once_naming_its_subject_in_the_inbox_only(
    client: TestClient,
    workspace: str,
    subjects: dict[str, str],
    repositories: Any,
    recorder: RecordingEmailSender,
    entity_type: str,
    field: str,
    value: str,
) -> None:
    """At its moment the member gets one unread `reminder` row carrying the subject, and no email."""
    moment = _soon()
    sign_in(client, MEMBER)
    _set(client, workspace, entity_type, subjects[entity_type], moment)

    early = run_issue_reminders(repositories, moment - timedelta(minutes=1))
    on_time = run_issue_reminders(repositories, moment)
    later = run_issue_reminders(repositories, moment + timedelta(minutes=1))
    flush_digests(repositories)

    rows = _reminder_rows(repositories, workspace, MEMBER)
    assert (early, on_time, later) == (0, 1, 0)
    assert len(rows) == 1
    assert rows[0][field] == value
    assert rows[0]["issue_id"] == ""
    assert _listed(client, workspace) == []
    assert recorder.sent == []
    listed = client.get(f"/api/workspaces/{workspace}/inbox", params={"kind": "reminder"}).json()["notifications"]
    assert [row["summary"] for row in listed] == ["Reminder"]
    assert listed[0]["unread"] is True


def test_a_member_who_lost_sight_of_the_project_hears_nothing(
    client: TestClient, workspace: str, subjects: dict[str, str], repositories: Any
) -> None:
    """A guest who left the team gets no reminder about its project or its document, and nothing retries."""
    moment = _soon()
    sign_in(client, GUEST)
    _set(client, workspace, "project", PROJECT, moment)
    _set(client, workspace, "document", DOCUMENT, moment)
    repositories.memberships.delete_team_membership(workspace, TEAM, GUEST)

    run_issue_reminders(repositories, moment)

    assert _reminder_rows(repositories, workspace, GUEST) == []
    assert repositories.inbox.reminders.list(workspace, GUEST) == []
    assert repositories.inbox.reminders.due(moment + timedelta(days=1), limit=10) == []


def test_the_in_app_preference_off_writes_nothing(
    client: TestClient, workspace: str, subjects: dict[str, str], repositories: Any
) -> None:
    """A member who turned reminder notifications off in the app gets no row."""
    repositories.users.update(MEMBER, notification_preferences={"reminder": {"in_app": False, "email": False}})
    moment = _soon()
    sign_in(client, MEMBER)
    _set(client, workspace, "initiative", INITIATIVE, moment)

    run_issue_reminders(repositories, moment)

    assert _reminder_rows(repositories, workspace, MEMBER) == []


def test_the_schedule_record_delivers_entity_reminders(
    client: TestClient, workspace: str, subjects: dict[str, str], repositories: Any
) -> None:
    """The flush schedule's synthetic record delivers an entity reminder as it does an issue's."""
    sign_in(client, MEMBER)
    _set(client, workspace, "document", DOCUMENT, _soon(2))
    pending = repositories.inbox.reminders.get(workspace, MEMBER, DOCUMENT, "document")
    repositories.inbox.reminders.set(
        workspace, MEMBER, DOCUMENT, pending.remind_at - timedelta(minutes=10), entity_type="document"
    )

    handle_record(repositories, {"eventSource": NOTIFY_DIGEST_SOURCE, "eventName": "FLUSH", "eventID": "x"})

    rows = _reminder_rows(repositories, workspace, MEMBER)
    assert [row["document_id"] for row in rows] == [DOCUMENT]


def test_purging_an_inbox_clears_entity_reminders(
    client: TestClient, workspace: str, subjects: dict[str, str], repositories: Any
) -> None:
    """The purges' inbox delete takes entity reminders and their due markers with it."""
    moment = _soon()
    sign_in(client, MEMBER)
    _set(client, workspace, "project", PROJECT, moment)

    repositories.inbox.delete_all(workspace, MEMBER)

    assert repositories.inbox.reminders.list(workspace, MEMBER) == []
    assert repositories.inbox.reminders.due(moment + timedelta(days=1), limit=10) == []


def test_a_row_written_before_entity_types_reads_as_an_issue(repositories: Any, workspace: str) -> None:
    """A stored reminder carrying only `issue_id` still reads, lists and cancels as an issue reminder."""
    store = repositories.inbox.reminders
    store._repository.put(
        {
            "ws_user": f"issue_reminder#{workspace}#{MEMBER}",
            "notification_id": "01JB000000000000000000LGCY",
            "workspace_id": workspace,
            "user_id": MEMBER,
            "issue_id": "01JB000000000000000000LGCY",
            "remind_at": _soon().isoformat(timespec="microseconds"),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
    )

    found = store.get(workspace, MEMBER, "01JB000000000000000000LGCY")

    assert found is not None
    assert found.entity_type == "issue"
    assert found.issue_id == found.entity_id == "01JB000000000000000000LGCY"
    assert store.cancel(workspace, MEMBER, "01JB000000000000000000LGCY") is True
