"""The two routes GitHub itself calls, which carry no session.

Both are unauthenticated at the gateway because GitHub cannot present a JWT, so
each authenticates its caller itself: the callback trusts only a `state` this
product signed, and the webhook receiver verifies the HMAC over the raw body
before the body is parsed at all. Parsing first would mean acting on attacker
controlled JSON, so the order in `receive_webhook` is load bearing.

The receiver never calls GitHub. The claims the delivery id, enqueues and
answers, which keeps the request short enough that GitHub's own timeout cannot
make it redeliver work that is already running.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Annotated, Any
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Depends, Header, Request, Response, status
from fastapi.responses import RedirectResponse
from webbpulse.events import EventEnvelope, enqueue
from webbpulse.http import SignatureMismatch, verify_hmac_signature

from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.core.config import settings
from app.domains.integrations.install_state import StateError, redeem_state, workspace_hint
from app.domains.integrations.installs import BindRejected, bind_installation, refresh_installation
from app.domains.integrations.service import not_configured

router = APIRouter(prefix="/api", tags=["integrations"])

_log = logging.getLogger(__name__)

DELIVERY_TTL_SECONDS = 86400.0

DELIVERY_SCOPE = "github-delivery"

PLATFORM_SCOPE = "_platform"
"""The sentinel workspace a delivery id is claimed under.

A delivery arrives before anything has resolved which workspace it belongs to, and
the id is globally unique to GitHub anyway, so it is claimed in one namespace
rather than being claimed twice or claimed late.
"""

RELEVANT_EVENTS = frozenset({"pull_request", "push", "installation", "installation_repositories"})


def _settings_url(repositories: Repositories, workspace_id: str, outcome: str) -> str:
    """Where the callback sends the browser back to.

    The outcome rides in the query string rather than in a flash message, because
    the callback has no session to attach one to. A workspace that cannot be named
    falls back to the workspace list, which is a page every signed in person has.
    """
    query = urlencode({"github": outcome})
    workspace = repositories.workspaces.get(workspace_id) if workspace_id else None
    slug = workspace.slug if workspace is not None else ""
    if not slug:
        return f"{settings.frontend_base_url}/workspaces?{query}"
    return f"{settings.frontend_base_url}/w/{quote(slug, safe='')}/settings?{query}"


def _redirect(repositories: Repositories, workspace_id: str, outcome: str) -> RedirectResponse:
    """A 302 to the settings page carrying one outcome code."""
    return RedirectResponse(_settings_url(repositories, workspace_id, outcome), status_code=status.HTTP_302_FOUND)


@router.get("/github/callback", status_code=status.HTTP_302_FOUND, response_class=RedirectResponse)
def github_callback(
    repositories: Annotated[Repositories, Depends(get_repositories)],
    state: str = "",
    installation_id: str = "",
    setup_action: str = "",
) -> Response:
    """Bind a finished GitHub install to the workspace whose admin started it.

    GitHub sends the browser here as the App's Setup URL with `installation_id`,
    `setup_action` and the `state` the install url carried. The workspace comes from
    the signed state alone and never from a query parameter, the state is redeemed
    once, and the installation id is checked against GitHub with the App JWT before
    anything is written. An `update` that GitHub sends with no state, because the
    change started on GitHub, only refreshes an installation that is already bound.
    """
    if not settings.github_configured:
        raise not_configured()

    if installation_id and not installation_id.isdigit():
        return _redirect(repositories, "", "error")

    if not state:
        if setup_action == "update" and installation_id:
            workspace_id = refresh_installation(repositories, installation_id)
            return _redirect(repositories, workspace_id, "updated" if workspace_id else "unbound")
        _log.warning("A GitHub callback carried no state.", extra={"event": "integrations.state_missing"})
        return _redirect(repositories, "", "invalid_state")

    try:
        claims = redeem_state(state, repositories.idempotency)
    except StateError:
        _log.warning("A GitHub callback carried an unusable state.", extra={"event": "integrations.state_rejected"})
        return _redirect(repositories, workspace_hint(state), "invalid_state")

    workspace_id = str(claims["workspace_id"])
    user_id = str(claims["user_id"])

    if setup_action == "request" or not installation_id:
        return _redirect(repositories, workspace_id, "pending")

    issued_at = datetime.fromtimestamp(int(claims["iat"]), tz=timezone.utc)
    try:
        outcome = bind_installation(
            repositories,
            workspace_id,
            installation_id,
            installed_by=user_id,
            state_issued_at=issued_at,
            setup_action=setup_action,
        )
    except BindRejected as rejection:
        _log.warning(
            "A GitHub installation could not be bound.",
            extra={"event": "integrations.install_rejected", "reason": rejection.reason},
        )
        return _redirect(repositories, workspace_id, rejection.reason)
    except Exception:
        _log.exception("Recording a GitHub installation failed.", extra={"event": "integrations.install_failed"})
        return _redirect(repositories, workspace_id, "error")

    return _redirect(repositories, workspace_id, outcome)


@router.post("/github/webhooks")
async def receive_webhook(
    request: Request,
    repositories: Annotated[Repositories, Depends(get_repositories)],
    x_hub_signature_256: Annotated[str | None, Header()] = None,
    x_github_event: Annotated[str | None, Header()] = None,
    x_github_delivery: Annotated[str | None, Header()] = None,
) -> Response:
    """Verify, claim and enqueue one GitHub delivery, then answer at once.

    The order is the security property. The signature is checked over the raw body
    before `json.loads` runs, so a forged delivery never reaches a parser. The
    delivery id is then claimed in `idempotency`, which makes GitHub's redelivery
    of a request whose response it never saw a no-op rather than a second set of
    transitions.
    """
    body = await request.body()
    secret = settings.GITHUB_WEBHOOK_SECRET
    if not secret:
        raise not_configured()

    try:
        verify_hmac_signature(body, x_hub_signature_256, secret)
    except SignatureMismatch:
        _log.warning(
            "Rejected a GitHub delivery whose signature did not verify.",
            extra={"event": "integrations.signature_rejected", "github_event": x_github_event or ""},
        )
        return Response(
            content=json.dumps({"error_code": "INVALID_SIGNATURE", "message": "The signature does not verify."}),
            media_type="application/json",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    event = x_github_event or ""
    if event not in RELEVANT_EVENTS:
        return Response(
            content=json.dumps({"accepted": False, "reason": "ignored"}),
            media_type="application/json",
            status_code=status.HTTP_200_OK,
        )

    delivery = x_github_delivery or ""
    if delivery:
        claimed = repositories.idempotency.claim(
            PLATFORM_SCOPE,
            DELIVERY_SCOPE,
            delivery,
            ttl_seconds=DELIVERY_TTL_SECONDS,
        )
        if not claimed:
            _log.info(
                "Dropped a replayed GitHub delivery.",
                extra={"event": "integrations.delivery_replayed", "github_event": event},
            )
            return Response(
                content=json.dumps({"accepted": False, "reason": "duplicate"}),
                media_type="application/json",
                status_code=status.HTTP_200_OK,
            )

    try:
        payload: Any = json.loads(body)
    except ValueError:
        return Response(
            content=json.dumps({"accepted": False, "reason": "unparseable"}),
            media_type="application/json",
            status_code=status.HTTP_200_OK,
        )

    installation = payload.get("installation") if isinstance(payload, dict) else None
    installation_id = str((installation or {}).get("id", "")) if isinstance(installation, dict) else ""

    enqueue(
        settings.GITHUB_EVENTS_QUEUE_URL,
        EventEnvelope(
            name=f"github.{event}",
            payload={"event": event, "delivery": delivery, "body": payload},
            scope=installation_id or None,
        ),
    )
    return Response(
        content=json.dumps({"accepted": True}),
        media_type="application/json",
        status_code=status.HTTP_202_ACCEPTED,
    )
