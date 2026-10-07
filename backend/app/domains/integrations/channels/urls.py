"""Which channel webhook URLs are accepted, and how one is sealed, opened and masked.

An incoming webhook URL is a bearer credential: anybody holding it can post to the
channel. It is checked against a fixed allowlist of provider hosts and paths, which
is also what keeps a typed URL from pointing this product at anything else, and it
is stored only as an AES-GCM envelope.

The envelope is the one the TOTP seeds use, `SecretMasterKeyCipher`, keyed by a
master derived with HKDF from the environment's `WEBHOOK_SIGNING_KEY` under an info
string of its own, so this needs no new key in the app secret and the two uses can
never yield the same key. Each URL is bound to its workspace and destination id, so
a ciphertext copied onto another row does not open.

No message here ever repeats the URL, because an error string can reach a log line.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from urllib.parse import urlsplit

from webbpulse.identity.crypto import SealedSecret, SecretMasterKeyCipher
from webbpulse.security import expand_key

from app.common.core.config import settings
from app.common.db.dynamo.channels import ChannelDestination, ChannelProvider

KEY_INFO = b"standupless.channel-url.v1"
"""The HKDF info the channel URL master is expanded under, distinct from every signing key."""

SEAL_PURPOSE = "channel_webhook_url"

SLACK_HOST = "hooks.slack.com"

DISCORD_HOSTS = frozenset({"discord.com", "discordapp.com"})

MAX_URL_LENGTH = 512

HINT_CHARS = 4


class ChannelUrlRejected(ValueError):
    """A channel webhook URL that is not one this product posts to."""


class ChannelKeyMissing(RuntimeError):
    """The environment has no master key to seal or open channel URLs with."""


@dataclass(frozen=True, slots=True)
class ChannelUrl:
    """An accepted URL with the provider it belongs to."""

    url: str
    provider: ChannelProvider


def classify(raw: str) -> ChannelUrl:
    """Accept a Slack or Discord incoming webhook URL, or raise `ChannelUrlRejected`.

    Slack's live at `https://hooks.slack.com/services/...` and Discord's at
    `https://discord.com/api/webhooks/<id>/<token>`, the older `discordapp.com` host
    included. Anything else, another port, credentials, a query or a fragment
    included, is refused.
    """
    url = raw.strip()
    if not url or len(url) > MAX_URL_LENGTH:
        raise ChannelUrlRejected("Paste a Slack or Discord webhook URL.")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise ChannelUrlRejected("That is not a valid URL.") from exc
    if parts.scheme != "https":
        raise ChannelUrlRejected("The webhook URL must start with https://.")
    if parts.username is not None or parts.password is not None or port not in (None, 443):
        raise ChannelUrlRejected("Paste the webhook URL exactly as Slack or Discord shows it.")
    if parts.query or parts.fragment:
        raise ChannelUrlRejected("Paste the webhook URL without a query string.")
    host = (parts.hostname or "").lower()
    segments = [segment for segment in parts.path.split("/") if segment]
    if host == SLACK_HOST and len(segments) >= 4 and segments[0] == "services":
        return ChannelUrl(url=f"https://{SLACK_HOST}/{'/'.join(segments)}", provider="slack")
    if host in DISCORD_HOSTS and len(segments) == 4 and segments[:2] == ["api", "webhooks"] and segments[2].isdigit():
        return ChannelUrl(url=f"https://{host}/{'/'.join(segments)}", provider="discord")
    raise ChannelUrlRejected(
        "Only Slack incoming webhooks (hooks.slack.com/services) and Discord webhooks "
        "(discord.com/api/webhooks) are supported."
    )


def mask(url: str) -> str:
    """The host and the last few characters of the token, enough to tell two URLs apart."""
    parts = urlsplit(url)
    return f"{parts.hostname}/…{parts.path.rstrip('/')[-HINT_CHARS:]}"


def _cipher() -> SecretMasterKeyCipher:
    """The cipher for channel URLs, keyed from the environment master key."""
    master = settings.WEBHOOK_SIGNING_KEY
    if not master:
        raise ChannelKeyMissing("Channel notifications are not configured in this environment.")
    return SecretMasterKeyCipher(expand_key(hashlib.sha256(master.encode()).digest(), KEY_INFO, 32))


def _context(workspace_id: str, channel_id: str) -> str:
    """What a sealed URL is bound to, so it opens only on its own row."""
    return f"{workspace_id}:{channel_id}"


def seal(workspace_id: str, channel_id: str, url: str) -> SealedSecret:
    """Encrypt one URL for one destination."""
    return _cipher().seal(url.encode(), user_id=_context(workspace_id, channel_id), purpose=SEAL_PURPOSE)


def sealed_fields(workspace_id: str, channel_id: str, url: str) -> dict[str, str]:
    """The destination attributes that store one sealed URL and its masked tail."""
    sealed = seal(workspace_id, channel_id, url)
    return {
        "url_ciphertext": sealed.ciphertext,
        "url_nonce": sealed.nonce,
        "url_salt": sealed.wrapped_key,
        "url_scheme": sealed.scheme,
        "url_hint": mask(url),
    }


def open_url(destination: ChannelDestination) -> str:
    """The plaintext URL of one destination, raising `EnvelopeDecryptionFailed` when it will not open."""
    sealed = SealedSecret(
        ciphertext=destination.url_ciphertext,
        nonce=destination.url_nonce,
        wrapped_key=destination.url_salt,
        scheme=destination.url_scheme,
    )
    plaintext = _cipher().open(
        sealed, user_id=_context(destination.workspace_id, destination.channel_id), purpose=SEAL_PURPOSE
    )
    return plaintext.decode()
