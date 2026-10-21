"""Ending a person's signed in sessions from any function that holds the grant.

A session is a refresh token family in the identity package's own table. Account
deletion ends them in the identity function, and directory deprovisioning ends
them in the workspaces function, so both build the same store here rather than
each knowing the table's name and index.
"""

from __future__ import annotations


def revoke_refresh_families(user_id: str) -> int:
    """Revoke every refresh family the user holds, or nothing when no issuer is configured.

    Answers how many families were live. Access tokens already issued run out on
    their own short lifetime; nothing can refresh them once this returns.
    """
    from webbpulse.dynamodb import Repository
    from webbpulse.identity import REFRESH_TOKENS_TABLE, DynamoRefreshTokenStore

    from app.common.core.config import get_settings

    settings = get_settings()
    if not settings.IDENTITY_ISSUER or not user_id:
        return 0
    store = DynamoRefreshTokenStore(
        Repository(
            REFRESH_TOKENS_TABLE,
            prefix=settings.dynamodb_table_prefix,
            endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
        )
    )
    return store.revoke_all_for_user(user_id)
