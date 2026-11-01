"""Sending one message to one device, behind one sender per mobile platform.

The fan out only knows `PushSender`, so another provider arrives as one more class
and one more entry in `sender_for`, with no change to who hears what. Only the Apple
sender exists so far.

Delivery is best effort and must never hold up the work that triggered it. Timeouts
are short, nothing here raises for a provider's answer, a run of connection failures
pauses sending for a minute so one outage cannot spend a consumer's whole timeout,
and nothing logged carries a token or a credential. A credential that is missing or
does not parse leaves the platform without a sender, which turns push off cleanly.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import threading
import time
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache
from typing import Protocol
from urllib.parse import quote

import httpx
import jwt
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePrivateKey
from cryptography.hazmat.primitives.serialization import load_der_private_key, load_pem_private_key

from app.common.core.config import settings

_log = logging.getLogger(__name__)

APNS_TIMEOUT = httpx.Timeout(3.0, connect=2.0)
"""Per request bounds, short because a send happens inside a consumer or a route."""

PROVIDER_TOKEN_LIFETIME_SECONDS = 2400
"""How long one Apple provider token is reused, inside the 20 to 60 minutes Apple asks for."""

OUTAGE_PAUSE_SECONDS = 60.0
"""How long sending stops after a connection fails twice in a row."""

ALERT_EXPIRY_SECONDS = 86400
"""How long Apple keeps trying a device that is offline, after which an alert has no use."""

GONE_REASONS = frozenset({"BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"})
"""The answers that mean a token will never work again, so its device should go."""


class PushOutcome(Enum):
    """What a provider said about one send."""

    SENT = "sent"
    GONE = "gone"
    FAILED = "failed"


@dataclass(frozen=True)
class PushAlert:
    """What a person sees: the text, where a tap goes, and how the system groups it."""

    title: str
    body: str
    path: str
    collapse_id: str
    thread_id: str


@dataclass(frozen=True)
class PushMessage:
    """One message to one device: always a badge, with an alert when one should show."""

    badge: int
    alert: PushAlert | None = None


class PushSender(Protocol):
    """Delivers a message to a device on one platform."""

    def send(self, token: str, message: PushMessage) -> PushOutcome:
        """Send one message, answering what the provider said and never raising."""
        ...


def load_apns_private_key(raw: str) -> EllipticCurvePrivateKey | None:
    """The `.p8` signing key from its stored text, or `None` when it cannot be used.

    Accepts the PEM itself, the PEM with escaped newlines, or either the PEM or its
    DER encoded as base64, since how the key was stored has not been read back.
    """
    text = raw.strip().replace("\\n", "\n")
    if not text:
        return None
    try:
        if "-----BEGIN" in text:
            key = load_pem_private_key(text.encode("utf-8"), password=None)
        else:
            decoded = base64.b64decode(text, validate=True)
            if b"-----BEGIN" in decoded:
                key = load_pem_private_key(decoded, password=None)
            else:
                key = load_der_private_key(decoded, password=None)
    except (ValueError, TypeError, UnsupportedAlgorithm):
        return None
    return key if isinstance(key, EllipticCurvePrivateKey) else None


class ApnsSender:
    """Sends to Apple over HTTP/2 with token based authentication."""

    def __init__(
        self,
        *,
        key: EllipticCurvePrivateKey,
        key_id: str,
        team_id: str,
        topic: str,
        host: str,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        """Keep the credentials and open no connection until the first send."""
        self._key = key
        self._key_id = key_id
        self._team_id = team_id
        self._topic = topic
        self._host = host.rstrip("/")
        self._transport = transport
        self._client: httpx.Client | None = None
        self._provider_token = ""
        self._provider_token_at = 0.0
        self._paused_until = 0.0
        self._lock = threading.Lock()

    def _connection(self) -> httpx.Client:
        """The kept alive client, since Apple asks senders to reuse one connection."""
        if self._client is None:
            self._client = httpx.Client(http2=True, timeout=APNS_TIMEOUT, transport=self._transport)
        return self._client

    def _discard_connection(self) -> None:
        """Drop the client, whose connection may have died while the function was frozen."""
        if self._client is not None:
            self._client.close()
            self._client = None

    def _bearer(self) -> str:
        """A provider token, minted again once it has been in use long enough."""
        now = time.time()
        if not self._provider_token or now - self._provider_token_at >= PROVIDER_TOKEN_LIFETIME_SECONDS:
            self._provider_token = jwt.encode(
                {"iss": self._team_id, "iat": int(now)},
                self._key,
                algorithm="ES256",
                headers={"kid": self._key_id},
            )
            self._provider_token_at = now
        return self._provider_token

    def _headers(self, message: PushMessage) -> dict[str, str]:
        """The request headers, with a badge alone sent at the lower priority."""
        alert = message.alert
        collapse_id = hashlib.sha256((alert.collapse_id if alert else "badge").encode("utf-8")).hexdigest()[:32]
        return {
            "authorization": f"bearer {self._bearer()}",
            "apns-topic": self._topic,
            "apns-push-type": "alert",
            "apns-priority": "10" if alert is not None else "5",
            "apns-expiration": str(int(time.time()) + ALERT_EXPIRY_SECONDS) if alert is not None else "0",
            "apns-collapse-id": collapse_id,
        }

    @staticmethod
    def _body(message: PushMessage) -> bytes:
        """The payload: the badge, and the alert with the path a tap opens."""
        aps: dict[str, object] = {"badge": message.badge}
        payload: dict[str, object] = {"aps": aps}
        if message.alert is not None:
            aps["alert"] = {"title": message.alert.title, "body": message.alert.body}
            aps["sound"] = "default"
            aps["thread-id"] = message.alert.thread_id
            payload["path"] = message.alert.path
        return json.dumps(payload, separators=(",", ":")).encode("utf-8")

    def _outcome(self, response: httpx.Response) -> PushOutcome:
        """Read Apple's answer, and forget the provider token when Apple refused it."""
        if response.status_code == 200:
            return PushOutcome.SENT
        try:
            reason = str(response.json().get("reason", ""))
        except ValueError:
            reason = ""
        if response.status_code == 410 or reason in GONE_REASONS:
            return PushOutcome.GONE
        if response.status_code == 403:
            self._provider_token = ""
        _log.warning("APNs refused a push", extra={"status": response.status_code, "reason": reason})
        return PushOutcome.FAILED

    def send(self, token: str, message: PushMessage) -> PushOutcome:
        """Send one message, retrying once on a fresh connection when the kept one is dead."""
        with self._lock:
            if time.monotonic() < self._paused_until:
                return PushOutcome.FAILED
            url = f"{self._host}/3/device/{quote(token, safe='')}"
            body = self._body(message)
            for attempt in range(2):
                try:
                    response = self._connection().post(url, content=body, headers=self._headers(message))
                except httpx.TransportError as exc:
                    self._discard_connection()
                    if attempt == 1:
                        self._paused_until = time.monotonic() + OUTAGE_PAUSE_SECONDS
                        _log.warning("APNs is unreachable", extra={"error_type": type(exc).__name__})
                    continue
                return self._outcome(response)
            return PushOutcome.FAILED


def _apns_sender() -> ApnsSender | None:
    """The Apple sender, or `None` when this environment's credentials are not usable."""
    raw_key, key_id, team_id = settings.apns_key, settings.apns_key_id, settings.apns_team_id
    if not raw_key or not key_id or not team_id:
        _log.info("Native push is off: the APNs credentials are not all in the app secret")
        return None
    key = load_apns_private_key(raw_key)
    if key is None:
        _log.warning("Native push is off: the stored APNs key did not parse")
        return None
    return ApnsSender(key=key, key_id=key_id, team_id=team_id, topic=settings.apns_topic, host=settings.APNS_HOST)


@lru_cache(maxsize=None)
def sender_for(platform: str) -> PushSender | None:
    """The sender for one platform, held for the process, or `None` when it cannot send."""
    if platform == "ios":
        return _apns_sender()
    return None
