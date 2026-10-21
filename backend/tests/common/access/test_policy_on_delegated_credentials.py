"""A workspace's authentication policy reaches API keys and MCP grants issued before it tightened.

The policy is enforced at request time rather than by revoking anything. Turning on
two-factor, requiring single sign-on or narrowing the sign-in methods stamps the
moment the policy tightened. A delegated credential issued since then was minted by a
session the policy admitted, so it passes; one issued before is held to the policy
as a sign-in with nothing to show and refused for whatever it now requires. The owner
keeps the single sign-on way past, a workspace key by its creator's role, and turning
the requirement off admits the old credential again.

These tests mint keys over REST through the merged application and move the policy's
clock rather than sleeping, because key times are stored to the second.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.memberships import AuthPolicy
from tests.domains.helpers import (
    ADMIN,
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

SSO_SESSION: dict[str, Any] = {"amr": ["sso"], "sso_connection": WORKSPACE}


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client carrying every domain, so minting, policy and issues share one app."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(list(DOMAINS.values()))
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A Business workspace with an owner, an admin and a member in one team."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, ADMIN, "admin@example.com", "Adam Admin")
    make_user(repositories, MEMBER, "member@example.com", "Mo Member")
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    return WORKSPACE


@pytest.fixture
def issue(client: TestClient, workspace: str) -> str:
    """One issue the owner created over a session."""
    as_person(client, OWNER)
    response = client.post(f"/api/workspaces/{WORKSPACE}/issues", json={"team_id": TEAM, "title": "An issue"})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def as_person(client: TestClient, subject: str, **claims: Any) -> None:
    """Make later requests arrive as a signed in person, with no key presented."""
    client.headers.pop("authorization", None)
    sign_in(client, subject, **claims)


def mint(client: TestClient, creator: str, kind: str = "user", **claims: Any) -> str:
    """Mint a key over REST as `creator`, signed in with `claims`, and return its plaintext."""
    as_person(client, creator, **claims)
    response = client.post(
        f"/api/workspaces/{WORKSPACE}/api-keys",
        json={"name": "A key", "scopes": ["issues:read"], "kind": kind},
    )
    assert response.status_code == 201, response.text
    return str(response.json()["secret"])


def read(client: TestClient, secret: str, issue_id: str) -> Any:
    """One key reading one issue, with no session beside it."""
    sign_out(client)
    client.headers["authorization"] = f"Bearer {secret}"
    return client.get(f"/api/workspaces/{WORKSPACE}/issues/{issue_id}")


def set_policy(repositories: Any, monkeypatch: pytest.MonkeyPatch, *, offset: int, **policy: Any) -> AuthPolicy:
    """Store the policy as if saved `offset` seconds from now."""
    moment = datetime.now(timezone.utc) + timedelta(seconds=offset)
    policy.setdefault("require_two_factor", False)
    with monkeypatch.context() as patch:
        patch.setattr("app.common.db.dynamo.memberships.utc_now", lambda: moment)
        stored: AuthPolicy = repositories.memberships.set_auth_policy(WORKSPACE, updated_by=OWNER, **policy)
    return stored


def test_a_key_minted_before_two_factor_was_required_is_refused_until_it_is_turned_off(
    client: TestClient, issue: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = mint(client, MEMBER)
    assert read(client, secret, issue).status_code == 200

    set_policy(repositories, monkeypatch, offset=120, require_two_factor=True)
    refused = read(client, secret, issue)
    assert refused.status_code == 403
    assert refused.json()["error_code"] == "AUTH_POLICY_REQUIRED"

    set_policy(repositories, monkeypatch, offset=240, require_two_factor=False)
    assert read(client, secret, issue).status_code == 200


def test_a_key_minted_under_the_policy_keeps_working(
    client: TestClient, issue: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_policy(repositories, monkeypatch, offset=-120, require_two_factor=True)
    secret = mint(client, MEMBER, two_factor=True)
    assert read(client, secret, issue).status_code == 200


def test_a_key_minted_before_single_sign_on_was_required_answers_sso_required(
    client: TestClient, issue: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = mint(client, MEMBER)
    set_policy(repositories, monkeypatch, offset=120, require_sso=True)

    refused = read(client, before, issue)
    assert refused.status_code == 403
    assert refused.json()["error_code"] == "SSO_REQUIRED"


def test_a_key_minted_through_single_sign_on_after_it_was_required_works(
    client: TestClient, issue: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_policy(repositories, monkeypatch, offset=-120, require_sso=True)
    secret = mint(client, MEMBER, **SSO_SESSION)
    assert read(client, secret, issue).status_code == 200


def test_the_owner_keeps_the_single_sign_on_way_in_with_an_older_key(
    client: TestClient, issue: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    personal = mint(client, OWNER)
    workspace_key = mint(client, OWNER, kind="workspace")
    admins = mint(client, ADMIN, kind="workspace")
    set_policy(repositories, monkeypatch, offset=120, require_sso=True)

    assert read(client, personal, issue).status_code == 200
    assert read(client, workspace_key, issue).status_code == 200
    refused = read(client, admins, issue)
    assert refused.status_code == 403
    assert refused.json()["error_code"] == "SSO_REQUIRED"


def test_the_owner_break_glass_does_not_pass_a_two_factor_requirement(
    client: TestClient, issue: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    personal = mint(client, OWNER)
    set_policy(repositories, monkeypatch, offset=120, require_sso=True, require_two_factor=True)
    assert read(client, personal, issue).json()["error_code"] == "AUTH_POLICY_REQUIRED"


def test_narrowing_the_methods_holds_older_keys(
    client: TestClient, issue: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = mint(client, MEMBER)
    set_policy(repositories, monkeypatch, offset=120, allowed_methods=["google"])
    refused = read(client, secret, issue)
    assert refused.status_code == 403
    assert refused.json()["reason"] == "sign_in_method"


def test_only_a_tightening_moves_the_cutoff(repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch) -> None:
    tightened = set_policy(repositories, monkeypatch, offset=-600, require_two_factor=True)
    assert tightened.enforced_since == tightened.updated_at

    resaved = set_policy(repositories, monkeypatch, offset=-300, require_two_factor=True)
    assert resaved.enforced_since == tightened.enforced_since

    loosened = set_policy(repositories, monkeypatch, offset=-200, require_two_factor=False)
    assert loosened.enforced_since == tightened.enforced_since

    narrowed = set_policy(repositories, monkeypatch, offset=-100, allowed_methods=["google", "password"])
    assert narrowed.enforced_since == narrowed.updated_at
    assert repositories.memberships.get_auth_policy(WORKSPACE).enforced_since == narrowed.updated_at

    widened = set_policy(repositories, monkeypatch, offset=-50, allowed_methods=["google", "password", "github"])
    assert widened.enforced_since == narrowed.updated_at


def test_a_policy_saved_before_the_cutoff_existed_falls_back_to_its_last_update() -> None:
    moment = datetime(2026, 10, 1, tzinfo=timezone.utc)
    assert AuthPolicy(require_two_factor=True, updated_at=moment).delegated_cutoff() == moment
    assert AuthPolicy().delegated_cutoff() is None


def test_an_mcp_access_token_is_held_by_its_issue_time(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.common.api.dependencies.authz import blocked_by_auth_policy

    policy = set_policy(repositories, monkeypatch, offset=0, require_two_factor=True)
    assert policy.enforced_since is not None
    cutoff = int(policy.enforced_since.timestamp())
    token = {"sub": MEMBER, "scopes": ["issues:read"]}
    assert blocked_by_auth_policy(repositories, WORKSPACE, {**token, "iat": cutoff - 60}, role="member") is True
    assert blocked_by_auth_policy(repositories, WORKSPACE, {**token, "iat": cutoff + 60}, role="member") is False


def _consent(user_id: str, at: datetime) -> Any:
    """A standing MCP grant to this workspace, last authorized at `at`."""
    from webbpulse.identity import ConsentRecord

    stamp = at.isoformat(timespec="seconds").replace("+00:00", "Z")
    return ConsentRecord(
        consent_id="c1",
        user_id=user_id,
        client_id="client",
        tenant_id=WORKSPACE,
        resource="http://api.test/api/mcp",
        scopes=("issues:read",),
        granted_at=stamp,
        updated_at=stamp,
    )


def test_the_refresh_grant_rechecks_the_policy(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.domains.identity.oauth_server_glue import refresh_allowed

    now = datetime.now(timezone.utc)
    before, after = now - timedelta(hours=1), now + timedelta(hours=1)
    assert refresh_allowed(_consent(MEMBER, before)) is True

    set_policy(repositories, monkeypatch, offset=0, require_sso=True)
    assert refresh_allowed(_consent(MEMBER, before)) is False
    assert refresh_allowed(_consent(MEMBER, after)) is True
    assert refresh_allowed(_consent(OWNER, before)) is True

    set_policy(repositories, monkeypatch, offset=60, require_sso=False)
    assert refresh_allowed(_consent(MEMBER, before)) is True


def test_the_refresh_guard_leaves_a_former_member_to_the_other_checks(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.domains.identity.oauth_server_glue import refresh_allowed

    set_policy(repositories, monkeypatch, offset=0, require_two_factor=True)
    assert refresh_allowed(_consent("01JB000000000000000000GONE", datetime(2026, 1, 1, tzinfo=timezone.utc))) is True
