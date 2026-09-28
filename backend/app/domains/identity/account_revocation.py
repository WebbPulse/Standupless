"""Ending every way a deleted account can still reach the API, in the deletion request.

The account is already marked deleted when this runs, and the identity hooks refuse
any sign in or refresh for a marked account, so each step here only shortens the
time a credential issued earlier keeps working. A step that fails is logged and the
rest still run; the account purge that follows deletes the same rows again.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:  # pragma: no cover
    from app.common.api.dependencies.repositories import Repositories

_log = logging.getLogger(__name__)


@dataclass
class Revocation:
    """How many of each credential the deletion revoked, and which steps failed."""

    refresh_records: int = 0
    connected_apps: int = 0
    api_keys: int = 0
    failed: tuple[str, ...] = ()


def revoke_account_access(repositories: "Repositories", user_id: str) -> Revocation:
    """Revoke every refresh family, every OAuth grant and every personal API key of one user.

    Refresh families cover browser sessions and MCP clients alike. Revoking each
    connected app also deletes its consents, so an MCP client has to authorize again
    and cannot, because the account may no longer sign in. Access tokens already
    minted run out on their own short lifetime, and every route refuses a deleted
    account or finds its memberships gone once the purge removes them.
    """
    result = Revocation()
    failed: list[str] = []

    def attempt(name: str, step: Callable[[], int]) -> int:
        """Run one revocation, logging and recording a failure rather than raising it."""
        try:
            return step()
        except Exception:
            failed.append(name)
            _log.exception(
                "An account deletion could not revoke one kind of credential.",
                extra={"event": "account.deletion.revoke_failed", "user_id": user_id, "credential": name},
            )
            return 0

    result.refresh_records = attempt("refresh_tokens", lambda: _revoke_refresh_families(user_id))
    result.connected_apps = attempt("connected_apps", lambda: _revoke_connected_apps(user_id))
    result.api_keys = attempt("api_keys", lambda: repositories.api_keys.delete_all_for_user(user_id))
    result.failed = tuple(failed)
    return result


def _revoke_refresh_families(user_id: str) -> int:
    """Revoke every refresh family the user holds, or nothing when no issuer is configured."""
    from webbpulse.dynamodb import Repository
    from webbpulse.identity import REFRESH_TOKENS_TABLE, DynamoRefreshTokenStore

    from app.common.core.config import get_settings

    settings = get_settings()
    if not settings.IDENTITY_ISSUER:
        return 0
    store = DynamoRefreshTokenStore(
        Repository(
            REFRESH_TOKENS_TABLE,
            prefix=settings.dynamodb_table_prefix,
            endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
        )
    )
    return store.revoke_all_for_user(user_id)


def _revoke_connected_apps(user_id: str) -> int:
    """Withdraw the user's grant to every OAuth client, returning how many clients it covered."""
    from app.common.core.config import get_settings
    from app.domains.identity.connected_apps import build_authorization_server

    server = build_authorization_server(get_settings())
    if server is None:
        return 0
    client_ids = sorted({record.client_id for record in server.stores.consents.list_for_user(user_id)})
    for client_id in client_ids:
        server.service.revoke_authorization(user_id, client_id)
    return len(client_ids)
