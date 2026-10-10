"""Sealing and opening the Slack bot token.

The same envelope as a channel webhook URL, `SecretMasterKeyCipher` keyed from the
environment's `WEBHOOK_SIGNING_KEY`, but expanded under an HKDF info string of its
own, so a token and a URL never share a key. Each token is bound to its workspace
and Slack team, so a ciphertext copied onto another row does not open.
"""

from __future__ import annotations

import hashlib

from webbpulse.identity.crypto import SealedSecret, SecretMasterKeyCipher
from webbpulse.security import expand_key

from app.common.core.config import settings
from app.common.db.dynamo.slack import SlackInstallation

KEY_INFO = b"standupless.slack-bot-token.v1"

SEAL_PURPOSE = "slack_bot_token"


class TokenKeyMissing(RuntimeError):
    """The environment has no master key to seal or open a bot token with."""


def _cipher() -> SecretMasterKeyCipher:
    """The cipher for bot tokens, keyed from the environment master key."""
    master = settings.WEBHOOK_SIGNING_KEY
    if not master:
        raise TokenKeyMissing("The Slack App is not configured in this environment.")
    return SecretMasterKeyCipher(expand_key(hashlib.sha256(master.encode()).digest(), KEY_INFO, 32))


def _context(workspace_id: str, slack_team_id: str) -> str:
    """What a sealed token is bound to."""
    return f"{workspace_id}:{slack_team_id}"


def sealed_fields(workspace_id: str, slack_team_id: str, token: str) -> dict[str, str]:
    """The installation attributes that store one sealed bot token."""
    sealed = _cipher().seal(token.encode(), user_id=_context(workspace_id, slack_team_id), purpose=SEAL_PURPOSE)
    return {
        "token_ciphertext": sealed.ciphertext,
        "token_nonce": sealed.nonce,
        "token_salt": sealed.wrapped_key,
        "token_scheme": sealed.scheme,
    }


def open_token(installation: SlackInstallation) -> str:
    """The plaintext bot token of one installation, raising `EnvelopeDecryptionFailed` when it will not open."""
    sealed = SealedSecret(
        ciphertext=installation.token_ciphertext,
        nonce=installation.token_nonce,
        wrapped_key=installation.token_salt,
        scheme=installation.token_scheme,
    )
    plaintext = _cipher().open(
        sealed, user_id=_context(installation.workspace_id, installation.slack_team_id), purpose=SEAL_PURPOSE
    )
    return plaintext.decode()
