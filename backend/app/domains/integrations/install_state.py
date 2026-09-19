"""The signed `state` that carries a workspace through the GitHub install redirect.

The same shape as the M3 upload ticket and for the same reason: the callback is
reached with no session, by a browser GitHub redirected, so something in the request
has to name the workspace and be unforgeable. A signed token does that without a
stored nonce, which means an install that is started and abandoned leaves no row to
expire.

The audience is pinned to this one use, so an upload ticket cannot be replayed as an
install state even though both are signed with the same application secret.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from webbpulse.security import ExpiredToken, InvalidToken, create_token, decode_token

from app.common.core.config import settings

STATE_AUDIENCE = "standupless.github-install"

STATE_TTL_SECONDS = 600
"""Ten minutes, which is an install flow rather than a session.

Short because the token authenticates the callback outright: the window in which a
leaked state could be redeemed by someone else is exactly this.
"""


class StateError(Exception):
    """A state was absent, malformed, expired or signed for another purpose."""


def mint_state(workspace_id: str, user_id: str) -> tuple[str, datetime]:
    """A signed state binding this install to one workspace, and when it expires."""
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=STATE_TTL_SECONDS)
    token = create_token(
        {"workspace_id": workspace_id, "user_id": user_id},
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
            require=["exp", "workspace_id", "user_id"],
        )
    except (ExpiredToken, InvalidToken) as error:
        raise StateError("invalid state") from error
    workspace_id = str(claims.get("workspace_id", ""))
    if not workspace_id:
        raise StateError("invalid state")
    return claims
