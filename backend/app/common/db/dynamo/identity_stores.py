"""The identity package's API key and share token stores, bound to this product's tables.

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

from webbpulse.dynamodb import Repository
from webbpulse.identity.api_keys import API_KEYS_TABLE, DynamoApiKeyStore
from webbpulse.identity.share_tokens import SHARE_TOKENS_TABLE, DynamoShareTokenStore

from app.common.db.dynamo.base import build_identity_repository


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


class ShareTokenStoreRepository(DynamoShareTokenStore):
    """The package's `DynamoShareTokenStore` over this environment's `share-tokens` table.

    Subclassed for the same reason as `ApiKeyStoreRepository`, and overriding
    nothing.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_identity_repository(SHARE_TOKENS_TABLE, repository)
        super().__init__(self._repository)
