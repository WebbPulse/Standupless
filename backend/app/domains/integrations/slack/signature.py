"""Verifying that a request came from Slack, before its body is parsed.

Slack signs `v0:<timestamp>:<raw body>` with the App's signing secret as
HMAC-SHA256 and sends it as `X-Slack-Signature: v0=<hex>` beside
`X-Slack-Request-Timestamp`. A timestamp more than five minutes from now is refused
even when the signature matches, so a captured request cannot be replayed later.
"""

from __future__ import annotations

import hashlib
import hmac
import time

VERSION = "v0"

MAX_SKEW_SECONDS = 300


class SignatureRejected(Exception):
    """The request is unsigned, signed with another secret, or too old."""


def sign(secret: str, timestamp: str, body: bytes) -> str:
    """The `X-Slack-Signature` value for one body at one timestamp."""
    base = f"{VERSION}:{timestamp}:".encode() + body
    return f"{VERSION}=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()


def verify(secret: str, timestamp: str | None, signature: str | None, body: bytes, *, now: float | None = None) -> None:
    """Return when the request is Slack's and fresh, or raise `SignatureRejected`."""
    if not secret or not timestamp or not signature:
        raise SignatureRejected("unsigned")
    try:
        sent = int(timestamp)
    except ValueError as error:
        raise SignatureRejected("bad timestamp") from error
    if abs((time.time() if now is None else now) - sent) > MAX_SKEW_SECONDS:
        raise SignatureRejected("stale")
    if not hmac.compare_digest(sign(secret, timestamp, body), signature):
        raise SignatureRejected("mismatch")
