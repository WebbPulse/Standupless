"""The users-table stream purge the identity package router mounts.

Drives the package's stream route over the stores this product's glue builds, because
the value under test is the wiring: a store left out of the glue is a table the purge
silently skips, and for `api-keys`, which has no TTL, that is a key left behind forever.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER, OWNER
from tests.domains.identity.test_oauth_server import client, identity_environment, oauth_tables

__all__ = ["client", "identity_environment", "oauth_tables"]

WORKSPACE = "01JB00000000000000000000W1"


def _key(user_id: str) -> Any:
    """A personal API key record for one user."""
    from webbpulse.identity.api_keys import ApiKeyRecord

    return ApiKeyRecord(
        key_hash=f"hash-{user_id}",
        key_id=f"key-{user_id}",
        user_id=user_id,
        tenant_id=WORKSPACE,
        name="laptop",
        prefix="sl_test",
        scopes=("issues:read",),
        created_at="2026-09-01T00:00:00Z",
    )


def _remove_record(user_id: str) -> dict[str, Any]:
    """The `REMOVE` record the users-table stream sends when a users row is deleted."""
    return {
        "eventID": f"remove-{user_id}",
        "eventName": "REMOVE",
        "eventSource": "aws:dynamodb",
        "dynamodb": {"Keys": {"id": {"S": user_id}}},
    }


def test_purging_a_deleted_user_deletes_their_api_keys(client: TestClient, repositories: Any) -> None:
    """The purged user's keys are gone and another user's key is untouched."""
    from webbpulse.events import events_path

    repositories.api_keys.put(_key(MEMBER))
    repositories.api_keys.put(_key(OWNER))

    response = client.post(events_path(), json={"Records": [_remove_record(MEMBER)]})

    assert response.status_code == 200, response.text
    assert response.json() == {"batchItemFailures": []}
    assert repositories.api_keys.list_for_user(MEMBER) == []
    assert [record.key_id for record in repositories.api_keys.list_for_user(OWNER)] == [f"key-{OWNER}"]
