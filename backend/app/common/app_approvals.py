"""Admin approval of third-party OAuth apps, shared by the consent gate and the approval routes.

With a workspace's `third_party_app_approvals` on, a member consenting to a
third-party app the workspace has not approved is sent to a request page instead of
being granted. The identity function decides that at consent, and the integrations
function serves the request page and the admin decisions, so the two halves meet
here: the predicate both read, and the signed request ticket the first mints and the
second reads.

The ticket carries the app and the authorization request to return to, so the
request page names the app without reaching the identity tables and its "Continue"
link resumes the very authorization the member started. It is signed under
`SECRET_KEY` for its own audience, so it cannot be forged or replayed as anything
else, and its `return_to` cannot be pointed somewhere other than this issuer.

First-party clients, the CLI and the official MCP server, are never gated. A
member's grant given before the setting was turned on stays usable, and so does
re-authorizing it, until an admin denies or revokes the app.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Mapping
from urllib.parse import quote, urlencode

from webbpulse.security import ExpiredToken, InvalidToken, create_token, decode_token

from app.common.core.config import settings
from app.common.db.dynamo.memberships import AppApproval

TICKET_AUDIENCE = "standupless.app-approval-request"
"""What a request ticket may be presented for, so no other token signed under `SECRET_KEY` passes as one."""

TICKET_TTL = timedelta(days=1)
"""How long a member has to send the request after being stopped at consent."""

AUTHORIZE_PATH = "/authorize"
"""The authorization endpoint's path under the issuer, where `return_to` resumes."""

RETURN_FIELDS: tuple[str, ...] = (
    "response_type",
    "client_id",
    "redirect_uri",
    "resource",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
)
"""The authorization request parameters a resumed authorization needs, and no consent field."""


class TicketError(Exception):
    """A request ticket that did not verify, for whatever reason, answered alike."""


def needs_approval(
    enabled: bool,
    first_party: bool,
    approval: AppApproval | None,
    *,
    has_grant: bool = False,
) -> bool:
    """Whether a consent to this app in this workspace must wait for an admin.

    Never with the setting off or for a first-party client. An approved app passes.
    A denied app is held even for a member who granted it before. Otherwise a member
    re-authorizing a grant they already hold passes, which keeps apps authorized
    before the setting authorized, and anyone else waits.
    """
    if not enabled or first_party:
        return False
    if approval is not None and approval.status == "approved":
        return False
    if approval is not None and approval.status == "denied":
        return True
    return not has_grant


def refresh_refused(enabled: bool, first_party: bool, approval: AppApproval | None) -> bool:
    """Whether a standing grant to this app may no longer refresh, which is once an admin denied it."""
    return enabled and not first_party and approval is not None and approval.status == "denied"


def return_to(issuer: str, params: Mapping[str, str]) -> str:
    """The authorization URL that resumes the request the member was stopped on."""
    query = urlencode([(name, params[name]) for name in RETURN_FIELDS if params.get(name)])
    return f"{issuer.rstrip('/')}{AUTHORIZE_PATH}?{query}"


def mint_request_ticket(workspace_id: str, client_id: str, client_name: str, resume: str) -> str:
    """Sign the ticket the request page presents, naming the app and where to resume."""
    return create_token(
        {
            "workspace_id": workspace_id,
            "client_id": client_id,
            "client_name": client_name,
            "return_to": resume,
        },
        settings.SECRET_KEY,
        expires_in=TICKET_TTL,
        audience=TICKET_AUDIENCE,
    )


def read_request_ticket(ticket: str, workspace_id: str) -> Mapping[str, Any]:
    """The claims of a request ticket for this workspace, or `TicketError`."""
    try:
        claims = decode_token(
            ticket,
            settings.SECRET_KEY,
            audience=TICKET_AUDIENCE,
            require=["exp", "workspace_id", "client_id"],
        )
    except (ExpiredToken, InvalidToken) as exc:
        raise TicketError("The request link is not valid") from exc
    if claims.get("workspace_id") != workspace_id or not claims.get("client_id"):
        raise TicketError("The request link is for another workspace")
    return claims


def request_page_url(workspace_id: str, ticket: str) -> str:
    """The SPA page where a member stopped at consent asks an admin for access."""
    return (
        f"{settings.frontend_base_url}/app-access"
        f"?workspace_id={quote(workspace_id, safe='')}&ticket={quote(ticket, safe='')}"
    )


def settings_url(slug: str) -> str:
    """The workspace's connected apps settings page, where admins decide and members see decisions."""
    return f"{settings.frontend_base_url}/w/{quote(slug, safe='')}/settings/connected-apps"
