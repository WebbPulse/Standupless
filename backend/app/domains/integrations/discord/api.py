"""The Discord HTTP API calls the App makes, and the one place a request leaves for Discord.

Discord answers a refusal with an HTTP status and, usually, a JSON body carrying
a numeric `code`, so every call turns a refusal into `DiscordError` with both,
which are the only parts of an answer ever logged or shown. The bot token and the
client secret travel in the `Authorization` header and are never formatted into
an error.
"""

from __future__ import annotations

from typing import Any, Mapping
from urllib.parse import urlencode

import httpx

from app.common.core.config import settings

API_ROOT = "https://discord.com/api/v10"

AUTHORIZE_URL = "https://discord.com/oauth2/authorize"

TIMEOUT_SECONDS = 10.0

INSTALL_SCOPES: tuple[str, ...] = ("bot", "applications.commands")
"""What an install asks for: the bot joining the server, and the commands in it."""

LINK_SCOPES: tuple[str, ...] = ("identify", "email")
"""What linking a person asks for: their Discord id and their email, read once."""

VIEW_CHANNEL = 1 << 10
SEND_MESSAGES = 1 << 11
EMBED_LINKS = 1 << 14

BOT_PERMISSIONS = VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS
"""The permissions the bot asks for in a server: see channels, post in them, and post embeds."""

UNKNOWN_GUILD = 10004
UNKNOWN_CHANNEL = 10003
MISSING_ACCESS = 50001
MISSING_PERMISSIONS = 50013


class DiscordError(Exception):
    """Discord refused a call, with its status and error code, or did not answer one."""

    def __init__(self, status_code: int, code: int = 0, *, retry_after: float = 0.0) -> None:
        """Carry the HTTP status, Discord's numeric code and any wait it asked for."""
        super().__init__(f"discord answered {status_code} ({code})")
        self.status_code = status_code
        self.code = code
        self.retry_after = retry_after


def redirect_uri() -> str:
    """The OAuth redirect this environment's App is configured with, for installs and links alike."""
    return f"{settings.api_base_url}/api/discord/oauth/callback"


def install_url(state: str) -> str:
    """Where to send a workspace admin to add the bot to one of their Discord servers."""
    query = urlencode(
        {
            "client_id": settings.DISCORD_APPLICATION_ID,
            "scope": " ".join(INSTALL_SCOPES),
            "permissions": str(BOT_PERMISSIONS),
            "integration_type": "0",
            "response_type": "code",
            "redirect_uri": redirect_uri(),
            "state": state,
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


def link_url(state: str) -> str:
    """Where to send a Discord person to link their account by their confirmed email."""
    query = urlencode(
        {
            "client_id": settings.DISCORD_APPLICATION_ID,
            "scope": " ".join(LINK_SCOPES),
            "response_type": "code",
            "redirect_uri": redirect_uri(),
            "state": state,
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


def _client() -> httpx.Client:
    """A short lived client with the call timeout."""
    return httpx.Client(timeout=TIMEOUT_SECONDS)


def _answer(response: httpx.Response) -> Any:
    """The parsed answer of one call, or `DiscordError` for a refusal of any kind."""
    try:
        body = response.json() if response.content else {}
    except ValueError:
        body = {}
    if response.status_code == 429:
        wait = body.get("retry_after", 0) if isinstance(body, dict) else 0
        raise DiscordError(429, retry_after=float(wait or 0))
    if response.status_code >= 400:
        code = body.get("code", 0) if isinstance(body, dict) else 0
        raise DiscordError(response.status_code, int(code) if isinstance(code, int) else 0)
    return body


def exchange_code(code: str) -> dict[str, Any]:
    """The token answer for a callback code, or `DiscordError`.

    Authenticated with the application id and client secret as HTTP basic, so the
    secret never rides in a form body. An install's answer names the server the
    bot was added to under `guild`, which is the only trusted source of it.
    """
    try:
        with _client() as client:
            response = client.post(
                f"{API_ROOT}/oauth2/token",
                data={"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri()},
                auth=(settings.DISCORD_APPLICATION_ID, settings.DISCORD_CLIENT_SECRET),
            )
    except httpx.HTTPError as error:
        raise DiscordError(0) from error
    answer = _answer(response)
    if not isinstance(answer, dict):
        raise DiscordError(response.status_code)
    return answer


def current_user(access_token: str) -> dict[str, Any]:
    """The Discord person a user access token belongs to, with their email when granted."""
    try:
        with _client() as client:
            response = client.get(f"{API_ROOT}/users/@me", headers={"Authorization": f"Bearer {access_token}"})
    except httpx.HTTPError as error:
        raise DiscordError(0) from error
    answer = _answer(response)
    if not isinstance(answer, dict):
        raise DiscordError(response.status_code)
    return answer


def bot(method: str, path: str, payload: Mapping[str, Any] | list[Any] | None = None) -> Any:
    """Call one API route as the App's bot, answering its body or raising `DiscordError`."""
    headers = {"Authorization": f"Bot {settings.DISCORD_BOT_TOKEN}"}
    try:
        with _client() as client:
            if payload is None:
                response = client.request(method, f"{API_ROOT}{path}", headers=headers)
            else:
                response = client.request(method, f"{API_ROOT}{path}", headers=headers, json=payload)
    except httpx.HTTPError as error:
        raise DiscordError(0) from error
    return _answer(response)
