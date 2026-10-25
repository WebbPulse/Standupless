"""The notify consumer's triage duty notice: an issue entering a team's inbox.

These pin that each member on duty of a team that notifies hears of an issue
created into triage or sent back to it, that the person who put it there does
not, and that a team that assigns its duty, or an issue already waiting, sends
no notice.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from webbpulse.dynamodb import table_name

from app.common.core.config import settings
from app.common.db.dynamo.team_config import default_triage_settings
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import TEAM, seed_issue

ISSUES_ARN = f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('issues', settings.dynamodb_table_prefix)}/stream/x"

STAMP = "2026-10-24T12:00:00+00:00"


def _duty(repositories: Any, workspace: str, action: str = "notify") -> None:
    """Turn triage on for `TEAM` with the admin and the member on duty."""
    repositories.team_config.put_triage_settings(
        default_triage_settings(workspace, TEAM).model_copy(
            update={"enabled": True, "responsible_user_ids": [ADMIN, MEMBER], "responsibility_action": action}
        )
    )


def _image(workspace: str, issue_id: str, in_triage: bool, **attributes: str) -> "dict[str, Any]":
    """One issue stream image in DynamoDB's wire encoding, `in_triage` present only while true."""
    encoded: "dict[str, Any]" = {
        "workspace_id": {"S": workspace},
        "issue_id": {"S": issue_id},
        "updated_at": {"S": STAMP},
    }
    encoded.update({name: {"S": value} for name, value in attributes.items()})
    if in_triage:
        encoded["in_triage"] = {"BOOL": True}
    return encoded


def _record(event_name: str, new: "dict[str, Any]", old: "dict[str, Any] | None" = None) -> "dict[str, Any]":
    """One issues stream record shaped the way Lambda delivers it."""
    dynamodb: "dict[str, Any]" = {"NewImage": new}
    if old is not None:
        dynamodb["OldImage"] = old
    return {"eventName": event_name, "eventID": "1", "eventSourceARN": ISSUES_ARN, "dynamodb": dynamodb}


def _kinds(repositories: Any, workspace: str, user_id: str) -> list[str]:
    """The kinds of every notification one member holds."""
    return [str(item["kind"]) for item in repositories.inbox.list(workspace, user_id, limit=50).items]


def test_an_issue_filed_into_triage_tells_everyone_on_duty_but_the_filer(
    issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """Both members on duty hear of it, and the admin who filed it does not."""
    _duty(repositories, workspace)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace)

    handle_record(
        repositories, _record("INSERT", _image(workspace, issue["id"], True, created_by=ADMIN, status_id="triage"))
    )

    assert _kinds(repositories, workspace, MEMBER) == ["triage_new"]
    assert _kinds(repositories, workspace, ADMIN) == []
    row = repositories.inbox.list(workspace, MEMBER, limit=1).items[0]
    assert row["issue_key"] == issue["key"]


def test_an_issue_sent_back_to_triage_tells_duty_again(
    issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """Moving an issue back into the inbox is an entry like filing it there."""
    _duty(repositories, workspace)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace)

    handle_record(
        repositories,
        _record(
            "MODIFY",
            _image(workspace, issue["id"], True, updated_by=OWNER, status_id="S"),
            _image(workspace, issue["id"], False, status_id="S"),
        ),
    )

    assert _kinds(repositories, workspace, ADMIN) == ["triage_new"]
    assert _kinds(repositories, workspace, MEMBER) == ["triage_new"]


def test_an_issue_already_waiting_sends_no_notice(issues_client: TestClient, workspace: str, repositories: Any) -> None:
    """An edit to an issue that was in triage before and after is no entry."""
    _duty(repositories, workspace)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace)

    handle_record(
        repositories,
        _record(
            "MODIFY",
            _image(workspace, issue["id"], True, updated_by=OWNER, title="Renamed"),
            _image(workspace, issue["id"], True, title="An issue"),
        ),
    )

    assert _kinds(repositories, workspace, MEMBER) == []


def test_a_team_that_assigns_its_duty_sends_no_triage_notice(
    issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """With the assign action the assignment notice is the only news."""
    _duty(repositories, workspace, action="assign")
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace)

    handle_record(
        repositories,
        _record("INSERT", _image(workspace, issue["id"], True, created_by=OWNER, assignee_id=ADMIN)),
    )

    assert _kinds(repositories, workspace, ADMIN) == ["assigned"]
    assert _kinds(repositories, workspace, MEMBER) == []


def test_a_replayed_record_writes_one_notice(issues_client: TestClient, workspace: str, repositories: Any) -> None:
    """The notice id comes from the record, so a redelivery is a no-op."""
    _duty(repositories, workspace)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace)
    record = _record("INSERT", _image(workspace, issue["id"], True, created_by=OWNER))

    handle_record(repositories, record)
    handle_record(repositories, record)

    assert _kinds(repositories, workspace, MEMBER) == ["triage_new"]
