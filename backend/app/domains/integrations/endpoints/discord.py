"""The Discord App: the install a workspace admin drives, and the two routes Discord calls.

`router` sits under `/workspaces` and is authorized like every other workspace
route. `public_router` carries its own `/api` and no session, because Discord
cannot present one. The OAuth callback serves both the server install and a
person linking their account, telling them apart by the audience of the `state`
this product signed and trusting nothing else in the query. The interactions
receiver verifies Discord's Ed25519 signature over the raw body before anything
is parsed. Every public route answers 404 in an environment whose Discord App
keys are not set, so the feature is simply off there.
"""

from __future__ import annotations

import json
import logging
from html import escape
from typing import Annotated, Any, Mapping

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.core.config import settings
from app.domains.integrations.chat.returns import return_url
from app.domains.integrations.discord import api, commands, install, people, signature
from app.domains.integrations.install_state import StateError, mint_state, redeem_state, state_hint
from app.domains.integrations.schemas.discord import DiscordConnectionRead, DiscordInstallUrlRead
from app.domains.integrations.service import not_configured, not_found

router = APIRouter()

public_router = APIRouter(prefix="/api", tags=["integrations"])

_log = logging.getLogger(__name__)

PLATFORM_SCOPE = "_platform"

INTERACTION_SCOPE = "discord-interaction"

INTERACTION_TTL_SECONDS = 900.0

WorkspaceReader = Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))]

WorkspaceAdmin = Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))]

Bundle = Annotated[Repositories, Depends(get_repositories)]

LINK_PAGES: dict[str, str] = {
    "linked": "Your Discord account is linked. You can go back to Discord and run the command again.",
    "invalid_state": "This link has expired or was already used. Run the command in Discord again for a new one.",
    "denied": "Linking was cancelled. Run the command in Discord again whenever you are ready.",
    "not_installed": "Standupless is no longer connected to that Discord server.",
    "wrong_account": "This link was made for a different Discord account. Run the command again from your own.",
    "unverified_email": "Discord has no verified email address for your account. Verify it in Discord first.",
    "no_member": "No member of this Standupless workspace has your Discord email address as a confirmed email.",
    "error": "Discord could not be reached. Try again in a minute.",
}


def _connection(repositories: Repositories, workspace_id: str) -> DiscordConnectionRead:
    """What the settings page shows about this workspace's Discord App."""
    if not settings.discord_configured:
        return DiscordConnectionRead(configured=False, installed=False)
    installation = repositories.github.discord.get(workspace_id)
    if installation is None:
        return DiscordConnectionRead(configured=True, installed=False)
    return DiscordConnectionRead(
        configured=True,
        installed=True,
        guild_id=installation.guild_id,
        guild_name=installation.guild_name,
        installed_by=installation.installed_by,
        installed_at=installation.installed_at,
    )


@router.get("/{workspace_id}/discord", response_model=DiscordConnectionRead)
def get_discord_connection(context: WorkspaceReader, repositories: Bundle) -> DiscordConnectionRead:
    """Whether the Discord App is available here and installed in this workspace."""
    return _connection(repositories, context.workspace_id)


@router.get("/{workspace_id}/discord/install-url", response_model=DiscordInstallUrlRead)
def get_discord_install_url(
    context: WorkspaceAdmin,
    repositories: Bundle,
    team_id: Annotated[str, Query(max_length=64)] = "",
) -> DiscordInstallUrlRead:
    """Where to send this admin to add the Discord App, returning to the team they started from."""
    if not settings.discord_configured:
        raise not_configured("Discord App")
    extra: dict[str, str] = {}
    if team_id:
        if repositories.teams.get(context.workspace_id, team_id) is None or not context.can_find_team(team_id):
            raise not_found()
        extra["team_id"] = team_id
    state, expires_at = mint_state(context.workspace_id, context.user_id, audience=install.STATE_AUDIENCE, extra=extra)
    return DiscordInstallUrlRead(url=api.install_url(state), expires_at=expires_at)


@router.delete("/{workspace_id}/discord", status_code=status.HTTP_204_NO_CONTENT)
def delete_discord_connection(context: WorkspaceAdmin, repositories: Bundle) -> Response:
    """Take the Discord App out of this workspace's server and turn off the channels that posted through it."""
    if not install.disconnect(repositories, context.workspace_id):
        raise not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


NOT_CONFIGURED_RESPONSE: dict[int | str, dict[str, Any]] = {
    status.HTTP_404_NOT_FOUND: {"description": "This environment has no Discord App."},
}

SIGNED_RESPONSES: dict[int | str, dict[str, Any]] = {
    **NOT_CONFIGURED_RESPONSE,
    status.HTTP_400_BAD_REQUEST: {"description": "The signed body could not be read."},
    status.HTTP_401_UNAUTHORIZED: {"description": "Discord did not sign the request, or it is too old."},
}


CALLBACK_RESPONSES: dict[int | str, dict[str, Any]] = {
    **NOT_CONFIGURED_RESPONSE,
    status.HTTP_200_OK: {"description": "A person's account link finished.", "content": {"text/html": {}}},
    status.HTTP_400_BAD_REQUEST: {"description": "A person's account link was refused.", "content": {"text/html": {}}},
}


def _require_configured() -> None:
    """Answer 404 for every public route while this environment has no Discord App."""
    if not settings.discord_configured:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error_code": "NOT_FOUND"})


def _back(repositories: Repositories, claims: Mapping[str, Any], outcome: str) -> RedirectResponse:
    """A 302 to the settings page the install started from, carrying one outcome code."""
    return RedirectResponse(return_url(repositories, claims, "discord", outcome), status_code=status.HTTP_302_FOUND)


def _link_page(outcome: str) -> HTMLResponse:
    """The small page a person lands on after linking their Discord account, saying how it went."""
    message = escape(LINK_PAGES.get(outcome, LINK_PAGES["error"]))
    page = (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        "<title>Standupless for Discord</title></head>"
        "<body style=\"font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem\">"
        f"<h1 style=\"font-size:1.25rem\">Standupless for Discord</h1><p>{message}</p></body></html>"
    )
    code = status.HTTP_200_OK if outcome == "linked" else status.HTTP_400_BAD_REQUEST
    return HTMLResponse(page, status_code=code, headers={"Cache-Control": "no-store"})


def _complete_link(repositories: Repositories, state: str, code: str, error: str) -> HTMLResponse:
    """Finish one person linking their Discord account, answering the page that says how it went."""
    try:
        claims = redeem_state(
            state, repositories.idempotency, audience=people.LINK_AUDIENCE, nonce_scope=people.LINK_NONCE_SCOPE
        )
    except StateError:
        return _link_page("invalid_state")
    if error or not code:
        return _link_page("denied")
    try:
        answer = api.exchange_code(code)
    except api.DiscordError as refusal:
        _log.warning(
            "Discord refused a link code.",
            extra={"event": "integrations.discord.link_exchange_failed", "status": refusal.status_code},
        )
        return _link_page("error")
    try:
        people.complete_link(repositories, claims, str(answer.get("access_token", "")))
    except people.LinkRejected as rejection:
        _log.info(
            "A Discord link was refused.",
            extra={"event": "integrations.discord.link_rejected", "reason": rejection.reason},
        )
        return _link_page(rejection.reason)
    _log.info("Linked a Discord account.", extra={"event": "integrations.discord.linked"})
    return _link_page("linked")


def _complete_install(repositories: Repositories, state: str, code: str, error: str) -> RedirectResponse:
    """Bind a finished server install to the workspace whose admin started it."""
    try:
        claims = redeem_state(
            state, repositories.idempotency, audience=install.STATE_AUDIENCE, nonce_scope=install.NONCE_SCOPE
        )
    except StateError:
        _log.warning(
            "A Discord callback carried an unusable state.", extra={"event": "integrations.discord.state_rejected"}
        )
        return _back(repositories, state_hint(state, audience=install.STATE_AUDIENCE), "invalid_state")
    if error or not code:
        return _back(repositories, claims, "denied")
    try:
        answer = api.exchange_code(code)
    except api.DiscordError as refusal:
        _log.warning(
            "Discord refused the install code.",
            extra={"event": "integrations.discord.exchange_failed", "status": refusal.status_code},
        )
        return _back(repositories, claims, "error")
    try:
        install.bind(repositories, str(claims["workspace_id"]), str(claims["user_id"]), answer)
    except install.InstallRejected as rejection:
        _log.warning(
            "A Discord install could not be bound.",
            extra={"event": "integrations.discord.install_rejected", "reason": rejection.reason},
        )
        return _back(repositories, claims, rejection.reason)
    _log.info("Bound a Discord install.", extra={"event": "integrations.discord.installed"})
    return _back(repositories, claims, "installed")


@public_router.get(
    "/discord/oauth/callback",
    status_code=status.HTTP_302_FOUND,
    response_class=RedirectResponse,
    responses=CALLBACK_RESPONSES,
)
def discord_oauth_callback(
    repositories: Bundle,
    state: str = "",
    code: str = "",
    error: str = "",
) -> Response:
    """Finish a server install or a person's account link, whichever the signed state was minted for.

    The workspace comes from the state alone, redeemed once, and the code is
    exchanged with the client secret before anything is written, so a callback
    nobody started from Standupless binds and links nothing.
    """
    _require_configured()
    if state_hint(state, audience=people.LINK_AUDIENCE):
        return _complete_link(repositories, state, code, error)
    return _complete_install(repositories, state, code, error)


def _rejected() -> JSONResponse:
    """The answer to a request whose signature did not verify."""
    return JSONResponse(
        {"error_code": "INVALID_SIGNATURE", "message": "The signature does not verify."},
        status_code=status.HTTP_401_UNAUTHORIZED,
    )


def _not_connected(kind: object) -> dict[str, Any]:
    """The answer to an interaction from a server no workspace holds."""
    if kind == commands.AUTOCOMPLETE:
        return {"type": commands.AUTOCOMPLETE_RESULT, "data": {"choices": []}}
    return commands.ephemeral("Standupless is not connected to this Discord server.")


@public_router.post("/discord/interactions", responses=SIGNED_RESPONSES)
async def receive_discord_interaction(request: Request, repositories: Bundle) -> Response:
    """Verify one interaction, then answer Discord's ping or act on a command, an autocomplete or a form once."""
    _require_configured()
    body = await request.body()
    try:
        signature.verify(
            settings.DISCORD_PUBLIC_KEY,
            request.headers.get("x-signature-timestamp"),
            request.headers.get("x-signature-ed25519"),
            body,
        )
    except signature.SignatureRejected:
        _log.warning(
            "Rejected a Discord request whose signature did not verify.",
            extra={"event": "integrations.discord.signature_rejected"},
        )
        return _rejected()
    try:
        payload = json.loads(body)
    except ValueError:
        return JSONResponse({"error_code": "INVALID_BODY"}, status_code=status.HTTP_400_BAD_REQUEST)
    if not isinstance(payload, dict):
        return JSONResponse({"error_code": "INVALID_BODY"}, status_code=status.HTTP_400_BAD_REQUEST)
    kind = payload.get("type")
    if kind == commands.PING:
        return JSONResponse({"type": commands.PONG})
    interaction_id = str(payload.get("id", ""))
    if interaction_id and not repositories.idempotency.claim(
        PLATFORM_SCOPE, INTERACTION_SCOPE, interaction_id, ttl_seconds=INTERACTION_TTL_SECONDS
    ):
        return JSONResponse(commands.ephemeral("This was already handled."))
    guild_id = str(payload.get("guild_id", ""))
    installation = repositories.github.discord.installation_for_guild(guild_id) if guild_id.isdigit() else None
    if installation is None:
        return JSONResponse(_not_connected(kind))
    return JSONResponse(commands.interaction(repositories, installation, payload))
