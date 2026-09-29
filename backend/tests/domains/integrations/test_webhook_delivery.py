"""Outbound webhook delivery: the SSRF guard, payloads, fan-out, retries and auto-disable.

Nothing here opens a socket. DNS answers come from the `public_dns` fixture or an
injected resolver, queue sends are captured, and the HTTP sender is a fake, except in
the pinned sender tests, which replace only the connection class so the checks in
front of it run for real.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Mapping

import pytest
from boto3.dynamodb.types import TypeSerializer
from webbpulse.dynamodb import table_name
from webbpulse.events.webhooks import WebhookResponse

from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import WebhookEndpoint, new_webhook_id, webhook_key
from app.common.db.dynamo.planning import Project, project_key, project_update_key
from app.common.team_purge import Deadline, PurgeJob
from app.domains.integrations.consumers import purge, stream
from app.domains.integrations.outbound import delivery, payloads, ssrf
from app.domains.integrations.service import mint_secret
from tests.domains.integrations.conftest import OTHER_TEAM, OWNER, TEAM, WORKSPACE

SERIALIZER = TypeSerializer()


@dataclass
class Queue:
    """What the code under test queued, with the delay each message asked for."""

    jobs: list[dict[str, Any]] = field(default_factory=list)
    delays: list[int | None] = field(default_factory=list)


@pytest.fixture
def queue(monkeypatch: pytest.MonkeyPatch) -> Queue:
    """Capture every attempt job instead of sending it to SQS."""
    captured = Queue()

    def record(queue_url: str, envelope: Any, **kwargs: Any) -> str:
        """Keep the payload and the delay of one queued job."""
        captured.jobs.append(dict(envelope.payload))
        captured.delays.append(kwargs.get("delay_seconds"))
        return "message-id"

    monkeypatch.setattr(delivery, "enqueue", record)
    return captured


class FakeSender:
    """A sender answering from a script of responses and recording each request."""

    def __init__(self, *responses: WebhookResponse) -> None:
        """Answer with `responses` in order, repeating the last one."""
        self.responses = list(responses) or [WebhookResponse(status_code=200, body="ok")]
        self.sent: list[tuple[str, bytes, dict[str, str]]] = []

    def post(self, url: str, *, body: bytes, headers: Any, timeout: float) -> WebhookResponse:
        """Record one request and answer with the next scripted response."""
        self.sent.append((url, body, dict(headers)))
        return self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]


def make_endpoint(
    repositories: Any,
    *,
    team_id: str | None = None,
    resource_types: list[str] | None = None,
    active: bool = True,
    url: str = "https://example.test/hook",
) -> WebhookEndpoint:
    """Store one webhook the way the create route would."""
    webhook_id = new_webhook_id()
    return repositories.github.create_endpoint(
        WebhookEndpoint(
            workspace_id=WORKSPACE,
            github_key=webhook_key(webhook_id),
            webhook_id=webhook_id,
            url=url,
            label="Receiver",
            team_id=team_id,
            resource_types=resource_types or ["issues"],
            active=active,
            secret_salt="salt",
            created_by=OWNER,
            created_at=utc_now(),
            updated_at=utc_now(),
        )
    )


def issue_image(team_id: str = TEAM, **fields: Any) -> dict[str, Any]:
    """One issue row as a stream image carries it."""
    return {
        "workspace_id": WORKSPACE,
        "issue_id": "01JB0000000000000000000IS1",
        "team_id": team_id,
        "key": "OLD-1",
        "number": 1,
        "title": "First",
        "body": "Text",
        "priority": "high",
        "created_by": OWNER,
        "created_at": "2026-09-26T00:00:00+00:00",
        "updated_at": "2026-09-26T00:00:00+00:00",
        **fields,
    }


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


def one_delivery(repositories: Any, endpoint: WebhookEndpoint) -> Any:
    """The single delivery logged for `endpoint`."""
    rows = repositories.github.list_deliveries(WORKSPACE, endpoint.webhook_id)
    assert len(rows) == 1
    return rows[0]


@pytest.mark.parametrize(
    "address",
    [
        "10.0.0.1",
        "172.16.5.4",
        "192.168.1.1",
        "127.0.0.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:10.0.0.1",
        "::ffff:127.0.0.1",
        "64:ff9b::a9fe:a9fe",
        "2002:0a00:0001::1",
        "not-an-address",
    ],
)
def test_a_non_public_address_is_refused(address: str) -> None:
    """Private, loopback, link-local, CGNAT, multicast and IPv4-embedding IPv6 forms all fail."""
    assert not ssrf.is_public_address(address)


@pytest.mark.parametrize("address", ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:93.184.216.34"])
def test_a_public_address_is_allowed(address: str) -> None:
    """A public unicast address passes, including one carried in a mapped IPv6 form."""
    assert ssrf.is_public_address(address)


@pytest.mark.parametrize(
    "url",
    [
        "http://example.test/hook",
        "ftp://example.test/hook",
        "https:///hook",
        "https://user:pw@example.test/hook",
        "https://localhost/hook",
        "https://api.localhost/hook",
        "https://10.0.0.1/hook",
        "https://[::1]/hook",
        "https://example.test:99999/hook",
    ],
)
def test_an_unsafe_url_shape_is_refused(url: str) -> None:
    """Only https with a host, no credentials and a real port survives the parse."""
    with pytest.raises(ssrf.UnsafeDestination):
        ssrf.check_destination(url, resolver=lambda host, port: ["93.184.216.34"])


def test_one_private_answer_rejects_the_whole_name() -> None:
    """A name cannot mix a public answer in to pass the check."""
    with pytest.raises(ssrf.UnsafeDestination):
        ssrf.check_destination("https://mixed.test/", resolver=lambda host, port: ["93.184.216.34", "10.0.0.5"])


def test_an_unresolvable_name_can_be_saved_but_not_sent() -> None:
    """A receiver configured before its DNS exists saves, and the sender still refuses it."""

    def nowhere(host: str, port: int) -> list[str]:
        """Fail the way the system resolver fails for an unknown name."""
        raise OSError("no such host")

    assert ssrf.check_destination("https://later.test/", resolver=nowhere) == []
    with pytest.raises(ssrf.UnsafeDestination):
        ssrf.check_destination("https://later.test/", resolver=nowhere, allow_unresolved=False)


class FakeResponse:
    """Stands in for `http.client.HTTPResponse`."""

    def __init__(self, status: int, body: bytes) -> None:
        """Hold a status and body."""
        self.status = status
        self._body = body

    def read(self, limit: int) -> bytes:
        """Answer up to `limit` bytes of the body."""
        return self._body[:limit]


def fake_connection(dialled: list[tuple[str, str, str]], status: int, body: bytes = b"") -> type:
    """A connection class that records what it would dial and answers `status`."""

    class Connection:
        """Records the pinned address and the request instead of opening a socket."""

        def __init__(self, host: str, port: int, *, address: str, timeout: float, context: Any) -> None:
            """Remember the host and the address it was pinned to."""
            self.host = host
            self.address = address

        def request(self, method: str, target: str, *, body: bytes, headers: Mapping[str, str]) -> None:
            """Record one request."""
            dialled.append((self.host, self.address, target))

        def getresponse(self) -> FakeResponse:
            """Answer with the configured status."""
            return FakeResponse(status, body)

        def close(self) -> None:
            """Nothing to close."""

    return Connection


def test_the_sender_dials_the_checked_address(monkeypatch: pytest.MonkeyPatch) -> None:
    """The connection goes to the address that passed the check, with the hostname kept for TLS."""
    dialled: list[tuple[str, str, str]] = []
    monkeypatch.setattr(ssrf, "_PinnedHTTPSConnection", fake_connection(dialled, 204))
    sender = ssrf.PinnedHttpsSender(resolver=lambda host, port: ["93.184.216.34"])

    response = sender.post("https://example.test/hook?x=1", body=b"{}", headers={}, timeout=1)

    assert response.status_code == 204
    assert dialled == [("example.test", "93.184.216.34", "/hook?x=1")]


def test_the_sender_does_not_follow_a_redirect(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 3xx is reported as itself and never followed, since its target was never checked."""
    dialled: list[tuple[str, str, str]] = []
    monkeypatch.setattr(ssrf, "_PinnedHTTPSConnection", fake_connection(dialled, 302, b"moved"))
    sender = ssrf.PinnedHttpsSender(resolver=lambda host, port: ["93.184.216.34"])

    response = sender.post("https://example.test/hook", body=b"{}", headers={}, timeout=1)

    assert response.status_code == 302
    assert response.error == "Redirect not followed"
    assert not response.delivered
    assert len(dialled) == 1


def test_the_sender_refuses_a_name_that_now_resolves_privately(monkeypatch: pytest.MonkeyPatch) -> None:
    """DNS is checked again per attempt, so a rebinding to an internal address is caught."""
    dialled: list[tuple[str, str, str]] = []
    monkeypatch.setattr(ssrf, "_PinnedHTTPSConnection", fake_connection(dialled, 200))
    sender = ssrf.PinnedHttpsSender(resolver=lambda host, port: ["169.254.169.254"])

    response = sender.post("https://rebound.test/hook", body=b"{}", headers={}, timeout=1)

    assert response.status_code == 0
    assert response.error is not None and response.error.startswith(ssrf.BLOCKED_PREFIX)
    assert dialled == []
    assert not delivery.retryable(response)


def test_the_sender_gives_up_on_a_receiver_that_trickles_past_the_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    """Bytes arriving often enough to beat the per-read timeout still cannot hold the attempt open."""
    listener = socket.create_server(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    stop = threading.Event()

    def trickle() -> None:
        """Accept one connection and dribble a response one byte at a time."""
        conn, _ = listener.accept()
        with conn:
            conn.recv(65536)
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n")
            while not stop.is_set():
                try:
                    conn.sendall(b"x")
                except OSError:
                    return
                time.sleep(0.05)

    class Plain(ssrf._PinnedHTTPSConnection):
        """The real pinned connection with TLS left off, so a local server can answer."""

        def _secure(self, raw: socket.socket) -> socket.socket:
            """Use the dialled socket as it is."""
            return raw

    server = threading.Thread(target=trickle, daemon=True)
    server.start()
    monkeypatch.setattr(ssrf, "_PinnedHTTPSConnection", Plain)
    monkeypatch.setattr(ssrf, "check_destination", lambda url, **kwargs: ["127.0.0.1"])
    sender = ssrf.PinnedHttpsSender()

    started = time.monotonic()
    try:
        response = sender.post(f"https://receiver.test:{port}/hook", body=b"{}", headers={}, timeout=0.5)
    finally:
        stop.set()
        listener.close()
    elapsed = time.monotonic() - started

    assert response.status_code == 0
    assert response.error == "Timed out"
    assert elapsed < 3
    assert delivery.retryable(response)


def test_the_delivery_deadline_is_ten_seconds() -> None:
    """Every attempt is capped at ten seconds end to end."""
    assert ssrf.DELIVERY_TIMEOUT_SECONDS == 10.0
    assert delivery.SLOT_LEASE_SECONDS > ssrf.DELIVERY_TIMEOUT_SECONDS


def test_a_server_error_and_a_timeout_are_retryable_and_a_client_error_is_not() -> None:
    """Retries are for failures another attempt could fix."""
    assert delivery.retryable(WebhookResponse(status_code=503))
    assert delivery.retryable(WebhookResponse(status_code=0, error="Timed out"))
    assert delivery.retryable(WebhookResponse(status_code=429))
    assert not delivery.retryable(WebhookResponse(status_code=404))


def test_an_update_carries_updated_from_for_changed_public_fields(repositories: Any, workspace: str) -> None:
    """`updatedFrom` names only the public fields that changed, under their public names."""
    old = issue_image()
    new = issue_image(title="Second", priority="low", sort_order=5)

    event = payloads.describe(repositories, payloads.ISSUE, "MODIFY", new, old)

    assert event is not None
    assert event.action == "update"
    assert event.event_type == "Issue"
    assert event.updated_from == {"title": "First", "priority": "high"}
    assert event.data["title"] == "Second"
    assert event.data["identifier"] == "ABC-1"
    assert event.url.endswith("/issues/ABC-1")
    assert event.team_ids == (TEAM,)


def test_an_archive_and_a_restore_carry_archived_at(repositories: Any, workspace: str) -> None:
    """Archiving is a public change, so a receiver hears of it and of the restore."""
    old = issue_image()
    archived = issue_image(archived_at="2026-09-26T01:00:00+00:00")

    archive = payloads.describe(repositories, payloads.ISSUE, "MODIFY", archived, old)
    restore = payloads.describe(repositories, payloads.ISSUE, "MODIFY", old, archived)

    assert archive is not None and restore is not None
    assert archive.action == "update"
    assert archive.updated_from == {"archivedAt": None}
    assert archive.data["archivedAt"] == "2026-09-26T01:00:00+00:00"
    assert restore.updated_from == {"archivedAt": "2026-09-26T01:00:00+00:00"}


def test_an_update_to_internal_fields_only_describes_nothing(repositories: Any, workspace: str) -> None:
    """A rollup or index change is not news to a receiver."""
    old = issue_image()

    assert payloads.describe(repositories, payloads.ISSUE, "MODIFY", {**old, "sort_order": 9}, old) is None


def test_the_body_has_the_linear_shape(repositories: Any, workspace: str) -> None:
    """Create and remove bodies carry action, type, data, url and createdAt, and no updatedFrom."""
    created = payloads.describe(repositories, payloads.ISSUE, "INSERT", issue_image(), {})
    removed = payloads.describe(repositories, payloads.ISSUE, "REMOVE", {}, issue_image())
    assert created is not None and removed is not None

    body = created.body(webhook_id="w", delivery_id="d", timestamp_ms=1)

    assert {"action", "type", "data", "url", "createdAt", "webhookId", "webhookDeliveryId", "webhookTimestamp"} <= set(
        body
    )
    assert body["action"] == "create"
    assert "updatedFrom" not in body
    assert removed.action == "remove"
    assert removed.data["id"] == issue_image()["issue_id"]


def test_a_long_description_is_bounded(repositories: Any, workspace: str) -> None:
    """One body always fits the queue message and the log row that carry it."""
    event = payloads.describe(repositories, payloads.ISSUE, "INSERT", issue_image(body="x" * 50_000), {})

    assert event is not None
    assert len(event.data["description"]) == payloads.TEXT_LIMIT


def test_a_label_and_a_cycle_describe_their_team(repositories: Any, workspace: str) -> None:
    """Labels and cycles carry the team they belong to, which is what matching uses."""
    label = {
        "workspace_id": WORKSPACE,
        "config_key": f"team#{TEAM}#label#L1",
        "team_id": TEAM,
        "label_id": "L1",
        "name": "Bug",
        "color": "#ff0000",
    }
    cycle = {"workspace_id": WORKSPACE, "kind": "cycle", "cycle_id": "C1", "team_id": TEAM, "name": "Cycle 1"}

    described_label = payloads.describe(repositories, payloads.LABEL, "INSERT", label, {})
    described_cycle = payloads.describe(repositories, payloads.CYCLE, "INSERT", cycle, {})

    assert described_label is not None and described_label.event_type == "IssueLabel"
    assert described_label.team_ids == (TEAM,)
    assert described_cycle is not None and described_cycle.event_type == "Cycle"
    assert described_cycle.data["name"] == "Cycle 1"


def test_a_change_fans_out_to_matching_webhooks_only(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """Team scope, resource type and the enable toggle each decide who hears a change."""
    wide = make_endpoint(repositories)
    same_team = make_endpoint(repositories, team_id=TEAM)
    other_team = make_endpoint(repositories, team_id=OTHER_TEAM)
    comments_only = make_endpoint(repositories, resource_types=["comments"])
    disabled = make_endpoint(repositories, active=False)

    stream.handle_record(repositories, record("INSERT", issue_image()))

    targeted = {job["webhook_id"] for job in queue.jobs}
    assert targeted == {wide.webhook_id, same_team.webhook_id}
    for endpoint in (other_team, comments_only, disabled):
        assert repositories.github.list_deliveries(WORKSPACE, endpoint.webhook_id) == []
    assert one_delivery(repositories, wide).state == "pending"
    assert all(job["attempt"] == 1 for job in queue.jobs)


def test_the_stream_lists_a_workspaces_endpoints_once_per_cache_window(
    repositories: Any, workspace: str, github_env: None, queue: Queue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A burst of writes in one workspace costs one eventually consistent Query, not one per record."""
    endpoint = make_endpoint(repositories)
    clock = [100.0]
    cache = stream.EndpointCache(clock=lambda: clock[0])
    reads: list[bool] = []
    original = repositories.github.list_endpoints

    def spy(workspace_id: str, **kwargs: Any) -> Any:
        """Record whether the list was consistent, then list."""
        reads.append(kwargs.get("consistent", True))
        return original(workspace_id, **kwargs)

    monkeypatch.setattr(repositories.github, "list_endpoints", spy)

    for index in range(5):
        stream.handle_record(repositories, record("INSERT", issue_image(), event_id=f"evt-{index}"), cache)
    assert reads == [False]
    assert len(repositories.github.list_deliveries(WORKSPACE, endpoint.webhook_id)) == 5

    clock[0] += stream.ENDPOINT_CACHE_SECONDS
    stream.handle_record(repositories, record("INSERT", issue_image(), event_id="evt-late"), cache)
    assert reads == [False, False]


def test_a_workspace_with_no_webhooks_is_remembered_as_empty(
    repositories: Any, workspace: str, github_env: None, queue: Queue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The common case, no webhooks at all, is answered from memory inside the window."""
    cache = stream.EndpointCache(clock=lambda: 0.0)
    calls: list[str] = []
    original = repositories.github.list_endpoints

    def spy(workspace_id: str, **kwargs: Any) -> Any:
        """Count one list call."""
        calls.append(workspace_id)
        return original(workspace_id, **kwargs)

    monkeypatch.setattr(repositories.github, "list_endpoints", spy)

    for index in range(3):
        stream.handle_record(repositories, record("INSERT", issue_image(), event_id=f"e{index}"), cache)

    assert calls == [WORKSPACE]
    assert queue.jobs == []


def test_a_stream_record_seen_twice_schedules_once(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """Delivery ids come from the stream record, so a replayed batch adds nothing."""
    endpoint = make_endpoint(repositories)
    change = record("INSERT", issue_image())

    stream.handle_record(repositories, change)
    delivery_id = one_delivery(repositories, endpoint).delivery_id
    repositories.github.put_delivery(one_delivery(repositories, endpoint).model_copy(update={"state": "delivered"}))
    stream.handle_record(repositories, change)

    assert one_delivery(repositories, endpoint).delivery_id == delivery_id
    assert len(queue.jobs) == 1


def test_nothing_is_sent_for_a_workspace_being_deleted(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """A purge must not announce every row it removes."""
    make_endpoint(repositories)
    repositories.workspaces.schedule_deletion(WORKSPACE, OWNER)

    stream.handle_record(repositories, record("REMOVE", None, issue_image()))

    assert queue.jobs == []


def test_nothing_is_sent_for_a_team_being_deleted(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """A tombstoned team's rows leave quietly, while other teams still send."""
    make_endpoint(repositories)
    repositories.teams.mark_deleting(WORKSPACE, TEAM)

    stream.handle_record(repositories, record("REMOVE", None, issue_image()))
    assert queue.jobs == []

    stream.handle_record(repositories, record("INSERT", issue_image(team_id=OTHER_TEAM), event_id="evt-2"))
    assert len(queue.jobs) == 1


def test_only_label_rows_of_team_config_are_sent(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """Statuses and settings share the table with labels, and only labels are a resource type."""
    endpoint = make_endpoint(repositories, resource_types=["labels"])
    status_row = {"workspace_id": WORKSPACE, "config_key": f"team#{TEAM}#status#S1", "team_id": TEAM, "name": "Todo"}
    label_row = {
        "workspace_id": WORKSPACE,
        "config_key": f"team#{TEAM}#label#L1",
        "team_id": TEAM,
        "label_id": "L1",
        "name": "Bug",
        "color": "#f00",
    }

    stream.handle_record(repositories, record("INSERT", status_row, table="team_config", event_id="s"))
    stream.handle_record(repositories, record("INSERT", label_row, table="team_config", event_id="l"))

    assert len(queue.jobs) == 1
    assert json.loads(one_delivery(repositories, endpoint).body)["type"] == "IssueLabel"


def test_planning_rows_other_than_cycles_and_projects_are_ignored(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """Cycle history and milestones live beside cycles, and are not sent."""
    make_endpoint(repositories, resource_types=["cycles", "projects"])
    history = {"workspace_id": WORKSPACE, "kind": "cycle_history", "team_id": TEAM, "cycle_id": "C1"}
    cycle = {"workspace_id": WORKSPACE, "kind": "cycle", "team_id": TEAM, "cycle_id": "C1", "name": "One"}

    stream.handle_record(repositories, record("INSERT", history, table="planning", event_id="h"))
    stream.handle_record(repositories, record("INSERT", cycle, table="planning", event_id="c"))

    assert len(queue.jobs) == 1


def _stored_project(repositories: Any, team_ids: list[str]) -> Project:
    """Store one project row, which a project update reads for its name and teams."""
    return repositories.planning.create_project(
        Project(
            workspace_id=WORKSPACE,
            planning_key=project_key("P1"),
            project_id="P1",
            team_ids=team_ids,
            name="Launch",
            created_by=OWNER,
        )
    )


def _update_image() -> dict[str, Any]:
    """One project update row, as the planning stream carries it."""
    return {
        "workspace_id": WORKSPACE,
        "planning_key": project_update_key("P1", "U1"),
        "kind": "project_update",
        "project_id": "P1",
        "update_id": "U1",
        "author_id": OWNER,
        "body": "Slipping a week",
        "health": "at_risk",
        "created_at": "2026-09-20T12:00:00+00:00",
    }


def test_a_project_update_describes_its_projects_teams_and_link(repositories: Any, workspace: str) -> None:
    """The update row has no teams, so they, and the name, come off the project row."""
    _stored_project(repositories, [TEAM, OTHER_TEAM])

    event = payloads.describe(repositories, payloads.PROJECT_UPDATE, "INSERT", _update_image(), {})

    assert event is not None and event.event_type == "ProjectUpdate"
    assert event.team_ids == (TEAM, OTHER_TEAM)
    assert event.data["id"] == "U1"
    assert event.data["projectId"] == "P1"
    assert event.data["projectName"] == "Launch"
    assert event.data["userId"] == OWNER
    assert event.data["body"] == "Slipping a week"
    assert event.data["health"] == "at_risk"
    assert event.url.endswith("/projects/P1?tab=updates#update-U1")


def test_a_project_update_on_a_deleted_project_has_no_teams(repositories: Any, workspace: str) -> None:
    """With the project gone the update still describes itself, for workspace wide webhooks."""
    event = payloads.describe(repositories, payloads.PROJECT_UPDATE, "REMOVE", {}, _update_image())

    assert event is not None
    assert event.team_ids == ()
    assert event.data["projectName"] is None


def test_a_posted_project_update_reaches_project_update_webhooks(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """The planning stream sends update rows to webhooks that asked for them, and no others."""
    _stored_project(repositories, [TEAM])
    wanted = make_endpoint(repositories, resource_types=["project_updates"])
    make_endpoint(repositories, resource_types=["projects"])

    stream.handle_record(repositories, record("INSERT", _update_image(), table="planning", event_id="u"))

    assert {job["webhook_id"] for job in queue.jobs} == {wanted.webhook_id}
    assert json.loads(one_delivery(repositories, wanted).body)["type"] == "ProjectUpdate"


def queued_attempt(repositories: Any, endpoint: WebhookEndpoint, queue: Queue) -> dict[str, Any]:
    """Schedule one issue delivery to `endpoint` and hand back its first attempt job."""
    event = payloads.describe(repositories, payloads.ISSUE, "INSERT", issue_image(), {})
    assert event is not None
    assert delivery.schedule(repositories, endpoint, event, seed=f"seed-{len(queue.jobs)}")
    return queue.jobs[-1]


def test_an_attempt_is_signed_with_the_shown_secret(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """The signature verifies with the secret exactly as it was shown, prefix included."""
    endpoint = make_endpoint(repositories)
    sender = FakeSender()

    outcome = delivery.run_attempt(repositories, queued_attempt(repositories, endpoint, queue), sender=sender)

    assert outcome == "delivered"
    _url, body, headers = sender.sent[0]
    secret = mint_secret(endpoint.webhook_id, endpoint.secret_salt).encode()
    expected = hmac.new(secret, f"{headers['X-Webhook-Timestamp']}.".encode() + body, hashlib.sha256).hexdigest()
    assert headers["X-Webhook-Signature"] == f"sha256={expected}"
    assert headers["X-Webhook-Event"] == "Issue"
    assert headers["X-Webhook-Delivery"] == json.loads(body)["webhookDeliveryId"]
    logged = one_delivery(repositories, endpoint)
    assert logged.state == "delivered"
    assert logged.attempts[0].status_code == 200


def test_a_failed_attempt_queues_the_next_with_backoff(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """A retryable failure queues the next attempt with a growing delay and logs each try."""
    endpoint = make_endpoint(repositories)
    sender = FakeSender(WebhookResponse(status_code=503, body="down"))
    job = queued_attempt(repositories, endpoint, queue)

    assert delivery.run_attempt(repositories, job, sender=sender) == "retrying"
    assert delivery.run_attempt(repositories, queue.jobs[-1], sender=sender) == "retrying"

    assert queue.delays[1:] == [delivery.BACKOFF_SECONDS[0], delivery.BACKOFF_SECONDS[1]]
    assert queue.jobs[-1]["attempt"] == 3
    logged = one_delivery(repositories, endpoint)
    assert logged.state == "retrying"
    assert logged.next_attempt_at is not None
    assert [row.status_code for row in logged.attempts] == [503, 503]
    assert logged.attempts[0].response_body == "down"


def test_a_retry_then_success_is_delivered(repositories: Any, workspace: str, github_env: None, queue: Queue) -> None:
    """A receiver that recovers gets the delivery on a later attempt."""
    endpoint = make_endpoint(repositories)
    sender = FakeSender(WebhookResponse(status_code=500), WebhookResponse(status_code=200))
    job = queued_attempt(repositories, endpoint, queue)

    delivery.run_attempt(repositories, job, sender=sender)
    assert delivery.run_attempt(repositories, queue.jobs[-1], sender=sender) == "delivered"

    assert one_delivery(repositories, endpoint).state == "delivered"


def test_a_duplicate_job_does_not_post_twice(repositories: Any, workspace: str, github_env: None, queue: Queue) -> None:
    """SQS may hand a job over twice, and the log decides it was already done."""
    endpoint = make_endpoint(repositories)
    sender = FakeSender()
    job = queued_attempt(repositories, endpoint, queue)

    delivery.run_attempt(repositories, job, sender=sender)

    assert delivery.run_attempt(repositories, job, sender=sender) == "duplicate"
    assert len(sender.sent) == 1


def test_a_blocked_destination_fails_without_retrying(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """A refused destination will be refused again, so it is not retried."""
    endpoint = make_endpoint(repositories)
    sender = FakeSender(WebhookResponse(status_code=0, error=f"{ssrf.BLOCKED_PREFIX}: private"))
    job = queued_attempt(repositories, endpoint, queue)

    assert delivery.run_attempt(repositories, job, sender=sender) == "failed"
    assert len(queue.jobs) == 1


@pytest.mark.parametrize("status_code", [400, 401, 403, 404, 405, 410, 413, 422])
def test_a_client_error_fails_without_retrying(
    repositories: Any, workspace: str, github_env: None, queue: Queue, status_code: int
) -> None:
    """A 4xx other than 408 and 429 means the receiver refused this body, which a retry will not change.

    405 is the case staging logged: a receiver that serves GET only answers every
    POST the same way, so the delivery fails on its one attempt and queues nothing.
    """
    endpoint = make_endpoint(repositories)
    job = queued_attempt(repositories, endpoint, queue)
    queued = len(queue.jobs)

    sender = FakeSender(WebhookResponse(status_code=status_code))
    assert delivery.run_attempt(repositories, job, sender=sender) == "failed"
    assert len(queue.jobs) == queued

    stored = repositories.github.get_endpoint(WORKSPACE, endpoint.webhook_id)
    assert stored is not None and stored.consecutive_failures == 1


def test_an_endpoint_is_read_strongly_consistently(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The management routes read an endpoint just after creating it, so the read must see that write."""
    endpoint = make_endpoint(repositories)
    table = repositories.github._repository
    reads: list[bool] = []
    original = table.get

    def spy(key: Any, *, consistent: bool = False) -> Any:
        """Record whether the read was consistent, then read."""
        reads.append(consistent)
        return original(key, consistent=consistent)

    monkeypatch.setattr(table, "get", spy)

    assert repositories.github.get_endpoint(WORKSPACE, endpoint.webhook_id) is not None
    assert reads == [True]


def test_endpoints_are_listed_strongly_consistently(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A list just after a create must show the new endpoint."""
    endpoint = make_endpoint(repositories)
    reads: list[bool] = []
    original = repositories.github.list_endpoints

    def spy(workspace_id: str, **kwargs: Any) -> Any:
        """Record whether the list was consistent, then list."""
        reads.append(kwargs.get("consistent", True))
        return original(workspace_id, **kwargs)

    monkeypatch.setattr(repositories.github, "list_endpoints", spy)

    listed = repositories.github.list_endpoints(WORKSPACE)
    assert [row.webhook_id for row in listed] == [endpoint.webhook_id]
    assert reads == [True]


def test_running_out_of_attempts_fails_the_delivery(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """The last attempt's failure closes the delivery rather than queueing a sixth."""
    endpoint = make_endpoint(repositories)
    sender = FakeSender(WebhookResponse(status_code=500))
    job = queued_attempt(repositories, endpoint, queue)

    outcomes = [delivery.run_attempt(repositories, job, sender=sender)]
    while outcomes[-1] == "retrying":
        outcomes.append(delivery.run_attempt(repositories, queue.jobs[-1], sender=sender))

    assert outcomes == ["retrying"] * (delivery.MAX_ATTEMPTS - 1) + ["failed"]
    assert len(one_delivery(repositories, endpoint).attempts) == delivery.MAX_ATTEMPTS


def test_repeated_failures_disable_the_webhook_with_a_notice(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """`CIRCUIT_BREAKER_THRESHOLD` failed attempts in a row turn the webhook off and say why."""
    endpoint = make_endpoint(repositories)
    sender = FakeSender(WebhookResponse(status_code=410))

    for _ in range(delivery.CIRCUIT_BREAKER_THRESHOLD - 1):
        delivery.run_attempt(repositories, queued_attempt(repositories, endpoint, queue), sender=sender)
    still_on = repositories.github.get_endpoint(WORKSPACE, endpoint.webhook_id)
    assert still_on is not None and still_on.active

    delivery.run_attempt(repositories, queued_attempt(repositories, endpoint, queue), sender=sender)

    stored = repositories.github.get_endpoint(WORKSPACE, endpoint.webhook_id)
    assert stored is not None
    assert stored.active is False
    assert stored.consecutive_failures == delivery.CIRCUIT_BREAKER_THRESHOLD
    assert stored.disabled_reason == delivery.DISABLED_REASON.format(count=delivery.CIRCUIT_BREAKER_THRESHOLD)
    assert stored.disabled_at is not None


def test_retried_attempts_count_towards_the_breaker_and_opening_it_stops_retries(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """A hanging receiver trips the breaker on attempts, and the tripping attempt queues no retry."""
    endpoint = make_endpoint(repositories)
    sender = FakeSender(WebhookResponse(status_code=0, error="Timed out"))
    outcomes: list[str] = []

    while len(outcomes) < delivery.CIRCUIT_BREAKER_THRESHOLD:
        job = queued_attempt(repositories, endpoint, queue)
        outcomes.append(delivery.run_attempt(repositories, job, sender=sender))
        while outcomes[-1] == "retrying" and len(outcomes) < delivery.CIRCUIT_BREAKER_THRESHOLD:
            outcomes.append(delivery.run_attempt(repositories, queue.jobs[-1], sender=sender))
    queued = len(queue.jobs)

    assert outcomes[-1] == "failed"
    assert len(sender.sent) == delivery.CIRCUIT_BREAKER_THRESHOLD
    assert len(queue.jobs) == queued
    stored = repositories.github.get_endpoint(WORKSPACE, endpoint.webhook_id)
    assert stored is not None and stored.active is False and stored.disabled_at is not None


def test_an_open_breaker_fails_queued_attempts_fast(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """Attempts queued before the breaker opened end without a request or a slot."""
    endpoint = make_endpoint(repositories)
    backlog = [queued_attempt(repositories, endpoint, queue) for _ in range(3)]
    repositories.github.update_endpoint(
        WORKSPACE, endpoint.webhook_id, active=False, disabled_reason="open", disabled_at=utc_now().isoformat()
    )
    sender = FakeSender()

    assert [delivery.run_attempt(repositories, job, sender=sender) for job in backlog] == ["skipped"] * 3
    assert sender.sent == []
    assert repositories.github.acquire_dispatch_slot(
        WORKSPACE, limit=delivery.WORKSPACE_IN_FLIGHT_LIMIT, lease_seconds=1, now_ms=0
    ) == (0, 1000)


def hold_every_slot(repositories: Any, workspace_id: str) -> None:
    """Lease every in-flight slot of a workspace far into the future."""
    for _ in range(delivery.WORKSPACE_IN_FLIGHT_LIMIT):
        assert repositories.github.acquire_dispatch_slot(
            workspace_id,
            limit=delivery.WORKSPACE_IN_FLIGHT_LIMIT,
            lease_seconds=3600,
            now_ms=int(utc_now().timestamp() * 1000),
        )


def test_a_workspace_at_its_in_flight_limit_defers_without_a_request(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """With every slot held, the same attempt goes back on the queue after a jittered delay."""
    endpoint = make_endpoint(repositories)
    job = queued_attempt(repositories, endpoint, queue)
    hold_every_slot(repositories, WORKSPACE)
    sender = FakeSender()

    assert delivery.run_attempt(repositories, job, sender=sender) == "deferred"

    assert sender.sent == []
    assert queue.jobs[-1] == job
    delay = queue.delays[-1]
    assert delay is not None
    assert delivery.DEFER_SECONDS <= delay <= delivery.DEFER_SECONDS + delivery.DEFER_JITTER_SECONDS
    stored = repositories.github.get_endpoint(WORKSPACE, endpoint.webhook_id)
    assert stored is not None and stored.consecutive_failures == 0
    assert one_delivery(repositories, endpoint).attempts == []


def test_another_workspace_is_not_held_back_by_a_full_one(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """Slots are per workspace, so a saturated tenant leaves every other tenant's share alone."""
    endpoint = make_endpoint(repositories)
    job = queued_attempt(repositories, endpoint, queue)
    hold_every_slot(repositories, "01JB0000000000000000OTHERW")

    assert delivery.run_attempt(repositories, job, sender=FakeSender()) == "delivered"


def test_an_attempt_frees_its_slot_whatever_the_outcome(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """A delivered, a failed and a raising attempt each hand their slot back."""
    endpoint = make_endpoint(repositories)

    class Exploding:
        """A sender that raises instead of answering."""

        def post(self, url: str, *, body: bytes, headers: Any, timeout: float) -> WebhookResponse:
            """Raise."""
            raise RuntimeError("boom")

    delivery.run_attempt(repositories, queued_attempt(repositories, endpoint, queue), sender=FakeSender())
    delivery.run_attempt(
        repositories, queued_attempt(repositories, endpoint, queue), sender=FakeSender(WebhookResponse(status_code=500))
    )
    with pytest.raises(RuntimeError):
        delivery.run_attempt(repositories, queued_attempt(repositories, endpoint, queue), sender=Exploding())

    now_ms = int(utc_now().timestamp() * 1000)
    leased = [
        repositories.github.acquire_dispatch_slot(
            WORKSPACE, limit=delivery.WORKSPACE_IN_FLIGHT_LIMIT, lease_seconds=60, now_ms=now_ms
        )
        for _ in range(delivery.WORKSPACE_IN_FLIGHT_LIMIT)
    ]
    assert all(lease is not None for lease in leased)


def test_an_expired_slot_lease_is_reclaimed(repositories: Any, workspace: str) -> None:
    """A holder that died without releasing frees its slot when the lease runs out."""
    github = repositories.github
    limit = delivery.WORKSPACE_IN_FLIGHT_LIMIT
    for _ in range(limit):
        assert github.acquire_dispatch_slot(WORKSPACE, limit=limit, lease_seconds=10, now_ms=1_000)
    assert github.acquire_dispatch_slot(WORKSPACE, limit=limit, lease_seconds=10, now_ms=5_000) is None

    assert github.acquire_dispatch_slot(WORKSPACE, limit=limit, lease_seconds=10, now_ms=11_001) == (0, 21_001)


def test_releasing_a_lease_that_passed_to_another_holder_leaves_it(repositories: Any, workspace: str) -> None:
    """A late release frees nothing when its slot has since been leased again."""
    github = repositories.github
    first = github.acquire_dispatch_slot(WORKSPACE, limit=1, lease_seconds=10, now_ms=1_000)
    second = github.acquire_dispatch_slot(WORKSPACE, limit=1, lease_seconds=10, now_ms=20_000)
    assert first == (0, 11_000) and second == (0, 30_000)

    github.release_dispatch_slot(WORKSPACE, 0, 11_000)

    assert github.acquire_dispatch_slot(WORKSPACE, limit=1, lease_seconds=10, now_ms=25_000) is None
    github.release_dispatch_slot(WORKSPACE, 0, 30_000)
    assert github.acquire_dispatch_slot(WORKSPACE, limit=1, lease_seconds=10, now_ms=25_000) == (0, 35_000)


def test_a_delivered_attempt_resets_the_failure_run(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """Failures only disable when they are in a row."""
    endpoint = make_endpoint(repositories)

    for _ in range(delivery.CIRCUIT_BREAKER_THRESHOLD - 1):
        delivery.run_attempt(
            repositories,
            queued_attempt(repositories, endpoint, queue),
            sender=FakeSender(WebhookResponse(status_code=404)),
        )
    delivery.run_attempt(repositories, queued_attempt(repositories, endpoint, queue), sender=FakeSender())
    delivery.run_attempt(
        repositories, queued_attempt(repositories, endpoint, queue), sender=FakeSender(WebhookResponse(status_code=404))
    )

    stored = repositories.github.get_endpoint(WORKSPACE, endpoint.webhook_id)
    assert stored is not None
    assert stored.active is True
    assert stored.consecutive_failures == 1


def test_a_job_for_a_disabled_webhook_ends_without_an_attempt(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """A webhook turned off after its job was queued is not posted to."""
    endpoint = make_endpoint(repositories)
    job = queued_attempt(repositories, endpoint, queue)
    repositories.github.update_endpoint(WORKSPACE, endpoint.webhook_id, active=False)
    sender = FakeSender()

    assert delivery.run_attempt(repositories, job, sender=sender) == "skipped"
    assert sender.sent == []
    assert one_delivery(repositories, endpoint).state == "failed"


def test_a_job_for_a_deleted_webhook_is_dropped(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """A deleted webhook takes its log with it, so its queued jobs find nothing."""
    endpoint = make_endpoint(repositories)
    job = queued_attempt(repositories, endpoint, queue)
    repositories.github.delete_endpoint(WORKSPACE, endpoint.webhook_id)

    assert delivery.run_attempt(repositories, job, sender=FakeSender()) == "missing"


def test_a_team_purge_removes_that_teams_webhooks_only(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """The team's webhooks and their logs go with the team; workspace-wide ones stay."""
    wide = make_endpoint(repositories)
    team_hook = make_endpoint(repositories, team_id=TEAM)
    other = make_endpoint(repositories, team_id=OTHER_TEAM)
    delivery.run_attempt(repositories, queued_attempt(repositories, team_hook, queue), sender=FakeSender())

    while purge.step(repositories, PurgeJob(WORKSPACE, TEAM, "integrations", 0), Deadline(30)) is not None:
        pass

    remaining = {row.webhook_id for row in repositories.github.list_endpoints(WORKSPACE)}
    assert remaining == {wide.webhook_id, other.webhook_id}
    assert repositories.github.list_deliveries(WORKSPACE, team_hook.webhook_id) == []


def test_a_workspace_purge_removes_every_webhook_and_log(
    repositories: Any, workspace: str, github_env: None, queue: Queue
) -> None:
    """Workspace deletion leaves no webhook or delivery row behind."""
    wide = make_endpoint(repositories)
    make_endpoint(repositories, team_id=TEAM)
    delivery.run_attempt(repositories, queued_attempt(repositories, wide, queue), sender=FakeSender())

    purge.workspace_step(repositories, PurgeJob(WORKSPACE, "", "integrations", 0), Deadline(30))

    assert repositories.github.list_endpoints(WORKSPACE) == []
    assert repositories.github.list_deliveries(WORKSPACE, wide.webhook_id) == []
