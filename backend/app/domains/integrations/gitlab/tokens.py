"""Sealing and opening a GitLab access token, and the webhook secret's digest.

The access token is sealed with the same envelope as a Slack bot token,
`SecretMasterKeyCipher` keyed from the environment's `WEBHOOK_SIGNING_KEY` in the
app secret, expanded under an HKDF info string of its own so a GitLab token and
any other sealed value never share a key. Each token is bound to its workspace
and connection, so a ciphertext copied onto another row does not open. The
plaintext lives only in memory while a request uses it.

The webhook secret is the opposite case: GitLab sends it back on every delivery
and nothing here ever sends it, so only its SHA-256 digest is kept and the
receiver compares digests in constant time.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

from webbpulse.identity.crypto import SealedSecret, SecretMasterKeyCipher
from webbpulse.security import expand_key

from app.common.core.config import settings
from app.common.db.dynamo.gitlab import GitlabConnection

KEY_INFO = b"standupless.gitlab-access-token.v1"

SEAL_PURPOSE = "gitlab_access_token"

WEBHOOK_SECRET_BYTES = 32
"""The entropy of a generated webhook secret, well past any guessing."""


class TokenKeyMissing(RuntimeError):
    """The environment has no master key to seal or open an access token with."""


def configured() -> bool:
    """Whether this environment can seal a GitLab access token at all."""
    return bool(settings.WEBHOOK_SIGNING_KEY)


def _cipher() -> SecretMasterKeyCipher:
    """The cipher for access tokens, keyed from the environment master key."""
    master = settings.WEBHOOK_SIGNING_KEY
    if not master:
        raise TokenKeyMissing("GitLab is not configured in this environment.")
    return SecretMasterKeyCipher(expand_key(hashlib.sha256(master.encode()).digest(), KEY_INFO, 32))


def _context(workspace_id: str, connection_id: str) -> str:
    """What a sealed token is bound to."""
    return f"{workspace_id}:{connection_id}"


def sealed_fields(workspace_id: str, connection_id: str, token: str) -> dict[str, str]:
    """The connection attributes that store one sealed access token."""
    sealed = _cipher().seal(token.encode(), user_id=_context(workspace_id, connection_id), purpose=SEAL_PURPOSE)
    return {
        "token_ciphertext": sealed.ciphertext,
        "token_nonce": sealed.nonce,
        "token_salt": sealed.wrapped_key,
        "token_scheme": sealed.scheme,
    }


def open_token(connection: GitlabConnection) -> str:
    """The plaintext access token of one connection, raising `EnvelopeDecryptionFailed` when it will not open."""
    sealed = SealedSecret(
        ciphertext=connection.token_ciphertext,
        nonce=connection.token_nonce,
        wrapped_key=connection.token_salt,
        scheme=connection.token_scheme,
    )
    plaintext = _cipher().open(
        sealed, user_id=_context(connection.workspace_id, connection.connection_id), purpose=SEAL_PURPOSE
    )
    return plaintext.decode()


def hint(token: str) -> str:
    """The last four characters of a token, which an admin recognises it by without it being readable."""
    return token[-4:] if len(token) > 8 else ""


def new_webhook_secret() -> str:
    """A fresh webhook secret, shown to the admin once and never stored."""
    return secrets.token_urlsafe(WEBHOOK_SECRET_BYTES)


def secret_digest(secret: str) -> str:
    """The SHA-256 digest a connection keeps in place of its webhook secret."""
    return hashlib.sha256(secret.encode()).hexdigest()


def secret_matches(connection: GitlabConnection, presented: str | None) -> bool:
    """Whether the `X-Gitlab-Token` a delivery carried is this connection's secret."""
    if not presented or not connection.webhook_secret_hash:
        return False
    return hmac.compare_digest(secret_digest(presented), connection.webhook_secret_hash)
