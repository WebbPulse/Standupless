"""The API key routes: who may mint, what comes back, and what is never shown.

The secret is the thing these tests watch hardest. It exists in exactly one
response and must appear in no other, so several of these assert on its absence
rather than its presence: a listing that started returning `secret` would turn a
read grant on the settings page into a credential handout.

Every route refuses an API key actor, so a key cannot mint another key. Without
that the credential system extends itself and revoking the key a person was given
stops meaning anything.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.api_keys import API_KEY_SCOPES, service_subject
from app.domains.workspaces.schemas.api_key import MAX_KEYS_PER_WORKSPACE
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OUTSIDER,
    OWNER,
    add_member,
    make_user,
    make_workspace,
    sign_in,
)

WORKSPACE = "01JB00000000000000000000WS"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace carrying one member of each role."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, ADMIN, "admin@example.com", "Adam Admin")
    make_user(repositories, MEMBER, "member@example.com", "Mo Member")
    make_user(repositories, GUEST, "guest@example.com", "Gale Guest")
    return WORKSPACE


def create_key(client: TestClient, workspace_id: str, **payload: Any) -> Any:
    """Mint one key through the route, with a sensible default body."""
    body: dict[str, Any] = {"name": "A key", "scopes": ["issues:read"]}
    body.update(payload)
    return client.post(f"/api/workspaces/{workspace_id}/api-keys", json=body)


def test_a_member_mints_a_key_and_sees_the_secret_once(client: TestClient, workspace: str) -> None:
    """Creating a key answers its plaintext, and the listing then never does."""
    sign_in(client, MEMBER)

    created = create_key(client, workspace)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["secret"].startswith("wpk_")
    assert body["scopes"] == ["issues:read"]

    listed = client.get(f"/api/workspaces/{workspace}/api-keys")
    assert listed.status_code == 200
    rows = listed.json()["api_keys"]
    assert len(rows) == 1
    assert "secret" not in rows[0]
    assert "key_hash" not in rows[0]


def test_the_listing_shows_only_the_callers_own_keys_by_default(client: TestClient, workspace: str) -> None:
    """`mine` is the default, so one member's keys stay out of another's list."""
    sign_in(client, MEMBER)
    create_key(client, workspace, name="Mine")
    sign_in(client, ADMIN)
    create_key(client, workspace, name="Theirs")

    sign_in(client, MEMBER)
    rows = client.get(f"/api/workspaces/{workspace}/api-keys").json()["api_keys"]

    assert [row["name"] for row in rows] == ["Mine"]


def test_only_an_admin_may_list_the_whole_workspace(client: TestClient, workspace: str) -> None:
    """Widening the listing is an admin-only query parameter."""
    sign_in(client, MEMBER)
    create_key(client, workspace, name="Mine")

    refused = client.get(f"/api/workspaces/{workspace}/api-keys", params={"scope": "workspace"})
    assert refused.status_code == 403

    sign_in(client, ADMIN)
    allowed = client.get(f"/api/workspaces/{workspace}/api-keys", params={"scope": "workspace"})
    assert allowed.status_code == 200
    assert [row["name"] for row in allowed.json()["api_keys"]] == ["Mine"]


def test_only_an_admin_may_mint_a_workspace_key(client: TestClient, workspace: str) -> None:
    """A key that outlives its minter needs an admin, and acts as the service principal."""
    sign_in(client, MEMBER)
    refused = create_key(client, workspace, kind="workspace")
    assert refused.status_code == 403

    sign_in(client, ADMIN)
    created = create_key(client, workspace, kind="workspace")
    assert created.status_code == 201, created.text
    assert created.json()["kind"] == "workspace"

    rows = client.get(f"/api/workspaces/{workspace}/api-keys", params={"scope": "workspace"}).json()["api_keys"]
    assert any(row["kind"] == "workspace" for row in rows)


def test_a_workspace_key_belongs_to_the_service_principal(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The row's subject is `svc#<workspace>`, so no person's departure revokes it."""
    sign_in(client, ADMIN)
    create_key(client, workspace, kind="workspace")

    rows = repositories.api_keys.list_for_workspace(workspace)
    assert [row.user_id for row in rows] == [service_subject(workspace)]


def test_an_unknown_scope_is_refused(client: TestClient, workspace: str) -> None:
    """Only the five contract scopes may be minted, so a typo fails loudly."""
    sign_in(client, MEMBER)

    refused = create_key(client, workspace, scopes=["issues:delete"])

    assert refused.status_code == 422


def test_a_key_must_carry_at_least_one_scope(client: TestClient, workspace: str) -> None:
    """An empty scope set is refused rather than stored as a credential doing nothing."""
    sign_in(client, MEMBER)

    assert create_key(client, workspace, scopes=[]).status_code == 422


def test_every_contract_scope_is_accepted(client: TestClient, workspace: str) -> None:
    """The five the contract fixes all mint, so the list cannot drift from the schema."""
    sign_in(client, MEMBER)

    created = create_key(client, workspace, scopes=list(API_KEY_SCOPES))

    assert created.status_code == 201, created.text
    assert set(created.json()["scopes"]) == set(API_KEY_SCOPES)


def test_revoking_a_key_is_idempotent(client: TestClient, workspace: str) -> None:
    """A second revoke answers 204, so a retried request is not an error."""
    sign_in(client, MEMBER)
    key_id = create_key(client, workspace).json()["key_id"]

    assert client.delete(f"/api/workspaces/{workspace}/api-keys/{key_id}").status_code == 204
    assert client.delete(f"/api/workspaces/{workspace}/api-keys/{key_id}").status_code == 204


def test_a_member_cannot_revoke_someone_elses_key(client: TestClient, workspace: str) -> None:
    """Another member's key is a 404, so the key id space cannot be probed."""
    sign_in(client, MEMBER)
    key_id = create_key(client, workspace).json()["key_id"]

    sign_in(client, GUEST)
    assert client.delete(f"/api/workspaces/{workspace}/api-keys/{key_id}").status_code == 404


def test_an_admin_may_revoke_any_key(client: TestClient, workspace: str) -> None:
    """Offboarding needs one person able to close a credential they did not mint."""
    sign_in(client, MEMBER)
    key_id = create_key(client, workspace).json()["key_id"]

    sign_in(client, ADMIN)
    assert client.delete(f"/api/workspaces/{workspace}/api-keys/{key_id}").status_code == 204


def test_an_outsider_reaches_nothing(client: TestClient, workspace: str, repositories: Any) -> None:
    """Someone outside the workspace gets the workspace's own 404."""
    make_user(repositories, OUTSIDER, "outsider@example.com", "Ozzy Outsider")
    sign_in(client, OUTSIDER)

    assert client.get(f"/api/workspaces/{workspace}/api-keys").status_code == 404
    assert create_key(client, workspace).status_code == 404


def test_an_anonymous_caller_reaches_nothing(client: TestClient, workspace: str) -> None:
    """No credential means no listing, rather than an empty one."""
    assert client.get(f"/api/workspaces/{workspace}/api-keys").status_code in (401, 403)


def test_the_workspace_limit_is_enforced(client: TestClient, workspace: str, repositories: Any) -> None:
    """A workspace stops at its key limit with a 409 rather than growing without bound."""
    from webbpulse.identity.api_keys import display_prefix, hash_key, new_key

    from app.common.db.dynamo.api_keys import ApiKey, new_key_id

    for index in range(MAX_KEYS_PER_WORKSPACE):
        secret = new_key()
        repositories.api_keys.create(
            ApiKey(
                workspace_id=workspace,
                key_id=new_key_id(),
                key_hash=hash_key(secret),
                prefix=display_prefix(secret),
                name=f"Seeded {index}",
                scopes=["issues:read"],
                user_id=MEMBER,
                created_by=MEMBER,
            )
        )

    sign_in(client, MEMBER)
    refused = create_key(client, workspace)

    assert refused.status_code == 409
    assert refused.json()["error_code"] == "CONFLICT"
