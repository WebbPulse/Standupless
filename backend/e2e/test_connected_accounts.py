"""The connected accounts routes behind the /security page, driven against the deployed stage.

The run holds no real GitHub or Google account, so a link can never be completed here and
the unlink guard's own refusal, which needs a linked provider to refuse removing, is proven
by the unit suite in `webbpulse` instead. What the run can prove is everything up to the
provider's consent screen: the list answers for a signed-in user and refuses an anonymous
one, a link starts with an authorization URL on the provider and sets the cookie binding
that state to this browser, and an unlink of a provider the account does not hold is
refused with `OAUTH_NOT_LINKED` rather than reported as done.

Link and unlink both need a sign-in from the last ten minutes, and the shared session may
be older than that by the time these cases run, so each case signs in afresh and signs out
again afterwards.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from urllib.parse import urlsplit

import pytest
from webbpulse.e2e.identity import IdentitySession, login

WRITES = pytest.mark.e2e_writes

PROVIDER_HOSTS = {
    "github": "github.com",
    "google": "accounts.google.com",
}
"""Where each provider's consent screen lives, for asserting a link starts at the right host."""

BINDING_COOKIE = "wp_oauth_link"
"""The cookie that binds a link's state to the browser that started it."""


def _enabled_providers(anon: Any) -> list[str]:
    """The provider ids this stage offers, read from the public discovery route."""
    response = anon.get("/api/auth/oauth/providers")
    assert response.status_code == 200, f"/oauth/providers answered {response.status_code}."
    return [row["id"] for row in response.json().get("providers", [])]


def _error_code(response: Any) -> str:
    """The identity error code a refusal carries, or an empty string."""
    try:
        body = response.json()
    except ValueError:
        return ""
    return str(body.get("error_code", "")) if isinstance(body, dict) else ""


@pytest.fixture
def fresh(anon: Any, credentials: Any) -> Iterator[IdentitySession]:
    """A session signed in moments ago, so the recent sign-in check passes, signed out after."""
    session = login(anon, credentials.email, credentials.password)
    try:
        yield session
    finally:
        cookie = "; ".join(f"{name}={value}" for name, value in session.refresh_cookies.items())
        anon.post("/api/auth/logout", json={}, headers={"cookie": cookie})


class TestConnectedAccounts:
    """List, start a link and refuse a stray unlink, for the durable e2e user."""

    def test_anonymous_list_is_refused(self, anon: Any) -> None:
        """The list names another person's providers, so it never answers without a session."""
        response = anon.get("/api/auth/oauth/links")
        assert response.status_code == 401, f"an anonymous list answered {response.status_code}."

    def test_signed_in_list_answers(self, fresh: IdentitySession) -> None:
        """A signed-in user reads their links, each with the fields the settings page renders."""
        response = fresh.client.get("/api/auth/oauth/links")
        assert response.status_code == 200, f"the list answered {response.status_code}: {response.text[:300]}"
        links = response.json()["links"]
        assert isinstance(links, list)
        for row in links:
            assert {"provider", "login", "email", "linked_at"} <= row.keys(), row.keys()
            assert "subject" not in row, "the list leaked the provider subject."

    @WRITES
    def test_link_starts_at_the_provider_with_a_binding_cookie(self, anon: Any, fresh: IdentitySession) -> None:
        """A fresh sign-in starts a link: the provider's authorize URL and the binding cookie.

        Writes one state row, which expires on its own after ten minutes.
        """
        providers = [p for p in _enabled_providers(anon) if p in PROVIDER_HOSTS]
        if not providers:
            pytest.skip("this stage offers no provider to link.")
        provider = providers[0]
        response = fresh.client.post(
            f"/api/auth/oauth/{provider}/link",
            json={"return_to": "/security"},
        )
        assert response.status_code == 200, f"starting a link answered {response.status_code}: {response.text[:300]}"
        url = urlsplit(response.json()["authorization_url"])
        assert url.scheme == "https"
        assert url.hostname == PROVIDER_HOSTS[provider], url.hostname
        cookies = response.headers.get_list("set-cookie")
        binding = [value for value in cookies if value.startswith(f"{BINDING_COOKIE}=")]
        assert binding, f"starting a link set no {BINDING_COOKIE} cookie."
        assert "httponly" in binding[0].lower(), "the binding cookie is readable from script."

    def test_anonymous_link_is_refused(self, anon: Any) -> None:
        """Only a signed-in user can start attaching a provider to an account."""
        providers = _enabled_providers(anon)
        if not providers:
            pytest.skip("this stage offers no provider.")
        response = anon.post(f"/api/auth/oauth/{providers[0]}/link", json={})
        assert response.status_code == 401, f"an anonymous link answered {response.status_code}."

    @WRITES
    def test_unlinking_a_provider_not_held_is_refused(self, anon: Any, fresh: IdentitySession) -> None:
        """An unlink of a provider the account does not hold is a 404, never a silent success."""
        held = {row["provider"] for row in fresh.client.get("/api/auth/oauth/links").json()["links"]}
        spare = [p for p in _enabled_providers(anon) if p not in held]
        if not spare:
            pytest.skip("the e2e user holds every provider this stage offers.")
        response = fresh.client.delete(f"/api/auth/oauth/{spare[0]}/link")
        assert response.status_code == 404, f"a stray unlink answered {response.status_code}: {response.text[:300]}"
        assert _error_code(response) == "OAUTH_NOT_LINKED", _error_code(response)

    def test_anonymous_unlink_is_refused(self, anon: Any) -> None:
        """Only a signed-in user can detach a provider."""
        providers = _enabled_providers(anon)
        if not providers:
            pytest.skip("this stage offers no provider.")
        response = anon.delete(f"/api/auth/oauth/{providers[0]}/link")
        assert response.status_code == 401, f"an anonymous unlink answered {response.status_code}."
