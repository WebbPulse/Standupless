"""The notify consumer's project view subscription notice: a project entering a followed project view.

These pin the transition rule for project views: a follower hears of a project
when it is created into the view or changed so that it now matches, a project
that stays in the view says nothing, and one that leaves and comes back is news
again, since a project view remembers no notice. The guards around it are held
too: the person whose write moved the project says nothing to themselves, a
write that touches only the rollup counters is not judged, a replay writes one
row, a follower who cannot see the project's team hears nothing, a parent
team's view rolls up its sub-team's projects, and the preference switch
silences the kind.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Iterator, Optional

import pytest
from boto3.dynamodb.types import TypeSerializer
from fastapi.testclient import TestClient
from webbpulse.dynamodb import table_name
from webbpulse.identity.email import RecordingEmailSender

from app.common.core.config import settings
from app.common.db.dynamo.inbox import Notification
from app.common.db.dynamo.planning import Project, as_project_item, project_key
from app.common.db.dynamo.teams import Team
from app.common.email import reset_email_sender
from app.common.inbox_summary import notification_summary
from app.domains.views.consumers.notify import handle_record
from app.domains.views.consumers.project_view_watch import view_fields_changed
from app.domains.views.email import render_view_project_added_notification
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM
from tests.domains.views.test_notify_consumer import flush_digests
from tests.domains.views.test_saved_views import create_view

PLANNING_ARN = (
    f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('planning', settings.dynamodb_table_prefix)}/stream/x"
)

PROJECT_ID = "01JB000000000000000000PRJV"

SUB_TEAM = "01JB000000000000000000PRJ3"

SERIALIZER = TypeSerializer()

START = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def _project(workspace: str, minutes: int = 0, **fields: Any) -> Project:
    """One project state, created by `OWNER` on `TEAM` in backlog unless told otherwise."""
    values: "dict[str, Any]" = {
        "team_ids": [TEAM],
        "name": "Launch",
        "created_by": OWNER,
        "created_at": START,
        "updated_at": START + timedelta(minutes=minutes),
    }
    values.update(fields)
    return Project(workspace_id=workspace, planning_key=project_key(PROJECT_ID), project_id=PROJECT_ID, **values)


def _image(project: Project) -> "dict[str, Any]":
    """One project state as a stream image in DynamoDB's wire encoding."""
    item = json.loads(json.dumps(as_project_item(project)), parse_float=Decimal)
    return {name: SERIALIZER.serialize(value) for name, value in item.items()}


def _record(after: Project, before: Optional[Project] = None) -> "dict[str, Any]":
    """One planning stream record for a project write, a modify when `before` is given."""
    dynamodb: "dict[str, Any]" = {"NewImage": _image(after)}
    if before is not None:
        dynamodb["OldImage"] = _image(before)
    event = "MODIFY" if before is not None else "INSERT"
    return {"eventName": event, "eventID": "1", "eventSourceARN": PLANNING_ARN, "dynamodb": dynamodb}


def _write(repositories: Any, after: Project, before: Optional[Project] = None) -> None:
    """Store a project state and hand the consumer the record its write streams."""
    repositories.planning.create_project(after) if before is None else repositories.planning.replace_project(after)
    handle_record(repositories, _record(after, before))


def _sub_team(repositories: Any, workspace: str) -> None:
    """Put `SUB_TEAM` in under `TEAM`, with its statuses seeded."""
    repositories.teams.create(
        Team(workspace_id=workspace, team_id=SUB_TEAM, name="Sub", key_prefix="SUB", parent_team_id=TEAM)
    )
    repositories.team_config.seed_statuses(workspace, SUB_TEAM)


def _view_rows(repositories: Any, workspace: str, user_id: str) -> "list[dict[str, Any]]":
    """Every project view notice one member holds, newest first."""
    rows = repositories.inbox.list(workspace, user_id, limit=50).items
    return [dict(row) for row in rows if row["kind"] == "view_project_added"]


def _follow(client: TestClient, workspace: str, user_id: str, **payload: Any) -> "dict[str, Any]":
    """Save a project view as one member and follow it, answering the view."""
    sign_in(client, user_id)
    view = create_view(client, workspace, entity="projects", **payload)
    response = client.put(f"/api/workspaces/{workspace}/views/{view['view_id']}/subscription")
    assert response.status_code == 200, response.text
    return view


def test_a_project_created_into_a_followed_view_notifies_naming_the_view(
    client: TestClient, workspace: str, repositories: Any, recorder: RecordingEmailSender
) -> None:
    """A created project matched nothing before, so landing in the view is an entry, mailed too."""
    _follow(client, workspace, MEMBER, name="In flight", shared=True, filter={"status": ["in_progress"]})

    _write(repositories, _project(workspace, status="in_progress"))
    flush_digests(repositories)

    rows = _view_rows(repositories, workspace, MEMBER)
    assert len(rows) == 1
    assert rows[0]["project_id"] == PROJECT_ID
    assert rows[0]["project_name"] == "Launch"
    assert rows[0]["new_value"] == "In flight"
    assert rows[0]["team_id"] == TEAM
    assert rows[0]["actor_name"] == "Olive Owner"
    assert [item.to for item in recorder.sent] == ["member@example.com"]
    assert recorder.sent[0].subject == "[Project] Launch"


def test_a_project_changed_into_a_followed_view_notifies(client: TestClient, workspace: str, repositories: Any) -> None:
    """Moving a backlog project to in progress brings it into an in progress view."""
    _follow(client, workspace, MEMBER, name="In flight", shared=True, filter={"status": ["in_progress"]})
    before = _project(workspace)
    repositories.planning.create_project(before)

    _write(repositories, _project(workspace, 1, status="in_progress", updated_by=OWNER), before)

    assert len(_view_rows(repositories, workspace, MEMBER)) == 1


def test_a_project_turning_at_risk_enters_a_health_and_priority_view(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The property filters judge the watch as the list does, and a health change is a watched field."""
    _follow(
        client,
        workspace,
        MEMBER,
        name="At risk",
        shared=True,
        filter={"health": "at_risk", "priority": "high", "target_date_before": "2027-01-01"},
    )
    before = _project(workspace, health="on_track", priority="high", target_date="2026-12-01")
    repositories.planning.create_project(before)
    low = _project(workspace, 1, health="at_risk", priority="low", target_date="2026-12-01", updated_by=OWNER)

    _write(repositories, low, before)
    assert _view_rows(repositories, workspace, MEMBER) == []
    assert view_fields_changed(before, before.model_copy(update={"health": "at_risk"}))

    risky = _project(workspace, 2, health="at_risk", priority="high", target_date="2026-12-01", updated_by=OWNER)
    _write(repositories, risky, low)
    assert len(_view_rows(repositories, workspace, MEMBER)) == 1


def test_a_project_already_in_the_view_stays_quiet(client: TestClient, workspace: str, repositories: Any) -> None:
    """A change to a project that matched before and after is no transition."""
    _follow(client, workspace, MEMBER, name="In flight", shared=True, filter={"status": ["in_progress"]})
    before = _project(workspace, status="in_progress")
    repositories.planning.create_project(before)

    _write(repositories, _project(workspace, 1, status="in_progress", lead_id=ADMIN, updated_by=OWNER), before)

    assert _view_rows(repositories, workspace, MEMBER) == []


def test_a_project_that_leaves_and_comes_back_notifies_again(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A project view keeps no notice, so each entry is news."""
    _follow(client, workspace, MEMBER, name="In flight", shared=True, filter={"status": ["in_progress"]})
    first = _project(workspace)
    repositories.planning.create_project(first)
    entered = _project(workspace, 1, status="in_progress", updated_by=OWNER)
    left = _project(workspace, 2, status="paused", updated_by=OWNER)
    back = _project(workspace, 3, status="in_progress", updated_by=OWNER)

    _write(repositories, entered, first)
    _write(repositories, left, entered)
    _write(repositories, back, left)

    assert len(_view_rows(repositories, workspace, MEMBER)) == 2


def test_the_person_who_moved_the_project_is_not_told(client: TestClient, workspace: str, repositories: Any) -> None:
    """The follower's own edit brings the project into their view without a notice."""
    _follow(client, workspace, MEMBER, name="In flight", shared=True, filter={"status": ["in_progress"]})
    before = _project(workspace)
    repositories.planning.create_project(before)

    _write(repositories, _project(workspace, 1, status="in_progress", updated_by=MEMBER), before)

    assert _view_rows(repositories, workspace, MEMBER) == []


def test_a_rollup_write_is_not_judged(client: TestClient, workspace: str, repositories: Any) -> None:
    """Only the properties a view reads are compared, so a counter change says nothing."""
    before = _project(workspace, status="in_progress")
    after = before.model_copy(update={"updated_at": START + timedelta(minutes=1), "rollup_rev": 3})

    assert not view_fields_changed(before, after)
    assert view_fields_changed(before, before.model_copy(update={"lead_id": ADMIN}))
    assert view_fields_changed(None, after)


def test_a_replayed_record_writes_one_row(client: TestClient, workspace: str, repositories: Any) -> None:
    """The id is a function of the record, so a redelivery is a no-op."""
    _follow(client, workspace, MEMBER, name="In flight", shared=True, filter={"status": ["in_progress"]})
    project = _project(workspace, status="in_progress")
    repositories.planning.create_project(project)

    handle_record(repositories, _record(project))
    handle_record(repositories, _record(project))

    assert len(_view_rows(repositories, workspace, MEMBER)) == 1


def test_a_project_outside_the_views_team_stays_quiet(client: TestClient, workspace: str, repositories: Any) -> None:
    """A view filtered to one team never holds another team's project."""
    _follow(client, workspace, MEMBER, name="ABC projects", shared=True, filter={"team_id": TEAM})

    _write(repositories, _project(workspace, team_ids=[OTHER_TEAM]))

    assert _view_rows(repositories, workspace, MEMBER) == []


def test_a_parent_teams_view_rolls_up_a_sub_teams_project(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The page rolls a team's sub-teams into its view, so a sub-team's project enters it."""
    _sub_team(repositories, workspace)
    _follow(client, workspace, MEMBER, name="ABC projects", shared=True, filter={"team_id": TEAM})

    _write(repositories, _project(workspace, team_ids=[SUB_TEAM]))

    assert len(_view_rows(repositories, workspace, MEMBER)) == 1


def test_turning_roll_up_off_keeps_sub_team_projects_out(client: TestClient, workspace: str, repositories: Any) -> None:
    """With `sub_teams` off the view holds its own team's projects alone."""
    _sub_team(repositories, workspace)
    _follow(client, workspace, MEMBER, name="ABC only", shared=True, filter={"team_id": TEAM, "sub_teams": "false"})

    _write(repositories, _project(workspace, team_ids=[SUB_TEAM]))

    assert _view_rows(repositories, workspace, MEMBER) == []


def test_an_archived_project_never_enters(client: TestClient, workspace: str, repositories: Any) -> None:
    """Archived projects are left out of every view, as the page leaves them out."""
    _follow(client, workspace, MEMBER, name="Everything", shared=True)
    before = _project(workspace)
    repositories.planning.create_project(before)

    _write(repositories, _project(workspace, 1, archived_at=START, updated_by=OWNER), before)

    assert _view_rows(repositories, workspace, MEMBER) == []


def test_a_follower_who_cannot_see_the_team_hears_nothing(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The guest belongs to `TEAM` alone, so a project on `OTHER_TEAM` does not reach it."""
    _follow(client, workspace, GUEST, name="Mine")

    _write(repositories, _project(workspace, team_ids=[OTHER_TEAM]))

    assert _view_rows(repositories, workspace, GUEST) == []


def test_turning_the_preference_off_silences_both_channels(
    client: TestClient, workspace: str, repositories: Any, recorder: RecordingEmailSender
) -> None:
    """A follower who switched the kind off holds no row and gets no mail."""
    _follow(client, workspace, MEMBER, name="In flight", shared=True, filter={"status": ["in_progress"]})
    repositories.users.update(
        MEMBER, notification_preferences={"view_project_added": {"in_app": False, "email": False}}
    )

    _write(repositories, _project(workspace, status="in_progress"))
    flush_digests(repositories)

    assert _view_rows(repositories, workspace, MEMBER) == []
    assert recorder.sent == []


def test_an_issue_view_ignores_project_writes(client: TestClient, workspace: str, repositories: Any) -> None:
    """Only a project view judges a project; an issue view's follower hears nothing."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Issues", shared=True)
    client.put(f"/api/workspaces/{workspace}/views/{view['view_id']}/subscription")

    _write(repositories, _project(workspace, status="in_progress"))

    assert _view_rows(repositories, workspace, MEMBER) == []


def test_the_email_links_to_the_project() -> None:
    """The mail names the project and opens its page."""
    message = render_view_project_added_notification(
        to="member@example.com", project_id=PROJECT_ID, project_name="Launch", workspace_slug="acme"
    )

    assert message.subject == "[Project] Launch"
    assert f"{settings.frontend_base_url}/w/acme/projects/launch-{PROJECT_ID}" in message.text
    assert "A project was added to a view you follow." in message.text


def test_the_inbox_summary_names_the_view(client: TestClient, workspace: str, repositories: Any) -> None:
    """The inbox line says which followed view the project entered."""
    _follow(client, workspace, MEMBER, name="In flight", shared=True, filter={"status": ["in_progress"]})
    _write(repositories, _project(workspace, status="in_progress"))

    row = repositories.inbox.list(workspace, MEMBER, limit=5).items[0]

    assert notification_summary(Notification.model_validate(dict(row))) == "New project in In flight"
