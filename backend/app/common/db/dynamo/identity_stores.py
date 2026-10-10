"""The identity package's API key, share token and OAuth link stores, bound to this product's tables.

Standupless holds no identity persistence of its own. The package owns the schema,
the verification and the revocation for both credentials, and the identity
Terraform module owns the tables, so what lives here is the binding between them
and nothing else.

Both stores are constructed the way every other repository in the registry is, by
suffix through `webbpulse.dynamodb.Repository`, which resolves the same
`standupless-<environment>-` prefix the module names its tables with. That is why
no table name environment variable is needed: the module's `${name_prefix}-${key}`
and this product's prefix are the same string.
"""

from __future__ import annotations

from typing import Any, Mapping, cast

from boto3.dynamodb.conditions import Attr, ConditionBase
from webbpulse.dynamodb import Repository
from webbpulse.identity.api_keys import API_KEYS_TABLE, ApiKeyRecord, DynamoApiKeyStore
from webbpulse.identity.oauth import OAUTH_LINKS_TABLE, DynamoOAuthLinkStore
from webbpulse.identity.share_tokens import SHARE_TOKENS_TABLE, DynamoShareTokenStore

from app.common.db.dynamo.base import build_identity_repository


class _ItemCapture:
    """Stands in for a repository so the package store renders a record's item without writing it."""

    def __init__(self) -> None:
        """Start with nothing captured."""
        self.item: Mapping[str, Any] = {}

    def put(self, item: Mapping[str, Any], condition: ConditionBase | None = None) -> None:
        """Keep the item the store would have written."""
        del condition
        self.item = dict(item)


def _live_key() -> ConditionBase:
    """The condition that a key row exists and is not yet revoked."""
    return Attr("key_hash").exists() & (Attr("revoked_at").not_exists() | Attr("revoked_at").eq(""))


class ApiKeyStoreRepository(DynamoApiKeyStore):
    """The package's `DynamoApiKeyStore` over this environment's `api-keys` table.

    Subclassed only so the registry can build it the way it builds every other
    repository, with an optional injected repository for the read-only case. None
    of the store's behaviour is overridden.

    The repository is also kept as `_repository`, the name every product repository
    holds its own under, so a read-only grant is asserted against this store the
    same way it is against the rest rather than through the package's own spelling.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_identity_repository(API_KEYS_TABLE, repository)
        super().__init__(self._repository)

    def put_action(self, record: ApiKeyRecord) -> dict[str, Any]:
        """A transaction Put of a freshly minted key, in exactly the shape the package store writes."""
        capture = _ItemCapture()
        DynamoApiKeyStore(cast(Repository, capture)).put(record)
        return self._repository.put_action(dict(capture.item), condition=Attr("key_hash").not_exists())

    def revoke_action(self, key_hash: str, *, revoked_at: str) -> dict[str, Any]:
        """A transaction Update revoking one live key, failing its condition when already revoked."""
        return self._repository.update_action(
            {"key_hash": key_hash},
            update_expression="SET #revoked = :revoked",
            expression_values={":revoked": revoked_at},
            expression_names={"#revoked": "revoked_at"},
            condition=_live_key(),
        )

    def delete_live_action(self, key_hash: str) -> dict[str, Any]:
        """A transaction Delete of one key that is still live, so its slot is freed exactly once."""
        return self._repository.delete_action({"key_hash": key_hash}, condition=_live_key())

    def count_live_for_tenant(self, tenant_id: str) -> int:
        """How many keys of one tenant are not revoked, from the tenant index."""
        if not tenant_id:
            return 0
        return len([record for record in self.list_for_tenant(tenant_id) if not record.is_revoked])


class ShareTokenStoreRepository(DynamoShareTokenStore):
    """The package's `DynamoShareTokenStore` over this environment's `share-tokens` table.

    Subclassed for the same reason as `ApiKeyStoreRepository`, and overriding
    nothing.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_identity_repository(SHARE_TOKENS_TABLE, repository)
        super().__init__(self._repository)


class OAuthLinkStoreRepository(DynamoOAuthLinkStore):
    """The package's `DynamoOAuthLinkStore` over this environment's `oauth-links` table.

    Read by the GitHub issue sync alone, to turn a GitHub account id into the
    Standupless user who linked it and back, which is how an assignee crosses
    between the two sides. Subclassed for the same reason as `ApiKeyStoreRepository`,
    and overriding nothing.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_identity_repository(OAUTH_LINKS_TABLE, repository)
        super().__init__(self._repository)
