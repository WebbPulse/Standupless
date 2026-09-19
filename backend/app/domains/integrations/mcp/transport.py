"""The JSON-RPC 2.0 envelope and the streamable HTTP shape the MCP endpoint speaks.

Separated from the tools so the transport can be read on its own: what is a
protocol error, what is a tool error, and what an unauthenticated caller is told.
The distinction matters because they carry different information. A transport
error means the request could not be understood or authorized; a tool error means
it was, and the tool refused.

No SSE stream. Nothing this server does is long running enough to need one, and a
server-sent event stream through an HTTP API and a Lambda is a 29 second timeout
wearing a streaming interface.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

PROTOCOL_VERSION = "2025-06-18"

JSONRPC_VERSION = "2.0"

PARSE_ERROR = -32700

INVALID_REQUEST = -32600

METHOD_NOT_FOUND = -32601

INVALID_PARAMS = -32602

INTERNAL_ERROR = -32603

INSUFFICIENT_SCOPE = -32003
"""The code a tool call refused for scope answers.

An application-defined code rather than a transport-level 403, because the
transport request itself was authorized and it is the tool that was not. A client
that saw a 403 would reasonably re-run discovery; one that sees this knows its
token is fine and the tool is out of reach.
"""


class ProtocolError(Exception):
    """A JSON-RPC level failure, carrying the code that goes on the wire."""

    def __init__(self, code: int, message: str, *, data: Any = None) -> None:
        """Hold the code, the message and any structured detail."""
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class ToolError(Exception):
    """A tool level failure, rendered as an error result rather than an error response.

    The MCP specification distinguishes the two: a tool that ran and failed answers
    a result marked `isError`, so the model calling it can read the message and try
    something else, while a protocol error is a client bug. Refusing a scope is the
    one exception and goes back as a protocol error, because no retry of the same
    call can succeed.
    """

    def __init__(self, message: str) -> None:
        """Hold the message the calling model will read."""
        super().__init__(message)
        self.message = message


def success(request_id: Any, result: Mapping[str, Any]) -> dict[str, Any]:
    """A JSON-RPC success response for one request id."""
    return {"jsonrpc": JSONRPC_VERSION, "id": request_id, "result": dict(result)}


def failure(request_id: Any, code: int, message: str, *, data: Any = None) -> dict[str, Any]:
    """A JSON-RPC error response for one request id."""
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": JSONRPC_VERSION, "id": request_id, "error": error}


def tool_result(text: str, *, is_error: bool = False) -> dict[str, Any]:
    """One tool's answer in MCP's content shape.

    Text content rather than a typed structure, because every consumer of this
    server is a language model and the JSON it reads is more useful rendered than
    wrapped. `isError` is what tells the model its call failed rather than returned
    nothing.
    """
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def challenge_header(issuer: str) -> str:
    """The `WWW-Authenticate` value an unauthenticated caller is answered with.

    This one header is the whole discovery handshake: a client reads it, fetches
    the protected resource metadata it names, finds the authorization server and
    starts the PKCE flow. It is also the only thing an unauthenticated caller ever
    gets from this endpoint.
    """
    base = issuer.rstrip("/")
    return f'Bearer resource_metadata="{base}/.well-known/oauth-protected-resource"'


def parse_request(payload: Any) -> tuple[Optional[Any], str, Mapping[str, Any], bool]:
    """One JSON-RPC message as its id, method, params and whether it is a notification.

    A notification is a message with no `id`, which the specification says must be
    answered with no body at all. Telling the two apart here rather than in the
    handler keeps the 202 path from ever growing a response.
    """
    if not isinstance(payload, Mapping):
        raise ProtocolError(INVALID_REQUEST, "A request must be a JSON object")

    if payload.get("jsonrpc") != JSONRPC_VERSION:
        raise ProtocolError(INVALID_REQUEST, "Only JSON-RPC 2.0 is supported")

    method = payload.get("method")
    if not isinstance(method, str) or not method:
        raise ProtocolError(INVALID_REQUEST, "A request must name a method")

    params = payload.get("params") or {}
    if not isinstance(params, Mapping):
        raise ProtocolError(INVALID_PARAMS, "params must be an object")

    is_notification = "id" not in payload
    return payload.get("id"), method, params, is_notification
