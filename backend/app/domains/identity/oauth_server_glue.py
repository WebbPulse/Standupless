"""What the identity package's OAuth 2.1 authorization server needs from this product.

The package owns every endpoint, the PKCE checks, the code exchange and the token
minting. Three things it cannot know are supplied here: where the three tables live,
which workspaces a consenting user may bind a token to, and which scopes that
workspace's membership actually allows.

The tenant resolver reads the membership model directly rather than through the
request's repository bundle, because the package calls it as a plain callable with no
request in hand. The repositories it builds are the same ones the routes use, so a test
binding moto tables sees them too.

The package's built-in consent screen is kept, branded by `consent_theme.py`. Its form
carries an HMAC over the authorization parameters, so a renderer that edited the scopes
it shows would post a form the package then refuses; narrowing belongs where both
halves of the intersection exist at once, which is `require` in
`app/common/api/dependencies/authz.py`, on every request.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from app.common.db.dynamo.api_keys import API_KEY_SCOPES

if TYPE_CHECKING:  # pragma: no cover
    from webbpulse.identity import OAuthServerStores, TenantChoice

    from app.common.core.config import Settings

MCP_SCOPES: tuple[str, ...] = API_KEY_SCOPES
"""The scopes `/authorize` will grant, which are exactly the scopes an API key may carry.

Named here rather than left to `IDENTITY_MCP_SCOPES_SUPPORTED` so the authorization
server and the API keys cannot be given different sets by an environment edit: a token
the server would grant but no route would honour is a scope that only ever refuses.

A client that names no scope is granted all of them, `admin` included. That is safe
because every request intersects the token's scopes with the live ceiling of the
holder's role, and `admin` is live only for an owner or an admin, so a member's
default grant carries it inertly. It is included because the MCP clients people
connect with do not let them pick scopes, and an owner driving the workspace from an
agent needs it for role changes and removals.
"""


def build_oauth_server_stores(settings: "Settings") -> "OAuthServerStores":
    """The package's three Dynamo backed stores, over this product's table prefix.

    The package's own stores are instantiated rather than reimplemented: `consume` is
    one conditional delete and a hand written copy would be the place single use is
    quietly lost.
    """
    from webbpulse.dynamodb import Repository
    from webbpulse.identity import (
        AUTHORIZATION_CODES_TABLE,
        ConsentRecord,
        OAUTH_CLIENTS_TABLE,
        OAUTH_CONSENTS_TABLE,
        DynamoAuthorizationCodeStore,
        DynamoConsentStore,
        DynamoOAuthClientStore,
        OAuthServerStores,
    )

    def repository(logical_name: str) -> Repository:
        """A package repository for one of the authorization server's tables."""
        return Repository(
            logical_name,
            prefix=settings.dynamodb_table_prefix,
            endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
        )

    clients = DynamoOAuthClientStore(repository(OAUTH_CLIENTS_TABLE))

    class AuditedConsentStore(DynamoConsentStore):
        """The package's consent store, recording each first grant in the workspace audit log."""

        def put(self, record: ConsentRecord) -> None:
            """Write the grant, then audit it when it is new rather than a re-authorization."""
            super().put(record)
            if record.tenant_id and (not record.granted_at or record.granted_at == record.updated_at):
                client = clients.get(record.client_id)
                audit_connected_app(
                    record.tenant_id,
                    record.user_id,
                    record.client_id,
                    client.client_name if client is not None else record.client_id,
                    list(record.scopes),
                )

    return OAuthServerStores(
        clients=clients,
        codes=DynamoAuthorizationCodeStore(repository(AUTHORIZATION_CODES_TABLE)),
        consents=AuditedConsentStore(repository(OAUTH_CONSENTS_TABLE)),
    )


def audit_connected_app(workspace_id: str, user_id: str, client_id: str, client_name: str, scopes: list[str]) -> None:
    """Record that a member authorized a connected app in one workspace.

    The package calls the consent store with no request in hand, so the entry
    carries the person and the client but no address.
    """
    from app.common import audit
    from app.common.api.dependencies.repositories import build_bundle

    audit.record_system(
        build_bundle(("audit",), name="identity-consents"),
        workspace_id,
        "connected_app.authorized",
        actor_id=user_id,
        actor_kind="user",
        source="mcp",
        target_type="connected_app",
        target_id=client_id,
        target_label=client_name,
        after={"scopes": scopes},
    )


def allowed_scopes(user_id: str, workspace_id: str) -> tuple[str, ...]:
    """The scopes this user's membership in this workspace permits, in fixed order.

    The membership leg of the intersection the contract fixes. A caller who is not a
    member gets nothing, which is what makes a workspace with no delegable scope no
    workspace to consent in.
    """
    from app.common.api.dependencies.authz import live_scopes_for
    from app.common.db.dynamo.memberships import MembershipRepository

    membership = MembershipRepository().get(workspace_id, user_id)
    if membership is None:
        return ()
    live = set(live_scopes_for(membership.role, user_id))
    return tuple(scope for scope in MCP_SCOPES if scope in live)


def resolve_tenants(user_id: str, has_two_factor: Callable[[str], bool] | None = None) -> "list[TenantChoice]":
    """The workspaces this user may bind an MCP token to, in membership order.

    Consent names exactly one of these and the token carries it as its tenant claim, so
    this list is the whole of what an authorization can ever reach. The package checks
    the consented tenant against this same list, which is what stops a form edited in
    the browser binding a token to somebody else's workspace.

    A workspace whose membership delegates no scope at all is left out rather than
    offered: consenting there could only ever produce a token that refuses everything.
    A user with no membership gets an empty list, which the consent screen renders as
    nothing to grant rather than as a free choice.

    A workspace requiring two-factor authentication is left out too while the user
    has none, because the token would otherwise reach a workspace their own session
    cannot. With no `has_two_factor` to ask, the user is taken to have none.
    """
    from webbpulse.identity import TenantChoice

    from app.common.db.dynamo.memberships import MembershipRepository
    from app.common.db.dynamo.workspaces import WorkspaceRepository

    memberships = MembershipRepository().list_workspaces_for_user(user_id)
    if not memberships:
        return []

    repository = MembershipRepository()
    workspaces = WorkspaceRepository().get_many([membership.workspace_id for membership in memberships])
    two_factor: bool | None = None
    choices: list[TenantChoice] = []
    for membership in memberships:
        if not allowed_scopes(user_id, membership.workspace_id):
            continue
        if repository.get_auth_policy(membership.workspace_id).require_two_factor:
            if two_factor is None:
                two_factor = has_two_factor is not None and has_two_factor(user_id)
            if not two_factor:
                continue
        workspace = workspaces.get(membership.workspace_id)
        choices.append(TenantChoice(id=membership.workspace_id, name=workspace.name if workspace is not None else ""))
    return choices
