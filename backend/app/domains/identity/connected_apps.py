"""The OAuth clients a person has authorized, read and revoked through the identity package.

The package owns the grant: `OAuthServerService.revoke_authorization` deletes the
consents and revokes the refresh families behind them, so a revoked client has to
authorize again. This module only builds that service over the same tables and
settings the mounted authorization server uses, and shapes consents into the
per-client view the settings pages render.

The consents table has no tenant index, so a workspace's grants are read one member
at a time. A workspace's membership is bounded, and a platform table change for an
admin view nobody opens often would cost more than the reads it saves.
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from app.domains.identity.oauth_server_glue import MCP_SCOPES

if TYPE_CHECKING:  # pragma: no cover
    from webbpulse.identity import ConsentRecord, OAuthServerService, OAuthServerStores

    from app.common.core.config import Settings


@dataclass(frozen=True)
class Grant:
    """One consent, with the client's display name resolved."""

    client_id: str
    client_name: str
    user_id: str
    tenant_id: str
    scopes: tuple[str, ...]
    granted_at: str
    last_used_at: str


@dataclass
class ConnectedApp:
    """Every grant one person holds to one client, across workspaces."""

    client_id: str
    client_name: str
    grants: list[Grant] = field(default_factory=list)

    @property
    def scopes(self) -> tuple[str, ...]:
        """The union of the scopes granted in every workspace, in the product's fixed order."""
        granted = {scope for grant in self.grants for scope in grant.scopes}
        return tuple(scope for scope in MCP_SCOPES if scope in granted) + tuple(sorted(granted - set(MCP_SCOPES)))

    @property
    def first_authorized_at(self) -> str:
        """When the earliest surviving grant was given."""
        return min((grant.granted_at for grant in self.grants if grant.granted_at), default="")

    @property
    def last_used_at(self) -> str:
        """When any grant was last used, if ever."""
        return max((grant.last_used_at for grant in self.grants if grant.last_used_at), default="")


@dataclass(frozen=True)
class AuthorizationServer:
    """The package's service, which revokes, and the stores it was built over, which list."""

    service: "OAuthServerService"
    stores: "OAuthServerStores"


def build_authorization_server(settings: "Settings") -> AuthorizationServer | None:
    """The package's authorization server service, or `None` when MCP OAuth is off.

    A deployment with no issuer mounts no identity package at all, so it has no
    authorization server either, and its settings are not read.

    Built with the refresh token flows so a revocation reaches the refresh families
    as well as the consents. The stores and settings are the ones `package_glue`
    mounts the server with, so both halves read the same tables.
    """
    from webbpulse.dynamodb import Repository
    from webbpulse.identity import (
        REFRESH_TOKENS_TABLE,
        DynamoRefreshTokenStore,
        IdentityStores,
        OAuthServerService,
        TokenService,
        signing_client,
    )
    from webbpulse.identity.flows import IdentityFlows

    from app.domains.identity.identity_hooks import StanduplessIdentityHooks
    from app.domains.identity.oauth_server_glue import build_oauth_server_stores
    from app.domains.identity.package_glue import build_identity_settings

    if not (settings.IDENTITY_ISSUER or os.environ.get("IDENTITY_ISSUER")):
        return None
    identity_settings = build_identity_settings(settings)
    if not identity_settings.mcp_oauth_enabled:
        return None
    tokens = TokenService(identity_settings, signing_client(identity_settings))
    refresh_tokens = DynamoRefreshTokenStore(
        Repository(
            REFRESH_TOKENS_TABLE,
            prefix=settings.dynamodb_table_prefix,
            endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
        )
    )
    flows = IdentityFlows(
        identity_settings,
        StanduplessIdentityHooks(),
        IdentityStores(refresh_tokens=refresh_tokens),
        tokens,
    )
    stores = build_oauth_server_stores(settings)
    return AuthorizationServer(
        service=OAuthServerService(identity_settings, stores, tokens, flows=flows),
        stores=stores,
    )


def grants_for_user(stores: "OAuthServerStores", user_id: str) -> list[Grant]:
    """Every consent one person holds, oldest first, with client names resolved."""
    return _resolve(stores, stores.consents.list_for_user(user_id))


def grants_for_workspace(stores: "OAuthServerStores", member_ids: Iterable[str], workspace_id: str) -> list[Grant]:
    """Every consent the given members hold in one workspace, oldest first."""
    records = [
        record
        for member_id in member_ids
        for record in stores.consents.list_for_user(member_id)
        if record.tenant_id == workspace_id
    ]
    return _resolve(stores, records)


def group_by_client(grants: Iterable[Grant]) -> list[ConnectedApp]:
    """One entry per client, most recently used first, then by name."""
    apps: dict[str, ConnectedApp] = {}
    for grant in grants:
        app = apps.setdefault(grant.client_id, ConnectedApp(grant.client_id, grant.client_name))
        app.grants.append(grant)
    return sorted(
        apps.values(), key=lambda app: (app.last_used_at or app.first_authorized_at, app.client_name), reverse=True
    )


def _resolve(stores: "OAuthServerStores", records: "Iterable[ConsentRecord]") -> list[Grant]:
    """Pair each consent with its client's name, reading each client once.

    A dynamically registered client that has gone unused past its TTL has no record
    any more, and its grant is shown under its id rather than dropped, so the person
    can still revoke it. Last use is the consent's own, never the client's, because a
    client record is shared by everyone who authorized it.
    """
    names: dict[str, str] = {}
    grants: list[Grant] = []
    for record in records:
        if record.client_id not in names:
            client = stores.clients.get(record.client_id)
            names[record.client_id] = "" if client is None else client.client_name
        client_name = names[record.client_id]
        grants.append(
            Grant(
                client_id=record.client_id,
                client_name=client_name or record.client_id,
                user_id=record.user_id,
                tenant_id=record.tenant_id,
                scopes=tuple(record.scopes),
                granted_at=record.granted_at,
                last_used_at=record.last_used_at,
            )
        )
    return sorted(grants, key=lambda grant: grant.granted_at)
