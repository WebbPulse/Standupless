"""Discord's Ed25519 signature over every interaction it sends.

Discord signs the `X-Signature-Timestamp` header followed by the raw body with the
App's private key, and publishes the matching public key on the App's page. A
request is acted on only when that signature verifies against this environment's
key and the timestamp is within five minutes, so a captured request cannot be
replayed later. Discord itself probes the endpoint with bad signatures and expects
each one refused.
"""

from __future__ import annotations

import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

MAX_SKEW_SECONDS = 300


class SignatureRejected(Exception):
    """The request was not signed by Discord with this environment's key, or is too old."""


def verify(
    public_key: str,
    timestamp: str | None,
    signature: str | None,
    body: bytes,
    *,
    now: float | None = None,
) -> None:
    """Accept a body Discord signed with the App's key in the last five minutes, or raise `SignatureRejected`."""
    if not public_key or not timestamp or not signature:
        raise SignatureRejected("missing signature")
    try:
        stamp = int(timestamp)
    except ValueError as error:
        raise SignatureRejected("unreadable timestamp") from error
    if abs((time.time() if now is None else now) - stamp) > MAX_SKEW_SECONDS:
        raise SignatureRejected("stale timestamp")
    try:
        key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key))
        key.verify(bytes.fromhex(signature), timestamp.encode() + body)
    except (ValueError, InvalidSignature) as error:
        raise SignatureRejected("signature does not verify") from error


def sign(private_key: Ed25519PrivateKey, timestamp: str, body: bytes) -> str:
    """The hex signature Discord would send with one body, for tests and the local stack's e2e."""
    return private_key.sign(timestamp.encode() + body).hex()
