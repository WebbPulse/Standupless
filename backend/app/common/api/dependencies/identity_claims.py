"""Read the authorizer's identity claims, and verify a Bearer token where there are none.

Reading the claims is `webbpulse.identity.claims`, re-exported here so routes keep
one import. What stays is the product's own fallback: a real verification against
the identity issuer's published keys.

Claims reach a domain function only through the authorizer context, and the gateway
publishes them only for the route keys it enforces a token on. An optional auth route
is never one of those, so without this fallback every signed in caller on those routes
would read as anonymous.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import Request
from webbpulse.identity.claims import (
    GATE_CLAIMS_KEY,
    identity_claims,
    identity_subject,
)

__all__ = [
    "GATE_CLAIMS_KEY",
    "bearer_token",
    "identity_claims",
    "identity_subject",
    "require_identity_subject",
    "reset_verifier",
    "verify_bearer_subject",
    "verify_mcp_bearer_claims",
]

logger = logging.getLogger(__name__)


def bearer_token(request: Request) -> str:
    """The presented Bearer credential, or `""` when there is no usable one."""
    authorization = request.headers.get("authorization", "")
    scheme, _, presented = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return ""
    return presented.strip()


def verify_bearer_subject(request: Request) -> str:
    """The `sub` of a Bearer identity token verified in this process, or `""`.

    A real verification: signature, issuer, audience, expiry and not-before. Every
    failure answers `""` rather than raising, so a bad or expired token on an
    optional auth route is an anonymous caller and not an error.
    """
    from app.common.core.config import settings

    if not settings.IDENTITY_ISSUER.strip():
        return ""

    presented = bearer_token(request)
    if not presented:
        return ""

    verifier = _verifier()
    if verifier is None:
        return ""
    try:
        claims = verifier(presented)
    except Exception:
        logger.debug("An identity access token did not verify.", exc_info=True)
        return ""
    return str(claims.get("sub", "") or "")


def caller_subject(request: Request) -> str:
    """The verified `sub` of whoever is asking, or `""` for nobody.

    Prefers the gateway authorizer's already-checked claims and falls back to
    verifying the presented token here.
    """
    subject = identity_subject(request)
    if subject:
        return subject
    return verify_bearer_subject(request)


def require_identity_subject(request: Request) -> str:
    """The caller's `sub`, or a 401. The dependency an authenticated route names."""
    from fastapi import HTTPException, status

    subject = caller_subject(request)
    if not subject:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error_code": "NOT_AUTHENTICATED", "message": "Sign in first."},
        )
    return subject


def verify_mcp_bearer_claims(request: Request) -> Optional[Any]:
    """The verified claims of an MCP access token on this request, or `None`.

    An MCP token is an ordinary product access token with two differences that matter
    here. Its `aud` is the RFC 8707 resource, which is the MCP endpoint's own URL rather
    than `IDENTITY_AUDIENCE`, so it is verified against `IDENTITY_MCP_RESOURCE_URL`. And
    the gateway route for `/api/mcp` carries `authorization_type = "NONE"` so the endpoint
    can answer the discovery challenge itself, which means no authorizer ever runs and the
    signature has to be checked in this process.

    Verification is the package's `JwksVerifier` over the issuer's published key set:
    RS256, `iss`, `aud`, `exp` and `nbf`, with no KMS grant. Every failure answers `None`
    rather than raising, because the caller turns a refusal into the challenge response and
    must not be able to tell a forged token from an expired one.
    """
    presented = bearer_token(request)
    if not presented:
        return None

    verifier = _mcp_verifier()
    if verifier is None:
        return None
    try:
        claims = verifier(presented)
    except Exception:
        logger.debug("An MCP access token did not verify.", exc_info=True)
        return None

    from webbpulse.identity.claims import AuthorizerClaims

    return AuthorizerClaims(claims)


_verifier_cache: Optional[Any] = None
_verifier_failed = False

_mcp_verifier_cache: Optional[Any] = None
_mcp_verifier_failed = False


def _mcp_verifier() -> Optional[Any]:
    """The memoised callable verifying an MCP token, or `None` where none can be built.

    Separate from `_verifier` because the two check different audiences against the same
    issuer, and a `JwksVerifier` binds its audience at construction. Both share the key set
    over the wire, so the second instance costs one extra fetch per execution environment.
    """
    global _mcp_verifier_cache, _mcp_verifier_failed

    if _mcp_verifier_cache is not None:
        return _mcp_verifier_cache
    if _mcp_verifier_failed:
        return None

    from app.common.core.config import settings

    try:
        from webbpulse.identity import JwksVerifier

        issuer = settings.IDENTITY_ISSUER.strip()
        resource = settings.IDENTITY_MCP_RESOURCE_URL.strip()
        if not issuer or not resource:
            raise ValueError("IDENTITY_ISSUER and IDENTITY_MCP_RESOURCE_URL are both required")

        verifier = JwksVerifier(
            issuer=issuer,
            audience=resource,
            jwks_uri=settings.IDENTITY_JWKS_URL.strip() or None,
        )
        _mcp_verifier_cache = verifier.verify
    except Exception:
        _mcp_verifier_failed = True
        logger.debug(
            "No in-process MCP token verifier on this function, so an OAuth bearer cannot be "
            "verified here and only an API key reaches the MCP endpoint.",
            exc_info=True,
        )
        return None
    return _mcp_verifier_cache


def _verifier() -> Optional[Any]:
    """The memoised callable that verifies a token, or `None` where none can be built.

    A domain function holds only the issuer and the audience, so it verifies against
    the issuer's published key set and needs no KMS grant. A failure is remembered:
    without the environment the settings raise, and retrying that per request would
    be a pydantic validation on every call.
    """
    global _verifier_cache, _verifier_failed

    if _verifier_cache is not None:
        return _verifier_cache
    if _verifier_failed:
        return None

    from app.common.core.config import settings

    try:
        from webbpulse.identity import JwksVerifier

        audience = settings.IDENTITY_AUDIENCE.strip()
        if not audience:
            raise ValueError("IDENTITY_AUDIENCE is required to verify a token in process")

        verifier = JwksVerifier(
            issuer=settings.IDENTITY_ISSUER.strip(),
            audience=audience,
            jwks_uri=settings.IDENTITY_JWKS_URL.strip() or None,
        )
        _verifier_cache = verifier.verify
    except Exception:
        _verifier_failed = True
        logger.debug(
            "No in-process identity verifier on this function, so a Bearer identity token "
            "cannot be verified here and an optional auth caller reads as anonymous.",
            exc_info=True,
        )
        return None
    return _verifier_cache


def reset_verifier() -> None:
    """Drop the memoised verifiers. For tests that change the environment."""
    global _verifier_cache, _verifier_failed, _mcp_verifier_cache, _mcp_verifier_failed

    _verifier_cache = None
    _verifier_failed = False
    _mcp_verifier_cache = None
    _mcp_verifier_failed = False
