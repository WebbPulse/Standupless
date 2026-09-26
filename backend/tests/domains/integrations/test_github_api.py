"""The product side of the GitHub client: building it and refusing to without an App.

`github_api.app_client` is the one place a `GitHubAppClient` is built, so these pin
that it reads the App from the same settings the rest of the function does, signs
with that App's key, and fails as `GitHubNotConfigured` without ever echoing a key.
"""

from __future__ import annotations

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.common.core.config import settings
from app.domains.integrations import github_api


def _pem() -> str:
    """A throwaway RSA key in the PEM form GitHub hands out."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ).decode()


def test_the_client_signs_as_this_environments_app(monkeypatch: pytest.MonkeyPatch) -> None:
    """The App JWT names the configured App id as its issuer."""
    monkeypatch.setattr(settings, "APP_SECRETS_ARN", "", raising=False)
    monkeypatch.delenv("APP_SECRETS_ARN", raising=False)
    monkeypatch.setenv("GITHUB_APP_ID", "123456")
    monkeypatch.setenv("GITHUB_PRIVATE_KEY", _pem())

    with github_api.app_client() as client:
        token = client.app_jwt()

    claims = jwt.decode(token, options={"verify_signature": False})
    assert str(claims["iss"]) == "123456"


def test_an_unusable_key_is_not_configured_and_never_echoed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A key that does not parse fails as not configured, naming the key and not its value."""
    monkeypatch.setattr(settings, "APP_SECRETS_ARN", "", raising=False)
    monkeypatch.delenv("APP_SECRETS_ARN", raising=False)
    monkeypatch.setenv("GITHUB_APP_ID", "123456")
    monkeypatch.setenv("GITHUB_PRIVATE_KEY", "not-a-real-key-material")

    with pytest.raises(github_api.GitHubNotConfigured) as caught:
        github_api.app_client()

    assert "not-a-real-key-material" not in str(caught.value)


def test_a_missing_app_is_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """No App id and no key is the inert state before the App is created."""
    monkeypatch.setattr(settings, "APP_SECRETS_ARN", "", raising=False)
    monkeypatch.delenv("APP_SECRETS_ARN", raising=False)
    monkeypatch.delenv("GITHUB_APP_ID", raising=False)
    monkeypatch.delenv("GITHUB_PRIVATE_KEY", raising=False)

    with pytest.raises(github_api.GitHubNotConfigured):
        github_api.app_client()


def test_the_install_url_needs_a_slug(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without a slug there is nowhere to send an admin, which reads as not configured."""
    monkeypatch.setattr(settings, "GITHUB_APP_SLUG", "", raising=False)

    with pytest.raises(github_api.GitHubNotConfigured):
        github_api.install_url("state")


def test_the_install_url_carries_the_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """The public install path is built from the slug and carries the signed state."""
    monkeypatch.setattr(settings, "GITHUB_APP_SLUG", "standupless-test", raising=False)

    assert github_api.install_url("abc") == "https://github.com/apps/standupless-test/installations/new?state=abc"
