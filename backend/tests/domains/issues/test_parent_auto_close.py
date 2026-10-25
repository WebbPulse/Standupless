"""Closing a parent with its last sub-issue, and sub-issues with their parent, from the rollup consumer.

The properties worth holding are that nothing moves while a team leaves both
switches off, that a parent closes into the team's first completed status only
once every sub-issue is finished, that a finished parent closes its open
sub-issues into the same category, that each close is a system history row, and
that replaying the records the closes themselves produce moves nothing further.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import ParentAutoCloseSettings, parent_auto_close_settings_key
from app.domains.issues.consumers.rollup import handle_record
from app.domains.issues.parent_auto_close import first_status
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.issues.conftest import TEAM, WORKSPACE, create_issue


def _enable(repositories: Any, close_parent: bool = False, close_sub_issues: bool = False) -> None:
    """Save `TEAM`'s parent and sub-issue auto-close switches."""
    repositories.team_config.put_parent_auto_close_settings(
        ParentAutoCloseSettings(
            workspace_id=WORKSPACE,
            config_key=parent_auto_close_settings_key(TEAM),
            team_id=TEAM,
            close_parent=close_parent,
            close_sub_issues=close_sub_issues,
        )
    )


def _stored(repositories: Any, issue_id: str) -> Issue:
    """One issue as the table holds it now."""
    row = repositories.issues.get(WORKSPACE, issue_id)
    assert row is not None
    return row


def _image(issue: Issue, status_id: str) -> "dict[str, Any]":
    """One issue's stream image in DynamoDB's wire encoding, with the status it held."""
    image = {
        "workspace_id": {"S": issue.workspace_id},
        "team_id": {"S": issue.team_id},
        "issue_id": {"S": issue.issue_id},
        "status_id": {"S": status_id},
    }
    if issue.parent_id:
        image["parent_id"] = {"S": issue.parent_id}
    return image


def _record(issue: Issue, old_status: str, new_status: str) -> "dict[str, Any]":
    """A modify record moving one issue between two statuses, shaped the way Lambda delivers it."""
    return {
        "eventName": "MODIFY",
        "eventID": "1",
        "dynamodb": {"NewImage": _image(issue, new_status), "OldImage": _image(issue, old_status)},
    }


def _move(repositories: Any, issue_id: str, status_id: str) -> "dict[str, Any]":
    """Move one issue in the table and answer the stream record the move produces."""
    row = _stored(repositories, issue_id)
    repositories.issues.replace(row.model_copy(update={"status_id": status_id}))
    return _record(row, row.status_id, status_id)


def _status_rows(repositories: Any, issue_id: str) -> "list[dict[str, Any]]":
    """The status history rows of one issue."""
    return [
        row
        for row in repositories.activity.list_for_issue(WORKSPACE, issue_id).items
        if row["kind"] == "field_changed" and row.get("field") == "status_id"
    ]


def _family(client: TestClient, workspace: str, children: int = 2) -> "tuple[str, list[str]]":
    """One open parent with open sub-issues."""
    parent = create_issue(client, workspace, title="Parent")
    kids = [create_issue(client, workspace, title=f"Child {n}", parent_id=parent["id"]) for n in range(children)]
    return str(parent["id"]), [str(kid["id"]) for kid in kids]


def test_nothing_moves_while_both_switches_are_off(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A team that never turned the switches on keeps its parent and sub-issues where they are."""
    sign_in(client, MEMBER)
    parent, kids = _family(client, workspace, children=1)
    open_status = _stored(repositories, parent).status_id

    handle_record(repositories, _move(repositories, kids[0], statuses["completed"].status_id))

    assert _stored(repositories, parent).status_id == open_status

    other_parent, other_kids = _family(client, workspace, children=1)
    child_status = _stored(repositories, other_kids[0]).status_id
    handle_record(repositories, _move(repositories, other_parent, statuses["completed"].status_id))

    assert _stored(repositories, other_kids[0]).status_id == child_status


def test_the_parent_closes_with_its_last_open_sub_issue(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """The parent waits for every sub-issue, then moves to the team's first completed status."""
    sign_in(client, MEMBER)
    _enable(repositories, close_parent=True)
    parent, kids = _family(client, workspace)
    open_status = _stored(repositories, parent).status_id

    handle_record(repositories, _move(repositories, kids[0], statuses["completed"].status_id))
    assert _stored(repositories, parent).status_id == open_status

    handle_record(repositories, _move(repositories, kids[1], statuses["cancelled"].status_id))

    stored = _stored(repositories, parent)
    assert stored.status_id == first_status(repositories, WORKSPACE, TEAM, "completed")
    assert stored.completed_at is not None
    assert stored.updated_by == "system"
    rows = _status_rows(repositories, parent)
    assert len(rows) == 1
    assert (rows[0]["actor_kind"], rows[0]["actor_id"]) == ("system", "system")


def test_open_sub_issues_close_with_their_parent(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A cancelled parent cancels its open sub-issues and leaves a finished one alone."""
    sign_in(client, MEMBER)
    _enable(repositories, close_sub_issues=True)
    parent, kids = _family(client, workspace, children=3)
    done = statuses["completed"].status_id
    _move(repositories, kids[2], done)

    handle_record(repositories, _move(repositories, parent, statuses["cancelled"].status_id))

    cancelled = first_status(repositories, WORKSPACE, TEAM, "cancelled")
    assert [_stored(repositories, kid).status_id for kid in kids] == [cancelled, cancelled, done]
    assert _stored(repositories, kids[0]).cancelled_at is not None
    rows = _status_rows(repositories, kids[0])
    assert len(rows) == 1
    assert rows[0]["actor_kind"] == "system"
    assert _status_rows(repositories, kids[2]) == []


def test_a_completed_parent_completes_its_sub_issues(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """The sub-issues follow the parent's category, completed here."""
    sign_in(client, MEMBER)
    _enable(repositories, close_sub_issues=True)
    parent, kids = _family(client, workspace)

    handle_record(repositories, _move(repositories, parent, statuses["completed"].status_id))

    completed = first_status(repositories, WORKSPACE, TEAM, "completed")
    assert {_stored(repositories, kid).status_id for kid in kids} == {completed}


def test_a_move_between_finished_statuses_closes_nothing(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Only a move from open to finished counts, so reworking a closed parent leaves reopened sub-issues open."""
    sign_in(client, MEMBER)
    _enable(repositories, close_sub_issues=True)
    parent, kids = _family(client, workspace, children=1)
    _move(repositories, parent, statuses["completed"].status_id)
    open_status = _stored(repositories, kids[0]).status_id

    handle_record(repositories, _move(repositories, parent, statuses["cancelled"].status_id))

    assert _stored(repositories, kids[0]).status_id == open_status


def test_replaying_the_closes_moves_nothing_further(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """With both switches on, the records the closes produce, delivered twice, leave every issue where it is."""
    sign_in(client, MEMBER)
    _enable(repositories, close_parent=True, close_sub_issues=True)
    parent, kids = _family(client, workspace)
    open_status = _stored(repositories, kids[0]).status_id

    parent_record = _move(repositories, parent, statuses["completed"].status_id)
    handle_record(repositories, parent_record)

    completed = first_status(repositories, WORKSPACE, TEAM, "completed")
    child_records = [
        _record(_stored(repositories, kid).model_copy(update={"status_id": open_status}), open_status, completed)
        for kid in kids
    ]
    for record in [*child_records, parent_record, *child_records]:
        handle_record(repositories, record)

    assert _stored(repositories, parent).status_id == statuses["completed"].status_id
    assert {_stored(repositories, kid).status_id for kid in kids} == {completed}
    assert _status_rows(repositories, parent) == []
    assert [len(_status_rows(repositories, kid)) for kid in kids] == [1, 1]
