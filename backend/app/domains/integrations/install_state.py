"""The signed `state` that carries a workspace through the GitHub install redirect.

The same shape as the M3 upload ticket and for the same reason: the callback is
reached with no session, by a browser GitHub redirected, so something in the request
has to name the workspace and be unforgeable. A signed token does that, and its
`nonce` is claimed in `idempotency` only when the callback redeems it, so an install
that is started and abandoned leaves no row while a redeemed state cannot be
redeemed twice.

The audience is pinned to this one use, so an upload ticket cannot be replayed as an
install state even though both are signed with the same application secret.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Protocol

import jwt
from webbpulse.security import DEFAULT_ALGORITHM, ExpiredToken, InvalidToken, create_token, decode_token

from app.common.core.config import settings

STATE_AUDIENCE = "standupless.github-install"

NONCE_SCOPE = "github-install-state"

PLATFORM_SCOPE = "_platform"

STATE_TTL_SECONDS = 600
"""Ten minutes, which is an install flow rather than a session.

Short because the token authenticates the callback outright: the window in which a
leaked state could be redeemed by someone else is exactly this.
"""


class StateError(Exception):
    """A state was absent, malformed, expired, already redeemed or signed for another purpose."""


class _Claims(Protocol):
    """The slice of the idempotency repository a redemption needs."""

    def claim(self, workspace_id: str, scope: str, key: str, *, ttl_seconds: float = ...) -> bool:
        """Claim one key, answering whether this caller won it."""
        ...


def mint_state(workspace_id: str, user_id: str) -> tuple[str, datetime]:
    """A signed state binding this install to one workspace, and when it expires."""
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=STATE_TTL_SECONDS)
    token = create_token(
        {"workspace_id": workspace_id, "user_id": user_id, "nonce": secrets.token_urlsafe(16)},
        settings.SECRET_KEY,
        expires_in=timedelta(seconds=STATE_TTL_SECONDS),
        audience=STATE_AUDIENCE,
    )
    return token, expires_at


def read_state(state: str) -> Mapping[str, Any]:
    """The claims of a valid state, or `StateError`.

    Every failure is the same exception with no detail, because the caller is
    unauthenticated and the difference between "expired" and "forged" is not
    something an unauthenticated caller is owed.
    """
    if not state:
        raise StateError("missing state")
    try:
        claims = decode_token(
            state,
            settings.SECRET_KEY,
            audience=STATE_AUDIENCE,
            require=["exp", "iat", "workspace_id", "user_id", "nonce"],
        )
    except (ExpiredToken, InvalidToken) as error:
        raise StateError("invalid state") from error
    workspace_id = str(claims.get("workspace_id", ""))
    if not workspace_id:
        raise StateError("invalid state")
    return claims


def redeem_state(state: str, idempotency: _Claims) -> Mapping[str, Any]:
    """The claims of a valid state that has not been redeemed before, or `StateError`.

    The nonce claim outlives the token, so a state replayed from a browser history
    inside its ten minutes finds the claim already taken.
    """
    claims = read_state(state)
    nonce = str(claims.get("nonce", ""))
    if not nonce or not idempotency.claim(PLATFORM_SCOPE, NONCE_SCOPE, nonce, ttl_seconds=STATE_TTL_SECONDS * 2):
        raise StateError("state already redeemed")
    return claims


def workspace_hint(state: str) -> str:
    """The workspace a state was minted for, even when it has expired or been redeemed.

    Only ever used to choose which settings page a refused callback lands on, so an
    admin whose state went stale is sent back to their own workspace rather than to
    the workspace list. The signature is still checked, so a forged state names
    nothing.
    """
    try:
        claims = jwt.decode(
            state,
            settings.SECRET_KEY,
            algorithms=[DEFAULT_ALGORITHM],
            audience=STATE_AUDIENCE,
            options={"verify_exp": False},
        )
    except jwt.PyJWTError:
        return ""
    return str(claims.get("workspace_id", ""))
