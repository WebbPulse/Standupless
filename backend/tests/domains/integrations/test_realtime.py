"""The WebSocket push: connecting, disconnecting, heartbeats and the stream fan-out.

The verifier and the sender are fakes at the two boundaries, the identity keys and
the API Gateway management API, so everything between them, the connection rows,
the membership checks and the notice derivation, runs against the mocked tables.
"""

from __future__ import annotations

import json
from typing import Any, Mapping

import pytest
from boto3.dynamodb.types import TypeSerializer
from fastapi import FastAPI
from fastapi.testclient import TestClient
from webbpulse.dynamodb import table_name
from webbpulse.http import REQUEST_CONTEXT_HEADER

from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import CYCLE, INITIATIVE, PROJECT
from app.common.db.dynamo.realtime_connections import CONNECTION_TTL_SECONDS
from app.domains.integrations.consumers import stream
from app.domains.integrations.realtime import fanout, websocket
from app.domains.integrations.realtime.notices import Notice, batch_notices, notices_for
from tests.domains.helpers import add_team_member
from tests.domains.integrations.conftest import (
    ADMIN,
    GUEST,
    MEMBER,
    OTHER_TEAM,
    OUTSIDER,
    OWNER,
    TEAM,
    WORKSPACE,
)

SERIALIZER = TypeSerializer()

ISSUE = "01JB0000000000000000000IS1"


class FakeSender:
    """Records every send, and answers gone for the connection ids it is told are closed."""

    def __init__(self, gone: set[str] | None = None, failing: set[str] | None = None) -> None:
        """Start with no sends and the given closed and failing connections."""
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.gone = gone or set()
        self.failing = failing or set()

    def send(self, connection_id: str, data: bytes) -> bool:
        """Record one send, answering False for a closed connection."""
        if connection_id in self.failing:
            raise RuntimeError("the management API timed out")
        if connection_id in self.gone:
            return False
        self.sent.append((connection_id, json.loads(data)))
        return True

    def to(self, connection_id: str) -> list[dict[str, Any]]:
        """The messages one connection received."""
        return [message for target, message in self.sent if target == connection_id]


def verifier(token: str) -> Mapping[str, Any]:
    """Accept `token-<user id>` and refuse anything else, the way a bad signature is refused."""
    if not token.startswith("token-"):
        raise ValueError("bad signature")
    return {"sub": token.removeprefix("token-")}


def ws_event(route: str, connection_id: str, **fields: Any) -> dict[str, Any]:
    """One API Gateway WebSocket event in the shape the integration delivers it."""
    return {"requestContext": {"routeKey": route, "connectionId": connection_id, "eventType": "X"}, **fields}


def connect_event(connection_id: str, user_id: str | None, workspace_id: str | None = WORKSPACE) -> dict[str, Any]:
    """A `$connect` carrying a token for `user_id` and a workspace in the query."""
    query: dict[str, str] = {}
    if user_id is not None:
        query["token"] = f"token-{user_id}"
    if workspace_id is not None:
        query["workspace_id"] = workspace_id
    return ws_event("$connect", connection_id, queryStringParameters=query or None)


def record(
    event: str,
    new: Mapping[str, Any] | None,
    old: Mapping[str, Any] | None = None,
    *,
    table: str = "issues",
    event_id: str = "evt-1",
) -> dict[str, Any]:
    """One DynamoDB stream record in the shape Lambda delivers it."""
    dynamodb: dict[str, Any] = {"ApproximateCreationDateTime": 1790000000}
    if new is not None:
        dynamodb["NewImage"] = {key: SERIALIZER.serialize(value) for key, value in new.items()}
    if old is not None:
        dynamodb["OldImage"] = {key: SERIALIZER.serialize(value) for key, value in old.items()}
    arn = f"arn:aws:dynamodb:us-west-2:1:table/{table_name(table, settings.dynamodb_table_prefix)}/stream/x"
    return {"eventID": event_id, "eventName": event, "eventSourceARN": arn, "dynamodb": dynamodb}


def issue_image(team_id: str = TEAM, **fields: Any) -> dict[str, Any]:
    """One issue row as a stream image carries it."""
    return {
        "workspace_id": WORKSPACE,
        "issue_id": ISSUE,
        "team_id": team_id,
        "key": "ABC-1",
        "number": 1,
        "title": "A secret title",
        "created_by": OWNER,
        **fields,
    }


def connected(repositories: Any, *pairs: tuple[str, str]) -> None:
    """Store an open connection for each (connection id, user id)."""
    for connection_id, user_id in pairs:
        repositories.realtime_connections.add(WORKSPACE, user_id, connection_id)


def test_connect_stores_a_row_for_a_verified_member(repositories: Any, workspace: str) -> None:
    """A member with a good token is accepted and the connection is kept under the workspace."""
    response = websocket.handle_event(repositories, connect_event("c-1", MEMBER), verifier)

    assert response == {"statusCode": 200}
    [row] = repositories.realtime_connections.list_for_workspace(WORKSPACE)
    assert (row.connection_id, row.user_id) == ("c-1", MEMBER)
    assert row.expires_at - row.connected_at == CONNECTION_TTL_SECONDS


def test_connect_reads_a_bearer_header_too(repositories: Any, workspace: str) -> None:
    """A client that can set headers may send the token as a Bearer credential."""
    event = ws_event(
        "$connect",
        "c-1",
        headers={"Authorization": f"Bearer token-{OWNER}"},
        queryStringParameters={"workspace_id": WORKSPACE},
    )

    assert websocket.handle_event(repositories, event, verifier)["statusCode"] == 200


@pytest.mark.parametrize(
    ("event", "status"),
    [
        (connect_event("c-1", None), 401),
        (ws_event("$connect", "c-1", queryStringParameters={"token": "forged", "workspace_id": WORKSPACE}), 401),
        (connect_event("c-1", MEMBER, workspace_id=None), 400),
        (connect_event("c-1", OUTSIDER), 403),
    ],
)
def test_connect_refuses_what_the_http_api_would(
    repositories: Any, workspace: str, event: dict[str, Any], status: int
) -> None:
    """No token or a bad one is 401, no workspace is 400, and a non-member is 403."""
    assert websocket.handle_event(repositories, event, verifier)["statusCode"] == status
    assert repositories.realtime_connections.list_for_workspace(WORKSPACE) == []


def test_connect_without_a_verifier_refuses(repositories: Any, workspace: str) -> None:
    """Where no identity keys are configured, nothing connects."""
    assert websocket.handle_event(repositories, connect_event("c-1", MEMBER), None)["statusCode"] == 401


def test_a_suspended_member_cannot_connect(repositories: Any, workspace: str) -> None:
    """Suspension keeps the membership row but grants nothing, a socket included."""
    membership = repositories.memberships.get(WORKSPACE, MEMBER)
    repositories.memberships.put(membership.model_copy(update={"suspended_at": utc_now(), "suspended_by": OWNER}))

    assert websocket.handle_event(repositories, connect_event("c-1", MEMBER), verifier)["statusCode"] == 403


def test_a_member_over_the_connection_limit_is_refused(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The per member limit answers 429, and another member is unaffected."""
    monkeypatch.setattr(websocket, "MAX_CONNECTIONS_PER_MEMBER", 2)
    connected(repositories, ("c-1", MEMBER), ("c-2", MEMBER))

    assert websocket.handle_event(repositories, connect_event("c-3", MEMBER), verifier)["statusCode"] == 429
    assert websocket.handle_event(repositories, connect_event("c-4", OWNER), verifier)["statusCode"] == 200


def test_disconnect_removes_the_row(repositories: Any, workspace: str) -> None:
    """Closing a socket forgets it, and closing one already forgotten is still a 200."""
    connected(repositories, ("c-1", MEMBER), ("c-2", OWNER))

    assert websocket.handle_event(repositories, ws_event("$disconnect", "c-1"), verifier)["statusCode"] == 200
    assert websocket.handle_event(repositories, ws_event("$disconnect", "c-1"), verifier)["statusCode"] == 200
    assert [row.connection_id for row in repositories.realtime_connections.list_for_workspace(WORKSPACE)] == ["c-2"]


def test_heartbeat_pushes_the_expiry_out(repositories: Any, workspace: str) -> None:
    """A heartbeat answers pong and refreshes the row's TTL."""
    repositories.realtime_connections.add(WORKSPACE, MEMBER, "c-1", now=1_000)

    response = websocket.handle_event(repositories, ws_event("heartbeat", "c-1"), verifier)

    assert response["statusCode"] == 200
    assert json.loads(response["body"]) == {"action": "pong", "connected": True}
    [row] = repositories.realtime_connections.list_for_workspace(WORKSPACE)
    assert row.expires_at > 1_000 + CONNECTION_TTL_SECONDS


def test_heartbeat_on_a_forgotten_socket_says_so(repositories: Any, workspace: str) -> None:
    """A socket whose row is gone is told to reconnect."""
    response = websocket.handle_event(repositories, ws_event("heartbeat", "c-9"), verifier)

    assert json.loads(response["body"]) == {"action": "pong", "connected": False}


def test_an_expired_row_is_not_listed(repositories: Any, workspace: str) -> None:
    """A row past its TTL that DynamoDB has not reclaimed yet is skipped."""
    repositories.realtime_connections.add(WORKSPACE, MEMBER, "c-old", now=1_000)
    connected(repositories, ("c-new", MEMBER))

    assert [row.connection_id for row in repositories.realtime_connections.list_for_workspace(WORKSPACE)] == ["c-new"]


def test_the_websocket_route_answers_the_integration_response(repositories: Any, workspace: str) -> None:
    """The pass-through route hands the event over and returns the status API Gateway reads."""
    app = FastAPI()
    app.include_router(websocket.build_router(repositories, verifier))
    with TestClient(app) as client:
        response = client.post("/events", json=connect_event("c-1", MEMBER))

    assert response.status_code == 200
    assert response.json() == {"statusCode": 200}


def test_the_websocket_route_refuses_a_gateway_request(repositories: Any, workspace: str) -> None:
    """Reached through the HTTP API, the route is a 404, so no caller can forge a connect."""
    app = FastAPI()
    app.include_router(websocket.build_router(repositories, verifier))
    with TestClient(app) as client:
        response = client.post(
            "/events",
            json=connect_event("c-1", MEMBER),
            headers={REQUEST_CONTEXT_HEADER: '{"http": {"method": "POST", "path": "/events"}}'},
        )

    assert response.status_code == 404


def test_an_issue_write_becomes_one_notice_without_content() -> None:
    """The notice names the issue and its team, and carries none of the row."""
    [notice] = notices_for(record("MODIFY", issue_image(), issue_image(title="Older")))

    assert notice.message() == {
        "type": "change",
        "kind": "issue",
        "id": ISSUE,
        "action": "updated",
        "workspace_id": WORKSPACE,
        "team_id": TEAM,
    }
    assert "secret" not in json.dumps(notice.message())


def test_a_moved_issue_tells_both_teams() -> None:
    """An issue moved between teams is announced to the team it left as well."""
    notices = notices_for(record("MODIFY", issue_image(OTHER_TEAM), issue_image(TEAM)))

    assert {notice.team_id for notice in notices} == {TEAM, OTHER_TEAM}


def test_a_removed_issue_is_announced_from_its_old_image() -> None:
    """A delete has no new image, so the old one names the issue."""
    [notice] = notices_for(record("REMOVE", None, issue_image()))

    assert (notice.kind, notice.action) == ("issue", "removed")


def test_bulk_imports_and_document_comments_are_skipped() -> None:
    """An import's rows and a comment on a document announce nothing."""
    imported = record("INSERT", issue_image(import_batch_id="01JB00000000000000000IMPRT"))
    on_document = record(
        "INSERT",
        {"workspace_id": WORKSPACE, "comment_id": "cm-1", "document_id": "doc-1"},
        table="comments",
    )

    assert notices_for(imported) == []
    assert notices_for(on_document) == []


def test_planning_rows_become_their_own_kinds() -> None:
    """Cycles, projects and initiatives are announced, and other planning rows are not."""
    cycle = record(
        "INSERT", {"workspace_id": WORKSPACE, "kind": CYCLE, "cycle_id": "cy-1", "team_id": TEAM}, table="planning"
    )
    project = record(
        "INSERT",
        {"workspace_id": WORKSPACE, "kind": PROJECT, "project_id": "pr-1", "team_ids": [TEAM, OTHER_TEAM]},
        table="planning",
    )
    initiative = record(
        "INSERT", {"workspace_id": WORKSPACE, "kind": INITIATIVE, "initiative_id": "in-1"}, table="planning"
    )
    other = record(
        "INSERT", {"workspace_id": WORKSPACE, "kind": "project_update", "update_id": "u-1"}, table="planning"
    )

    assert [(n.kind, n.team_id) for n in notices_for(cycle)] == [("cycle", TEAM)]
    [project_notice] = notices_for(project)
    assert (project_notice.kind, project_notice.team_ids) == ("project", (TEAM, OTHER_TEAM))
    assert [(n.kind, n.team_id) for n in notices_for(initiative)] == [("initiative", None)]
    assert notices_for(other) == []


def test_a_batch_announces_each_change_once() -> None:
    """Several writes to one issue in a batch become one notice, the last action winning."""
    notices = batch_notices(
        [
            record("INSERT", issue_image(), event_id="1"),
            record("MODIFY", issue_image(), issue_image(), event_id="2"),
            record("REMOVE", None, issue_image(), event_id="3"),
        ]
    )

    assert [(notice.id, notice.action) for notice in notices] == [(ISSUE, "removed")]


def test_a_private_team_notice_reaches_only_its_members(repositories: Any, workspace: str) -> None:
    """A member outside a private team hears nothing of it, and a team member does."""
    repositories.memberships.set_team_private(WORKSPACE, OTHER_TEAM, True)
    add_team_member(repositories, WORKSPACE, OTHER_TEAM, ADMIN, "member")
    connected(repositories, ("c-member", MEMBER), ("c-admin", ADMIN))
    sender = FakeSender()

    fanout.fan_out(repositories, [Notice("issue", ISSUE, WORKSPACE, OTHER_TEAM, "updated")], sender)

    assert sender.to("c-member") == []
    assert len(sender.to("c-admin")) == 1


def test_a_guest_hears_only_their_teams_and_no_initiatives(repositories: Any, workspace: str) -> None:
    """A guest hears the team they belong to, not another team and not an initiative."""
    connected(repositories, ("c-guest", GUEST), ("c-member", MEMBER))
    sender = FakeSender()

    fanout.fan_out(
        repositories,
        [
            Notice("issue", "i-1", WORKSPACE, TEAM, "updated"),
            Notice("issue", "i-2", WORKSPACE, OTHER_TEAM, "updated"),
            Notice("initiative", "in-1", WORKSPACE, None, "created"),
            Notice("project", "pr-1", WORKSPACE, None, "created", (OTHER_TEAM, TEAM)),
        ],
        sender,
    )

    assert [m["id"] for m in sender.to("c-guest")] == ["i-1", "pr-1"]
    assert [m["id"] for m in sender.to("c-member")] == ["i-1", "i-2", "in-1", "pr-1"]


def test_a_member_suspended_after_connecting_hears_nothing(repositories: Any, workspace: str) -> None:
    """Visibility is read at send time, so an open socket stops hearing on suspension."""
    connected(repositories, ("c-member", MEMBER))
    membership = repositories.memberships.get(WORKSPACE, MEMBER)
    repositories.memberships.put(membership.model_copy(update={"suspended_at": utc_now(), "suspended_by": OWNER}))
    sender = FakeSender()

    fanout.fan_out(repositories, [Notice("issue", ISSUE, WORKSPACE, TEAM, "updated")], sender)

    assert sender.sent == []


def test_a_gone_connection_is_deleted_and_a_failing_one_kept(repositories: Any, workspace: str) -> None:
    """A 410 removes the row, any other failure is counted and the row stays."""
    connected(repositories, ("c-gone", MEMBER), ("c-flaky", MEMBER), ("c-ok", OWNER))
    sender = FakeSender(gone={"c-gone"}, failing={"c-flaky"})

    counts = fanout.fan_out(
        repositories,
        [Notice("issue", "i-1", WORKSPACE, TEAM, "updated"), Notice("issue", "i-2", WORKSPACE, TEAM, "updated")],
        sender,
    )

    remaining = {row.connection_id for row in repositories.realtime_connections.list_for_workspace(WORKSPACE)}
    assert remaining == {"c-flaky", "c-ok"}
    assert counts["gone"] == 1
    assert counts["failed"] == 2
    assert counts["sent"] == 2


def test_the_budget_stops_sending_without_failing(repositories: Any, workspace: str) -> None:
    """Past the batch's budget the remaining sends are skipped and counted."""
    connected(repositories, ("c-1", MEMBER), ("c-2", OWNER))
    ticks = iter([0.0, 0.0, 100.0, 100.0])
    sender = FakeSender()

    counts = fanout.fan_out(
        repositories,
        [Notice("issue", ISSUE, WORKSPACE, TEAM, "updated")],
        sender,
        clock=lambda: next(ticks),
        budget_seconds=1.0,
    )

    assert counts["sent"] == 1
    assert counts["skipped"] == 1


def test_no_sender_sends_nothing(repositories: Any, workspace: str) -> None:
    """Where no WebSocket API is configured the fan-out only counts."""
    connected(repositories, ("c-1", MEMBER))

    counts = fanout.fan_out(repositories, [Notice("issue", ISSUE, WORKSPACE, TEAM, "updated")], None)

    assert counts["notices"] == 1
    assert counts["sent"] == 0


def test_the_stream_consumer_pushes_a_batch_after_its_outbound_work(repositories: Any, workspace: str) -> None:
    """A stream batch through the mounted route reaches the connections that may read it."""
    connected(repositories, ("c-guest", GUEST), ("c-member", MEMBER))
    sender = FakeSender()
    app = FastAPI()
    app.include_router(stream.build_router(repositories, sender))
    with TestClient(app) as consumer:
        response = consumer.post(
            "/events",
            json={"Records": [record("INSERT", issue_image(OTHER_TEAM), event_id="1")]},
        )

    assert response.status_code == 200
    assert response.json() == {"batchItemFailures": []}
    assert sender.to("c-guest") == []
    assert [m["id"] for m in sender.to("c-member")] == [ISSUE]


def test_a_failing_fan_out_never_fails_the_batch(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The push is best effort, so its failure leaves the batch's envelope as it was."""

    def broken(*_args: Any, **_kwargs: Any) -> dict[str, int]:
        """Fail the way a throttled Query would."""
        raise RuntimeError("throttled")

    monkeypatch.setattr(stream, "fan_out", broken)
    app = FastAPI()
    app.include_router(stream.build_router(repositories, FakeSender()))
    with TestClient(app) as consumer:
        response = consumer.post("/events", json={"Records": [record("INSERT", issue_image(), event_id="1")]})

    assert response.json() == {"batchItemFailures": []}


def test_no_endpoint_means_no_sender(monkeypatch: pytest.MonkeyPatch) -> None:
    """An environment without the WebSocket API builds no management client."""
    monkeypatch.setattr(settings, "REALTIME_ENDPOINT_URL", "")

    assert fanout.default_sender() is None
