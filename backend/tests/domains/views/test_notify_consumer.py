"""The notify consumer: issue and comment stream records become inbox rows.

Two properties carry the design. Records from two tables arrive on one route and
are told apart by the source ARN rather than by guessing from the attributes
present, and the notification id is derived from the record, so a redelivered
record writes the same key and the conditional put makes the replay a no-op rather
than a second badge.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from webbpulse.dynamodb import table_name
from webbpulse.http import REQUEST_CONTEXT_HEADER

from app.common.core.config import settings
from app.common.db.dynamo.comments import Comment, ws_issue as comment_partition
from app.domains.views.consumers.notify import (
    build_router,
    handle_record,
    notification_id,
)
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_PROJECT, PROJECT, seed_issue

ISSUES_ARN = f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('issues', settings.dynamodb_table_prefix)}/stream/x"

COMMENTS_ARN = (
    f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('comments', settings.dynamodb_table_prefix)}/stream/x"
)


def _image(**attributes: Any) -> "dict[str, Any]":
    """One stream image in DynamoDB's wire encoding.

    Only the types these records actually carry are encoded: strings, and the list
    of strings a comment's mentions are.
    """
    encoded: "dict[str, Any]" = {}
    for name, value in attributes.items():
        if value is None:
            continue
        if isinstance(value, list):
            encoded[name] = {"L": [{"S": item} for item in value]}
        else:
            encoded[name] = {"S": str(value)}
    return encoded


def _record(
    arn: str,
    event_name: str,
    new: "dict[str, Any] | None" = None,
    old: "dict[str, Any] | None" = None,
    event_id: str = "1",
) -> "dict[str, Any]":
    """One stream record shaped the way Lambda delivers it."""
    dynamodb: "dict[str, Any]" = {}
    if new is not None:
        dynamodb["NewImage"] = new
    if old is not None:
        dynamodb["OldImage"] = old
    return {
        "eventName": event_name,
        "eventID": event_id,
        "eventSourceARN": arn,
        "dynamodb": dynamodb,
    }


def put_comment(repositories: Any, workspace: str, issue_id: str, comment_id: str, **fields: Any) -> Comment:
    """Write one comment row directly, since `views` only ever reads that table."""
    comment = Comment(
        ws_issue=comment_partition(workspace, issue_id),
        comment_id=comment_id,
        workspace_id=workspace,
        issue_id=issue_id,
        project_id=fields.pop("project_id", PROJECT),
        **fields,
    )
    repositories.comments._repository.put(comment.model_dump(mode="json", exclude_none=True))
    return comment


def inbox_of(repositories: Any, workspace: str, user_id: str) -> list[Any]:
    """Every notification one member holds, newest first."""
    page = repositories.inbox.list(workspace, user_id, limit=50)
    return [dict(item) for item in page.items]


def test_a_notification_id_is_a_function_of_the_record() -> None:
    """The same record computes the same id, which is what makes a replay a no-op."""
    from datetime import datetime, timezone

    moment = datetime(2026, 9, 1, tzinfo=timezone.utc)

    first = notification_id(moment, "assigned", MEMBER, "issue#1")
    second = notification_id(moment, "assigned", MEMBER, "issue#1")

    assert first == second


def test_different_recipients_get_different_ids() -> None:
    """Two members notified about one event hold two separate rows."""
    from datetime import datetime, timezone

    moment = datetime(2026, 9, 1, tzinfo=timezone.utc)

    assert notification_id(moment, "assigned", MEMBER, "i#1") != notification_id(moment, "assigned", OWNER, "i#1")


def test_an_assignment_notifies_the_new_assignee(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The ordinary case: being given an issue is news."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Do the thing", assignee_id=MEMBER)

    record = _record(
        ISSUES_ARN,
        "MODIFY",
        new=_image(workspace_id=workspace, issue_id=issue["id"], assignee_id=MEMBER, updated_by=OWNER, status_id="S"),
        old=_image(workspace_id=workspace, issue_id=issue["id"], status_id="S"),
    )
    handle_record(repositories, record)

    rows = inbox_of(repositories, workspace, MEMBER)
    assert [row["kind"] for row in rows] == ["assigned"]
    assert rows[0]["issue_key"] == issue["key"]
    assert rows[0]["actor_name"] == "Olive Owner"


def test_assigning_yourself_notifies_nobody(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A member does not need telling about what they just did."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Mine", assignee_id=OWNER)

    handle_record(
        repositories,
        _record(
            ISSUES_ARN,
            "MODIFY",
            new=_image(workspace_id=workspace, issue_id=issue["id"], assignee_id=OWNER, updated_by=OWNER),
            old=_image(workspace_id=workspace, issue_id=issue["id"]),
        ),
    )

    assert inbox_of(repositories, workspace, OWNER) == []


def test_an_unchanged_assignee_notifies_nobody(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Editing a title is not an assignment, so nothing is written."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Titled", assignee_id=MEMBER)

    handle_record(
        repositories,
        _record(
            ISSUES_ARN,
            "MODIFY",
            new=_image(workspace_id=workspace, issue_id=issue["id"], assignee_id=MEMBER, title="New", updated_by=OWNER),
            old=_image(workspace_id=workspace, issue_id=issue["id"], assignee_id=MEMBER, title="Old"),
        ),
    )

    assert inbox_of(repositories, workspace, MEMBER) == []


def test_a_status_change_notifies_the_assignee(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Someone else moving your issue is news."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Moved", assignee_id=MEMBER)

    handle_record(
        repositories,
        _record(
            ISSUES_ARN,
            "MODIFY",
            new=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                assignee_id=MEMBER,
                status_id="S2",
                updated_by=OWNER,
            ),
            old=_image(workspace_id=workspace, issue_id=issue["id"], assignee_id=MEMBER, status_id="S1"),
        ),
    )

    assert [row["kind"] for row in inbox_of(repositories, workspace, MEMBER)] == ["status_changed"]


def test_a_replayed_record_writes_one_row(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The idempotence the partial batch retry rests on."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Once", assignee_id=MEMBER)

    record = _record(
        ISSUES_ARN,
        "MODIFY",
        new=_image(workspace_id=workspace, issue_id=issue["id"], assignee_id=MEMBER, updated_by=OWNER),
        old=_image(workspace_id=workspace, issue_id=issue["id"]),
    )
    handle_record(repositories, record)
    handle_record(repositories, record)

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1


def test_a_member_who_cannot_see_the_project_is_not_notified(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Visibility is checked at write time, so losing a project stops the flow.

    The guest is assigned while they are still in the project, which is the only way
    M2 allows it, and their project membership is then removed. The record is
    handled afterwards, which is exactly the race the check exists for: a stream
    record is always about a row as it was, and the recipient may since have lost
    the access the notification would have revealed.
    """
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Hidden", project_id=PROJECT, assignee_id=GUEST)

    repositories.memberships.delete_project_membership(workspace, PROJECT, GUEST)

    handle_record(
        repositories,
        _record(
            ISSUES_ARN,
            "MODIFY",
            new=_image(workspace_id=workspace, issue_id=issue["id"], assignee_id=GUEST, updated_by=OWNER),
            old=_image(workspace_id=workspace, issue_id=issue["id"]),
        ),
    )

    assert inbox_of(repositories, workspace, GUEST) == []


def test_a_notification_for_an_issue_in_an_unreadable_project_is_dropped(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A guest is never told about an issue in a project they were never in."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Elsewhere", project_id=OTHER_PROJECT, assignee_id=OWNER)

    handle_record(
        repositories,
        _record(
            COMMENTS_ARN,
            "INSERT",
            new=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                comment_id="01C000000000000000000009",
                author_id=OWNER,
                mentions=[GUEST],
            ),
        ),
    )

    assert inbox_of(repositories, workspace, GUEST) == []


def test_a_guest_in_the_project_is_notified(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The other half of the same rule: membership is what lets a row through."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Visible", project_id=PROJECT, assignee_id=GUEST)

    handle_record(
        repositories,
        _record(
            ISSUES_ARN,
            "MODIFY",
            new=_image(workspace_id=workspace, issue_id=issue["id"], assignee_id=GUEST, updated_by=OWNER),
            old=_image(workspace_id=workspace, issue_id=issue["id"]),
        ),
    )

    assert [row["kind"] for row in inbox_of(repositories, workspace, GUEST)] == ["assigned"]


def test_a_comment_notifies_the_assignee(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A comment on your issue is news even when you are not mentioned."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Discussed", assignee_id=MEMBER)

    handle_record(
        repositories,
        _record(
            COMMENTS_ARN,
            "INSERT",
            new=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                comment_id="01C000000000000000000001",
                author_id=OWNER,
                body="Any thoughts?",
            ),
        ),
    )

    assert [row["kind"] for row in inbox_of(repositories, workspace, MEMBER)] == ["commented"]


def test_a_mention_beats_a_comment_notification(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A member who would earn both gets the stronger signal, once."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Discussed", assignee_id=MEMBER)

    handle_record(
        repositories,
        _record(
            COMMENTS_ARN,
            "INSERT",
            new=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                comment_id="01C000000000000000000001",
                author_id=OWNER,
                mentions=[MEMBER],
            ),
        ),
    )

    assert [row["kind"] for row in inbox_of(repositories, workspace, MEMBER)] == ["mentioned"]


def test_a_reply_notifies_the_parent_author(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The thread is walked upwards, so whoever is being replied to hears about it."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Threaded")

    put_comment(repositories, workspace, issue["id"], "01C000000000000000000001", author_id=ADMIN, body="First")

    handle_record(
        repositories,
        _record(
            COMMENTS_ARN,
            "INSERT",
            new=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                comment_id="01C000000000000000000002",
                parent_comment_id="01C000000000000000000001",
                author_id=OWNER,
                body="A reply",
            ),
        ),
    )

    assert [row["kind"] for row in inbox_of(repositories, workspace, ADMIN)] == ["commented"]


def test_a_comment_edit_notifies_nobody(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Only a new comment is news; editing one is not worth a second badge."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Discussed", assignee_id=MEMBER)

    handle_record(
        repositories,
        _record(
            COMMENTS_ARN,
            "MODIFY",
            new=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                comment_id="01C000000000000000000001",
                author_id=OWNER,
                body="Edited",
            ),
            old=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                comment_id="01C000000000000000000001",
                author_id=OWNER,
                body="Original",
            ),
        ),
    )

    assert inbox_of(repositories, workspace, MEMBER) == []


def test_a_record_from_an_unexpected_table_is_ignored(repositories: Any, workspace: str) -> None:
    """A mapping pointed at a third stream is a deployment mistake, not a retry.

    Failing every such record would retry it until the stream aged out, so it is
    logged and dropped instead.
    """
    handle_record(
        repositories,
        _record(
            "arn:aws:dynamodb:us-west-2:1234:table/standupless-development-projects/stream/x",
            "INSERT",
            new=_image(workspace_id=workspace, issue_id="01JBX"),
        ),
    )


def test_the_events_route_answers_a_stream_batch(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The mounted route takes a batch and answers the failures envelope."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Batched", assignee_id=MEMBER)

    app = FastAPI()
    app.include_router(build_router(repositories))
    with TestClient(app) as consumer:
        response = consumer.post(
            "/events",
            json={
                "Records": [
                    _record(
                        ISSUES_ARN,
                        "MODIFY",
                        new=_image(
                            workspace_id=workspace,
                            issue_id=issue["id"],
                            assignee_id=MEMBER,
                            updated_by=OWNER,
                        ),
                        old=_image(workspace_id=workspace, issue_id=issue["id"]),
                    )
                ]
            },
        )

    assert response.status_code == 200
    assert response.json() == {"batchItemFailures": []}
    assert len(inbox_of(repositories, workspace, MEMBER)) == 1


def test_the_events_route_refuses_a_gateway_request(repositories: Any) -> None:
    """A stream route reached through the API is a 404, not an invocation.

    Letting a signed in caller post records would be a way to write notifications
    the request path does not own.
    """
    app = FastAPI()
    app.include_router(build_router(repositories))
    with TestClient(app) as consumer:
        response = consumer.post(
            "/events",
            json={"Records": []},
            headers={REQUEST_CONTEXT_HEADER: '{"http": {"method": "POST", "path": "/events"}}'},
        )

    assert response.status_code == 404


def test_a_failing_record_comes_back_as_a_batch_item_failure(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One bad record is reported alone, so the rest of the batch is not replayed."""
    import app.domains.views.consumers.notify as notify

    def explode(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("dynamo is unhappy")

    monkeypatch.setattr(notify, "handle_issue_record", explode)

    app = FastAPI()
    app.include_router(notify.build_router(repositories))
    with TestClient(app, raise_server_exceptions=False) as consumer:
        response = consumer.post(
            "/events",
            json={
                "Records": [
                    _record(
                        ISSUES_ARN,
                        "MODIFY",
                        new=_image(workspace_id=workspace, issue_id="01JBX", assignee_id=MEMBER),
                        event_id="bad-1",
                    )
                ]
            },
        )

    assert response.status_code == 200
    assert response.json() == {"batchItemFailures": [{"itemIdentifier": "bad-1"}]}
