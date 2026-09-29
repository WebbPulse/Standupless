"""Let every REST parameter that takes a team id also take the team's key prefix.

A team id reaches a route in three places: the `teams/{team_id}` path segment,
a `team_id` query parameter, and a top-level `team_id` or `team_ids` field of a JSON
body. Rewriting a prefix to its id here, before routing, is one resolution point
for all of them, so no route has to know prefixes exist and the MCP tools, which
resolve through the same `app.common.team_refs`, cannot drift from the routes.

Only a prefix-shaped value is looked up, so ordinary id traffic costs no read.
Nothing is ever answered from here: a reference that matches no team passes
through unchanged and the authorized route answers its not-found, so an
unauthenticated caller learns nothing about which prefixes a workspace holds.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable, Optional
from urllib.parse import parse_qsl, urlencode

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.common.team_refs import SPELLINGS, is_key_prefix_shaped, resolve_team_id

WORKSPACE_PATH = re.compile(r"/workspaces/(?P<workspace>[^/]+)(?P<rest>/.*)?$")

TEAM_SEGMENT = re.compile(r"^(?P<head>/teams/)(?P<team>[^/]+)(?P<tail>/.*)?$")

BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})

BODY_FIELDS = (b'"team_id"', b'"team_ids"')

Resolver = Callable[[str], str]


def _teams_repository(scope: Scope) -> Any:
    """The application's team repository, or `None` when its bundle carries none."""
    from app.common.api.dependencies.repositories import bound_repositories

    bundle = bound_repositories(scope["app"])
    if "teams" not in bundle.repository_names:
        return None
    return bundle.teams


def _rewrite_path(path: str, resolve: Resolver) -> str:
    """The path with a prefix in its `teams/{team_id}` segment replaced by the id."""
    match = WORKSPACE_PATH.search(path)
    if match is None or not match.group("rest"):
        return path
    segment = TEAM_SEGMENT.match(match.group("rest"))
    if segment is None or not is_key_prefix_shaped(segment.group("team")):
        return path
    resolved = resolve(segment.group("team"))
    rest = f"{segment.group('head')}{resolved}{segment.group('tail') or ''}"
    return f"{path[: match.start('rest')]}{rest}"


def _rewrite_query(query: bytes, resolve: Resolver) -> bytes:
    """The query string with each prefix-shaped `team_id` value replaced by the id."""
    if b"team_id" not in query:
        return query
    pairs = parse_qsl(query.decode("latin-1"), keep_blank_values=True)
    if not any(name == "team_id" and is_key_prefix_shaped(value) for name, value in pairs):
        return query
    rewritten = [(name, resolve(value) if name == "team_id" else value) for name, value in pairs]
    return urlencode(rewritten).encode("latin-1")


def _rewrite_body(body: bytes, resolve: Resolver) -> Optional[bytes]:
    """The JSON body with its team references resolved, or `None` when unchanged."""
    if not any(field in body for field in BODY_FIELDS):
        return None
    try:
        payload = json.loads(body)
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    changed = False
    value = payload.get("team_id")
    if isinstance(value, str) and is_key_prefix_shaped(value):
        payload["team_id"] = resolve(value)
        changed = changed or payload["team_id"] != value
    values = payload.get("team_ids")
    if isinstance(values, list):
        resolved = [resolve(item) if isinstance(item, str) and is_key_prefix_shaped(item) else item for item in values]
        changed = changed or resolved != values
        payload["team_ids"] = resolved
    return json.dumps(payload).encode() if changed else None


class TeamReferenceMiddleware:
    """Resolve team key prefixes in the path, query and JSON body of workspace routes."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap the next application."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Rewrite one request's team references, then hand it on."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        match = WORKSPACE_PATH.search(scope.get("path", ""))
        if match is None:
            await self.app(scope, receive, send)
            return

        workspace_id = match.group("workspace")
        cache: dict[str, str] = {}
        spellings: dict[str, str] = {}
        SPELLINGS.set(spellings)

        def resolve(reference: str) -> str:
            """One reference resolved within the path's workspace, read at most once."""
            if reference not in cache:
                teams = _teams_repository(scope)
                cache[reference] = reference if teams is None else resolve_team_id(teams, workspace_id, reference)
                if cache[reference] != reference:
                    spellings[cache[reference]] = reference
            return cache[reference]

        scope = dict(scope)
        path = _rewrite_path(scope["path"], resolve)
        if path != scope["path"]:
            scope["path"] = path
            scope["raw_path"] = path.encode()
        scope["query_string"] = _rewrite_query(scope.get("query_string", b""), resolve)

        if scope.get("method") not in BODY_METHODS or not _is_json(scope):
            await self.app(scope, receive, send)
            return

        body = await _read_body(receive)
        rewritten = _rewrite_body(body, resolve)
        if rewritten is not None:
            body = rewritten
            headers = [(name, value) for name, value in scope.get("headers", []) if name != b"content-length"]
            headers.append((b"content-length", str(len(body)).encode()))
            scope["headers"] = headers
        await self.app(scope, _replay(body, receive), send)


def _is_json(scope: Scope) -> bool:
    """Whether the request declares a JSON body."""
    for name, value in scope.get("headers", []):
        if name == b"content-type":
            return b"json" in value.lower()
    return False


async def _read_body(receive: Receive) -> bytes:
    """The whole request body, gathered from however many messages carry it."""
    chunks: list[bytes] = []
    while True:
        message = await receive()
        if message["type"] != "http.request":
            break
        chunks.append(message.get("body", b""))
        if not message.get("more_body", False):
            break
    return b"".join(chunks)


def _replay(body: bytes, receive: Receive) -> Receive:
    """A receive that yields the gathered body once, then defers to the original."""
    sent = False

    async def replay() -> Message:
        """The body first, then whatever the server sends next, such as a disconnect."""
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await receive()

    return replay
