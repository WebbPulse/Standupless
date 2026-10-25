"""The consent gate that holds a third-party app for admin approval, and its refresh twin.

The package's consent route validates the form, its signature and the chosen
workspace, then writes the grant through the consent store before it issues a code.
The gate sits in that write, so it runs only on a consent the package has already
accepted, and an edited or forged form never reaches it. A refused consent raises a
303 to the request page instead of writing, so no grant and no code exist.

The store has no request in hand, so `capture_consent_request` keeps the posted
authorization parameters for the length of the request, the same way
`capture_request` keeps the caller's address. A grant written anywhere else, such as
a person widening their own grant, carries no captured consent and is never gated.

A grant that already exists keeps refreshing unless an admin denied the app, which
`refresh_refused_for` answers for the refresh guard.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextvars import ContextVar
from typing import TYPE_CHECKING
from urllib.parse import parse_qsl

from fastapi import HTTPException, Request, status

from app.common.app_approvals import mint_request_ticket, needs_approval, refresh_refused, request_page_url, return_to

if TYPE_CHECKING:  # pragma: no cover
    from webbpulse.identity import ConsentRecord, ConsentStore, OAuthClientStore, OAuthServerStores

CONSENT_SUFFIX = "/authorize/consent"
"""The tail of the package's consent route, under whatever issuer path it mounts at."""

_consent: ContextVar[dict[str, str] | None] = ContextVar("standupless_consent_request", default=None)


async def capture_consent_request(request: Request) -> AsyncIterator[None]:
    """A route dependency that keeps a consent post's authorization parameters for the consent store."""
    params: dict[str, str] | None = None
    if request.method == "POST" and request.url.path.endswith(CONSENT_SUFFIX):
        body = await request.body()
        params = dict(parse_qsl(body.decode("utf-8", errors="replace"), keep_blank_values=True))
    token = _consent.set(params)
    try:
        yield
    finally:
        try:
            _consent.reset(token)
        except ValueError:
            _consent.set(None)


def gate_consent(clients: "OAuthClientStore", consents: "ConsentStore", record: "ConsentRecord") -> None:
    """Refuse a consent the workspace must approve first, by redirecting to the request page.

    Reads the workspace switch first, so a workspace without it pays one read. The
    redirect carries a signed ticket naming the app and the authorization to resume.
    """
    params = _consent.get()
    if params is None or not record.tenant_id:
        return
    from app.common.db.dynamo.memberships import MembershipRepository
    from app.common.db.dynamo.workspaces import WorkspaceRepository

    workspace = WorkspaceRepository().get(record.tenant_id)
    if workspace is None or not workspace.third_party_app_approvals:
        return
    client = clients.get(record.client_id)
    if client is None or client.first_party:
        return
    approval = MembershipRepository().get_app_approval(record.tenant_id, record.client_id)
    has_grant = any(
        consent.tenant_id == record.tenant_id for consent in consents.list_for_client(record.user_id, record.client_id)
    )
    if not needs_approval(True, False, approval, has_grant=has_grant):
        return
    ticket = mint_request_ticket(
        record.tenant_id,
        record.client_id,
        client.client_name or record.client_id,
        return_to(_issuer(), params),
    )
    raise HTTPException(
        status_code=status.HTTP_303_SEE_OTHER,
        detail={"error_code": "APP_APPROVAL_REQUIRED", "message": "This app needs an admin's approval first."},
        headers={"Location": request_page_url(record.tenant_id, ticket), "Cache-Control": "no-store"},
    )


def refresh_refused_for(stores: "OAuthServerStores", consent: "ConsentRecord") -> bool:
    """Whether an admin denied this grant's app in its workspace while approvals are on."""
    if not consent.tenant_id:
        return False
    from app.common.db.dynamo.memberships import MembershipRepository
    from app.common.db.dynamo.workspaces import WorkspaceRepository

    workspace = WorkspaceRepository().get(consent.tenant_id)
    if workspace is None or not workspace.third_party_app_approvals:
        return False
    approval = MembershipRepository().get_app_approval(consent.tenant_id, consent.client_id)
    if approval is None:
        return False
    client = stores.clients.get(consent.client_id)
    return refresh_refused(True, client is not None and client.first_party, approval)


def _issuer() -> str:
    """The authorization server's issuer, which `return_to` resumes under."""
    from app.common.core.config import get_settings
    from app.domains.identity.package_glue import build_identity_settings

    return str(build_identity_settings(get_settings()).issuer)
