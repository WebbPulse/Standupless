"""The workspaces routes, against real tables in moto.

The list route is the product's first tenant-scoped read, so these pin both
halves of that: an anonymous caller gets nothing, and a signed in one gets only
their own rows.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.api.dependencies.identity_claims import require_identity_subject
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app

OWNER = "11111111-1111-4111-8111-111111111111"
OTHER_OWNER = "22222222-2222-4222-8222-222222222222"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def _sign_in(client: TestClient, subject: str) -> None:
    """Make every request on this client read as `subject`.

    Overrides the dependency rather than minting a token, because who the caller
    is comes from the gateway authorizer in production and signing a real token
    here would test the verifier instead of the route.
    """
    client.app.dependency_overrides[require_identity_subject] = lambda: subject  # type: ignore[attr-defined]


def _store(repositories: Any, workspace_id: str, name: str, owner: str) -> None:
    """Put one workspace row straight into the table."""
    from app.common.db.dynamo.workspaces import Workspace

    repositories.workspaces.create(Workspace(id=workspace_id, name=name, owner_user_id=owner))


def test_health_reads_nothing(client: TestClient) -> None:
    """The domain probe answers without touching a table."""
    response = client.get("/api/workspaces/health")
    assert response.status_code == 200
    assert response.json()["domain"] == "workspaces"


def test_an_anonymous_caller_is_refused(client: TestClient) -> None:
    """No token means 401, not an empty list: the route fails closed."""
    response = client.get("/api/workspaces")
    assert response.status_code == 401
    assert response.json()["error_code"] == "NOT_AUTHENTICATED"


def test_a_new_account_sees_an_empty_list(client: TestClient) -> None:
    """A signed in caller who owns nothing gets [], which is what a new account sees."""
    _sign_in(client, OWNER)
    response = client.get("/api/workspaces")
    assert response.status_code == 200
    assert response.json() == []


def test_a_caller_sees_only_their_own_workspaces(client: TestClient, repositories: Any) -> None:
    """The tenant boundary: another owner's workspace never appears in the response.

    This is the property the whole product rests on, so it is asserted against a
    table holding both owners' rows rather than only the caller's.
    """
    _store(repositories, "ws-mine", "Mine", OWNER)
    _store(repositories, "ws-theirs", "Theirs", OTHER_OWNER)
    _sign_in(client, OWNER)

    body = client.get("/api/workspaces").json()

    assert [row["id"] for row in body] == ["ws-mine"]
