"""The Slack Web API calls the App makes, and the one place a request leaves for Slack.

Slack answers almost every refusal as a 200 carrying `"ok": false` and an `error`
code, so `call` turns that into `SlackError` with the code, which is the only part
of an answer that is ever logged or shown. The bot token travels in the
`Authorization` header and is never formatted into an error.
"""

from __future__ import annotations

from typing import Any, Mapping
from urllib.parse import urlencode

import httpx

from app.common.core.config import settings

API_ROOT = "https://slack.com/api"

AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"

TIMEOUT_SECONDS = 10.0

BOT_SCOPES: tuple[str, ...] = (
    "chat:write",
    "chat:write.public",
    "channels:read",
    "groups:read",
    "commands",
    "links:read",
    "links:write",
    "users:read",
    "users:read.email",
)
"""What the bot asks for: posting, picking a channel, the command, unfurls and finding the person."""

GET_METHODS = frozenset({"conversations.list", "users.info", "auth.test", "auth.revoke", "chat.getPermalink"})
"""The methods that take no JSON body, sent as a query string instead."""


class SlackError(Exception):
    """Slack refused a call, with its error code, or did not answer one."""

    def __init__(self, code: str, *, status_code: int = 200, retry_after: int = 0) -> None:
        """Carry Slack's error code, the HTTP status and any Retry-After it asked for."""
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.retry_after = retry_after


def redirect_uri() -> str:
    """The OAuth redirect this environment's App is configured with."""
    return f"{settings.api_base_url}/api/slack/oauth/callback"


def authorize_url(state: str) -> str:
    """Where to send a workspace admin to add the App to their Slack workspace."""
    query = urlencode(
        {
            "client_id": settings.SLACK_CLIENT_ID,
            "scope": ",".join(BOT_SCOPES),
            "redirect_uri": redirect_uri(),
            "state": state,
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


def _client() -> httpx.Client:
    """A short lived client with the call timeout."""
    return httpx.Client(timeout=TIMEOUT_SECONDS)


def _answer(response: httpx.Response) -> dict[str, Any]:
    """The parsed answer of one call, or `SlackError` for a refusal of any kind."""
    if response.status_code == 429:
        try:
            wait = int(response.headers.get("Retry-After", "0") or 0)
        except ValueError:
            wait = 0
        raise SlackError("ratelimited", status_code=429, retry_after=wait)
    try:
        body = response.json() if response.content else {}
    except ValueError as error:
        raise SlackError("invalid_response", status_code=response.status_code) from error
    if not isinstance(body, dict):
        raise SlackError("invalid_response", status_code=response.status_code)
    if response.status_code >= 400 or not body.get("ok"):
        raise SlackError(str(body.get("error") or f"http_{response.status_code}"), status_code=response.status_code)
    return body


def exchange_code(code: str) -> dict[str, Any]:
    """The `oauth.v2.access` answer for a callback code, or `SlackError`.

    Authenticated with the client id and secret as HTTP basic, which is the form
    Slack recommends, so the secret never rides in a form body.
    """
    try:
        with _client() as client:
            response = client.post(
                f"{API_ROOT}/oauth.v2.access",
                data={"code": code, "redirect_uri": redirect_uri()},
                auth=(settings.SLACK_CLIENT_ID, settings.SLACK_CLIENT_SECRET),
            )
    except httpx.HTTPError as error:
        raise SlackError("unreachable", status_code=0) from error
    return _answer(response)


def call(method: str, token: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Call one Web API method as the bot, answering its body or raising `SlackError`."""
    headers = {"Authorization": f"Bearer {token}"}
    try:
        with _client() as client:
            if method in GET_METHODS:
                response = client.get(f"{API_ROOT}/{method}", params=dict(payload or {}), headers=headers)
            else:
                response = client.post(
                    f"{API_ROOT}/{method}",
                    json=dict(payload or {}),
                    headers={**headers, "Content-Type": "application/json; charset=utf-8"},
                )
    except httpx.HTTPError as error:
        raise SlackError("unreachable", status_code=0) from error
    return _answer(response)


def respond(response_url: str, payload: Mapping[str, Any]) -> bool:
    """Post a message to a command's or a shortcut's `response_url`, reporting whether it landed.

    The url is Slack's own and is only ever one a signed request carried; anything
    off `hooks.slack.com` is refused rather than posted to.
    """
    if not response_url.startswith("https://hooks.slack.com/"):
        return False
    try:
        with _client() as client:
            response = client.post(response_url, json=dict(payload))
    except httpx.HTTPError:
        return False
    return 200 <= response.status_code < 300
