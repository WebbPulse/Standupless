"""Fixtures the admin tests share: the admin application, a platform admin, and fakes.

GitHub and Secrets Manager are both replaced at the module boundary the routes call
through, `github_app.convert` and `github_app.secret_store`, so no test here reaches
either service and a test that starts to fails rather than calling out.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from webbpulse.integrations.github import AppManifestConversion

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.users import User
from app.domains.admin import github_app
from tests.domains.helpers import OUTSIDER, OWNER, make_user

PLATFORM_ADMIN = OWNER

PEM = "-----BEGIN RSA PRIVATE KEY-----\nfake-private-key-material\n-----END RSA PRIVATE KEY-----\n"

CLIENT_SECRET = "fake-client-secret-value"

WEBHOOK_SECRET = "fake-webhook-secret-value"

SECRET_VALUES = (PEM, "fake-private-key-material", CLIENT_SECRET, WEBHOOK_SECRET)


class FakeSecretStore:
    """A stand-in for `SecretStore` that records writes and holds only key names."""

    def __init__(self, keys: set[str] | None = None) -> None:
        """Start with the given key names already present in the secret."""
        self.keys: set[str] = set(keys or ())
        self.writes: list[dict[str, str]] = []

    def key_names(self) -> list[str]:
        """The key names the secret holds, the only read the flow makes."""
        return sorted(self.keys)

    def set_many(self, values: dict[str, str]) -> str:
        """Record one merged write and answer a version id like the real store."""
        self.writes.append(dict(values))
        self.keys.update(values)
        return "version-1"


def conversion() -> AppManifestConversion:
    """A conversion as GitHub would answer it, with credentials that must never be echoed."""
    return AppManifestConversion(
        id=987654,
        slug="standupless-test",
        name="Standupless (test)",
        html_url="https://github.com/apps/standupless-test",
        owner_login="WebbPulse",
        client_id="Iv1.fakeclientid",
        client_secret=SecretStr(CLIENT_SECRET),
        webhook_secret=SecretStr(WEBHOOK_SECRET),
        pem=SecretStr(PEM),
    )


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> FakeSecretStore:
    """An empty `app` secret the routes read and write through."""
    fake = FakeSecretStore()
    monkeypatch.setattr(github_app, "secret_store", lambda: fake)
    return fake


@pytest.fixture
def converted(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Replace the code exchange with one answering `conversion()`, recording the codes sent."""
    codes: list[str] = []

    def fake_convert(code: str) -> AppManifestConversion:
        """Record the code and answer the canned App."""
        codes.append(code)
        return conversion()

    monkeypatch.setattr(github_app, "convert", fake_convert)
    return codes


@pytest.fixture
def people(repositories: Any) -> None:
    """A platform admin, and an ordinary signed up user who is not one."""
    repositories.users.create(User(id=PLATFORM_ADMIN, email="admin@example.com", is_admin=True))
    make_user(repositories, OUTSIDER, "outsider@example.com")


@pytest.fixture
def client(repositories: Any, people: None) -> Iterator[TestClient]:
    """The admin function's own application, bound to the tests' tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["admin"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client
