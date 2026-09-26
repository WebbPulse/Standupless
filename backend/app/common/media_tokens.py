"""Signed media tokens, the credential an inline image or video URL carries.

An `<img>` or `<video>` element sends no bearer token and the API sits on its own
origin, so neither the identity header nor a cookie reaches the content route. A
short-lived token in the query string is the credential instead: it names exactly
one attachment on one issue in one workspace, and the content route checks all
three against the row it serves.

The token is minted by whoever already decided the reader may see the issue: the
discussion domain for a member, after `load_visible_issue`, and the views domain
for an anonymous reader, bound to the one issue their share link names. It lives in
`app.common` because both mint it and neither may import the other.

The Markdown a person writes stores only the stable path. The token is appended at
render time, so a stored body never carries a credential and a copied image URL
stops working when its token expires.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import timedelta
from typing import Iterable

from webbpulse.security import ExpiredToken, InvalidToken, create_token, decode_token

from app.common.core.config import settings

MEDIA_AUDIENCE = "standupless.attachment-media"
"""What a media token may be presented for, pinned so no other token replays as one."""

MEDIA_TOKEN_TTL_SECONDS = 3600
"""How long one media token opens its attachment.

An hour covers a page left open through a meeting, and the frontend refreshes well
before it runs out. A copied URL is a credential only for that long.
"""

MAX_MEDIA_TOKENS = 200
"""The most tokens one response mints, so a crafted body cannot make a read sign without bound."""

CONTENT_PATH = re.compile(
    r"/api/workspaces/(?P<workspace_id>[A-Za-z0-9_-]{1,64})/attachments/(?P<attachment_id>[A-Za-z0-9_-]{1,64})/content"
)
"""The stable content path a body embeds, with the two ids it names."""


class MediaTokenError(Exception):
    """A media token that did not verify, for any reason.

    One exception for expired, malformed, wrongly signed and mismatched tokens alike,
    because the content route answers every one of them with the same 404.
    """


@dataclass(frozen=True)
class MediaGrant:
    """What one verified media token opens: a single attachment on a single issue."""

    workspace_id: str
    issue_id: str
    attachment_id: str


def mint_media_token(workspace_id: str, issue_id: str, attachment_id: str) -> str:
    """Sign one media token for one attachment on one issue."""
    return create_token(
        {"workspace_id": workspace_id, "issue_id": issue_id, "attachment_id": attachment_id},
        settings.SECRET_KEY,
        expires_in=timedelta(seconds=MEDIA_TOKEN_TTL_SECONDS),
        audience=MEDIA_AUDIENCE,
    )


def read_media_token(token: str, workspace_id: str, attachment_id: str) -> MediaGrant:
    """The grant a token carries, when it names the workspace and attachment in the path.

    The issue comes from the token rather than from the URL, so a reader cannot
    point a token minted for one issue at an attachment filed under another.
    """
    try:
        claims = decode_token(
            token,
            settings.SECRET_KEY,
            audience=MEDIA_AUDIENCE,
            require=["exp", "workspace_id", "issue_id", "attachment_id"],
        )
    except (ExpiredToken, InvalidToken) as exc:
        raise MediaTokenError("The media token is not valid") from exc

    if claims.get("workspace_id") != workspace_id or claims.get("attachment_id") != attachment_id:
        raise MediaTokenError("The media token names another attachment")
    return MediaGrant(
        workspace_id=str(claims["workspace_id"]),
        issue_id=str(claims["issue_id"]),
        attachment_id=str(claims["attachment_id"]),
    )


def referenced_attachments(workspace_id: str, bodies: Iterable[str]) -> list[str]:
    """The attachment ids a set of Markdown bodies embeds under one workspace, in order.

    Paths naming another workspace are skipped rather than minted for, and the list
    is capped at `MAX_MEDIA_TOKENS`.
    """
    found: list[str] = []
    seen: set[str] = set()
    for body in bodies:
        for match in CONTENT_PATH.finditer(body or ""):
            if match.group("workspace_id") != workspace_id:
                continue
            attachment_id = match.group("attachment_id")
            if attachment_id in seen:
                continue
            seen.add(attachment_id)
            found.append(attachment_id)
            if len(found) >= MAX_MEDIA_TOKENS:
                return found
    return found
