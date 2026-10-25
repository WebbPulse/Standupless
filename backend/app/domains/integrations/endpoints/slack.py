"""The Slack App: the install a workspace admin drives, and the four routes Slack calls.

`router` sits under `/workspaces` and is authorized like every other workspace
route. `public_router` carries its own `/api` and no session, because Slack cannot
present one: the OAuth callback trusts only a `state` this product signed, and the
events, command and interactivity receivers verify Slack's `v0` signature over the
raw body before anything is parsed. Every public route answers 404 in an
environment whose Slack App credentials are not set, so the feature is simply off
there.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any, Mapping
from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.core.config import settings
from app.common.db.dynamo.slack import SlackInstallation
from app.domains.integrations.chat.returns import return_url
from app.domains.integrations.install_state import StateError, mint_state, redeem_state, state_hint
from app.domains.integrations.schemas.slack import SlackConnectionRead, SlackInstallUrlRead, SlackLinkRead
from app.domains.integrations.service import not_configured, not_found
from app.domains.integrations.slack import api, commands, direct, install, reactions, signature, threads, unfurls

router = APIRouter()

public_router = APIRouter(prefix="/api", tags=["integrations"])

_log = logging.getLogger(__name__)

PLATFORM_SCOPE = "_platform"

EVENT_SCOPE = "slack-event"

EVENT_TTL_SECONDS = 86400.0

WorkspaceReader = Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))]

WorkspaceAdmin = Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))]

Bundle = Annotated[Repositories, Depends(get_repositories)]


def _connection(repositories: Repositories, workspace_id: str) -> SlackConnectionRead:
    """What the settings page shows about this workspace's Slack App."""
    if not settings.slack_configured:
        return SlackConnectionRead(configured=False, installed=False)
    installation = repositories.github.slack.get(workspace_id)
    if installation is None:
        return SlackConnectionRead(configured=True, installed=False)
    return SlackConnectionRead(
        configured=True,
        installed=True,
        slack_team_id=installation.slack_team_id,
        slack_team_name=installation.slack_team_name,
        installed_by=installation.installed_by,
        installed_at=installation.installed_at,
    )


@router.get("/{workspace_id}/slack", response_model=SlackConnectionRead)
def get_slack_connection(context: WorkspaceReader, repositories: Bundle) -> SlackConnectionRead:
    """Whether the Slack App is available here and installed in this workspace."""
    return _connection(repositories, context.workspace_id)


@router.get("/{workspace_id}/slack/install-url", response_model=SlackInstallUrlRead)
def get_slack_install_url(
    context: WorkspaceAdmin,
    repositories: Bundle,
    team_id: Annotated[str, Query(max_length=64)] = "",
) -> SlackInstallUrlRead:
    """Where to send this admin to add the Slack App, returning to the team they started from."""
    if not settings.slack_configured:
        raise not_configured("Slack App")
    extra: dict[str, str] = {}
    if team_id:
        if repositories.teams.get(context.workspace_id, team_id) is None or not context.can_find_team(team_id):
            raise not_found()
        extra["team_id"] = team_id
    state, expires_at = mint_state(context.workspace_id, context.user_id, audience=install.STATE_AUDIENCE, extra=extra)
    return SlackInstallUrlRead(url=api.authorize_url(state), expires_at=expires_at)


@router.delete("/{workspace_id}/slack", status_code=status.HTTP_204_NO_CONTENT)
def delete_slack_connection(context: WorkspaceAdmin, repositories: Bundle) -> Response:
    """Remove the Slack App from this workspace and turn off the channels that posted through it."""
    current = repositories.github.slack.get(context.workspace_id)
    if current is None or not install.disconnect(repositories, context.workspace_id):
        raise not_found()
    audit.record(
        repositories,
        context,
        "slack.disconnected",
        target_type="slack",
        target_id=current.slack_team_id,
        target_label=current.slack_team_name,
        before={"slack_team_id": current.slack_team_id, "name": current.slack_team_name},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


LINK_REFUSALS: dict[str, str] = {
    "email_unverified": "Verify your email address before linking Slack.",
    "slack_user_not_found": "No Slack account in this Slack workspace has your confirmed email address.",
    "slack_unavailable": "Slack did not answer. Try again in a minute.",
    "slack_refused": "Slack refused the lookup. Ask a workspace admin to reconnect the Slack App.",
}
"""What the settings page says for each reason a link could not be made."""


def _link(repositories: Repositories, workspace_id: str, user_id: str) -> SlackLinkRead:
    """What the caller's account settings show about their own Slack direct messages."""
    if not settings.slack_configured:
        return SlackLinkRead(configured=False, available=False)
    installation = repositories.github.slack.get(workspace_id)
    route = repositories.inbox.chat_routes.get(workspace_id, user_id, direct.PROVIDER)
    if route is None:
        return SlackLinkRead(
            configured=True,
            available=installation is not None,
            slack_team_name=installation.slack_team_name if installation else None,
        )
    return SlackLinkRead(
        configured=True,
        available=installation is not None,
        linked=True,
        slack_user_id=route.external_user_id,
        slack_team_name=installation.slack_team_name if installation else None,
        linked_at=route.linked_at,
        problem=direct.route_problem(route, installation) or None,
    )


@router.get("/{workspace_id}/slack/me", response_model=SlackLinkRead)
def get_my_slack_link(context: WorkspaceReader, repositories: Bundle) -> SlackLinkRead:
    """Whether the caller's personal notifications reach their Slack direct messages."""
    return _link(repositories, context.workspace_id, context.user_id)


@router.put(
    "/{workspace_id}/slack/me",
    response_model=SlackLinkRead,
    responses={status.HTTP_409_CONFLICT: {"description": "The link could not be made, with the reason."}},
)
def link_my_slack(context: WorkspaceReader, repositories: Bundle) -> SlackLinkRead:
    """Link the caller to the Slack user with their confirmed email, replacing any earlier link."""
    if not settings.slack_configured:
        raise not_configured("Slack App")
    installation = repositories.github.slack.get(context.workspace_id)
    if installation is None:
        raise not_found()
    try:
        direct.link(repositories, installation, context.user_id)
    except direct.LinkRefused as refused:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": refused.code.upper(), "message": LINK_REFUSALS.get(refused.code, "")},
        ) from refused
    return _link(repositories, context.workspace_id, context.user_id)


@router.delete("/{workspace_id}/slack/me", status_code=status.HTTP_204_NO_CONTENT)
def unlink_my_slack(context: WorkspaceReader, repositories: Bundle) -> Response:
    """Stop the caller's Slack direct messages and forget which Slack user they are."""
    if not repositories.inbox.chat_routes.delete(context.workspace_id, context.user_id, direct.PROVIDER):
        raise not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


NOT_CONFIGURED_RESPONSE: dict[int | str, dict[str, Any]] = {
    status.HTTP_404_NOT_FOUND: {"description": "This environment has no Slack App."},
}

SIGNED_RESPONSES: dict[int | str, dict[str, Any]] = {
    **NOT_CONFIGURED_RESPONSE,
    status.HTTP_400_BAD_REQUEST: {"description": "The signed body could not be read."},
    status.HTTP_401_UNAUTHORIZED: {"description": "Slack did not sign the request, or it is too old."},
}


def _require_configured() -> None:
    """Answer 404 for every public route while this environment has no Slack App."""
    if not settings.slack_configured:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error_code": "NOT_FOUND"})


def _return_url(repositories: Repositories, claims: Mapping[str, Any], outcome: str) -> str:
    """The settings page the install started from, carrying the outcome."""
    return return_url(repositories, claims, "slack", outcome)


def _back(repositories: Repositories, claims: Mapping[str, Any], outcome: str) -> RedirectResponse:
    """A 302 to the settings page carrying one outcome code."""
    return RedirectResponse(_return_url(repositories, claims, outcome), status_code=status.HTTP_302_FOUND)


@public_router.get(
    "/slack/oauth/callback",
    status_code=status.HTTP_302_FOUND,
    response_class=RedirectResponse,
    responses=NOT_CONFIGURED_RESPONSE,
)
def slack_oauth_callback(
    repositories: Bundle,
    state: str = "",
    code: str = "",
    error: str = "",
) -> Response:
    """Bind a finished Slack install to the workspace whose admin started it.

    The workspace comes from the signed state alone, redeemed once, and the code is
    exchanged with the client secret before anything is written, so a callback
    nobody started from Standupless binds nothing.
    """
    _require_configured()
    try:
        claims = redeem_state(
            state, repositories.idempotency, audience=install.STATE_AUDIENCE, nonce_scope=install.NONCE_SCOPE
        )
    except StateError:
        _log.warning(
            "A Slack callback carried an unusable state.", extra={"event": "integrations.slack.state_rejected"}
        )
        return _back(repositories, state_hint(state, audience=install.STATE_AUDIENCE), "invalid_state")
    if error or not code:
        return _back(repositories, claims, "denied")
    try:
        answer = api.exchange_code(code)
    except api.SlackError as refusal:
        _log.warning(
            "Slack refused the install code.",
            extra={"event": "integrations.slack.exchange_failed", "reason": refusal.code},
        )
        return _back(repositories, claims, "error")
    try:
        installation = install.bind(repositories, str(claims["workspace_id"]), str(claims["user_id"]), answer)
    except install.InstallRejected as rejection:
        _log.warning(
            "A Slack install could not be bound.",
            extra={"event": "integrations.slack.install_rejected", "reason": rejection.reason},
        )
        return _back(repositories, claims, rejection.reason)
    _log.info("Bound a Slack install.", extra={"event": "integrations.slack.installed"})
    audit.record_system(
        repositories,
        installation.workspace_id,
        "slack.connected",
        actor_id=installation.installed_by,
        actor_kind="user",
        source="web",
        target_type="slack",
        target_id=installation.slack_team_id,
        target_label=installation.slack_team_name,
        after={"slack_team_id": installation.slack_team_id, "name": installation.slack_team_name},
    )
    return _back(repositories, claims, "installed")


async def _verified_body(request: Request) -> bytes | None:
    """The raw body of a request Slack signed, or `None` for one it did not."""
    body = await request.body()
    try:
        signature.verify(
            settings.SLACK_SIGNING_SECRET,
            request.headers.get("x-slack-request-timestamp"),
            request.headers.get("x-slack-signature"),
            body,
        )
    except signature.SignatureRejected:
        _log.warning(
            "Rejected a Slack request whose signature did not verify.",
            extra={"event": "integrations.slack.signature_rejected"},
        )
        return None
    return body


def _rejected() -> JSONResponse:
    """The answer to a request whose signature did not verify."""
    return JSONResponse(
        {"error_code": "INVALID_SIGNATURE", "message": "The signature does not verify."},
        status_code=status.HTTP_401_UNAUTHORIZED,
    )


def _form(body: bytes) -> dict[str, str]:
    """A form encoded body as a flat map, keeping the first value of each field."""
    parsed = parse_qs(body.decode("utf-8", errors="replace"), keep_blank_values=True)
    return {key: values[0] for key, values in parsed.items() if values}


def _installation(repositories: Repositories, slack_team_id: str) -> SlackInstallation | None:
    """The installation a Slack team resolves to, or `None`."""
    return repositories.github.slack.installation_for_team(slack_team_id) if slack_team_id else None


def _handle_event(repositories: Repositories, envelope: Mapping[str, Any]) -> None:
    """Act on one `event_callback`: an unfurl, a reply in a synced thread, an intake reaction, or the App leaving."""
    event = envelope.get("event") or {}
    if not isinstance(event, Mapping):
        return
    slack_team_id = str(envelope.get("team_id", ""))
    kind = event.get("type")
    if kind == "app_uninstalled":
        install.forget_team(repositories, slack_team_id)
        return
    if kind == "tokens_revoked":
        tokens = event.get("tokens") or {}
        if isinstance(tokens, Mapping) and tokens.get("bot"):
            install.forget_team(repositories, slack_team_id)
        return
    if kind == "link_shared":
        installation = _installation(repositories, slack_team_id)
        if installation is not None:
            unfurls.unfurl(repositories, installation, event)
        return
    if kind == "message":
        installation = _installation(repositories, slack_team_id)
        if installation is not None:
            threads.receive(repositories, installation, event)
        return
    if kind == "reaction_added":
        installation = _installation(repositories, slack_team_id)
        if installation is not None:
            reactions.receive(repositories, installation, event)


@public_router.post("/slack/events", responses=SIGNED_RESPONSES)
async def receive_slack_event(request: Request, repositories: Bundle) -> Response:
    """Verify one Events API request, then answer its challenge or act on its event once."""
    _require_configured()
    body = await _verified_body(request)
    if body is None:
        return _rejected()
    try:
        envelope = json.loads(body)
    except ValueError:
        return JSONResponse({"error_code": "INVALID_BODY"}, status_code=status.HTTP_400_BAD_REQUEST)
    if not isinstance(envelope, dict):
        return JSONResponse({"error_code": "INVALID_BODY"}, status_code=status.HTTP_400_BAD_REQUEST)
    if envelope.get("type") == "url_verification":
        return JSONResponse({"challenge": str(envelope.get("challenge", ""))})
    if envelope.get("type") != "event_callback":
        return JSONResponse({"ok": True})
    event = envelope.get("event") or {}
    if isinstance(event, Mapping) and event.get("type") == "message" and not threads.wanted(event):
        return JSONResponse({"ok": True})
    if isinstance(event, Mapping) and event.get("type") == "reaction_added" and not reactions.wanted(event):
        return JSONResponse({"ok": True})
    event_id = str(envelope.get("event_id", ""))
    if event_id and not repositories.idempotency.claim(
        PLATFORM_SCOPE, EVENT_SCOPE, event_id, ttl_seconds=EVENT_TTL_SECONDS
    ):
        return JSONResponse({"ok": True, "duplicate": True})
    _handle_event(repositories, envelope)
    return JSONResponse({"ok": True})


@public_router.post("/slack/commands", responses=SIGNED_RESPONSES)
async def receive_slack_command(request: Request, repositories: Bundle) -> Response:
    """Verify and answer one `/standupless` slash command."""
    _require_configured()
    body = await _verified_body(request)
    if body is None:
        return _rejected()
    form = _form(body)
    installation = _installation(repositories, form.get("team_id", ""))
    if installation is None:
        return JSONResponse(commands.ephemeral("Standupless is not connected to this Slack workspace."))
    reply = commands.slash_command(repositories, installation, form)
    if not reply:
        return Response(status_code=status.HTTP_200_OK)
    return JSONResponse(reply)


@public_router.post("/slack/interactions", responses=SIGNED_RESPONSES)
async def receive_slack_interaction(request: Request, repositories: Bundle) -> Response:
    """Verify one interactivity request: the message shortcut, or the create issue form being submitted."""
    _require_configured()
    body = await _verified_body(request)
    if body is None:
        return _rejected()
    try:
        payload = json.loads(_form(body).get("payload", ""))
    except ValueError:
        return JSONResponse({"error_code": "INVALID_BODY"}, status_code=status.HTTP_400_BAD_REQUEST)
    if not isinstance(payload, dict):
        return JSONResponse({"error_code": "INVALID_BODY"}, status_code=status.HTTP_400_BAD_REQUEST)
    team = payload.get("team") or {}
    slack_team_id = str(team.get("id", "")) if isinstance(team, Mapping) else ""
    installation = _installation(repositories, slack_team_id)
    if installation is None:
        return Response(status_code=status.HTTP_200_OK)
    reply = commands.interaction(repositories, installation, payload)
    if not reply:
        return Response(status_code=status.HTTP_200_OK)
    return JSONResponse(reply)
