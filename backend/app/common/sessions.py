"""Ending a person's signed in sessions from any function that holds the grant.

A session is a refresh token family in the identity package's own table. Account
deletion ends them in the identity function, and directory deprovisioning ends
them in the workspaces function, so both build the same store here rather than
each knowing the table's name and index.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from app.common.session_audit import Revoker


def revoke_refresh_families(user_id: str, *, revoker: "Revoker | None" = None) -> int:
    """Revoke every refresh family the user holds, or nothing when no issuer is configured.

    Answers how many families were live. Access tokens already issued run out on
    their own short lifetime; nothing can refresh them once this returns. Each live
    session is recorded as revoked by `revoker`, or by the person themselves.
    """
    from contextlib import nullcontext

    from app.common.core.config import get_settings
    from app.common.session_audit import refresh_token_store, revoked_by

    settings = get_settings()
    if not settings.IDENTITY_ISSUER or not user_id:
        return 0
    store = refresh_token_store(settings)
    with revoked_by(revoker) if revoker is not None else nullcontext():
        return store.revoke_all_for_user(user_id)
