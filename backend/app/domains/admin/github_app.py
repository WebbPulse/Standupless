"""Creating this environment's GitHub App through GitHub's App manifest flow.

The manifest flow is the only way an App's private key never passes through a
person's clipboard or a build log: GitHub creates the App from a manifest the
browser posts, redirects back with a one-time `code`, and hands the App's id, key,
client secret and webhook secret to whoever exchanges that code. Here that is this
function, which writes them straight into the environment's `app` secret and
answers with nothing but the App's id and slug.

The manifest is built server side from this deployment's own settings, so the URLs
GitHub records can only be this environment's. The `state` the flow carries is
signed, names the platform admin who started it, works once and expires after ten
minutes, the same mechanism the install flow uses under its own audience.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Mapping, Protocol
from urllib.parse import quote

from webbpulse.security import ExpiredToken, InvalidToken, create_token, decode_token

from app.common.core.config import settings

if TYPE_CHECKING:  # pragma: no cover
    from webbpulse.integrations.github import AppManifestConversion
    from webbpulse.ops.config import SecretStore

_log = logging.getLogger(__name__)

GITHUB_ORGANIZATION = "WebbPulse"
"""The organization every environment's App is owned by."""

STATE_AUDIENCE = "standupless.github-app-manifest"

NONCE_SCOPE = "github-app-manifest-state"

PLATFORM_SCOPE = "_platform"

STATE_TTL_SECONDS = 600
"""Ten minutes, long enough to read GitHub's confirmation page and short enough to not linger."""

APP_ID_KEY = "GITHUB_APP_ID"
"""The `app` secret key whose presence means this environment already has an App."""

PERMISSIONS: Mapping[str, str] = {
    "issues": "read",
    "pull_requests": "write",
    "checks": "write",
    "contents": "read",
    "metadata": "read",
}
"""The repository permissions in docs/github-app.md, and nothing at organization or account level."""

EVENTS: tuple[str, ...] = ("pull_request", "push")
"""The subscribed events. `installation` and `installation_repositories` reach every App without one."""

FINISH_PATH = "/admin/github-app/created"
"""The web app page GitHub sends the browser back to with the manifest `code`."""


class ManifestStateError(Exception):
    """A state that is absent, malformed, expired, redeemed, or minted for somebody else."""


class _Claims(Protocol):
    """The slice of the idempotency repository a redemption needs."""

    def claim(self, workspace_id: str, scope: str, key: str, *, ttl_seconds: float = ...) -> bool:
        """Claim one key, answering whether this caller won it."""
        ...


def app_name() -> str:
    """The App's name, which GitHub requires to be unique across every App it hosts."""
    environment = settings.APP_ENVIRONMENT.lower()
    return "Standupless" if environment == "production" else f"Standupless ({environment})"


def build_manifest() -> dict[str, Any]:
    """The manifest for this environment's App, matching the table in docs/github-app.md.

    User authorization during installation is on, so GitHub sends an installing
    admin to the first callback URL and ignores `setup_url`; the setup URL is still
    the same route so unchecking the box later changes nothing that binds.
    """
    api = settings.api_base_url
    callback = f"{api}/api/github/callback"
    return {
        "name": app_name(),
        "url": settings.frontend_base_url,
        "hook_attributes": {"url": f"{api}/api/github/webhooks", "active": True},
        "redirect_url": f"{settings.frontend_base_url}{FINISH_PATH}",
        "callback_urls": [callback],
        "setup_url": callback,
        "setup_on_update": True,
        "request_oauth_on_install": True,
        "public": True,
        "default_permissions": dict(PERMISSIONS),
        "default_events": list(EVENTS),
    }


def creation_url(state: str) -> str:
    """Where the browser posts the manifest to create the App under the organization."""
    return f"https://github.com/organizations/{GITHUB_ORGANIZATION}/settings/apps/new?state={quote(state, safe='')}"


def settings_url(slug: str) -> str:
    """The App's settings page, where the logo and badge colour are set by hand."""
    return f"https://github.com/organizations/{GITHUB_ORGANIZATION}/settings/apps/{quote(slug, safe='')}"


def mint_state(user_id: str) -> tuple[str, datetime]:
    """A signed state naming the platform admin who started the flow, and when it expires."""
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=STATE_TTL_SECONDS)
    token = create_token(
        {"user_id": user_id, "nonce": secrets.token_urlsafe(16)},
        settings.SECRET_KEY,
        expires_in=timedelta(seconds=STATE_TTL_SECONDS),
        audience=STATE_AUDIENCE,
    )
    return token, expires_at


def redeem_state(state: str, user_id: str, idempotency: _Claims) -> None:
    """Accept a state once, and only from the admin it was minted for, or `ManifestStateError`.

    The caller is checked before the nonce is claimed, so somebody else holding a
    leaked state cannot burn it for the admin it belongs to.
    """
    if not state:
        raise ManifestStateError("missing state")
    try:
        claims = decode_token(
            state,
            settings.SECRET_KEY,
            audience=STATE_AUDIENCE,
            require=["exp", "iat", "user_id", "nonce"],
        )
    except (ExpiredToken, InvalidToken) as error:
        raise ManifestStateError("invalid state") from error
    if str(claims.get("user_id", "")) != user_id:
        raise ManifestStateError("state minted for another admin")
    nonce = str(claims.get("nonce", ""))
    if not nonce or not idempotency.claim(PLATFORM_SCOPE, NONCE_SCOPE, nonce, ttl_seconds=STATE_TTL_SECONDS * 2):
        raise ManifestStateError("state already redeemed")


def secret_store() -> SecretStore | None:
    """The environment's `app` secret as a key-level store, or `None` when there is none.

    Values never leave the store: it merges the new keys into the current version
    and answers only with a version id, so nothing here can echo a credential.
    """
    arn = settings.APP_SECRETS_ARN
    if not arn:
        return None
    import boto3
    from webbpulse.ops.config import SecretStore

    return SecretStore(boto3.client("secretsmanager"), arn)


def app_configured(store: SecretStore) -> bool:
    """Whether the `app` secret already names an App, read fresh rather than from the cold start cache."""
    return APP_ID_KEY in store.key_names()


def convert(code: str) -> AppManifestConversion:
    """Exchange the manifest `code` for the new App and the credentials GitHub shows once."""
    from webbpulse.integrations.github import convert_manifest_code

    return convert_manifest_code(code)


def store_credentials(store: SecretStore, conversion: AppManifestConversion, *, created_by: str) -> None:
    """Merge the new App's credentials into the `app` secret, keeping every other key.

    Logs the App's id and slug and who created it, never a value: the key, client
    secret and webhook secret are `SecretStr` on the conversion and are unwrapped
    only inside `app_secret_values`, straight into the write.
    """
    store.set_many(conversion.app_secret_values())
    _log.info(
        "Created the GitHub App and stored its credentials.",
        extra={
            "event": "admin.github_app_created",
            "github_app_id": conversion.id,
            "github_app_slug": conversion.slug,
            "user_id": created_by,
        },
    )
