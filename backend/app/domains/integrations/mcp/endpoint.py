"""The MCP endpoint: one path, the streamable HTTP transport, four methods.

This route carries no authorization dependency, and that is deliberate rather than
an oversight. An MCP client must be able to reach the endpoint unauthenticated to
receive the `WWW-Authenticate` challenge naming the authorization server, which is
how the discovery handshake starts. A dependency that raised before the handler ran
could not set that header, so the bearer check happens inside the handler instead.

The gateway route key carries `authorization_type = "NONE"` for the same reason, so
no authorizer ever runs on this path and both credentials it accepts are verified in
this process: an API key against its stored hash, and an OAuth access token against
the issuer's published key set. Verifying a token fetches that key set over a
blocking socket, so the bearer is resolved in a worker thread rather than on the
event loop: a stack serving the issuer and this endpoint from one process deadlocks
against itself otherwise.

The route is not public. Every request carrying a body is refused without a
verified bearer, before anything reads a table, and the challenge header is the
only thing an unauthenticated caller ever receives.

Authorization after that point is the product's ordinary path. The bearer resolves
to the same `AuthzContext` a browser session does, through the same `require`
dependency logic, so a tool cannot reach a team its credential could not reach
over HTTP.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any, Mapping, Optional

from fastapi import APIRouter, Depends, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from webbpulse.identity.api_keys import TENANT_CLAIM

from app.common.api.dependencies.authz import (
    AuthzContext,
    bearer_claims_of,
    missing_scopes,
    resolve_context,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.core.config import settings
from app.domains.integrations.mcp.tools import TOOLS, TOOLS_BY_NAME, ToolCall, render
from app.domains.integrations.mcp.transport import (
    INSUFFICIENT_SCOPE,
    INTERNAL_ERROR,
    INVALID_PARAMS,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    PROTOCOL_VERSION,
    ProtocolError,
    ToolError,
    challenge_header,
    failure,
    parse_request,
    success,
    tool_result,
)

router = APIRouter(prefix="/api/mcp", tags=["mcp"])

_log = logging.getLogger(__name__)

SERVER_NAME = "standupless"

SERVER_TITLE = "Standupless"


def _issuer() -> str:
    """Where the authorization server lives, for the challenge header."""
    return str(getattr(settings, "IDENTITY_ISSUER", "") or "").rstrip("/")


def _unauthenticated() -> Response:
    """The 401 every unverified request gets, carrying the discovery challenge."""
    return JSONResponse(
        status_code=401,
        content={"error_code": "NOT_AUTHENTICATED", "message": "This endpoint needs an OAuth bearer token."},
        headers={"WWW-Authenticate": challenge_header(_issuer())},
    )


def _resolve_context(request: Request, repositories: Repositories) -> Optional[AuthzContext]:
    """The authorization context this bearer resolves to, or `None` to challenge.

    Two credentials arrive here and both are verified in this process, because the
    gateway route carries no authorizer. An API key verifies against its stored hash;
    an OAuth access token verifies against the issuer's published key set, checking
    the signature, the issuer, the RFC 8707 resource it is bound to as its audience,
    and its expiry. Neither check is written here: both are the identity package's.

    The workspace comes from the credential's own tenant claim rather than from a
    path, because there is no path to put it in: consent bound the token to exactly
    one workspace, and that binding is what this reads. A session token carries no
    tenant claim and is refused, which is deliberate: a browser session has no
    business calling tools.

    Everything after that is `resolve_context` in the authorization module, the
    same code `require` runs, so membership is read live and scopes are intersected
    against it on every request. A token whose subject has left the workspace
    resolves to nothing, exactly as an API key on an HTTP route would.

    The claims are resolved once and handed on, so a token's signature is checked a
    single time per request rather than once to read the tenant and again to authorize
    against it.
    """
    claims = bearer_claims_of(request, repositories)
    if claims is None:
        return None
    workspace_id = str(claims.get(TENANT_CLAIM, "") or "").strip()
    if not workspace_id:
        return None
    return resolve_context(request, repositories, workspace_id, claims)


@router.get("", status_code=405)
def reject_get() -> Response:
    """Refuse a `GET`, carrying the challenge so discovery still starts from it.

    405 rather than 404, because the path exists and the method does not. There is
    no SSE stream to open here, which is what a client issuing a `GET` is asking
    for.
    """
    return JSONResponse(
        status_code=405,
        content={"error_code": "METHOD_NOT_ALLOWED", "message": "This endpoint takes POST."},
        headers={"WWW-Authenticate": challenge_header(_issuer())},
    )


@router.delete("")
def end_session(
    request: Request,
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """End a session. Stateless here, so this only confirms the bearer.

    Answered rather than refused because the specification has clients call it on
    shutdown, and a 404 would make a clean disconnect look like a failure. There is
    no server-side session to discard: every request carries its own bearer.
    """
    if _resolve_context(request, repositories) is None:
        return _unauthenticated()
    return Response(status_code=204)


@router.post("")
async def handle(
    request: Request,
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """One JSON-RPC request or notification, answered in the response body.

    The bearer is verified before the body is parsed, so an unauthenticated caller
    never reaches the dispatch table and nothing it sends is acted on.

    Resolving the bearer runs in a worker thread because verifying an OAuth token
    fetches the issuer's key set over a blocking socket. On the event loop that call
    stalls every other request on the worker, and where one process serves both the
    issuer and this endpoint it stalls the very response it is waiting for, so the
    fetch times out and a valid token reads as unverifiable.
    """
    context = await run_in_threadpool(_resolve_context, request, repositories)
    if context is None:
        return _unauthenticated()

    try:
        payload = json.loads(await request.body())
    except ValueError:
        return JSONResponse(status_code=200, content=failure(None, PARSE_ERROR, "Invalid JSON"))

    try:
        request_id, method, params, is_notification = parse_request(payload)
    except ProtocolError as exc:
        return JSONResponse(status_code=200, content=failure(None, exc.code, exc.message))

    if is_notification:
        return Response(status_code=202)

    try:
        result = _dispatch(method, params, context, repositories)
    except ProtocolError as exc:
        return JSONResponse(
            status_code=200,
            content=failure(request_id, exc.code, exc.message, data=exc.data),
        )
    except Exception:
        _log.exception("mcp method failed", extra={"method": method})
        return JSONResponse(
            status_code=200,
            content=failure(request_id, INTERNAL_ERROR, "That request could not be completed"),
        )

    return JSONResponse(status_code=200, content=success(request_id, result))


def _dispatch(
    method: str,
    params: Mapping[str, Any],
    context: AuthzContext,
    repositories: Repositories,
) -> dict[str, Any]:
    """Route one method to its handler, or raise `METHOD_NOT_FOUND`.

    Four methods only. No `resources/*`, no `prompts/*` and no `sampling/*`: each
    would be a second surface onto the same data with its own visibility rules, and
    the tools already cover what an agent needs.
    """
    if method == "initialize":
        return _initialize()
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [tool.descriptor() for tool in TOOLS]}
    if method == "tools/call":
        return _call_tool(params, context, repositories)
    raise ProtocolError(METHOD_NOT_FOUND, f"Unknown method: {method}")


def _initialize() -> dict[str, Any]:
    """The handshake response, advertising tools and nothing else."""
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {"tools": {"listChanged": False}},
        "serverInfo": {"name": SERVER_NAME, "title": SERVER_TITLE, "version": "1"},
    }


def _call_tool(
    params: Mapping[str, Any],
    context: AuthzContext,
    repositories: Repositories,
) -> dict[str, Any]:
    """Run one tool, after checking the bearer carries the scopes it needs.

    A missing scope is a protocol error rather than an error result, because no
    retry of the same call can succeed: the credential itself is too narrow, and
    the model should stop rather than rephrase. A tool that ran and refused answers
    an error result instead, which the model can read and act on.
    """
    name = params.get("name")
    if not isinstance(name, str) or not name:
        raise ProtocolError(INVALID_PARAMS, "A tool call must name a tool")

    tool = TOOLS_BY_NAME.get(name)
    if tool is None:
        raise ProtocolError(METHOD_NOT_FOUND, f"Unknown tool: {name}")

    missing = _missing_scopes(context, tool.scopes)
    if missing:
        raise ProtocolError(
            INSUFFICIENT_SCOPE,
            f"Missing scope: {', '.join(missing)}",
            data={"error_code": "INSUFFICIENT_SCOPE", "required": list(tool.scopes)},
        )

    arguments = params.get("arguments") or {}
    if not isinstance(arguments, Mapping):
        raise ProtocolError(INVALID_PARAMS, "arguments must be an object")

    call = ToolCall(context=context, repositories=repositories, arguments=arguments)
    try:
        return tool_result(render(tool.handler(call)))
    except ToolError as exc:
        return tool_result(exc.message, is_error=True)


def _missing_scopes(context: AuthzContext, required: tuple[str, ...]) -> list[str]:
    """Which of a tool's scopes this credential does not carry.

    A user context reaching this endpoint still has to carry scopes, unlike an HTTP
    route where a session is unrestricted. A browser session has no business
    calling tools, and treating it as unrestricted here would make the endpoint a
    way around the scope system rather than a part of it. That is why this calls
    the shared comparison directly rather than through `require_scopes_present`,
    which exempts a session.
    """
    return missing_scopes(context.scopes, required)
