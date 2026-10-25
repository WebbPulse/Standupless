"""The consent gate and refresh guard that hold third-party apps for a workspace's admins.

The consent tests drive the package's own authorize and consent routes, because the
gate is only reached through the consent the package has already validated. The
refresh and revoke tests use the authorization server the identity routes build.
"""

from __future__ import annotations

from typing import Any, Iterator
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.common.app_approvals import read_request_ticket
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.memberships import AppApproval
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_user, make_workspace, sign_in
from tests.domains.identity.test_oauth_server import (
    RESOURCE,
    WORKSPACE_ONE,
    WORKSPACE_TWO,
    authorize,
    consent,
    identity_environment,
    oauth_tables,
    pkce_pair,
    register_client,
)

__all__ = ["identity_environment", "oauth_tables"]

REDIRECT = "http://localhost:7777/callback"

THIRD_PARTY = "client-third-party"


@pytest.fixture
def package(oauth_tables: None, identity_environment: None, repositories: Any) -> Iterator[TestClient]:
    """A client over the identity package router, where the consent route lives."""
    from app.common.core.config import Settings
    from app.domains.identity.package_glue import build_router

    app = FastAPI()
    app.include_router(build_router(Settings(**{"_env_file": None})))  # pyright: ignore[reportCallIssue]
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def server(oauth_tables: None, identity_environment: None) -> Any:
    """The authorization server the identity routes build, with one third-party client."""
    from webbpulse.identity import OAuthClientRecord

    from app.common.core.config import get_settings
    from app.domains.identity.connected_apps import build_authorization_server

    built = build_authorization_server(get_settings())
    assert built is not None
    built.stores.clients.put(
        OAuthClientRecord(client_id=THIRD_PARTY, redirect_uris=(REDIRECT,), client_name="Third Party")
    )
    return built


@pytest.fixture
def client(server: Any, repositories: Any) -> Iterator[TestClient]:
    """A client for the identity application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["identity"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspaces(repositories: Any) -> None:
    """Two workspaces: an owner, an admin and a member in the first, the owner alone in the second."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    make_user(repositories, MEMBER, "member@example.com", display_name="Member")
    make_user(repositories, ADMIN, "admin@example.com", display_name="Admin")
    make_workspace(repositories, WORKSPACE_ONE, "one", OWNER)
    make_workspace(repositories, WORKSPACE_TWO, "two", OWNER)
    add_member(repositories, WORKSPACE_ONE, MEMBER, "member")
    add_member(repositories, WORKSPACE_ONE, ADMIN, "admin")


def approval(repositories: Any, client_id: str, status: str, workspace_id: str = WORKSPACE_ONE) -> None:
    """Put one app's approval record in the workspace."""
    repositories.memberships.put_app_approval(
        AppApproval(workspace_id=workspace_id, client_id=client_id, client_name="Test MCP Client", status=status)
    )


def consent_to(package: TestClient, client_id: str) -> Any:
    """Sign the member in and post their consent for `client_id` in the first workspace."""
    sign_in(package, MEMBER)
    _, challenge = pkce_pair()
    screen = authorize(package, client_id, "issues:read", challenge)
    assert screen.status_code == 200, screen.text
    return consent(package, screen.text, WORKSPACE_ONE)


def grant(server: Any, user_id: str, client_id: str, workspace_id: str) -> str:
    """Authorize `client_id` for `user_id` in one workspace, returning its refresh token."""
    verifier, challenge = pkce_pair()
    request = server.service.parse_authorization_request(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": REDIRECT,
            "resource": RESOURCE,
            "scope": "issues:read",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    server.service.record_consent(request, user_id=user_id, tenant_id=workspace_id)
    code = server.service.issue_code(request, user_id=user_id, tenant_id=workspace_id)
    body = server.service.exchange_code(
        {"code": code, "client_id": client_id, "redirect_uri": REDIRECT, "code_verifier": verifier}
    )
    return str(body["refresh_token"])


def refresh(server: Any, client_id: str, token: str) -> dict[str, Any]:
    """Rotate a refresh token the way the client would."""
    return server.service.refresh({"refresh_token": token, "client_id": client_id, "scope": "issues:read"})


def test_with_approvals_off_consent_issues_a_code(package: TestClient, repositories: Any, workspaces: None) -> None:
    """The default leaves consent exactly as it was."""
    client_id = register_client(package)

    response = consent_to(package, client_id)

    assert response.status_code == 303
    assert "code" in parse_qs(urlsplit(response.headers["location"]).query)


def test_an_unapproved_app_goes_to_the_request_page(package: TestClient, repositories: Any, workspaces: None) -> None:
    """No code is issued, and the redirect carries a ticket naming the app and the request to resume."""
    repositories.workspaces.set_third_party_app_approvals(WORKSPACE_ONE, True)
    client_id = register_client(package)

    response = consent_to(package, client_id)

    assert response.status_code == 303
    location = urlsplit(response.headers["location"])
    assert location.path.endswith("/app-access")
    query = parse_qs(location.query)
    assert "code" not in query
    assert query["workspace_id"] == [WORKSPACE_ONE]
    claims = read_request_ticket(query["ticket"][0], WORKSPACE_ONE)
    assert claims["client_id"] == client_id
    assert claims["client_name"] == "Test MCP Client"
    resume = parse_qs(urlsplit(str(claims["return_to"])).query)
    assert resume["client_id"] == [client_id]
    assert resume["state"] == ["opaque-client-state"]


def test_an_approved_app_issues_a_code(package: TestClient, repositories: Any, workspaces: None) -> None:
    """Once an admin approved the app any member may authorize it."""
    repositories.workspaces.set_third_party_app_approvals(WORKSPACE_ONE, True)
    client_id = register_client(package)
    approval(repositories, client_id, "approved")

    response = consent_to(package, client_id)

    assert "code" in parse_qs(urlsplit(response.headers["location"]).query)


def test_a_denied_app_is_held_at_consent(package: TestClient, repositories: Any, workspaces: None) -> None:
    """A denial holds every member's consent until an admin approves again."""
    repositories.workspaces.set_third_party_app_approvals(WORKSPACE_ONE, True)
    client_id = register_client(package)
    approval(repositories, client_id, "denied")

    response = consent_to(package, client_id)

    assert urlsplit(response.headers["location"]).path.endswith("/app-access")


def test_a_grant_from_before_the_setting_keeps_refreshing(server: Any, repositories: Any, workspaces: None) -> None:
    """Turning approvals on leaves existing grants working until an admin decides."""
    token = grant(server, MEMBER, THIRD_PARTY, WORKSPACE_ONE)
    repositories.workspaces.set_third_party_app_approvals(WORKSPACE_ONE, True)

    assert refresh(server, THIRD_PARTY, token)["access_token"]


def test_a_denied_app_stops_refreshing(server: Any, repositories: Any, workspaces: None) -> None:
    """A denial while approvals are on refuses the grant's next refresh."""
    from webbpulse.identity import OAuthServerError

    token = grant(server, MEMBER, THIRD_PARTY, WORKSPACE_ONE)
    repositories.workspaces.set_third_party_app_approvals(WORKSPACE_ONE, True)
    approval(repositories, THIRD_PARTY, "denied")

    with pytest.raises(OAuthServerError):
        refresh(server, THIRD_PARTY, token)


def test_an_admin_revokes_every_members_grant_to_an_app(
    client: TestClient, server: Any, repositories: Any, workspaces: None
) -> None:
    """Every grant to the app in this workspace goes, and the same app elsewhere is untouched."""
    from webbpulse.identity import OAuthServerError

    owner = grant(server, OWNER, THIRD_PARTY, WORKSPACE_ONE)
    member = grant(server, MEMBER, THIRD_PARTY, WORKSPACE_ONE)
    elsewhere = grant(server, OWNER, THIRD_PARTY, WORKSPACE_TWO)
    sign_in(client, ADMIN)

    response = client.delete(f"/api/workspaces/{WORKSPACE_ONE}/connected-apps/{THIRD_PARTY}")

    assert response.status_code == 204
    for token in (owner, member):
        with pytest.raises(OAuthServerError):
            refresh(server, THIRD_PARTY, token)
    assert refresh(server, THIRD_PARTY, elsewhere)["access_token"]
    assert client.get(f"/api/workspaces/{WORKSPACE_ONE}/connected-apps").json()["apps"] == []


def test_a_member_cannot_revoke_an_app(client: TestClient, server: Any, workspaces: None) -> None:
    """Only an admin removes everyone's grant."""
    token = grant(server, OWNER, THIRD_PARTY, WORKSPACE_ONE)
    sign_in(client, MEMBER)

    assert client.delete(f"/api/workspaces/{WORKSPACE_ONE}/connected-apps/{THIRD_PARTY}").status_code == 403
    assert refresh(server, THIRD_PARTY, token)["access_token"]
