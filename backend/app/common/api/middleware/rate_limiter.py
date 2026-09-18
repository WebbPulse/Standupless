"""Rate limiting middleware, backed by the shared DynamoDB counter.

Counting in the table rather than in a process is what makes the limit real on
Lambda, where every execution environment would otherwise hold its own count.
Every backend failure fails open, so an outage costs availability nothing.

Requests are classified first, so a page's read fanout counts against a generous
GET allowance instead of the cap that guards credential endpoints. CORS
preflights carry no data and are never counted at all.

Staging is never rate limited, by the shared `webbpulse` convention that
`settings.rate_limiting_enabled` carries.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Tuple

from fastapi import Request
from fastapi.responses import Response
from webbpulse.ratelimit import LimitClass

from app.common.core.config import settings

logger = logging.getLogger(__name__)

RATE_LIMIT_EXEMPT_EXACT: Tuple[str, ...] = ("/", "/health", "/ready", "/openapi.json")

RATE_LIMIT_EXEMPT_PREFIXES: Tuple[str, ...] = ("/docs", "/redoc")

RATE_LIMIT_EXEMPT_METHODS: Tuple[str, ...] = ("OPTIONS",)

WINDOW_SECONDS = 60

GET_CLASS = "get"

AUTH_CLASS = "auth"

DEFAULT_CLASS = "default"

AUTH_PATH_PREFIX = "/api/auth"

AUTH_CLASS_EXEMPT_PATHS: frozenset[str] = frozenset(
    {
        f"{AUTH_PATH_PREFIX}/refresh",
        f"{AUTH_PATH_PREFIX}/logout",
    }
)


def limit_classes() -> list[LimitClass]:
    """The three classes, narrowest first, since `classify` takes the first match.

    Each name doubles as the counter namespace and as the policy name on the
    `RateLimit` headers, so it stays a plain word rather than a storage key.
    """
    return [
        LimitClass(
            name=GET_CLASS,
            limit=settings.RATE_LIMIT_GET_REQUESTS_PER_MINUTE,
            window_seconds=WINDOW_SECONDS,
            methods=("GET",),
        ),
        LimitClass(
            name=AUTH_CLASS,
            limit=settings.RATE_LIMIT_AUTH_REQUESTS_PER_MINUTE,
            window_seconds=WINDOW_SECONDS,
            path_prefixes=(AUTH_PATH_PREFIX,),
            exempt_paths=tuple(sorted(AUTH_CLASS_EXEMPT_PATHS)),
        ),
        LimitClass(
            name=DEFAULT_CLASS,
            limit=settings.RATE_LIMIT_REQUESTS_PER_MINUTE,
            window_seconds=WINDOW_SECONDS,
        ),
    ]


def is_rate_limit_exempt(path: str) -> bool:
    """Return True when `path` is exempt from rate limiting.

    Exemption is deliberately split into two kinds. Entries in
    `RATE_LIMIT_EXEMPT_EXACT` are matched exactly, so the root path "/" exempts
    only itself rather than the whole API.
    """
    if path in RATE_LIMIT_EXEMPT_EXACT:
        return True
    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in RATE_LIMIT_EXEMPT_PREFIXES)


def is_rate_limit_exempt_method(method: str) -> bool:
    """Return True when `method` is never counted.

    CORS preflights carry no payload and the CORS middleware answers them, so
    counting them spends a real caller's allowance on browser bookkeeping.
    """
    return method.upper() in RATE_LIMIT_EXEMPT_METHODS


def rate_limiting_enabled() -> bool:
    """Whether the middleware should count this process's requests at all.

    Staging is never rate limited: `settings.rate_limiting_enabled` carries the
    shared `webbpulse` convention, so every deployment named staging turns the
    limiter off without a per-product variable.
    """
    if not settings.rate_limiting_enabled:
        return False
    if not settings.ENABLE_RATE_LIMITING:
        return False
    if os.getenv("ENABLE_RATE_LIMITING", "true").lower() == "false":
        return False
    return settings.ENABLE_SHARED_RATE_LIMITING


def _source_ip_from_context(context: Any) -> str:
    """Pull the source IP out of one API Gateway request context mapping."""
    if not isinstance(context, dict):
        return ""

    http_section = context.get("http")
    if isinstance(http_section, dict):
        source_ip = http_section.get("sourceIp")
        if isinstance(source_ip, str) and source_ip:
            return source_ip

    identity = context.get("identity")
    if isinstance(identity, dict):
        source_ip = identity.get("sourceIp")
        if isinstance(source_ip, str) and source_ip:
            return source_ip

    return ""


def client_identity(request: Request) -> str:
    """The caller's IP as API Gateway observed it.

    `webbpulse.http.client_ip` reads the forwarded request context header and never
    trusts `X-Forwarded-For`. Two shapes it does not cover are tried first: a context
    nested under `requestContext`, and the `aws.event` scope key an event-driven
    adapter populates.
    """
    from webbpulse.http import REQUEST_CONTEXT_HEADER, client_ip

    raw = request.headers.get(REQUEST_CONTEXT_HEADER)
    if raw:
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            parsed = None
        if isinstance(parsed, dict):
            source_ip = _source_ip_from_context(parsed.get("requestContext"))
            if source_ip:
                return source_ip

    event = request.scope.get("aws.event")
    if isinstance(event, dict):
        source_ip = _source_ip_from_context(event.get("requestContext"))
        if source_ip:
            return source_ip

    return client_ip(request)


def build_rate_limit_middleware(**kwargs: Any) -> Any:
    """The configured shared middleware: three classes over the first-request window."""
    from webbpulse.ratelimit import rate_limit_middleware as shared_middleware

    return shared_middleware(
        limit_classes(),
        identity_fn=client_identity,
        exempt_paths=RATE_LIMIT_EXEMPT_EXACT,
        exempt_prefixes=RATE_LIMIT_EXEMPT_PREFIXES,
        exempt_methods=RATE_LIMIT_EXEMPT_METHODS,
        anchor="first_request",
        count_attribute="requests",
        enabled=rate_limiting_enabled,
        **kwargs,
    )


_middleware: Any = None


async def rate_limit_middleware(request: Request, call_next: Any) -> Response:
    """Count one request against the shared window and reject it once spent.

    Built on first call rather than at import, so the caps come from settings as
    they are at request time and no table resource is created during an import.
    """
    global _middleware
    if _middleware is None:
        _middleware = build_rate_limit_middleware()
    return await _middleware(request, call_next)


def reset_rate_limit_middleware() -> None:
    """Drop the built middleware so the next request rebuilds it. For tests."""
    global _middleware
    _middleware = None
