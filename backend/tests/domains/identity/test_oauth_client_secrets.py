"""The OAuth client secrets tolerate a provider whose key the app secret lacks.

Apple was added to a live deployment whose stored secret may predate it, so a
missing key must drop that one provider and never stop the identity function from
starting.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from app.domains.identity.package_glue import OAUTH_SECRET_KEYS, build_oauth_client_secrets

ARN = "arn:aws:secretsmanager:us-west-2:000000000000:secret:test"


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start with no provider secret and no secret ARN in the environment."""
    monkeypatch.delenv("APP_SECRETS_ARN", raising=False)
    for key in OAUTH_SECRET_KEYS.values():
        monkeypatch.delenv(key, raising=False)


def settings_with(arn: str) -> Any:
    """Settings carrying only the secret ARN, which is all the builder reads."""
    return SimpleNamespace(APP_SECRETS_ARN=arn)


def stored(monkeypatch: pytest.MonkeyPatch, values: dict[str, str]) -> None:
    """Make the single app secret hold these keys."""
    monkeypatch.setattr("webbpulse.security.app_secrets", lambda _arn: values)


def test_apple_reads_its_own_key_from_the_app_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """A stored Apple key reaches the provider under the apple id."""
    stored(monkeypatch, {"OAUTH_APPLE_CLIENT_SECRET": "apple-value"})

    assert build_oauth_client_secrets(settings_with(ARN)) == {"apple": "apple-value"}


def test_an_absent_apple_key_leaves_the_other_providers_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    """A secret without the Apple key drops Apple rather than raising."""
    stored(monkeypatch, {"OAUTH_GOOGLE_CLIENT_SECRET": "google-value", "OAUTH_GITHUB_CLIENT_SECRET": "github-value"})

    assert build_oauth_client_secrets(settings_with(ARN)) == {"google": "google-value", "github": "github-value"}


def test_the_environment_wins_over_the_app_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """An environment value is used ahead of the stored one."""
    monkeypatch.setenv("OAUTH_APPLE_CLIENT_SECRET", "from-environment")
    stored(monkeypatch, {"OAUTH_APPLE_CLIENT_SECRET": "from-secret"})

    assert build_oauth_client_secrets(settings_with(ARN)) == {"apple": "from-environment"}


def test_no_secret_arn_yields_only_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without an ARN nothing is loaded, and an empty result is valid."""
    monkeypatch.setattr("webbpulse.security.app_secrets", lambda _arn: pytest.fail("loaded the app secret"))

    assert build_oauth_client_secrets(settings_with("")) == {}
