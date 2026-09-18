"""The stream consumer that keeps `progress` matching an issue's children.

The property worth holding is idempotence: the consumer recounts rather than
increments, so a record delivered twice leaves the same numbers as one delivered
once, which is what makes a retried batch safe.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from webbpulse.http import REQUEST_CONTEXT_HEADER

from app.domains.issues.consumers.rollup import (
    build_router,
    handle_record,
    parents_to_recount,
    workspace_of,
)
from tests.domains.helpers import OWNER, sign_in
from tests.domains.issues.conftest import create_issue


def _string_image(**attributes: str) -> "dict[str, Any]":
    """One stream image in DynamoDB's wire encoding, strings throughout."""
    return {name: {"S": value} for name, value in attributes.items()}


def _record(
    event_name: str, new: "dict[str, Any] | None" = None, old: "dict[str, Any] | None" = None
) -> "dict[str, Any]":
    """One stream record shaped the way Lambda delivers it."""
    dynamodb: "dict[str, Any]" = {}
    if new is not None:
        dynamodb["NewImage"] = new
    if old is not None:
        dynamodb["OldImage"] = old
    return {"eventName": event_name, "eventID": "1", "dynamodb": dynamodb}


def test_an_insert_stales_the_parent_it_hangs_off() -> None:
    """A new child makes its parent's count wrong."""
    record = _record("INSERT", new=_string_image(workspace_id="W", parent_id="P", status_id="S"))

    assert parents_to_recount(record) == {"P"}


def test_a_move_stales_both_parents() -> None:
    """Reparenting leaves the old parent overcounted and the new one under."""
    record = _record(
        "MODIFY",
        new=_string_image(workspace_id="W", parent_id="P2", status_id="S"),
        old=_string_image(workspace_id="W", parent_id="P1", status_id="S"),
    )

    assert parents_to_recount(record) == {"P1", "P2"}


def test_a_status_change_stales_the_one_parent() -> None:
    """Finishing a child changes only its own parent's completed count."""
    record = _record(
        "MODIFY",
        new=_string_image(workspace_id="W", parent_id="P", status_id="S2"),
        old=_string_image(workspace_id="W", parent_id="P", status_id="S1"),
    )

    assert parents_to_recount(record) == {"P"}


def test_a_remove_stales_the_parent_from_the_old_image() -> None:
    """A deleted child has no new image, and its parent is still wrong."""
    record = _record("REMOVE", old=_string_image(workspace_id="W", parent_id="P", status_id="S"))

    assert parents_to_recount(record) == {"P"}
    assert workspace_of(record) == "W"


@pytest.mark.parametrize(
    "record",
    [
        _record(
            "MODIFY", new=_string_image(workspace_id="W", title="b"), old=_string_image(workspace_id="W", title="a")
        ),
        _record(
            "MODIFY",
            new=_string_image(workspace_id="W", parent_id="P", status_id="S", title="b"),
            old=_string_image(workspace_id="W", parent_id="P", status_id="S", title="a"),
        ),
        _record("INSERT", new=_string_image(workspace_id="W", status_id="S")),
    ],
    ids=["no parent", "unrelated field", "top level insert"],
)
def test_an_irrelevant_record_stales_nothing(record: "dict[str, Any]") -> None:
    """Most records change nothing a parent counts, and cost no read."""
    assert parents_to_recount(record) == set()


def test_the_consumer_recounts_a_parent_from_its_children(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Counts come from the index, not from the record that woke the consumer."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    create_issue(client, workspace, title="Open child", parent_id=parent["id"])
    create_issue(
        client,
        workspace,
        title="Done child",
        parent_id=parent["id"],
        status_id=statuses["completed"].status_id,
    )

    record = _record("INSERT", new=_string_image(workspace_id=workspace, parent_id=parent["id"], status_id="S"))
    handle_record(repositories, record)

    stored = repositories.issues.get(workspace, parent["id"])
    assert (stored.progress.total, stored.progress.completed) == (2, 1)


def test_the_same_record_twice_leaves_the_same_counts(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The idempotence the retry story rests on."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    create_issue(client, workspace, title="Child", parent_id=parent["id"])

    record = _record("INSERT", new=_string_image(workspace_id=workspace, parent_id=parent["id"], status_id="S"))
    handle_record(repositories, record)
    first = repositories.issues.get(workspace, parent["id"]).progress

    handle_record(repositories, record)
    second = repositories.issues.get(workspace, parent["id"]).progress

    assert (second.total, second.completed) == (first.total, first.completed) == (1, 0)


def test_a_record_for_a_parent_that_is_gone_writes_nothing(workspace: str, repositories: Any) -> None:
    """A late record about a deleted parent is dropped rather than raising."""
    record = _record(
        "REMOVE", old=_string_image(workspace_id=workspace, parent_id="01JBGONE0000000000000000", status_id="S")
    )

    handle_record(repositories, record)


def test_the_events_route_answers_a_stream_batch(
    workspace: str, repositories: Any, client: TestClient, statuses: Any
) -> None:
    """The mounted route takes a batch and answers the failures envelope."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    create_issue(client, workspace, title="Child", parent_id=parent["id"])

    app = FastAPI()
    app.include_router(build_router(repositories))
    with TestClient(app) as consumer:
        response = consumer.post(
            "/events",
            json={
                "Records": [
                    _record(
                        "INSERT",
                        new=_string_image(workspace_id=workspace, parent_id=parent["id"], status_id="S"),
                    )
                ]
            },
        )

    assert response.status_code == 200
    assert response.json() == {"batchItemFailures": []}
    stored = repositories.issues.get(workspace, parent["id"])
    assert stored.progress.total == 1


def test_the_events_route_refuses_a_gateway_request(repositories: Any) -> None:
    """A stream route reached through the API is a 404, not an invocation.

    The route exists to be called by the event source mapping; letting a signed in
    caller post records would be a way to write counts the request path owns. The
    adapter stamps a non-empty request context only when a gateway request is what
    it forwarded, which is what the guard reads.
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
    workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One bad record is reported alone, so the rest of the batch is not replayed."""
    import app.domains.issues.consumers.rollup as rollup

    def explode(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("dynamo is unhappy")

    monkeypatch.setattr(rollup, "recount", explode)

    app = FastAPI()
    app.include_router(rollup.build_router(repositories))
    with TestClient(app, raise_server_exceptions=False) as consumer:
        response = consumer.post(
            "/events",
            json={
                "Records": [
                    {
                        "eventID": "bad-1",
                        "eventName": "INSERT",
                        "dynamodb": {"NewImage": _string_image(workspace_id=workspace, parent_id="P", status_id="S")},
                    }
                ]
            },
        )

    assert response.status_code == 200
    assert response.json() == {"batchItemFailures": [{"itemIdentifier": "bad-1"}]}
