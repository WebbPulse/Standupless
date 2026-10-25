"""Reply-by-email addresses: minting one per notification email and verifying it on the way back.

A single-issue notification email carries `reply-<token>@<intake domain>` as its
Reply-To. The token is an HMAC, under a key expanded from the environment
master, over the workspace, the issue, the recipient and the comment a reply
threads under, so nobody can construct one and every recipient's differs. The
row it resolves to is refreshed on every send and honoured for `TOKEN_TTL`, and
verifying a token recomputes the HMAC over that row, so a row edited in place or
left behind by a rotated key resolves to nothing.

Minting fails soft: with no master key or no intake domain the email simply
carries no Reply-To, which is exactly how it was sent before replies existed.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from datetime import datetime, timedelta, timezone
from typing import Iterable

from app.common.core.config import settings
from app.common.db.dynamo.email_replies import EmailReplyStore, EmailReplyToken

KEY_INFO = b"standupless.email-reply.v1"
"""The HKDF info the reply key is expanded under, distinct from every other key."""

REPLY_PREFIX = "reply-"

TOKEN_LENGTH = 32
"""Lowercase base32 characters, 160 bits, short enough for a 64 character local part."""

TOKEN_TTL = timedelta(days=30)
"""How long after the latest email a reply to it is still accepted."""


def reply_domain() -> str:
    """The mail domain reply addresses live under, or `""` when this deployment has none."""
    return settings.EMAIL_INTAKE_DOMAIN.strip().lower()


def _key() -> bytes | None:
    """The reply signing key, or `None` when this environment has no master."""
    master = settings.WEBHOOK_SIGNING_KEY
    if not master:
        return None
    from webbpulse.security import expand_key

    return expand_key(hashlib.sha256(master.encode()).digest(), KEY_INFO, 32)


def _sign(key: bytes, workspace_id: str, issue_id: str, user_id: str, comment_id: str) -> str:
    """The token for one recipient of one email about one issue."""
    message = "|".join(("v1", workspace_id, issue_id, user_id, comment_id)).encode()
    digest = hmac.new(key, message, hashlib.sha256).digest()
    return base64.b32encode(digest).decode("ascii").lower()[:TOKEN_LENGTH]


def token_digest(token: str) -> str:
    """What a token's row is keyed by, so the stored row never holds the token itself."""
    return hashlib.sha256(token.encode()).hexdigest()


def mint_reply_address(
    store: EmailReplyStore,
    *,
    workspace_id: str,
    issue_id: str,
    user_id: str,
    comment_id: str = "",
    now: datetime | None = None,
) -> str:
    """The Reply-To address for one notification email, or `""` when replies are not set up here."""
    domain = reply_domain()
    key = _key()
    if not domain or key is None or not workspace_id or not issue_id or not user_id:
        return ""
    token = _sign(key, workspace_id, issue_id, user_id, comment_id)
    moment = now or datetime.now(timezone.utc)
    store.put(
        token_digest(token),
        EmailReplyToken(
            workspace_id=workspace_id,
            issue_id=issue_id,
            user_id=user_id,
            comment_id=comment_id,
            valid_until=moment + TOKEN_TTL,
        ),
    )
    return f"{REPLY_PREFIX}{token}@{domain}"


def reply_tokens(addresses: Iterable[str], domain: str) -> list[str]:
    """The reply tokens among some lower cased recipient addresses, in order."""
    if not domain:
        return []
    suffix = f"@{domain.lower()}"
    found: list[str] = []
    for address in addresses:
        if not address.endswith(suffix):
            continue
        local = address[: -len(suffix)]
        if not local.startswith(REPLY_PREFIX):
            continue
        token = local[len(REPLY_PREFIX) :]
        if len(token) == TOKEN_LENGTH and token.isalnum():
            found.append(token)
    return list(dict.fromkeys(found))


def resolve_reply_token(store: EmailReplyStore, token: str) -> EmailReplyToken | None:
    """The row a genuine token stands for, expired or not, or `None` when it is unknown or forged."""
    key = _key()
    if key is None or len(token) != TOKEN_LENGTH:
        return None
    row = store.get(token_digest(token))
    if row is None:
        return None
    expected = _sign(key, row.workspace_id, row.issue_id, row.user_id, row.comment_id)
    if not hmac.compare_digest(expected, token):
        return None
    return row


def is_expired(row: EmailReplyToken, *, now: datetime | None = None) -> bool:
    """Whether a reply address is past the time it is honoured until."""
    return row.valid_until <= (now or datetime.now(timezone.utc))


def verify_reply_token(store: EmailReplyStore, token: str, *, now: datetime | None = None) -> EmailReplyToken | None:
    """The row a token stands for, or `None` when it is unknown, forged or expired."""
    row = resolve_reply_token(store, token)
    if row is None or is_expired(row, now=now):
        return None
    return row
