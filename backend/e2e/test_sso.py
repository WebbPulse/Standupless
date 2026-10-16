"""Workspace single sign-on against a real OIDC provider on the local stack.

The unit tests prove the policy with fakes, and none of them proves that a real
provider's discovery document, login form, code exchange and ID token come
together into a Standupless session. This module does, against a Keycloak the
local stack starts on loopback: an owner sets up a verified domain and an OIDC
connection, a person on that domain signs in through Keycloak for the first time,
joins the workspace just in time, tests the connection as an admin and requires
single sign-on, and the owner keeps the break-glass access the policy promises.

It runs only on the local stack, where `KEYCLOAK_URL` names the provider and the
backend trusts it over HTTP and skips the DNS lookup a real domain is proven with.
Every deployed stage skips it.
"""

from __future__ import annotations

import contextlib
import html
import os
import re
import secrets
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
import pytest

WRITES = pytest.mark.e2e_writes

KEYCLOAK_ADMIN = ("admin", "admin")
"""The throwaway bootstrap admin the CI job starts Keycloak with."""

FRONTEND_ORIGIN = "http://localhost:5173"

LOGIN_FORM = re.compile(r"<form\b[^>]*\bid=\"kc-form-login\"[^>]*>", re.IGNORECASE)
FORM_ACTION = re.compile(r"\baction=\"([^\"]+)\"", re.IGNORECASE)

BACKEND_DIRECTORY = Path(__file__).resolve().parents[1]


def _keycloak_url() -> str:
    """The local provider's base URL, or an empty string when this stack has none."""
    return os.environ.get("KEYCLOAK_URL", "").strip().rstrip("/")


@pytest.fixture(scope="module")
def keycloak(e2e_env: Any) -> str:
    """The provider's base URL, skipping every case where the stack runs none."""
    if e2e_env.environment != "local" or e2e_env.read_only or not _keycloak_url():
        pytest.skip("single sign-on runs against Keycloak on the local stack only")
    return _keycloak_url()


def _admin_token(base: str) -> str:
    """A Keycloak admin token from the master realm's admin CLI client."""
    response = httpx.post(
        f"{base}/realms/master/protocol/openid-connect/token",
        data={
            "grant_type": "password",
            "client_id": "admin-cli",
            "username": KEYCLOAK_ADMIN[0],
            "password": KEYCLOAK_ADMIN[1],
        },
        timeout=30,
    )
    assert response.status_code == 200, f"Keycloak admin sign-in answered {response.status_code}"
    return str(response.json()["access_token"])


class Provider:
    """One throwaway Keycloak realm with a confidential client and one person on the test domain."""

    def __init__(self, base: str, realm: str, domain: str, redirect_uri: str) -> None:
        """Hold the names the realm is built from; nothing is created until `create`."""
        self.base = base
        self.realm = realm
        self.domain = domain
        self.redirect_uri = redirect_uri
        self.client_id = "standupless"
        self.client_secret = secrets.token_urlsafe(24)
        self.email = f"alice@{domain}"
        self.password = secrets.token_urlsafe(18)

    @property
    def issuer(self) -> str:
        """The realm's issuer, as its discovery document states it."""
        return f"{self.base}/realms/{self.realm}"

    def _admin(self) -> httpx.Client:
        """An admin API client for this provider."""
        return httpx.Client(
            base_url=f"{self.base}/admin/realms",
            headers={"Authorization": f"Bearer {_admin_token(self.base)}"},
            timeout=30,
        )

    def create(self) -> None:
        """Create the realm, the client Standupless signs in through and the person."""
        with self._admin() as admin:
            realm = admin.post("", json={"realm": self.realm, "enabled": True})
            assert realm.status_code == 201, f"creating the realm answered {realm.status_code}: {realm.text[:300]}"
            client = admin.post(
                f"/{self.realm}/clients",
                json={
                    "clientId": self.client_id,
                    "enabled": True,
                    "protocol": "openid-connect",
                    "publicClient": False,
                    "secret": self.client_secret,
                    "redirectUris": [self.redirect_uri],
                    "standardFlowEnabled": True,
                    "directAccessGrantsEnabled": False,
                },
            )
            assert client.status_code == 201, f"creating the client answered {client.status_code}: {client.text[:300]}"
            user = admin.post(
                f"/{self.realm}/users",
                json={
                    "username": self.email,
                    "email": self.email,
                    "emailVerified": True,
                    "firstName": "Alice",
                    "lastName": "Example",
                    "enabled": True,
                    "requiredActions": [],
                    "credentials": [{"type": "password", "value": self.password, "temporary": False}],
                },
            )
            assert user.status_code == 201, f"creating the person answered {user.status_code}: {user.text[:300]}"

    def delete(self) -> None:
        """Remove the realm and everything in it. Best effort, since the container is thrown away."""
        try:
            with self._admin() as admin:
                admin.delete(f"/{self.realm}")
        except (httpx.HTTPError, AssertionError):
            pass


def _grant_business(slug: str) -> None:
    """Hold the workspace on the Business plan through the comp grant script, with no Stripe behind it."""
    result = subprocess.run(
        [
            sys.executable,
            "scripts/grant_comp_plan.py",
            "--stage",
            "e2e-local",
            "--workspace",
            slug,
            "--plan",
            "business",
            "--reason",
            "Single sign-on e2e",
        ],
        cwd=BACKEND_DIRECTORY,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, f"the comp grant failed: {result.stdout[-400:]} {result.stderr[-400:]}"


def _cookie_header(browser: httpx.Client) -> dict[str, str]:
    """Every cookie the client holds, as the header a browser on loopback would send.

    Keycloak marks its cookies `Secure` even on plain HTTP to localhost, which a browser
    treats as a secure context and the standard library cookie jar does not, so the jar
    alone would leave Keycloak's login form without its session cookie.
    """
    pairs = [f"{cookie.name}={cookie.value}" for cookie in browser.cookies.jar if cookie.value is not None]
    return {"Cookie": "; ".join(pairs)} if pairs else {}


def _sign_in_through_provider(api_base: str, provider: Provider, workspace_id: str) -> httpx.Client:
    """Run the browser's side of an OIDC sign-in and return a client holding the session cookie.

    Starts at the sign-in page's route, fills Keycloak's login form and follows the
    provider's redirect back to the callback by hand, so each hop can be asserted.
    """
    browser = httpx.Client(timeout=30, follow_redirects=False)
    started = browser.post(
        f"{api_base}/api/auth/sso/start",
        json={"connection_id": workspace_id, "return_to": "/"},
        headers={"Origin": FRONTEND_ORIGIN},
    )
    assert started.status_code == 200, f"starting single sign-on answered {started.status_code}: {started.text[:300]}"
    body = started.json()
    assert body["connection_id"] == workspace_id
    assert str(body["authorization_url"]).startswith(provider.issuer)

    page = browser.get(body["authorization_url"], follow_redirects=True)
    assert page.status_code == 200, f"the provider's login page answered {page.status_code}"
    form = LOGIN_FORM.search(page.text)
    assert form is not None, "the provider's page carries no login form"
    action = FORM_ACTION.search(form.group(0))
    assert action is not None, "the provider's login form names no action"
    submitted = browser.post(
        urljoin(str(page.url), html.unescape(action.group(1))),
        data={"username": provider.email, "password": provider.password, "credentialId": ""},
        headers=_cookie_header(browser),
    )
    assert submitted.status_code in (302, 303), f"the provider's login answered {submitted.status_code}"
    callback = submitted.headers["location"]
    assert callback.startswith(provider.redirect_uri), "the provider redirected somewhere other than the callback"

    finished = browser.get(callback, headers=_cookie_header(browser))
    assert finished.status_code == 303, f"the callback answered {finished.status_code}: {finished.text[:300]}"
    location = finished.headers["location"]
    assert "sso_error" not in location, f"the callback refused the sign-in: {location}"
    assert "sso=1" in location
    return browser


def _access_token(browser: httpx.Client, api_base: str) -> str:
    """Exchange the session cookie the callback set for an access token, as the auth shell does."""
    response = browser.post(
        f"{api_base}/api/auth/refresh",
        headers={"Origin": FRONTEND_ORIGIN, "Sec-Fetch-Site": "same-site", **_cookie_header(browser)},
    )
    assert response.status_code == 200, f"refreshing the SSO session answered {response.status_code}"
    return str(response.json()["access_token"])


@pytest.fixture
def sso_workspace(api: Any, e2e_env: Any, schedule_workspace_deletion: Any) -> Iterator[dict[str, Any]]:
    """A Business workspace this run owns, scheduled for deletion afterwards."""
    suffix = secrets.token_hex(4)
    slug = f"{e2e_env.resource_prefix}sso-{suffix}".replace("_", "-")[-40:].strip("-")
    created = api.post("/api/workspaces", json={"name": f"{e2e_env.resource_prefix}sso", "slug": slug})
    assert created.status_code in (200, 201), f"creating the workspace answered {created.status_code}"
    workspace = dict(created.json())
    _grant_business(workspace["slug"])
    yield workspace
    schedule_workspace_deletion(workspace["id"])


@WRITES
def test_oidc_sign_in_joins_tests_and_requires_sso(
    api: Any, e2e_env: Any, keycloak: str, sso_workspace: dict[str, Any]
) -> None:
    """A first sign-in through Keycloak joins the workspace, and an admin's own test unlocks requiring it."""
    api_base = e2e_env.api_base_url.rstrip("/")
    workspace_id = sso_workspace["id"]
    base = f"/api/workspaces/{workspace_id}/sso"
    domain = f"{secrets.token_hex(5)}.sso-e2e.test"

    settings = api.get(base)
    assert settings.status_code == 200, settings.text[:300]
    redirect_uri = settings.json()["service_provider"]["oidc_redirect_uri"]
    assert redirect_uri == f"{api_base}/api/auth/sso/oidc/{workspace_id}/callback"

    provider = Provider(keycloak, f"sso-{secrets.token_hex(6)}", domain, redirect_uri)
    provider.create()
    try:
        added = api.post(f"{base}/domains", json={"domain": domain.upper()})
        assert added.status_code == 201, added.text[:300]
        assert added.json()["record_value"].startswith("standupless-verification=")
        verified = api.post(f"{base}/domains/{domain}/verify")
        assert verified.status_code == 200, verified.text[:300]
        assert verified.json()["verified"] is True

        saved = api.put(
            f"{base}/connection",
            json={
                "protocol": "oidc",
                "display_name": "Keycloak",
                "oidc_issuer": provider.issuer,
                "oidc_client_id": provider.client_id,
                "oidc_client_secret": provider.client_secret,
            },
        )
        assert saved.status_code == 200, saved.text[:300]
        assert provider.client_secret not in saved.text
        assert saved.json()["connection"]["has_client_secret"] is True
        assert saved.json()["can_require"] is False

        too_early = api.put(f"{base}/policy", json={"require_sso": True})
        assert too_early.status_code == 409

        browser = _sign_in_through_provider(api_base, provider, workspace_id)
        with contextlib.closing(browser):
            token = _access_token(browser, api_base)
            alice = httpx.Client(base_url=api_base, headers={"Authorization": f"Bearer {token}"}, timeout=30)
            with alice:
                joined = alice.post("/api/workspaces/sso/join")
                assert joined.status_code == 201, joined.text[:300]
                assert joined.json()["workspace_id"] == workspace_id
                again = alice.post("/api/workspaces/sso/join")
                assert again.status_code == 200
                assert again.json()["created"] is False

                me = alice.get("/api/users/me")
                assert me.status_code == 200
                alice_id = str(me.json()["id"])
                assert me.json()["display_name"] == "Alice Example"

                promoted = api.patch(f"/api/workspaces/{workspace_id}/members/{alice_id}", json={"role": "admin"})
                assert promoted.status_code == 200, promoted.text[:300]

                tested = alice.post(f"{base}/connection/test-result")
                assert tested.status_code == 200, tested.text[:300]
                assert tested.json()["connection"]["tested"] is True
                assert tested.json()["current_session_sso"] is True
                assert tested.json()["can_require"] is True

                owner_test = api.post(f"{base}/connection/test-result")
                assert owner_test.status_code == 409

                discovered = httpx.post(
                    f"{api_base}/api/auth/sso/start",
                    json={"email": f"bob@{domain}", "return_to": "/"},
                    headers={"Origin": FRONTEND_ORIGIN},
                    timeout=30,
                )
                assert discovered.status_code == 200, discovered.text[:300]
                assert discovered.json()["connection_id"] == workspace_id
                unknown = httpx.post(
                    f"{api_base}/api/auth/sso/start",
                    json={"email": f"bob@unlisted-{domain}", "return_to": "/"},
                    headers={"Origin": FRONTEND_ORIGIN},
                    timeout=30,
                )
                assert unknown.status_code == 404
                assert unknown.json().get("error_code") == "SSO_CONNECTION_NOT_FOUND"

                required = alice.put(f"{base}/policy", json={"require_sso": True})
                assert required.status_code == 200, required.text[:300]
                assert required.json()["require_sso"] is True

                assert alice.get(f"/api/workspaces/{workspace_id}").status_code == 200
                assert api.get(f"/api/workspaces/{workspace_id}").status_code == 200

                assert api.delete(f"{base}/domains/{domain}").status_code == 409
                assert api.delete(f"{base}/connection").status_code == 409

                lifted = alice.put(f"{base}/policy", json={"require_sso": False})
                assert lifted.status_code == 200
                assert lifted.json()["require_sso"] is False
    finally:
        api.put(f"{base}/policy", json={"require_sso": False})
        api.delete(f"{base}/connection")
        api.delete(f"{base}/domains/{domain}")
        provider.delete()


@WRITES
def test_saml_routes_refuse_what_is_not_a_saml_connection(
    e2e_env: Any, keycloak: str, sso_workspace: dict[str, Any]
) -> None:
    """A workspace with no SAML connection serves no metadata, and a malformed ACS post is redirected with an error."""
    del keycloak
    api_base = e2e_env.api_base_url.rstrip("/")
    workspace_id = sso_workspace["id"]
    metadata = httpx.get(f"{api_base}/api/auth/sso/saml/{workspace_id}/metadata", timeout=30)
    assert metadata.status_code in (404, 501)
    acs = httpx.post(
        f"{api_base}/api/auth/sso/saml/{workspace_id}/acs",
        data={"SAMLResponse": "bm90IGEgcmVzcG9uc2U=", "RelayState": "unknown"},
        timeout=30,
    )
    assert acs.status_code == 303
    assert "sso_error=" in acs.headers["location"]
