"""Who else has an issue or a document open, pushed to the others viewing it.

A page sends `{"action": "presence", "kind", "id", "editing"}` when it opens and
every half minute while it stays open, and `{"action": "presence_leave", "kind",
"id"}` when it closes. The message names the entity and nothing more; who sent it
is the connection's own row, never anything the client claims.

Each message reads the entity once to learn its audience, and is refused unless
the sender may read it, so a guessed id learns nothing. The sender is answered with
the entity's other viewers, and when the set of viewers or who is editing changed,
every other connection on that entity that may still read it is told too. Nobody
is ever told about themselves, so a person with the page open in two tabs sees no
one.

A connection may send `PRESENCE_LIMIT_PER_MINUTE` messages a minute, far past what
a client's own throttle sends, and anything past that is dropped unanswered. The
fan-out is best effort like the change notices: a failed send is logged and the
viewers it missed catch up on their own next heartbeat's answer.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Mapping
from typing import Any

from webbpulse.ratelimit import RateLimiter

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.realtime_connections import RealtimeConnection
from app.common.db.dynamo.realtime_presence import PRESENCE_KINDS, Audience, Presence
from app.domains.integrations.realtime.fanout import ConnectionSender, Visibility, default_sender

_log = logging.getLogger(__name__)

PRESENCE_ROUTE = "presence"
"""The route key a page's open and heartbeat message selects."""

LEAVE_ROUTE = "presence_leave"
"""The route key a page's close message selects."""

PRESENCE_LIMIT_PER_MINUTE = 120
"""How many presence messages one connection may send a minute."""

ENTITY_ID_MAX = 64
"""The longest entity id a message may name."""

VIEWERS_MAX = 50
"""The most viewers one message lists, far past what a header shows."""

RATE_LIMIT_NAMESPACE = "realtime-presence"
"""The rate limiter namespace presence messages count under."""

SenderFactory = Callable[[], ConnectionSender | None]
"""Builds the sender pushes go out on, or answers None where there is none."""


def _status(code: int, body: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The integration response API Gateway reads."""
    response: dict[str, Any] = {"statusCode": code}
    if body is not None:
        response["body"] = json.dumps(body, separators=(",", ":"))
    return response


def _body(event: Mapping[str, Any]) -> dict[str, Any]:
    """The message a client sent, or an empty map for anything that is not a JSON object."""
    raw = event.get("body")
    if isinstance(raw, Mapping):
        return dict(raw)
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        value = json.loads(raw)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _target(message: Mapping[str, Any]) -> tuple[str, str] | None:
    """The kind and id a message names, or None when either is unusable."""
    kind = message.get("kind")
    entity_id = message.get("id")
    if kind not in PRESENCE_KINDS:
        return None
    if not isinstance(entity_id, str) or not entity_id or len(entity_id) > ENTITY_ID_MAX:
        return None
    return str(kind), entity_id


def resolve_audience(repositories: Repositories, workspace_id: str, kind: str, entity_id: str) -> Audience | None:
    """Who may read one issue or document, or None when it does not exist.

    An issue is its team's. A document is its parent's: a project's teams, an
    initiative's lead team with guests kept out, or a team.
    """
    if kind == "issue":
        issue = repositories.issues.get(workspace_id, entity_id)
        return Audience(team_id=issue.team_id) if issue is not None else None
    body = repositories.documents.get_body(workspace_id, entity_id)
    if body is None:
        return None
    if body.parent_kind == "project":
        project = repositories.planning.get_project(workspace_id, body.parent_id)
        return Audience(team_ids=tuple(project.team_ids)) if project is not None else None
    if body.parent_kind == "initiative":
        initiative = repositories.planning.get_initiative(workspace_id, body.parent_id)
        if initiative is None:
            return None
        return Audience(team_id=initiative.team_id, members_only=True)
    if body.parent_kind == "team":
        return Audience(team_id=body.parent_id)
    return None


def viewers_message(
    workspace_id: str, kind: str, entity_id: str, rows: list[Presence], recipient: str
) -> dict[str, Any]:
    """The viewers one member is told about: everyone on the entity but themselves, once each."""
    viewers: dict[str, bool] = {}
    for row in rows:
        if row.user_id == recipient:
            continue
        viewers[row.user_id] = viewers.get(row.user_id, False) or row.editing
    listed = list(viewers.items())[:VIEWERS_MAX]
    return {
        "type": "presence",
        "workspace_id": workspace_id,
        "kind": kind,
        "id": entity_id,
        "viewers": [{"user_id": user_id, "editing": editing} for user_id, editing in listed],
    }


def _summary(rows: list[Presence]) -> dict[str, bool]:
    """Who is on an entity and whether each is editing, the thing a change is judged by."""
    summary: dict[str, bool] = {}
    for row in rows:
        summary[row.user_id] = summary.get(row.user_id, False) or row.editing
    return summary


def _readable(visibility: Visibility, workspace_id: str, rows: list[Presence], audience: Audience) -> list[Presence]:
    """The rows whose member may still read the entity."""
    return [row for row in rows if visibility.can_read(workspace_id, row.user_id, audience)]


def broadcast(
    repositories: Repositories,
    sender: ConnectionSender | None,
    workspace_id: str,
    kind: str,
    entity_id: str,
    audience: Audience,
    *,
    skip_connection: str | None = None,
    visibility: Visibility | None = None,
    now: float | None = None,
) -> list[Presence]:
    """Tell every connection on an entity who else is there, answering the readable rows.

    A connection whose member can no longer read the entity is neither told nor
    listed, and a connection API Gateway says is gone loses its row.
    """
    seen = visibility if visibility is not None else Visibility(repositories)
    store = repositories.realtime_presence
    rows = _readable(seen, workspace_id, store.list_for_entity(workspace_id, kind, entity_id, now=now), audience)
    if sender is None:
        return rows
    for row in rows:
        if row.connection_id == skip_connection:
            continue
        data = json.dumps(
            viewers_message(workspace_id, kind, entity_id, rows, row.user_id), separators=(",", ":")
        ).encode()
        try:
            delivered = sender.send(row.connection_id, data)
        except Exception:
            _log.warning(
                "A presence change could not be sent.",
                exc_info=True,
                extra={"event": "integrations.realtime.presence_send_failed", "workspace_id": workspace_id},
            )
            continue
        if not delivered:
            store.remove(row)
    return rows


def _allowed(connection_id: str) -> bool:
    """Whether one connection is still under its presence limit. A limiter failure allows."""
    decision = RateLimiter(namespace=RATE_LIMIT_NAMESPACE).check(
        connection_id, limit=PRESENCE_LIMIT_PER_MINUTE, window_seconds=60
    )
    return decision.allowed


def _connection(repositories: Repositories, connection_id: str) -> RealtimeConnection | None:
    """The live row of the connection a message came on, or None."""
    connection = repositories.realtime_connections.find(connection_id)
    if connection is None or connection.expired():
        return None
    return connection


def presence(
    repositories: Repositories,
    event: Mapping[str, Any],
    connection_id: str,
    *,
    sender_factory: SenderFactory = default_sender,
    now: float | None = None,
) -> dict[str, Any]:
    """Record that a connection has an entity open, answer its other viewers, and tell them on a change."""
    connection = _connection(repositories, connection_id)
    if connection is None:
        return _status(200, {"action": "pong", "connected": False})
    if not _allowed(connection_id):
        return _status(429)
    message = _body(event)
    target = _target(message)
    if target is None:
        return _status(400)
    kind, entity_id = target
    editing = message.get("editing") is True
    workspace_id = connection.workspace_id

    audience = resolve_audience(repositories, workspace_id, kind, entity_id)
    visibility = Visibility(repositories)
    if audience is None or not visibility.can_read(workspace_id, connection.user_id, audience):
        return _status(404)

    store = repositories.realtime_presence
    moment = now if now is not None else time.time()
    before = _summary(
        _readable(visibility, workspace_id, store.list_for_entity(workspace_id, kind, entity_id, now=moment), audience)
    )
    existing = store.get(workspace_id, kind, entity_id, connection_id)
    store.put(
        workspace_id,
        kind,
        entity_id,
        connection_id,
        connection.user_id,
        editing=editing,
        audience=audience,
        opened_at=existing.opened_at if existing is not None and not existing.expired(moment) else None,
        now=moment,
    )
    rows = _readable(
        visibility, workspace_id, store.list_for_entity(workspace_id, kind, entity_id, now=moment), audience
    )
    if _summary(rows) != before:
        broadcast(
            repositories,
            sender_factory(),
            workspace_id,
            kind,
            entity_id,
            audience,
            skip_connection=connection_id,
            visibility=visibility,
            now=moment,
        )
    return _status(200, viewers_message(workspace_id, kind, entity_id, rows, connection.user_id))


def _forget(repositories: Repositories, rows: list[Presence], sender_factory: SenderFactory, now: float | None) -> None:
    """Delete rows a connection held and tell each entity's remaining viewers."""
    store = repositories.realtime_presence
    sender: ConnectionSender | None = None
    built = False
    for row in rows:
        store.remove(row)
        if row.expired(now):
            continue
        if not built:
            sender = sender_factory()
            built = True
        broadcast(repositories, sender, row.workspace_id, row.kind, row.entity_id, row.audience, now=now)


def leave(
    repositories: Repositories,
    event: Mapping[str, Any],
    connection_id: str,
    *,
    sender_factory: SenderFactory = default_sender,
    now: float | None = None,
) -> dict[str, Any]:
    """Forget that a connection has one entity open and tell its remaining viewers."""
    connection = _connection(repositories, connection_id)
    if connection is None:
        return _status(200)
    if not _allowed(connection_id):
        return _status(429)
    target = _target(_body(event))
    if target is None:
        return _status(400)
    kind, entity_id = target
    row = repositories.realtime_presence.get(connection.workspace_id, kind, entity_id, connection_id)
    if row is not None:
        _forget(repositories, [row], sender_factory, now)
    return _status(200)


def disconnect(
    repositories: Repositories,
    connection_id: str,
    *,
    sender_factory: SenderFactory = default_sender,
    now: float | None = None,
) -> None:
    """Forget every entity a closed connection had open, never raising into the disconnect."""
    try:
        rows = repositories.realtime_presence.list_for_connection(connection_id)
        _forget(repositories, rows, sender_factory, now)
    except Exception:
        _log.warning(
            "A closed connection's presence could not be cleared; its TTL will.",
            exc_info=True,
            extra={"event": "integrations.realtime.presence_clear_failed"},
        )
