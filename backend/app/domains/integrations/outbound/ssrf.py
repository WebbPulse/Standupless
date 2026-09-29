"""Where an outbound webhook may be sent, and a sender that cannot be talked out of it.

A webhook URL is typed by a customer and fetched by this product from inside its own
network, which is the textbook server side request forgery shape. Three rules close it:

- Only `https` URLs with a hostname and no credentials are accepted.
- Every address the hostname resolves to must be a public unicast address. One private,
  loopback, link-local, carrier-grade NAT, multicast or reserved answer rejects the whole
  URL, so a hostname cannot mix a public address in to pass the check.
- The connection goes to the address that was checked, not to whatever the name resolves
  to a moment later, so a short TTL cannot swap in an internal address between the check
  and the connect. TLS still verifies the certificate against the hostname.

Redirects are never followed, because a redirect is a second URL nobody checked. Every
attempt has one wall clock deadline, `DELIVERY_TIMEOUT_SECONDS`, from the connect to the
last byte read, so a receiver that trickles its answer a byte at a time cannot hold the
consumer open any longer than one that never answers.
"""

from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import threading
from dataclasses import dataclass
from typing import Callable, Mapping
from urllib.parse import urlsplit

from webbpulse.events.webhooks import WebhookResponse

DELIVERY_TIMEOUT_SECONDS = 10.0
"""The most one attempt may take end to end, connect, TLS, send and read together."""

RESPONSE_BODY_LIMIT = 2048

BLOCKED_PREFIX = "Blocked"
"""The start of the error an attempt records when the destination itself was refused."""

_NAT64 = ipaddress.ip_network("64:ff9b::/96")

type Resolver = Callable[[str, int], list[str]]
"""Resolve a hostname and port to every address it answers with."""


class UnsafeDestination(ValueError):
    """A webhook URL this product refuses to send to."""


@dataclass(frozen=True, slots=True)
class Destination:
    """The parts of a webhook URL a connection needs."""

    host: str
    port: int
    target: str


def resolve_host(host: str, port: int) -> list[str]:
    """Every address the system resolver gives for `host`, in its own order, deduplicated."""
    answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(answer[4][0]) for answer in answers))


def parse_destination(url: str) -> Destination:
    """Split a webhook URL into host, port and request target, refusing any unsafe shape."""
    try:
        parts = urlsplit(url.strip())
        port = parts.port or 443
    except ValueError as exc:
        raise UnsafeDestination("The URL is not valid.") from exc
    if parts.scheme.lower() != "https":
        raise UnsafeDestination("The URL must use https.")
    if not parts.hostname:
        raise UnsafeDestination("The URL must name a host.")
    if parts.username is not None or parts.password is not None:
        raise UnsafeDestination("The URL must not carry credentials.")
    target = parts.path or "/"
    if parts.query:
        target = f"{target}?{parts.query}"
    return Destination(host=parts.hostname.rstrip(".").lower(), port=port, target=target)


def is_public_address(value: str) -> bool:
    """Whether one address is a public unicast address a webhook may be sent to.

    IPv6 forms that embed an IPv4 address, namely mapped, NAT64, 6to4 and Teredo, are
    judged by the address they carry, since that is where the packet ends up.
    """
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        embedded: ipaddress.IPv4Address | None = address.ipv4_mapped or address.sixtofour
        if embedded is None and address in _NAT64:
            embedded = ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
        if embedded is None and address.teredo is not None:
            embedded = address.teredo[1]
        if embedded is not None:
            return is_public_address(str(embedded))
    return bool(
        address.is_global
        and not address.is_multicast
        and not address.is_reserved
        and not address.is_unspecified
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_private
    )


def _literal(host: str) -> bool:
    """Whether `host` is an IP address rather than a name."""
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def check_destination(url: str, *, resolver: Resolver | None = None, allow_unresolved: bool = True) -> list[str]:
    """Hold that `url` is safe to send to and return the addresses it resolves to.

    `allow_unresolved` lets a name that does not resolve yet be saved, since a receiver
    is often configured before its DNS exists; the sender itself passes `False`, so an
    unresolvable name is a failed attempt rather than a connection to nowhere.
    """
    destination = parse_destination(url)
    host = destination.host
    if host == "localhost" or host.endswith(".localhost"):
        raise UnsafeDestination("The URL must not point at this machine.")
    if _literal(host):
        if not is_public_address(host):
            raise UnsafeDestination("The URL must not point at a private, loopback or link-local address.")
        return [host]
    try:
        addresses = (resolver or resolve_host)(host, destination.port)
    except (OSError, UnicodeError) as exc:
        if allow_unresolved:
            return []
        raise UnsafeDestination("The host could not be resolved.") from exc
    if not addresses:
        if allow_unresolved:
            return []
        raise UnsafeDestination("The host could not be resolved.")
    if not all(is_public_address(address) for address in addresses):
        raise UnsafeDestination("The URL must not resolve to a private, loopback or link-local address.")
    return addresses


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """An HTTPS connection to one already checked address, verifying TLS against the hostname."""

    def __init__(self, host: str, port: int, *, address: str, timeout: float, context: ssl.SSLContext) -> None:
        """Remember the address to dial alongside the hostname TLS and `Host` use."""
        super().__init__(host, port, timeout=timeout, context=context)
        self._pinned_address = address
        self._pinned_context = context
        self._raw: socket.socket | None = None
        self._aborted = False
        self._lock = threading.Lock()

    def connect(self) -> None:
        """Dial the pinned address, then wrap the socket with SNI set to the hostname."""
        raw = socket.create_connection((self._pinned_address, self.port), self.timeout)
        with self._lock:
            self._raw = raw
            aborted = self._aborted
        if aborted:
            raw.close()
            raise TimeoutError("The attempt ran past its deadline")
        self.sock = self._secure(raw)

    def _secure(self, raw: socket.socket) -> socket.socket:
        """Wrap the dialled socket in TLS, verifying the certificate against the hostname."""
        return self._pinned_context.wrap_socket(raw, server_hostname=self.host)

    def abort(self) -> None:
        """Cut the connection from another thread, waking any blocked handshake, send or read."""
        with self._lock:
            self._aborted = True
            raw = self._raw
        if raw is None:
            return
        try:
            raw.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


class _Deadline:
    """A timer that aborts one connection once the attempt's time is up."""

    def __init__(self, connection: _PinnedHTTPSConnection, seconds: float) -> None:
        """Arm the timer against `connection`."""
        self._connection = connection
        self._fired = threading.Event()
        self._timer = threading.Timer(seconds, self._fire)
        self._timer.daemon = True

    def _fire(self) -> None:
        """Mark the deadline as passed and cut the connection."""
        self._fired.set()
        self._connection.abort()

    @property
    def fired(self) -> bool:
        """Whether the deadline passed before the attempt finished."""
        return self._fired.is_set()

    def __enter__(self) -> "_Deadline":
        """Start the clock."""
        self._timer.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        """Stop the clock."""
        self._timer.cancel()


class PinnedHttpsSender:
    """A `WebhookSender` that checks the destination on every attempt and dials what it checked.

    The check runs per attempt rather than once at save time, because DNS can change
    between the two. Every outcome is a `WebhookResponse`: a refused destination is a
    status of 0 with an error starting `Blocked`, and a 3xx is reported as itself with
    the redirect left unfollowed.
    """

    def __init__(self, *, resolver: Resolver | None = None, context: ssl.SSLContext | None = None) -> None:
        """Take an injected resolver and TLS context, defaulting to the system's."""
        self._resolver = resolver
        self._context = context

    def post(self, url: str, *, body: bytes, headers: Mapping[str, str], timeout: float) -> WebhookResponse:
        """Post `body` to the checked address of `url` and report what came back."""
        try:
            destination = parse_destination(url)
            addresses = check_destination(url, resolver=self._resolver, allow_unresolved=False)
        except UnsafeDestination as exc:
            return WebhookResponse(status_code=0, error=f"{BLOCKED_PREFIX}: {exc}")

        context = self._context or ssl.create_default_context()
        connection = _PinnedHTTPSConnection(
            destination.host,
            destination.port,
            address=addresses[0],
            timeout=timeout,
            context=context,
        )
        deadline = _Deadline(connection, timeout)
        try:
            with deadline:
                connection.request("POST", destination.target, body=body, headers=dict(headers))
                response = connection.getresponse()
                text = response.read(RESPONSE_BODY_LIMIT).decode("utf-8", "replace")
                status = int(response.status)
        except TimeoutError:
            return WebhookResponse(status_code=0, error="Timed out")
        except ssl.SSLError as exc:
            if deadline.fired:
                return WebhookResponse(status_code=0, error="Timed out")
            return WebhookResponse(status_code=0, error=f"TLS error: {type(exc).__name__}")
        except ConnectionRefusedError:
            return WebhookResponse(status_code=0, error="Connection refused")
        except (OSError, http.client.HTTPException) as exc:
            if deadline.fired:
                return WebhookResponse(status_code=0, error="Timed out")
            return WebhookResponse(status_code=0, error=f"Connection failed: {type(exc).__name__}")
        finally:
            connection.close()
        if deadline.fired:
            return WebhookResponse(status_code=0, error="Timed out")
        if 300 <= status < 400:
            return WebhookResponse(status_code=status, body=text, error="Redirect not followed")
        return WebhookResponse(status_code=status, body=text)
