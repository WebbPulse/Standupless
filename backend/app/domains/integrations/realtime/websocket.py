"""The WebSocket API's routes: `$connect`, `$disconnect`, `heartbeat` and presence.

API Gateway invokes the function with the WebSocket event, which the Lambda Web
Adapter has no mapping for and so posts as is to the pass-through path, the same
way a stream batch arrives. What the route answers is the integration response:
`$connect` accepts on a 200 and refuses the socket on anything else.

`$connect` takes the same identity access token the HTTP API does, verified
against the issuer's published keys, and a workspace the token's subject is an
unsuspended member of. A browser cannot set headers on a WebSocket, so the token
comes in the `token` query parameter, or in `Authorization` for a client that can
send one. A member may hold `MAX_CONNECTIONS_PER_MEMBER` sockets on a workspace,
generous enough for every tab and device a person keeps open and small enough
that a runaway client cannot grow one partition without bound.

The token is checked once, at connect. What a connection may hear is decided per
notice from the member's current rows, so an expired token costs nothing and a
removed member hears nothing more.

`presence` and `presence_leave` report which issue or document a page has open,
and are handled in `presence`.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Mapping
from typing import Any

from fastapi import APIRouter
from webbpulse.events import register_stream_consumer

from app.common.api.dependencies.repositories import Repositories
from app.domains.integrations.realtime import presence as presence_routes
from app.domains.integrations.realtime.fanout import default_sender
from app.domains.integrations.realtime.presence import SenderFactory

_log = logging.getLogger(__name__)

MAX_CONNECTIONS_PER_MEMBER = 50
"""How many sockets one member may hold open on one workspace."""

HEARTBEAT_ROUTE = "heartbeat"
"""The route key a client's `{"action": "heartbeat"}` message selects."""

TokenVerifier = Callable[[str], Mapping[str, Any]]
"""Verifies an access token, answering its claims or raising."""


def _status(code: int, body: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The integration response API Gateway reads."""
    response: dict[str, Any] = {"statusCode": code}
    if body is not None:
        response["body"] = json.dumps(body, separators=(",", ":"))
    return response


def _default_verifier() -> TokenVerifier | None:
    """The product's identity token verifier, or None where none can be built."""
    from app.common.api.dependencies import identity_claims

    verifier = identity_claims._verifier()
    return verifier.verify if verifier is not None else None


def _lowered(values: Any) -> dict[str, str]:
    """A header or query map with lower case names, empty for anything else."""
    if not isinstance(values, Mapping):
        return {}
    return {str(name).lower(): str(value) for name, value in values.items() if value is not None}


def _token(event: Mapping[str, Any]) -> str:
    """The access token a `$connect` presented, from the query or a Bearer header."""
    query = _lowered(event.get("queryStringParameters"))
    if query.get("token"):
        return query["token"].strip()
    authorization = _lowered(event.get("headers")).get("authorization", "")
    scheme, _, credential = authorization.partition(" ")
    return credential.strip() if scheme.lower() == "bearer" else ""


def connect(
    repositories: Repositories,
    event: Mapping[str, Any],
    connection_id: str,
    verifier: TokenVerifier | None,
) -> dict[str, Any]:
    """Accept a socket for a verified, unsuspended member under their limit, or refuse it."""
    token = _token(event)
    if not token or verifier is None:
        return _status(401)
    try:
        claims = verifier(token)
    except Exception:
        _log.info("A WebSocket connect presented a token that did not verify.", exc_info=True)
        return _status(401)
    user_id = str(claims.get("sub", "") or "").strip()
    workspace_id = _lowered(event.get("queryStringParameters")).get("workspace_id", "").strip()
    if not user_id:
        return _status(401)
    if not workspace_id:
        return _status(400)

    membership = repositories.memberships.get(workspace_id, user_id)
    if membership is None or membership.is_suspended:
        return _status(403)

    store = repositories.realtime_connections
    if store.count_for_member(workspace_id, user_id) >= MAX_CONNECTIONS_PER_MEMBER:
        _log.warning(
            "A member reached the WebSocket connection limit.",
            extra={"event": "integrations.realtime.limit", "workspace_id": workspace_id},
        )
        return _status(429)

    store.add(workspace_id, user_id, connection_id)
    return _status(200)


def disconnect(
    repositories: Repositories, connection_id: str, sender_factory: SenderFactory = default_sender
) -> dict[str, Any]:
    """Forget a closed socket and anything it had open. A row already gone is not an error."""
    repositories.realtime_connections.remove_by_id(connection_id)
    presence_routes.disconnect(repositories, connection_id, sender_factory=sender_factory)
    return _status(200)


def heartbeat(repositories: Repositories, connection_id: str) -> dict[str, Any]:
    """Answer a client's keepalive and push its row's expiry out again.

    API Gateway closes a socket idle for ten minutes, so a client sends this on a
    timer. A socket with no row, one the TTL or a 410 already removed, is told so
    and should reconnect.
    """
    store = repositories.realtime_connections
    connection = store.find(connection_id)
    if connection is None:
        return _status(200, {"action": "pong", "connected": False})
    store.refresh(connection)
    return _status(200, {"action": "pong", "connected": True})


def handle_event(
    repositories: Repositories,
    event: Mapping[str, Any],
    verifier: TokenVerifier | None,
    sender_factory: SenderFactory = default_sender,
) -> dict[str, Any]:
    """Route one WebSocket event by its route key."""
    context = event.get("requestContext")
    if not isinstance(context, Mapping):
        return _status(400)
    route = str(context.get("routeKey", ""))
    connection_id = str(context.get("connectionId", "") or "")
    if not connection_id:
        return _status(400)
    if route == "$connect":
        return connect(repositories, event, connection_id, verifier)
    if route == "$disconnect":
        return disconnect(repositories, connection_id, sender_factory)
    if route == HEARTBEAT_ROUTE:
        return heartbeat(repositories, connection_id)
    if route == presence_routes.PRESENCE_ROUTE:
        return presence_routes.presence(repositories, event, connection_id, sender_factory=sender_factory)
    if route == presence_routes.LEAVE_ROUTE:
        return presence_routes.leave(repositories, event, connection_id, sender_factory=sender_factory)
    return _status(404)


def build_router(
    repositories: Repositories,
    verifier: TokenVerifier | None = None,
    *,
    verifier_factory: Callable[[], TokenVerifier | None] = _default_verifier,
) -> APIRouter:
    """The pass-through route the WebSocket API's integration posts each event to."""
    router = APIRouter()

    def consume(event: Mapping[str, Any]) -> dict[str, Any]:
        """Handle one WebSocket event, refusing rather than raising on any failure."""
        try:
            return handle_event(repositories, event, verifier if verifier is not None else verifier_factory())
        except Exception:
            _log.exception(
                "A WebSocket event failed.",
                extra={"event": "integrations.realtime.event_failed"},
            )
            return _status(500)

    register_stream_consumer(router, consume, per_record=False, log_event="integrations.realtime.event")
    return router
