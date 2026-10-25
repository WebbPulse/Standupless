"""The notify consumer's role notices: a person made a project's lead, added to its members or made an initiative's owner.

These pin that each role is news once, to the person handed it and never to
whoever made the write, on a created row and on a changed one; that a removal,
an unchanged role and an archived project say nothing; that someone made lead
and member in one edit hears only that they lead it; that a redelivered record
writes one row; that a guest or a person turned off for the kind hears nothing;
and that the email, the digest and the inbox summary say what happened.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Iterator, Optional

import pytest
from boto3.dynamodb.types import TypeSerializer
from webbpulse.dynamodb import table_name
from webbpulse.identity.email import RecordingEmailSender

from app.common.core.config import settings
from app.common.db.dynamo.inbox import Notification
from app.common.db.dynamo.notify_digests import DigestEntry
from app.common.db.dynamo.planning import (
    Initiative,
    Project,
    as_initiative_item,
    as_project_item,
    initiative_key,
    project_key,
)
from app.common.email import reset_email_sender
from app.common.inbox_summary import notification_summary
from app.domains.views.consumers.digest import replyable
from app.domains.views.consumers.notify import handle_record
from app.domains.views.email import (
    render_digest,
    render_initiative_owner_notification,
    render_project_role_notification,
)
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER
from tests.domains.views.conftest import TEAM
from tests.domains.views.test_notify_consumer import flush_digests, inbox_of

PLANNING_ARN = (
    f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('planning', settings.dynamodb_table_prefix)}/stream/x"
)

PROJECT_ID = "01JB000000000000000000PRJR"

INITIATIVE_ID = "01JB000000000000000000INTR"

SERIALIZER = TypeSerializer()

START = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)

ROLE_KINDS = ("project_lead_assigned", "project_member_added", "initiative_owner_assigned")


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def _project(workspace: str, minutes: int = 0, **fields: Any) -> Project:
    """One project state on `TEAM`, created by `OWNER` with no lead or members unless told otherwise."""
    values: "dict[str, Any]" = {
        "team_ids": [TEAM],
        "name": "Launch",
        "created_by": OWNER,
        "created_at": START,
        "updated_at": START + timedelta(minutes=minutes),
    }
    values.update(fields)
    return Project(workspace_id=workspace, planning_key=project_key(PROJECT_ID), project_id=PROJECT_ID, **values)


def _initiative(workspace: str, minutes: int = 0, **fields: Any) -> Initiative:
    """One initiative state, created by `OWNER` with no owner unless told otherwise."""
    values: "dict[str, Any]" = {
        "name": "Expand to Europe",
        "status": "active",
        "created_by": OWNER,
        "created_at": START,
        "updated_at": START + timedelta(minutes=minutes),
    }
    values.update(fields)
    return Initiative(
        workspace_id=workspace, planning_key=initiative_key(INITIATIVE_ID), initiative_id=INITIATIVE_ID, **values
    )


def _image(item: "dict[str, Any]") -> "dict[str, Any]":
    """One stored item as a stream image in DynamoDB's wire encoding."""
    plain = json.loads(json.dumps(item), parse_float=Decimal)
    return {name: SERIALIZER.serialize(value) for name, value in plain.items()}


def _record(after: "dict[str, Any]", before: "Optional[dict[str, Any]]" = None) -> "dict[str, Any]":
    """One planning stream record for a write, a modify when `before` is given."""
    dynamodb: "dict[str, Any]" = {"NewImage": _image(after)}
    if before is not None:
        dynamodb["OldImage"] = _image(before)
    event = "MODIFY" if before is not None else "INSERT"
    return {"eventName": event, "eventID": "1", "eventSourceARN": PLANNING_ARN, "dynamodb": dynamodb}


def _project_record(after: Project, before: Optional[Project] = None) -> "dict[str, Any]":
    """The stream record a project write sends."""
    return _record(as_project_item(after), as_project_item(before) if before is not None else None)


def _initiative_record(after: Initiative, before: Optional[Initiative] = None) -> "dict[str, Any]":
    """The stream record an initiative write sends."""
    return _record(as_initiative_item(after), as_initiative_item(before) if before is not None else None)


def _roles(repositories: Any, workspace: str, user_id: str) -> "list[dict[str, Any]]":
    """Every role notice one member holds, newest first."""
    return [row for row in inbox_of(repositories, workspace, user_id) if row["kind"] in ROLE_KINDS]


def test_a_project_created_with_a_lead_and_members_tells_each_once(
    workspace: str, repositories: Any, recorder: RecordingEmailSender
) -> None:
    """The lead hears they lead it, a member hears they joined, and the creator hears nothing."""
    project = _project(workspace, lead_id=ADMIN, member_ids=[MEMBER, OWNER])
    repositories.planning.create_project(project)

    handle_record(repositories, _project_record(project))
    flush_digests(repositories)

    lead = _roles(repositories, workspace, ADMIN)
    member = _roles(repositories, workspace, MEMBER)
    assert [row["kind"] for row in lead] == ["project_lead_assigned"]
    assert [row["kind"] for row in member] == ["project_member_added"]
    assert lead[0]["project_id"] == PROJECT_ID
    assert lead[0]["project_name"] == "Launch"
    assert lead[0]["team_id"] == TEAM
    assert lead[0]["actor_name"] == "Olive Owner"
    assert _roles(repositories, workspace, OWNER) == []
    assert sorted(item.to for item in recorder.sent) == ["admin@example.com", "member@example.com"]
    assert all(item.subject == "[Project] Launch" for item in recorder.sent)


def test_a_lead_changed_on_an_existing_project_tells_the_new_lead(workspace: str, repositories: Any) -> None:
    """A modify that hands the project to someone new is news to them alone."""
    before = _project(workspace, lead_id=ADMIN)
    after = _project(workspace, 1, lead_id=MEMBER, updated_by=OWNER)
    repositories.planning.create_project(after)

    handle_record(repositories, _project_record(after, before))

    assert [row["kind"] for row in _roles(repositories, workspace, MEMBER)] == ["project_lead_assigned"]
    assert _roles(repositories, workspace, ADMIN) == []


def test_only_newly_added_members_hear(workspace: str, repositories: Any) -> None:
    """A member already on the project says nothing when another joins."""
    before = _project(workspace, member_ids=[ADMIN])
    after = _project(workspace, 1, member_ids=[ADMIN, MEMBER], updated_by=OWNER)
    repositories.planning.create_project(after)

    handle_record(repositories, _project_record(after, before))

    assert [row["kind"] for row in _roles(repositories, workspace, MEMBER)] == ["project_member_added"]
    assert _roles(repositories, workspace, ADMIN) == []


def test_a_member_removed_or_a_lead_cleared_sends_nothing(workspace: str, repositories: Any) -> None:
    """Losing a role is not announced."""
    before = _project(workspace, lead_id=ADMIN, member_ids=[MEMBER])
    after = _project(workspace, 1, updated_by=OWNER)
    repositories.planning.create_project(after)

    handle_record(repositories, _project_record(after, before))

    assert _roles(repositories, workspace, ADMIN) == []
    assert _roles(repositories, workspace, MEMBER) == []


def test_making_yourself_lead_or_member_is_silent(workspace: str, repositories: Any) -> None:
    """The person whose write handed them the role is never told about it."""
    before = _project(workspace)
    after = _project(workspace, 1, lead_id=MEMBER, member_ids=[MEMBER], updated_by=MEMBER)
    repositories.planning.create_project(after)

    handle_record(repositories, _project_record(after, before))

    assert _roles(repositories, workspace, MEMBER) == []


def test_lead_and_member_in_one_edit_is_one_notice(workspace: str, repositories: Any) -> None:
    """Someone made lead and member at once hears only that they lead it."""
    before = _project(workspace)
    after = _project(workspace, 1, lead_id=MEMBER, member_ids=[MEMBER], updated_by=OWNER)
    repositories.planning.create_project(after)

    handle_record(repositories, _project_record(after, before))

    assert [row["kind"] for row in _roles(repositories, workspace, MEMBER)] == ["project_lead_assigned"]


def test_an_archived_project_hands_out_no_roles(workspace: str, repositories: Any) -> None:
    """A role on a project nobody works on is not worth a notice."""
    before = _project(workspace)
    after = _project(workspace, 1, lead_id=MEMBER, archived_at=START, updated_by=OWNER)
    repositories.planning.create_project(after)

    handle_record(repositories, _project_record(after, before))

    assert _roles(repositories, workspace, MEMBER) == []


def test_a_retried_project_record_writes_one_row(workspace: str, repositories: Any) -> None:
    """The id is keyed on the write's time, so a redelivery is a no-op."""
    project = _project(workspace, lead_id=MEMBER)
    repositories.planning.create_project(project)

    handle_record(repositories, _project_record(project))
    handle_record(repositories, _project_record(project))

    assert len(_roles(repositories, workspace, MEMBER)) == 1


def test_a_lead_handed_back_later_is_news_again(workspace: str, repositories: Any) -> None:
    """A later write is a different moment, so losing and regaining the role notifies again."""
    first = _project(workspace, lead_id=MEMBER)
    cleared = _project(workspace, 1, updated_by=OWNER)
    back = _project(workspace, 2, lead_id=MEMBER, updated_by=OWNER)
    repositories.planning.create_project(back)

    handle_record(repositories, _project_record(first))
    handle_record(repositories, _project_record(cleared, first))
    handle_record(repositories, _project_record(back, cleared))

    assert len(_roles(repositories, workspace, MEMBER)) == 2


def test_turning_the_kind_off_silences_it(workspace: str, repositories: Any, recorder: RecordingEmailSender) -> None:
    """A person who switched member notices off holds no row and gets no mail."""
    repositories.users.update(
        MEMBER, notification_preferences={"project_member_added": {"in_app": False, "email": False}}
    )
    project = _project(workspace, member_ids=[MEMBER])
    repositories.planning.create_project(project)

    handle_record(repositories, _project_record(project))
    flush_digests(repositories)

    assert _roles(repositories, workspace, MEMBER) == []
    assert recorder.sent == []


def test_an_initiative_created_with_an_owner_tells_the_owner(
    workspace: str, repositories: Any, recorder: RecordingEmailSender
) -> None:
    """The owner hears it as a workspace level row with no team, and gets the mail."""
    initiative = _initiative(workspace, owner_id=MEMBER)
    repositories.planning.create_initiative(initiative)

    handle_record(repositories, _initiative_record(initiative))
    flush_digests(repositories)

    rows = _roles(repositories, workspace, MEMBER)
    assert [row["kind"] for row in rows] == ["initiative_owner_assigned"]
    assert rows[0]["initiative_id"] == INITIATIVE_ID
    assert rows[0]["initiative_name"] == "Expand to Europe"
    assert rows[0]["team_id"] == ""
    assert rows[0]["actor_name"] == "Olive Owner"
    assert [item.to for item in recorder.sent] == ["member@example.com"]
    assert recorder.sent[0].subject == "[Initiative] Expand to Europe"


def test_an_initiative_owner_changed_tells_the_new_owner(workspace: str, repositories: Any) -> None:
    """A modify that hands the initiative on is news to the new owner alone."""
    before = _initiative(workspace, owner_id=ADMIN)
    after = _initiative(workspace, 1, owner_id=MEMBER, updated_by=OWNER)
    repositories.planning.create_initiative(after)

    handle_record(repositories, _initiative_record(after, before))

    assert [row["kind"] for row in _roles(repositories, workspace, MEMBER)] == ["initiative_owner_assigned"]
    assert _roles(repositories, workspace, ADMIN) == []


def test_an_unchanged_or_cleared_initiative_owner_sends_nothing(workspace: str, repositories: Any) -> None:
    """A rename keeps the owner, and clearing the owner is not announced."""
    before = _initiative(workspace, owner_id=MEMBER)
    renamed = _initiative(workspace, 1, owner_id=MEMBER, name="Expand", updated_by=OWNER)
    cleared = _initiative(workspace, 2, updated_by=OWNER)
    repositories.planning.create_initiative(cleared)

    handle_record(repositories, _initiative_record(renamed, before))
    handle_record(repositories, _initiative_record(cleared, renamed))

    assert _roles(repositories, workspace, MEMBER) == []


def test_owning_your_own_initiative_is_silent(workspace: str, repositories: Any) -> None:
    """Taking an initiative yourself is not news to you."""
    before = _initiative(workspace)
    after = _initiative(workspace, 1, owner_id=MEMBER, updated_by=MEMBER)
    repositories.planning.create_initiative(after)

    handle_record(repositories, _initiative_record(after, before))

    assert _roles(repositories, workspace, MEMBER) == []


def test_a_guest_owner_hears_nothing(workspace: str, repositories: Any) -> None:
    """A guest cannot read workspace level initiatives, so it gets no notice of one."""
    initiative = _initiative(workspace, owner_id=GUEST)
    repositories.planning.create_initiative(initiative)

    handle_record(repositories, _initiative_record(initiative))

    assert _roles(repositories, workspace, GUEST) == []


def test_a_retried_initiative_record_writes_one_row(workspace: str, repositories: Any) -> None:
    """A redelivered initiative record stays one row."""
    initiative = _initiative(workspace, owner_id=MEMBER)
    repositories.planning.create_initiative(initiative)

    handle_record(repositories, _initiative_record(initiative))
    handle_record(repositories, _initiative_record(initiative))

    assert len(_roles(repositories, workspace, MEMBER)) == 1


def test_the_project_role_emails_name_the_actor_and_open_the_project() -> None:
    """Each project role mail says who did it and links the project overview."""
    lead = render_project_role_notification(
        kind="project_lead_assigned",
        to="member@example.com",
        actor_name="Olive Owner",
        project_id=PROJECT_ID,
        project_name="Launch",
        workspace_slug="acme",
    )
    member = render_project_role_notification(
        kind="project_member_added",
        to="member@example.com",
        actor_name="Olive Owner",
        project_id=PROJECT_ID,
        project_name="Launch",
        workspace_slug="acme",
    )

    assert lead.subject == "[Project] Launch"
    assert "Olive Owner made you the lead of this project." in lead.text
    assert "Olive Owner added you to this project." in member.text
    assert f"{settings.frontend_base_url}/w/acme/projects/launch-{PROJECT_ID}" in lead.text
    assert "?tab=updates" not in lead.text


def test_the_initiative_owner_email_opens_the_initiative() -> None:
    """The owner mail says who handed it over and links the initiative overview."""
    message = render_initiative_owner_notification(
        to="member@example.com",
        actor_name="Olive Owner",
        initiative_id=INITIATIVE_ID,
        initiative_name="Expand to Europe",
        workspace_slug="acme",
    )

    assert message.subject == "[Initiative] Expand to Europe"
    assert "Olive Owner made you the owner of this initiative." in message.text
    assert INITIATIVE_ID in message.text
    assert "?tab=updates" not in message.text


def test_the_digest_groups_role_notices_under_their_subjects() -> None:
    """A digest lists a project role under the project and an owner notice under the initiative."""
    entries = [
        DigestEntry(
            workspace_id="W1",
            recipient_id=MEMBER,
            notification_id="N1",
            kind="project_lead_assigned",
            team_id=TEAM,
            project_id=PROJECT_ID,
            project_name="Launch",
            actor_name="Olive Owner",
            created_at=START,
        ),
        DigestEntry(
            workspace_id="W1",
            recipient_id=MEMBER,
            notification_id="N2",
            kind="initiative_owner_assigned",
            team_id="",
            initiative_id=INITIATIVE_ID,
            initiative_name="Expand to Europe",
            actor_name="Olive Owner",
            created_at=START + timedelta(seconds=1),
        ),
    ]

    message = render_digest(entries, to="member@example.com", workspace_slug="acme")

    assert message.subject.startswith("2 new notifications")
    assert "Project: Launch" in message.text
    assert "Olive Owner made you the lead of this project." in message.text
    assert "Initiative: Expand to Europe" in message.text
    assert "Olive Owner made you the owner of this initiative." in message.text
    assert not any(replyable(entry) for entry in entries)


def test_the_inbox_summary_says_who_handed_the_role(workspace: str, repositories: Any) -> None:
    """The inbox line names the actor and the role."""
    project = _project(workspace, lead_id=MEMBER)
    repositories.planning.create_project(project)
    handle_record(repositories, _project_record(project))

    row = _roles(repositories, workspace, MEMBER)[0]

    assert notification_summary(Notification.model_validate(row)) == "Olive Owner made you lead"
