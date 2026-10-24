"""SCIM provisioning for a workspace: its tokens, its directory users and groups, and deprovisioning.

A workspace admin mints a SCIM token on the Business plan, and the identity
provider then pushes users and groups with it. A user must sit on one of the
workspace's verified single sign-on domains, an active one holds a membership
once their account exists, and a group links to a team that already exists.
Deactivating or deleting a user takes back their membership, revokes their keys
and ends their sessions, except for the last owner, whom the directory cannot
remove. A SCIM token reaches the SCIM routes and nothing else.
"""

from __future__ import annotations

import base64
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.users import User
from tests.domains.helpers import (
    ADMIN,
    MEMBER,
    OUTSIDER,
    OWNER,
    add_member,
    make_team,
    make_workspace,
    sign_in,
    sign_out,
)

WORKSPACE = "01JB00000000000000000000WS"

SCIM = "/api/scim/v2"

TOKENS = f"/api/workspaces/{WORKSPACE}/sso/scim/tokens"

USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"

GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group"

PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"

TEAM = "01JB0000000000000000000TM1"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def master_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """A throwaway master key, so a connection's client secret can be sealed."""
    monkeypatch.setenv("IDENTITY_TOTP_MASTER_KEY", base64.b64encode(b"k" * 32).decode("ascii"))


@pytest.fixture(autouse=True)
def revoked_sessions(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record every account whose refresh families deprovisioning ends, instead of reaching the table."""
    calls: list[str] = []

    def revoke(user_id: str, **_: Any) -> int:
        """Remember the account and report one family ended."""
        calls.append(user_id)
        return 1

    monkeypatch.setattr("app.common.sessions.revoke_refresh_families", revoke)
    return calls


def _person(repositories: Any, user_id: str, email: str, *, verified: bool = True) -> None:
    """Store one account with a verified address."""
    repositories.users.create(User(id=user_id, email=email, display_name="Alice", email_verified=verified))


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A Business workspace with acme.com verified for single sign-on, an admin, a member and a team."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    _person(repositories, OWNER, "owner@acme.com")
    _person(repositories, ADMIN, "admin@acme.com")
    row = repositories.memberships.add_sso_domain(WORKSPACE, "acme.com", token="t", added_by=ADMIN)
    repositories.memberships.mark_sso_domain_verified(row, verified_by=ADMIN)
    make_team(repositories, WORKSPACE, TEAM, "ENG")
    return WORKSPACE


def _mint(client: TestClient, name: str = "Okta") -> Any:
    """Mint a SCIM token as the owner."""
    sign_in(client, OWNER)
    return client.post(TOKENS, json={"name": name})


@pytest.fixture
def token(client: TestClient, workspace: str) -> str:
    """A live SCIM token for the workspace, with the client left signed out."""
    response = _mint(client)
    assert response.status_code == 201, response.text
    sign_out(client)
    return str(response.json()["secret"])


def _bearer(token: str) -> dict[str, str]:
    """The header an identity provider sends."""
    return {"Authorization": f"Bearer {token}"}


def _user_body(email: str, *, active: bool = True) -> dict[str, Any]:
    """An Okta-shaped user resource for one address."""
    return {
        "schemas": [USER_SCHEMA],
        "userName": email,
        "name": {"givenName": "Alice", "familyName": "Acme"},
        "emails": [{"value": email, "type": "work", "primary": True}],
        "displayName": "Alice Acme",
        "active": active,
    }


def _create_user(client: TestClient, token: str, email: str) -> Any:
    """Push one user."""
    return client.post(f"{SCIM}/Users", json=_user_body(email), headers=_bearer(token))


def _set_active(client: TestClient, token: str, scim_id: str, active: bool) -> Any:
    """Patch a user's `active` flag the way Okta and Entra do."""
    body = {"schemas": [PATCH_SCHEMA], "Operations": [{"op": "replace", "value": {"active": active}}]}
    return client.patch(f"{SCIM}/Users/{scim_id}", json=body, headers=_bearer(token))


def test_an_owner_mints_and_an_admin_lists_and_revokes_a_token(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    created = _mint(client)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["secret"].startswith("wpk_")
    assert body["name"] == "Okta"
    sign_in(client, ADMIN)
    settings = client.get(f"/api/workspaces/{WORKSPACE}/sso/scim")
    assert settings.status_code == 200
    assert settings.json()["base_url"].endswith("/api/scim/v2")
    assert [item["key_id"] for item in settings.json()["tokens"]] == [body["key_id"]]
    assert "secret" not in settings.text
    assert client.delete(f"{TOKENS}/{body['key_id']}").status_code == 204
    assert client.get(f"/api/workspaces/{WORKSPACE}/sso/scim").json()["tokens"] == []
    actions = {row.action for row in repositories.audit.list_events(WORKSPACE, AuditQuery()).events}
    assert {"scim.token_created", "scim.token_revoked"} <= actions


def test_a_revoked_token_stops_provisioning(client: TestClient, workspace: str) -> None:
    created = _mint(client).json()
    assert client.delete(f"{TOKENS}/{created['key_id']}").status_code == 204
    sign_out(client)
    response = client.get(f"{SCIM}/Users", headers=_bearer(created["secret"]))
    assert response.status_code == 401


def test_tokens_stop_at_the_cap(client: TestClient, workspace: str) -> None:
    for index in range(5):
        assert _mint(client, f"Token {index}").status_code == 201
    refused = _mint(client, "One too many")
    assert refused.status_code == 409
    assert refused.json()["error_code"] == "SCIM_TOKEN_LIMIT"


def test_an_admin_may_not_mint_a_token(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN)
    refused = client.post(TOKENS, json={"name": "Okta"})
    assert refused.status_code == 403
    assert refused.json()["error_code"] == "FORBIDDEN"
    assert client.get(f"/api/workspaces/{WORKSPACE}/sso/scim").json()["tokens"] == []


def test_only_an_owner_on_business_mints_a_token(client: TestClient, workspace: str, repositories: Any) -> None:
    sign_in(client, MEMBER)
    assert client.post(TOKENS, json={"name": "Okta"}).status_code in (403, 404)
    repositories.workspaces.set_billing(WORKSPACE, plan="free")
    refused = _mint(client)
    assert refused.status_code != 201


def test_a_scim_token_is_hidden_from_the_api_key_routes(client: TestClient, workspace: str) -> None:
    created = _mint(client).json()
    listing = client.get(f"/api/workspaces/{WORKSPACE}/api-keys", params={"scope": "workspace"})
    assert listing.status_code == 200
    assert created["key_id"] not in listing.text
    assert client.delete(f"/api/workspaces/{WORKSPACE}/api-keys/{created['key_id']}").status_code == 404


def test_a_scim_token_reaches_no_product_route(client: TestClient, token: str) -> None:
    response = client.get(f"/api/workspaces/{WORKSPACE}/api-keys", headers=_bearer(token))
    assert response.status_code in (401, 403)


def test_the_directory_needs_a_token(client: TestClient, workspace: str) -> None:
    assert client.get(f"{SCIM}/Users").status_code == 401
    assert client.get(f"{SCIM}/Users", headers={"Authorization": "Bearer wpk_nope"}).status_code == 401
    assert client.get(f"{SCIM}/ServiceProviderConfig").status_code == 200


def test_the_directory_stops_when_the_plan_lapses(client: TestClient, token: str, repositories: Any) -> None:
    repositories.workspaces.set_billing(WORKSPACE, plan="free")
    assert client.get(f"{SCIM}/Users", headers=_bearer(token)).status_code == 403


def test_a_user_needs_a_verified_domain(client: TestClient, token: str) -> None:
    response = _create_user(client, token, "alice@other.com")
    assert response.status_code == 400
    assert "verified" in response.json()["detail"]


def test_a_token_minted_before_the_policy_tightened_still_provisions(
    client: TestClient, token: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    later = datetime.now(timezone.utc) + timedelta(minutes=5)
    with monkeypatch.context() as patch:
        patch.setattr("app.common.db.dynamo.memberships.utc_now", lambda: later)
        repositories.memberships.set_auth_policy(
            WORKSPACE, require_two_factor=True, require_sso=True, allowed_methods=["google"], updated_by=OWNER
        )
    assert client.get(f"{SCIM}/Users", headers=_bearer(token)).status_code == 200
    _person(repositories, OUTSIDER, "carol@acme.com")
    assert _create_user(client, token, "carol@acme.com").status_code == 201


def test_a_user_with_an_account_becomes_a_member(client: TestClient, token: str, repositories: Any) -> None:
    _person(repositories, OUTSIDER, "alice@acme.com")
    response = _create_user(client, token, "alice@acme.com")
    assert response.status_code == 201, response.text
    scim_id = response.json()["id"]
    membership = repositories.memberships.get(WORKSPACE, OUTSIDER)
    assert membership is not None and membership.role == "member"
    row = repositories.memberships.get_scim_user(WORKSPACE, scim_id)
    assert row is not None and row.linked_user_id == OUTSIDER
    joined = repositories.audit.list_events(WORKSPACE, AuditQuery(action="member.joined")).events
    assert [event.after for event in joined] == [{"role": "member", "via": "scim"}]
    found = client.get(f"{SCIM}/Users", params={"filter": 'userName eq "alice@acme.com"'}, headers=_bearer(token))
    assert found.status_code == 200
    assert [item["id"] for item in found.json()["Resources"]] == [scim_id]


def test_a_user_without_an_account_waits_unlinked(client: TestClient, token: str, repositories: Any) -> None:
    response = _create_user(client, token, "bob@acme.com")
    assert response.status_code == 201
    row = repositories.memberships.get_scim_user(WORKSPACE, response.json()["id"])
    assert row is not None and row.linked_user_id == ""


def test_a_user_name_is_unique(client: TestClient, token: str) -> None:
    assert _create_user(client, token, "carol@acme.com").status_code == 201
    assert _create_user(client, token, "carol@acme.com").status_code == 409


def test_a_group_links_to_an_existing_team_only(client: TestClient, token: str, repositories: Any) -> None:
    missing = client.post(
        f"{SCIM}/Groups", json={"schemas": [GROUP_SCHEMA], "displayName": "Design"}, headers=_bearer(token)
    )
    assert missing.status_code == 400
    linked = client.post(
        f"{SCIM}/Groups", json={"schemas": [GROUP_SCHEMA], "displayName": "eng"}, headers=_bearer(token)
    )
    assert linked.status_code == 201, linked.text
    assert linked.json()["id"] == TEAM
    again = client.post(
        f"{SCIM}/Groups", json={"schemas": [GROUP_SCHEMA], "displayName": "Eng"}, headers=_bearer(token)
    )
    assert again.status_code == 409
    renamed = client.patch(
        f"{SCIM}/Groups/{TEAM}",
        json={"schemas": [PATCH_SCHEMA], "Operations": [{"op": "replace", "value": {"displayName": "Engineering"}}]},
        headers=_bearer(token),
    )
    assert renamed.status_code in (200, 204)
    team = repositories.teams.get(WORKSPACE, TEAM)
    assert team is not None and team.name == "Eng"


def test_group_members_join_and_leave_the_team(client: TestClient, token: str, repositories: Any) -> None:
    _person(repositories, OUTSIDER, "alice@acme.com")
    scim_id = _create_user(client, token, "alice@acme.com").json()["id"]
    client.post(f"{SCIM}/Groups", json={"schemas": [GROUP_SCHEMA], "displayName": "ENG"}, headers=_bearer(token))
    added = client.patch(
        f"{SCIM}/Groups/{TEAM}",
        json={
            "schemas": [PATCH_SCHEMA],
            "Operations": [{"op": "add", "path": "members", "value": [{"value": scim_id}]}],
        },
        headers=_bearer(token),
    )
    assert added.status_code in (200, 204), added.text
    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, OUTSIDER) is not None
    user = client.get(f"{SCIM}/Users/{scim_id}", headers=_bearer(token)).json()
    assert [group["value"] for group in user["groups"]] == [TEAM]
    removed = client.patch(
        f"{SCIM}/Groups/{TEAM}",
        json={"schemas": [PATCH_SCHEMA], "Operations": [{"op": "remove", "path": f'members[value eq "{scim_id}"]'}]},
        headers=_bearer(token),
    )
    assert removed.status_code in (200, 204), removed.text
    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, OUTSIDER) is None


def test_unlinking_a_group_keeps_the_team(client: TestClient, token: str, repositories: Any) -> None:
    client.post(f"{SCIM}/Groups", json={"schemas": [GROUP_SCHEMA], "displayName": "ENG"}, headers=_bearer(token))
    assert client.delete(f"{SCIM}/Groups/{TEAM}", headers=_bearer(token)).status_code == 204
    assert repositories.teams.get(WORKSPACE, TEAM) is not None
    assert client.get(f"{SCIM}/Groups/{TEAM}", headers=_bearer(token)).status_code == 404


def test_deactivating_removes_access_keys_and_sessions(
    client: TestClient, token: str, repositories: Any, revoked_sessions: list[str]
) -> None:
    from webbpulse.identity.api_keys import mint

    _person(repositories, OUTSIDER, "alice@acme.com")
    scim_id = _create_user(client, token, "alice@acme.com").json()["id"]
    key = mint(
        user_id=OUTSIDER,
        tenant_id=WORKSPACE,
        scopes=["issues:read"],
        name="Alice's key",
        store=repositories.api_keys,
        created_by=OUTSIDER,
    )
    response = _set_active(client, token, scim_id, False)
    assert response.status_code in (200, 204), response.text
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None
    stored = repositories.api_keys.get(key.record.key_hash)
    assert stored is not None and stored.is_revoked
    assert revoked_sessions == [OUTSIDER]
    assert client.get(f"{SCIM}/Users", headers=_bearer(token)).status_code == 200
    reactivated = _set_active(client, token, scim_id, True)
    assert reactivated.status_code in (200, 204)
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is not None


def test_deprovisioning_reaches_a_member_who_joined_by_invite(
    client: TestClient, token: str, repositories: Any, revoked_sessions: list[str]
) -> None:
    _person(repositories, OUTSIDER, "dana@acme.com")
    add_member(repositories, WORKSPACE, OUTSIDER, "member")
    response = client.post(f"{SCIM}/Users", json=_user_body("dana@acme.com", active=False), headers=_bearer(token))
    assert response.status_code == 201
    assert client.delete(f"{SCIM}/Users/{response.json()['id']}", headers=_bearer(token)).status_code == 204
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None
    assert set(revoked_sessions) == {OUTSIDER}


def test_deleting_a_user_forgets_the_row_and_keeps_the_account(
    client: TestClient, token: str, repositories: Any
) -> None:
    _person(repositories, OUTSIDER, "alice@acme.com")
    scim_id = _create_user(client, token, "alice@acme.com").json()["id"]
    assert client.delete(f"{SCIM}/Users/{scim_id}", headers=_bearer(token)).status_code == 204
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None
    assert repositories.memberships.get_scim_user(WORKSPACE, scim_id) is None
    assert repositories.users.get(OUTSIDER) is not None
    assert client.get(f"{SCIM}/Users/{scim_id}", headers=_bearer(token)).status_code == 404


def test_the_last_owner_cannot_be_deprovisioned(client: TestClient, token: str, repositories: Any) -> None:
    scim_id = _create_user(client, token, "owner@acme.com").json()["id"]
    refused = _set_active(client, token, scim_id, False)
    assert refused.status_code == 409
    assert client.delete(f"{SCIM}/Users/{scim_id}", headers=_bearer(token)).status_code == 409
    membership = repositories.memberships.get(WORKSPACE, OWNER)
    assert membership is not None and membership.role == "owner"


OIDC_CONNECTION = {
    "protocol": "oidc",
    "display_name": "Acme Okta",
    "oidc_issuer": "https://acme.okta.example/",
    "oidc_client_id": "client-123",
    "oidc_client_secret": "not-a-real-secret",
}

SSO_AMR = ["sso", "oidc"]


@pytest.fixture
def connection(client: TestClient, token: str) -> str:
    """The workspace's OIDC connection saved and tested, so people can join through it."""
    sign_in(client, OWNER)
    assert client.put(f"/api/workspaces/{WORKSPACE}/sso/connection", json=OIDC_CONNECTION).status_code == 200
    sign_in(client, ADMIN, amr=SSO_AMR, sso_connection=WORKSPACE, auth_time=int(time.time()))
    assert client.post(f"/api/workspaces/{WORKSPACE}/sso/connection/test-result").status_code == 200
    sign_out(client)
    return token


def test_a_deactivated_person_cannot_join_through_single_sign_on(
    client: TestClient, connection: str, repositories: Any
) -> None:
    _person(repositories, OUTSIDER, "erin@acme.com")
    body = _user_body("erin@acme.com", active=False)
    assert client.post(f"{SCIM}/Users", json=body, headers=_bearer(connection)).status_code == 201
    sign_in(client, OUTSIDER, amr=SSO_AMR, sso_connection=WORKSPACE)
    refused = client.post("/api/workspaces/sso/join")
    assert refused.status_code == 403
    assert refused.json()["error_code"] == "SCIM_DEACTIVATED"
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None


def test_joining_through_single_sign_on_adopts_a_waiting_row(
    client: TestClient, connection: str, repositories: Any
) -> None:
    scim_id = client.post(f"{SCIM}/Users", json=_user_body("gus@acme.com"), headers=_bearer(connection)).json()["id"]
    client.post(f"{SCIM}/Groups", json={"schemas": [GROUP_SCHEMA], "displayName": "ENG"}, headers=_bearer(connection))
    client.patch(
        f"{SCIM}/Groups/{TEAM}",
        json={
            "schemas": [PATCH_SCHEMA],
            "Operations": [{"op": "add", "path": "members", "value": [{"value": scim_id}]}],
        },
        headers=_bearer(connection),
    )
    _person(repositories, OUTSIDER, "gus@acme.com")
    sign_in(client, OUTSIDER, amr=SSO_AMR, sso_connection=WORKSPACE)
    assert client.post("/api/workspaces/sso/join").status_code == 201
    row = repositories.memberships.get_scim_user(WORKSPACE, scim_id)
    assert row is not None and row.linked_user_id == OUTSIDER
    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, OUTSIDER) is not None


def test_the_directory_is_recorded_as_scim(client: TestClient, token: str, repositories: Any) -> None:
    _create_user(client, token, "frank@acme.com")
    events = repositories.audit.list_events(WORKSPACE, AuditQuery(action="scim.user_provisioned")).events
    assert len(events) == 1
    assert events[0].actor.id == "scim"
