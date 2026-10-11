"""Connected apps: a person's authorized OAuth clients, and a workspace admin's view of them.

Grants are made through the package's own authorization server service, the same
one the mounted routes drive, so a listed grant is one a real client could hold and
a revoked one is proven revoked by the refresh it can no longer make.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_user, make_workspace, sign_in
from tests.domains.identity.test_oauth_server import (
    RESOURCE,
    WORKSPACE_ONE,
    WORKSPACE_TWO,
    identity_environment,
    oauth_tables,
    pkce_pair,
)

__all__ = ["identity_environment", "oauth_tables"]

REDIRECT = "http://localhost:7777/callback"

CLAUDE = "client-claude"

CURSOR = "client-cursor"


@pytest.fixture
def server(oauth_tables: None, identity_environment: None) -> Any:
    """The authorization server the routes build, over the mocked tables, with two clients."""
    from webbpulse.identity import OAuthClientRecord

    from app.common.core.config import get_settings
    from app.domains.identity.connected_apps import build_authorization_server

    built = build_authorization_server(get_settings())
    assert built is not None
    for client_id, name in ((CLAUDE, "Claude"), (CURSOR, "Cursor")):
        built.stores.clients.put(OAuthClientRecord(client_id=client_id, redirect_uris=(REDIRECT,), client_name=name))
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
    """Two workspaces: the owner and a member in the first, the owner alone in the second."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    make_user(repositories, MEMBER, "member@example.com", display_name="Member")
    make_user(repositories, ADMIN, "admin@example.com", display_name="Admin")
    make_workspace(repositories, WORKSPACE_ONE, "one", OWNER)
    make_workspace(repositories, WORKSPACE_TWO, "two", OWNER)
    add_member(repositories, WORKSPACE_ONE, MEMBER, "member")
    add_member(repositories, WORKSPACE_ONE, ADMIN, "admin")


def grant(server: Any, user_id: str, client_id: str, workspace_id: str) -> str:
    """Authorize `client_id` for `user_id` in one workspace, returning its refresh token."""
    verifier, challenge = pkce_pair()
    request = server.service.parse_authorization_request(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": REDIRECT,
            "resource": RESOURCE,
            "scope": "issues:read issues:write",
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


def test_an_anonymous_caller_is_refused(client: TestClient) -> None:
    """No claims is a 401, never an empty list."""
    assert client.get("/api/users/me/connected-apps").status_code == 401


def test_a_delegated_credential_is_refused(client: TestClient, workspaces: None) -> None:
    """An MCP token or API key may not list or revoke the grants behind it."""
    sign_in(client, OWNER, scope="issues:read")
    assert client.get("/api/users/me/connected-apps").status_code == 403
    assert client.delete(f"/api/users/me/connected-apps/{CLAUDE}").status_code == 403


def test_nothing_authorized_is_an_empty_list(client: TestClient, workspaces: None) -> None:
    """The empty state is an empty list, not a 404."""
    sign_in(client, OWNER)
    response = client.get("/api/users/me/connected-apps")
    assert response.status_code == 200
    assert response.json() == {"apps": []}


def test_the_caller_sees_each_client_once_with_a_row_per_workspace(
    client: TestClient, server: Any, workspaces: None
) -> None:
    """Grants group by client, name the workspace, and carry the grant and use times."""
    grant(server, OWNER, CLAUDE, WORKSPACE_ONE)
    grant(server, OWNER, CLAUDE, WORKSPACE_TWO)
    grant(server, MEMBER, CURSOR, WORKSPACE_ONE)
    sign_in(client, OWNER)

    body = client.get("/api/users/me/connected-apps").json()

    assert [app["client_name"] for app in body["apps"]] == ["Claude"]
    app = body["apps"][0]
    assert app["client_id"] == CLAUDE
    assert app["scopes"] == ["issues:read", "issues:write"]
    assert app["first_authorized_at"]
    assert app["last_used_at"]
    assert sorted(workspace["id"] for workspace in app["workspaces"]) == [WORKSPACE_ONE, WORKSPACE_TWO]
    assert all(workspace["name"] for workspace in app["workspaces"])


def test_revoking_ends_the_clients_refresh(client: TestClient, server: Any, workspaces: None) -> None:
    """After a revoke the grant is gone and the client's refresh token is refused."""
    from webbpulse.identity import OAuthServerError

    token = grant(server, OWNER, CLAUDE, WORKSPACE_ONE)
    sign_in(client, OWNER)

    assert client.delete(f"/api/users/me/connected-apps/{CLAUDE}").status_code == 204

    assert client.get("/api/users/me/connected-apps").json() == {"apps": []}
    with pytest.raises(OAuthServerError):
        refresh(server, CLAUDE, token)


def test_revoking_a_client_never_authorized_is_a_404(client: TestClient, workspaces: None) -> None:
    """A stale row on the page reads as gone rather than as a silent success."""
    sign_in(client, OWNER)
    assert client.delete(f"/api/users/me/connected-apps/{CLAUDE}").status_code == 404


def test_a_person_cannot_revoke_someone_elses_grant(client: TestClient, server: Any, workspaces: None) -> None:
    """The account route only ever reads the caller's own consents."""
    token = grant(server, MEMBER, CURSOR, WORKSPACE_ONE)
    sign_in(client, OWNER)

    assert client.delete(f"/api/users/me/connected-apps/{CURSOR}").status_code == 404
    assert refresh(server, CURSOR, token)["access_token"]


def test_an_admin_sees_every_members_grant_in_the_workspace(client: TestClient, server: Any, workspaces: None) -> None:
    """The workspace view lists members' grants in this workspace and no other."""
    grant(server, OWNER, CLAUDE, WORKSPACE_ONE)
    grant(server, OWNER, CLAUDE, WORKSPACE_TWO)
    grant(server, MEMBER, CURSOR, WORKSPACE_ONE)
    sign_in(client, ADMIN)

    response = client.get(f"/api/workspaces/{WORKSPACE_ONE}/connected-apps")

    assert response.status_code == 200
    rows = response.json()["apps"]
    assert sorted((row["user"]["id"], row["client_id"]) for row in rows) == sorted([(OWNER, CLAUDE), (MEMBER, CURSOR)])
    member_row = next(row for row in rows if row["user"]["id"] == MEMBER)
    assert member_row["user"]["email"] == "member@example.com"
    assert member_row["client_name"] == "Cursor"


def test_a_member_is_refused_the_workspace_view(client: TestClient, workspaces: None) -> None:
    """Only an admin reads or revokes other people's grants."""
    sign_in(client, MEMBER)
    assert client.get(f"/api/workspaces/{WORKSPACE_ONE}/connected-apps").status_code == 403
    assert client.delete(f"/api/workspaces/{WORKSPACE_ONE}/connected-apps/{OWNER}/{CLAUDE}").status_code == 403


def test_an_admin_revokes_only_this_workspaces_grant(client: TestClient, server: Any, workspaces: None) -> None:
    """The same person's grant in another workspace keeps working."""
    from webbpulse.identity import OAuthServerError

    here = grant(server, OWNER, CLAUDE, WORKSPACE_ONE)
    elsewhere = grant(server, OWNER, CLAUDE, WORKSPACE_TWO)
    sign_in(client, ADMIN)

    response = client.delete(f"/api/workspaces/{WORKSPACE_ONE}/connected-apps/{OWNER}/{CLAUDE}")

    assert response.status_code == 204
    with pytest.raises(OAuthServerError):
        refresh(server, CLAUDE, here)
    assert refresh(server, CLAUDE, elsewhere)["access_token"]
    remaining = client.get(f"/api/workspaces/{WORKSPACE_ONE}/connected-apps").json()["apps"]
    assert remaining == []


def test_an_admin_revoking_a_grant_not_in_this_workspace_is_a_404(
    client: TestClient, server: Any, workspaces: None
) -> None:
    """A grant in another workspace is out of reach, and says so."""
    grant(server, OWNER, CLAUDE, WORKSPACE_TWO)
    sign_in(client, ADMIN)
    assert client.delete(f"/api/workspaces/{WORKSPACE_ONE}/connected-apps/{OWNER}/{CLAUDE}").status_code == 404


def test_a_grant_lists_the_scopes_it_does_not_cover_yet(client: TestClient, server: Any, workspaces: None) -> None:
    """Scopes the product offers beyond the grant are listed as new, per app and per workspace."""
    grant(server, OWNER, CLAUDE, WORKSPACE_ONE)
    sign_in(client, OWNER)

    app = client.get("/api/users/me/connected-apps").json()["apps"][0]

    assert "releases:read" in app["new_scopes"]
    assert "issues:read" not in app["new_scopes"]
    assert app["workspaces"][0]["new_scopes"] == app["new_scopes"]


def test_granting_new_permissions_reaches_the_next_refresh(client: TestClient, server: Any, workspaces: None) -> None:
    """The approved scopes join the grant, and the client's next refresh carries them with the old ones."""
    token = grant(server, OWNER, CLAUDE, WORKSPACE_ONE)
    sign_in(client, OWNER)

    response = client.post(
        f"/api/users/me/connected-apps/{CLAUDE}/scopes", json={"scopes": ["releases:read", "releases:write"]}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["scopes"] == ["issues:read", "issues:write", "releases:read", "releases:write"]
    assert "releases:read" not in body["new_scopes"]
    refreshed = server.service.refresh({"refresh_token": token, "client_id": CLAUDE})
    assert refreshed["scope"].split() == ["issues:read", "issues:write", "releases:read", "releases:write"]


def test_granting_new_permissions_never_adds_what_was_not_approved(
    client: TestClient, server: Any, workspaces: None
) -> None:
    """Only the posted scopes are added, never the rest of the product's set."""
    token = grant(server, OWNER, CLAUDE, WORKSPACE_ONE)
    sign_in(client, OWNER)

    client.post(f"/api/users/me/connected-apps/{CLAUDE}/scopes", json={"scopes": ["releases:read"]})

    refreshed = server.service.refresh({"refresh_token": token, "client_id": CLAUDE})
    assert refreshed["scope"].split() == ["issues:read", "issues:write", "releases:read"]


def test_granting_new_permissions_in_one_workspace_leaves_the_other(
    client: TestClient, server: Any, workspaces: None
) -> None:
    """A named workspace widens that grant alone."""
    here = grant(server, OWNER, CLAUDE, WORKSPACE_ONE)
    elsewhere = grant(server, OWNER, CLAUDE, WORKSPACE_TWO)
    sign_in(client, OWNER)

    response = client.post(
        f"/api/users/me/connected-apps/{CLAUDE}/scopes",
        json={"scopes": ["releases:read"], "workspace_id": WORKSPACE_ONE},
    )

    assert response.status_code == 200
    widened = server.service.refresh({"refresh_token": here, "client_id": CLAUDE})["scope"].split()
    untouched = server.service.refresh({"refresh_token": elsewhere, "client_id": CLAUDE})["scope"].split()
    assert "releases:read" in widened
    assert "releases:read" not in untouched


def test_granting_new_permissions_is_audited(
    client: TestClient, server: Any, workspaces: None, repositories: Any
) -> None:
    """The workspace log records the widening with the scopes before and after."""
    grant(server, OWNER, CLAUDE, WORKSPACE_ONE)
    sign_in(client, OWNER)

    client.post(f"/api/users/me/connected-apps/{CLAUDE}/scopes", json={"scopes": ["releases:read"]})

    events = repositories.audit.list_events(WORKSPACE_ONE).events
    granted = [event for event in events if event.action == "connected_app.scopes_granted"]
    assert len(granted) == 1


def test_granting_an_unknown_scope_is_refused(client: TestClient, server: Any, workspaces: None) -> None:
    """A scope the server does not offer is a 422, not silently dropped."""
    grant(server, OWNER, CLAUDE, WORKSPACE_ONE)
    sign_in(client, OWNER)

    response = client.post(f"/api/users/me/connected-apps/{CLAUDE}/scopes", json={"scopes": ["everything"]})

    assert response.status_code == 422


def test_granting_to_a_client_never_authorized_is_a_404(client: TestClient, server: Any, workspaces: None) -> None:
    """There is no grant to widen, and another person's grant is out of reach."""
    grant(server, MEMBER, CURSOR, WORKSPACE_ONE)
    sign_in(client, OWNER)

    response = client.post(f"/api/users/me/connected-apps/{CURSOR}/scopes", json={"scopes": ["releases:read"]})

    assert response.status_code == 404


def test_a_delegated_credential_cannot_grant_itself_scopes(client: TestClient, workspaces: None) -> None:
    """An MCP token may never widen the grant behind it."""
    sign_in(client, OWNER, scope="issues:read")
    response = client.post(f"/api/users/me/connected-apps/{CLAUDE}/scopes", json={"scopes": ["releases:read"]})
    assert response.status_code == 403
