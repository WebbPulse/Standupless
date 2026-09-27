"""REST scope enforcement: a key spends only the scopes it carries.

The property under test is the contract's rule that a scope is a ceiling on a
role. A key minted by a member holds that member's capabilities, so the capability
check passes, and what stops it creating an issue is the scope check alone. That
makes these tests the only thing standing between a `teams:read` key and the
whole write surface.

A session is checked in the same file rather than a separate one, because the
enforcement is one branch: getting it wrong in the other direction would lock out
every browser login, and that failure has to show up here too.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.api.dependencies.scopes import NO_KEY_ACCESS, ROUTE_SCOPES
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.api_keys import API_KEY_SCOPES
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OWNER,
    add_member,
    add_team_member,
    make_team,
    make_user,
    make_workspace,
    sign_in,
    sign_out,
)

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER_TEAM = "01JB000000000000000000PRJ2"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client carrying every domain, so one key can be tried against them all.

    The merged application rather than one domain's, because the point of these
    tests is that the enforcement is central: a key refused on issues and admitted
    on teams has to be shown on the same client, or the two could be passing for
    different reasons.
    """
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(list(DOMAINS.values()))
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with two teams and one member of each role."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, MEMBER, "member@example.com", "Mo Member")
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    make_team(repositories, WORKSPACE, OTHER_TEAM, "XYZ")
    add_team_member(repositories, WORKSPACE, TEAM, GUEST, "member")
    return WORKSPACE


def mint(repositories: Any, user_id: str, scopes: tuple[str, ...]) -> str:
    """One API key, returning the plaintext a client would present."""
    from webbpulse.identity.api_keys import mint as mint_key

    return mint_key(
        user_id=user_id,
        tenant_id=WORKSPACE,
        scopes=scopes,
        name="A REST key",
        store=repositories.api_keys,
        created_by=OWNER,
    ).plaintext


def present(client: TestClient, secret: str) -> None:
    """Make every later request on this client arrive as that key.

    The claims header is dropped first, because a key and a session arriving
    together would resolve as the session and the test would pass without ever
    exercising the key.
    """
    sign_out(client)
    client.headers["authorization"] = f"Bearer {secret}"


def seed_issue(client: TestClient, workspace_id: str) -> str:
    """One issue, created as a member over the session path, for the key to reach."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace_id}/issues",
        json={"team_id": TEAM, "title": "An issue"},
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_a_teams_read_key_cannot_create_an_issue(client: TestClient, repositories: Any, workspace: str) -> None:
    """The capability passes and the scope is what refuses, with the MCP error shape."""
    secret = mint(repositories, MEMBER, ("teams:read",))
    present(client, secret)

    response = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"team_id": TEAM, "title": "Should not exist"},
    )

    assert response.status_code == 403, response.text
    body = response.json()
    assert body["error_code"] == "INSUFFICIENT_SCOPE"
    assert "issues:write" in body["message"]


def test_a_teams_read_key_cannot_post_a_comment(client: TestClient, repositories: Any, workspace: str) -> None:
    """Commenting needs `comments:write`, which this key does not carry."""
    issue_id = seed_issue(client, workspace)
    secret = mint(repositories, MEMBER, ("teams:read",))
    present(client, secret)

    response = client.post(
        f"/api/workspaces/{workspace}/issues/{issue_id}/comments",
        json={"body": "Should not exist"},
    )

    assert response.status_code == 403, response.text
    body = response.json()
    assert body["error_code"] == "INSUFFICIENT_SCOPE"
    assert "comments:write" in body["message"]


def test_a_teams_read_key_may_read_teams(client: TestClient, repositories: Any, workspace: str) -> None:
    """The scope it does carry still works, so the refusals above are not blanket."""
    secret = mint(repositories, MEMBER, ("teams:read",))
    present(client, secret)

    listed = client.get(f"/api/workspaces/{workspace}/teams")
    assert listed.status_code == 200, listed.text
    assert {row["id"] for row in listed.json()["teams"]} == {TEAM, OTHER_TEAM}

    one = client.get(f"/api/workspaces/{workspace}/teams/{TEAM}")
    assert one.status_code == 200, one.text


def test_a_teams_read_key_cannot_read_issues(client: TestClient, repositories: Any, workspace: str) -> None:
    """Reading issues is a scope of its own, so `teams:read` does not carry it."""
    secret = mint(repositories, MEMBER, ("teams:read",))
    present(client, secret)

    response = client.get(f"/api/workspaces/{workspace}/issues")

    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "INSUFFICIENT_SCOPE"


def test_an_issues_write_key_may_create_an_issue(client: TestClient, repositories: Any, workspace: str) -> None:
    """The write surface opens for the key that carries the write scope."""
    secret = mint(repositories, MEMBER, ("issues:write",))
    present(client, secret)

    response = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"team_id": TEAM, "title": "A real issue"},
    )

    assert response.status_code == 201, response.text


def test_a_session_user_is_unaffected_by_scopes(client: TestClient, workspace: str) -> None:
    """A browser login carries no scopes and must still reach the whole surface.

    The same member whose key is refused above, on the same routes, so this is the
    other side of exactly one branch rather than a different scenario.
    """
    sign_in(client, MEMBER)

    listed = client.get(f"/api/workspaces/{workspace}/teams")
    assert listed.status_code == 200, listed.text

    created = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"team_id": TEAM, "title": "A session issue"},
    )
    assert created.status_code == 201, created.text

    issue_id = created.json()["id"]
    commented = client.post(
        f"/api/workspaces/{workspace}/issues/{issue_id}/comments",
        json={"body": "A session comment"},
    )
    assert commented.status_code == 201, commented.text


def test_a_key_carrying_every_scope_still_cannot_administer(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """No scope reaches workspace administration, so the widest key is still refused.

    Minted by the owner, so the capability check cannot be what refuses and the
    route table is the only thing left.
    """
    secret = mint(repositories, OWNER, API_KEY_SCOPES)
    present(client, secret)

    response = client.patch(f"/api/workspaces/{workspace}", json={"name": "Renamed"})

    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "INSUFFICIENT_SCOPE"


def test_a_key_cannot_delete_an_issue(client: TestClient, repositories: Any, workspace: str) -> None:
    """Deleting is outside every scope, per the contract's no-destruction rule."""
    issue_id = seed_issue(client, workspace)
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)
    present(client, secret)

    response = client.delete(f"/api/workspaces/{workspace}/issues/{issue_id}")

    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "INSUFFICIENT_SCOPE"


def test_a_key_still_cannot_reach_a_team_its_minter_cannot_see(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The scope is a ceiling on the role, so a guest's key stays inside the guest's teams."""
    secret = mint(repositories, GUEST, ("teams:read",))
    present(client, secret)

    assert client.get(f"/api/workspaces/{workspace}/teams/{TEAM}").status_code == 200
    assert client.get(f"/api/workspaces/{workspace}/teams/{OTHER_TEAM}").status_code == 404


def _workspace_routes() -> "list[tuple[str, str]]":
    """Every workspace-scoped route in the merged application, as method and template.

    Walks the included routers rather than reading `app.routes`, because this
    FastAPI version keeps an included router nested instead of flattening its
    routes onto the parent.
    """
    app = build_domain_app(list(DOMAINS.values()))

    def walk(router: Any, prefix: str = "") -> "list[tuple[str, str, str]]":
        found: "list[tuple[str, str, str]]" = []
        for route in router.routes:
            path = getattr(route, "path", None)
            if path is None and hasattr(route, "original_router"):
                context = getattr(route, "include_context", None)
                found += walk(route.original_router, prefix + getattr(context, "prefix", ""))
            elif path is not None:
                for method in getattr(route, "methods", None) or ():
                    if method not in ("HEAD", "OPTIONS"):
                        found.append((method, prefix + path, path))
        return found

    return [(method, relative) for method, full, relative in walk(app) if full.startswith("/api/workspaces")]


def test_every_protected_route_has_a_scope_decision() -> None:
    """The table names every workspace-scoped route, so none is decided by omission.

    A route absent here is refused to every key at runtime, which is the safe
    direction, but it would be refused silently. This turns that into a failing
    test naming the route, so the decision is made deliberately when the route is
    added.
    """
    unlisted = sorted(
        f"{method} {path}"
        for method, path in _workspace_routes()
        if path not in ("", "/health") and (method, path) not in ROUTE_SCOPES
    )

    assert unlisted == [], f"These routes need an entry in ROUTE_SCOPES: {unlisted}"


def test_the_table_names_no_route_that_does_not_exist() -> None:
    """A stale entry is removed rather than left to describe a route that is gone."""
    live = set(_workspace_routes())

    stale = sorted(f"{method} {path}" for method, path in ROUTE_SCOPES if (method, path) not in live)

    assert stale == [], f"These ROUTE_SCOPES entries match no route: {stale}"


def test_every_required_scope_is_one_the_product_mints() -> None:
    """A table entry naming a scope outside the five would refuse every key forever."""
    named = {scope for required in ROUTE_SCOPES.values() for scope in required}

    assert named <= set(API_KEY_SCOPES)


def test_no_key_access_is_distinguishable_from_a_missing_entry() -> None:
    """The sentinel is empty, which is what makes an unlisted route fail closed too."""
    assert NO_KEY_ACCESS == ()
