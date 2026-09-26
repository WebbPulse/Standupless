"""The platform admin's Create GitHub App flow, end to end against fakes.

Pins who may reach it, what the manifest says, that the signed state works once
and only for the admin it names, and that the credentials GitHub hands back go
into the secret store and nowhere else: not the response, not the logs.
"""

from __future__ import annotations

import json
import logging
from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from webbpulse.integrations.github import GitHubError
from webbpulse.security import create_token

from app.common.core.config import settings
from app.common.db.dynamo.users import User
from app.domains.admin import github_app
from tests.domains.admin.conftest import PLATFORM_ADMIN, SECRET_VALUES, FakeSecretStore
from tests.domains.helpers import ADMIN, OUTSIDER, sign_in, sign_out

STATUS = "/api/admin/github-app"

MANIFEST = "/api/admin/github-app/manifest"

CONVERSIONS = "/api/admin/github-app/conversions"


def _state(client: TestClient) -> str:
    """Start a creation as whoever is signed in and answer the state GitHub would echo."""
    response = client.post(MANIFEST)
    assert response.status_code == 200, response.text
    return parse_qs(urlsplit(response.json()["post_url"]).query)["state"][0]


def _nonce_state(user_id: str, **overrides: Any) -> str:
    """A state minted by hand, so expiry and audience can be varied."""
    return create_token(
        {"user_id": user_id, "nonce": "fixed-nonce"},
        overrides.pop("secret", settings.SECRET_KEY),
        expires_in=overrides.pop("expires_in", timedelta(minutes=10)),
        audience=overrides.pop("audience", github_app.STATE_AUDIENCE),
    )


@pytest.mark.parametrize(
    ("method", "path"),
    [("GET", STATUS), ("POST", MANIFEST), ("POST", CONVERSIONS)],
)
def test_an_unauthenticated_caller_is_refused(
    client: TestClient, store: FakeSecretStore, method: str, path: str
) -> None:
    """No credential is a 401 on every route, before anything is read."""
    sign_out(client)
    response = client.request(method, path, json={"code": "c", "state": "s"})
    assert response.status_code == 401


@pytest.mark.parametrize(
    ("method", "path"),
    [("GET", STATUS), ("POST", MANIFEST), ("POST", CONVERSIONS)],
)
def test_a_user_who_is_not_a_platform_admin_sees_nothing(
    client: TestClient, store: FakeSecretStore, method: str, path: str
) -> None:
    """An ordinary user gets the same 404 an absent route would, so the page is not advertised."""
    sign_in(client, OUTSIDER)
    response = client.request(method, path, json={"code": "c", "state": "s"})
    assert response.status_code == 404
    assert store.writes == []


def test_a_signed_in_user_without_a_row_is_refused(client: TestClient, store: FakeSecretStore) -> None:
    """A token for somebody with no users row cannot be an admin."""
    sign_in(client, ADMIN)
    assert client.get(STATUS).status_code == 404


def test_the_admin_role_claim_alone_is_not_enough(client: TestClient, store: FakeSecretStore) -> None:
    """The row decides, so a token asserting the admin role for a non-admin is refused."""
    sign_in(client, OUTSIDER, roles=["admin"], role="admin")
    assert client.get(STATUS).status_code == 404


def test_a_disabled_admin_is_refused(client: TestClient, store: FakeSecretStore, repositories: Any) -> None:
    """Disabling an account takes its platform access with it immediately."""
    repositories.users.update(PLATFORM_ADMIN, disabled=True)
    sign_in(client, PLATFORM_ADMIN)
    assert client.get(STATUS).status_code == 404


def test_a_delegated_credential_is_refused_even_for_an_admin(client: TestClient, store: FakeSecretStore) -> None:
    """An MCP token or API key acting for an admin cannot create an App."""
    sign_in(client, PLATFORM_ADMIN, scope="workspace:read")
    assert client.get(STATUS).status_code == 404

    sign_in(client, PLATFORM_ADMIN, actor="service")
    assert client.get(STATUS).status_code == 404


def test_the_status_reports_an_empty_environment(client: TestClient, store: FakeSecretStore) -> None:
    """A platform admin sees that no App exists yet and that the secret can take one."""
    sign_in(client, PLATFORM_ADMIN)
    body = client.get(STATUS).json()
    assert body["configured"] is False
    assert body["secret_available"] is True
    assert body["organization"] == "WebbPulse"


def test_the_status_reports_a_missing_secret(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Without an app secret ARN the page can say why nothing can be created."""
    monkeypatch.setattr(github_app, "secret_store", lambda: None)
    sign_in(client, PLATFORM_ADMIN)
    body = client.get(STATUS).json()
    assert body == {**body, "configured": False, "secret_available": False}
    assert client.post(MANIFEST).status_code == 503


def test_the_manifest_matches_the_documented_app(client: TestClient, store: FakeSecretStore) -> None:
    """The manifest carries the permissions, events and URLs in docs/github-app.md."""
    sign_in(client, PLATFORM_ADMIN)
    body = client.post(MANIFEST).json()
    manifest = body["manifest"]

    assert manifest["default_permissions"] == {
        "issues": "read",
        "pull_requests": "write",
        "checks": "write",
        "contents": "read",
        "metadata": "read",
    }
    assert manifest["default_events"] == ["pull_request", "push"]
    assert manifest["hook_attributes"] == {"url": f"{settings.api_base_url}/api/github/webhooks", "active": True}
    assert manifest["callback_urls"] == [f"{settings.api_base_url}/api/github/callback"]
    assert manifest["setup_url"] == f"{settings.api_base_url}/api/github/callback"
    assert manifest["redirect_url"] == f"{settings.frontend_base_url}/admin/github-app/created"
    assert manifest["request_oauth_on_install"] is True
    assert manifest["setup_on_update"] is True
    assert manifest["public"] is True
    assert manifest["url"] == settings.frontend_base_url
    assert manifest["name"].startswith("Standupless")
    assert body["post_url"].startswith("https://github.com/organizations/WebbPulse/settings/apps/new?state=")


def test_the_manifest_is_refused_once_an_app_exists(client: TestClient, store: FakeSecretStore) -> None:
    """A second App cannot be started over the first."""
    store.keys.add("GITHUB_APP_ID")
    sign_in(client, PLATFORM_ADMIN)
    assert client.get(STATUS).json()["configured"] is True
    response = client.post(MANIFEST)
    assert response.status_code == 409
    assert response.json()["error_code"] == "ALREADY_CONFIGURED"


def test_a_conversion_stores_every_credential_and_answers_only_the_id_and_slug(
    client: TestClient,
    store: FakeSecretStore,
    converted: list[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The happy path: one write of all five keys, and nothing secret leaves the function."""
    caplog.set_level(logging.DEBUG)
    sign_in(client, PLATFORM_ADMIN)
    state = _state(client)

    response = client.post(CONVERSIONS, json={"code": "manifest-code", "state": state})

    assert response.status_code == 201, response.text
    assert response.json() == {
        "id": 987654,
        "slug": "standupless-test",
        "settings_url": "https://github.com/organizations/WebbPulse/settings/apps/standupless-test",
        "logo_path": "/github-app-logo.png",
        "badge_color": "#141518",
    }
    assert converted == ["manifest-code"]
    assert len(store.writes) == 1
    assert set(store.writes[0]) == {
        "GITHUB_APP_ID",
        "GITHUB_PRIVATE_KEY",
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
        "GITHUB_WEBHOOK_SECRET",
    }
    assert store.writes[0]["GITHUB_APP_ID"] == "987654"

    logged = caplog.text + json.dumps([record.__dict__ for record in caplog.records], default=str)
    for secret in SECRET_VALUES:
        assert secret not in response.text
        assert secret not in logged


def test_a_state_works_once(client: TestClient, store: FakeSecretStore, converted: list[str]) -> None:
    """Replaying a redeemed state is refused before GitHub is called again."""
    sign_in(client, PLATFORM_ADMIN)
    state = _state(client)
    assert client.post(CONVERSIONS, json={"code": "first", "state": state}).status_code == 201
    store.keys.clear()

    replay = client.post(CONVERSIONS, json={"code": "second", "state": state})

    assert replay.status_code == 400
    assert replay.json()["error_code"] == "INVALID_STATE"
    assert converted == ["first"]


def test_a_state_minted_for_another_admin_is_refused(
    client: TestClient, store: FakeSecretStore, converted: list[str], repositories: Any
) -> None:
    """A second platform admin cannot redeem the first one's state, nor burn it."""
    repositories.users.create(User(id=ADMIN, email="second@example.com", is_admin=True))
    sign_in(client, PLATFORM_ADMIN)
    state = _state(client)

    sign_in(client, ADMIN)
    refused = client.post(CONVERSIONS, json={"code": "c", "state": state})
    assert refused.status_code == 400

    sign_in(client, PLATFORM_ADMIN)
    assert client.post(CONVERSIONS, json={"code": "c", "state": state}).status_code == 201
    assert converted == ["c"]


@pytest.mark.parametrize(
    "overrides",
    [
        {"expires_in": timedelta(seconds=-1)},
        {"audience": "standupless.github-install"},
        {"secret": "a-different-signing-key-entirely-000000"},
    ],
    ids=["expired", "wrong-audience", "wrong-key"],
)
def test_an_unusable_state_is_refused(
    client: TestClient, store: FakeSecretStore, converted: list[str], overrides: dict[str, Any]
) -> None:
    """Expired, foreign and forged states never reach GitHub."""
    sign_in(client, PLATFORM_ADMIN)
    response = client.post(CONVERSIONS, json={"code": "c", "state": _nonce_state(PLATFORM_ADMIN, **overrides)})
    assert response.status_code == 400
    assert converted == []
    assert store.writes == []


def test_the_state_expires_after_ten_minutes() -> None:
    """The TTL the task fixes, so a slow confirmation page cannot linger for hours."""
    assert github_app.STATE_TTL_SECONDS == 600


def test_a_conversion_is_refused_once_an_app_exists(
    client: TestClient, store: FakeSecretStore, converted: list[str]
) -> None:
    """Keys already in the secret are never overwritten by a second creation."""
    sign_in(client, PLATFORM_ADMIN)
    state = _state(client)
    store.keys.add("GITHUB_APP_ID")

    response = client.post(CONVERSIONS, json={"code": "c", "state": state})

    assert response.status_code == 409
    assert converted == []
    assert store.writes == []


def test_a_github_failure_is_a_bad_gateway_and_writes_nothing(
    client: TestClient, store: FakeSecretStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """GitHub refusing the code answers 502 and leaves the secret untouched."""

    def refuse(code: str) -> Any:
        """Fail the way the shared client does on a used code."""
        raise GitHubError("gone", method="POST", path="/app-manifests/x/conversions", status_code=404)

    monkeypatch.setattr(github_app, "convert", refuse)
    sign_in(client, PLATFORM_ADMIN)

    response = client.post(CONVERSIONS, json={"code": "c", "state": _state(client)})

    assert response.status_code == 502
    assert store.writes == []


def test_a_malformed_code_is_a_bad_request(
    client: TestClient, store: FakeSecretStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A code the shared client refuses to send is a 400 rather than a call."""

    def reject(code: str) -> Any:
        """Fail the way `convert_manifest_code` does on a malformed code."""
        raise ValueError("malformed")

    monkeypatch.setattr(github_app, "convert", reject)
    sign_in(client, PLATFORM_ADMIN)

    response = client.post(CONVERSIONS, json={"code": "../x", "state": _state(client)})

    assert response.status_code == 400
    assert response.json()["error_code"] == "INVALID_CODE"


def test_a_failed_write_is_reported_and_leaks_nothing(
    client: TestClient,
    store: FakeSecretStore,
    converted: list[str],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A store failure is its own error code, and neither the answer nor the logs carry a value."""
    from webbpulse.ops.config import ConfigToolError

    def fail(values: dict[str, str]) -> str:
        """Fail the write, carrying the values in the message to prove they are not echoed."""
        raise ConfigToolError(f"write failed for {values}")

    monkeypatch.setattr(store, "set_many", fail)
    caplog.set_level(logging.DEBUG)
    sign_in(client, PLATFORM_ADMIN)

    response = client.post(CONVERSIONS, json={"code": "c", "state": _state(client)})

    assert response.status_code == 503
    assert response.json()["error_code"] == "STORE_FAILED"
    logged = caplog.text + json.dumps([record.__dict__ for record in caplog.records], default=str)
    for secret in SECRET_VALUES:
        assert secret not in response.text
        assert secret not in logged


def test_the_conversion_request_is_bounded(client: TestClient, store: FakeSecretStore) -> None:
    """An empty or oversized code is rejected by validation before any work."""
    sign_in(client, PLATFORM_ADMIN)
    assert client.post(CONVERSIONS, json={"code": "", "state": "s"}).status_code == 422
    assert client.post(CONVERSIONS, json={"code": "x" * 129, "state": "s"}).status_code == 422
