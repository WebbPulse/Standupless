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
from webbpulse.identity import (
    JwksVerifier,
    bearer_credential,
    cached_verifier,
    clear_verifier_cache,
    verified_bearer_subject,
)
from webbpulse.identity.claims import (
    GATE_CLAIMS_KEY,
    identity_claims,
    identity_subject,
)

__all__ = [
    "GATE_CLAIMS_KEY",
    "bearer_credential",
    "clear_verifier_cache",
    "identity_claims",
    "identity_subject",
    "require_identity_subject",
    "verify_bearer_subject",
    "verify_mcp_bearer_claims",
]

logger = logging.getLogger(__name__)


def verify_bearer_subject(request: Request) -> str:
    """The `sub` of a Bearer identity token verified in this process, or `""`.

    A real verification: signature, issuer, audience, expiry and not-before, through
    `webbpulse.identity.verified_bearer_subject`. Every failure answers `""` rather than
    raising, so a bad or expired token on an optional auth route is an anonymous caller
    and not an error.
    """
    return verified_bearer_subject(request, _verifier())


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
    presented = bearer_credential(request)
    if not presented:
        return None

    verifier = _mcp_verifier()
    if verifier is None:
        return None
    try:
        claims = verifier.verify(presented)
    except Exception:
        logger.debug("An MCP access token did not verify.", exc_info=True)
        return None

    from webbpulse.identity.claims import AuthorizerClaims

    return AuthorizerClaims(claims)


def _identity_settings() -> Optional[Any]:
    """The product settings, or `None` on a function whose environment cannot build them."""
    try:
        from app.common.core.config import settings

        return settings
    except Exception:
        logger.debug("No identity settings on this function.", exc_info=True)
        return None


def _mcp_verifier() -> Optional[JwksVerifier]:
    """The shared verifier for an MCP token, its audience the MCP resource, or `None`.

    Separate from `_verifier` because the two check different audiences against the same
    issuer. `cached_verifier` keeps one instance per issuer, audience and key set URI for
    the life of the execution environment.
    """
    settings = _identity_settings()
    if settings is None:
        return None
    return cached_verifier(
        settings.IDENTITY_ISSUER,
        settings.IDENTITY_MCP_RESOURCE_URL,
        jwks_uri=settings.IDENTITY_JWKS_URL,
    )


def _verifier() -> Optional[JwksVerifier]:
    """The shared verifier for a product identity token, or `None` where none can be built.

    A domain function holds only the issuer and the audience, so it verifies against
    the issuer's published key set and needs no KMS grant.
    """
    settings = _identity_settings()
    if settings is None:
        return None
    return cached_verifier(
        settings.IDENTITY_ISSUER,
        settings.IDENTITY_AUDIENCE,
        jwks_uri=settings.IDENTITY_JWKS_URL,
    )
