"""Signed-in and credentialed callers count on plan-tier limits by token, person and workspace (SUP-12).

The single stage throttle and a per-principal class were the only limits, so one busy
workspace spent the same allowance as everybody else. These tests hold that the
resolver names only verified identities, that a workspace aggregate is spent only by
its own members and credentials, and that the aggregate scales with the plan.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request
from webbpulse.ratelimit import Quota, ScopeLimits
from webbpulse.testing import make_request_context_headers

from app.common.api.middleware import rate_limit_tiers, rate_limiter
from app.common.db.dynamo.workspaces import Plan, Workspace
from tests.domains.helpers import GUEST, MEMBER, OUTSIDER, OWNER, add_member, make_team, make_workspace

WORKSPACE = "01JB00000000000000000000WS"

OTHER_WORKSPACE = "01JB00000000000000000000W2"

TEAM = "01JB000000000000000000PRJ1"

CALLER_IP = "198.51.100.41"


def _headers(sub: str | None = None, bearer: str | None = None) -> dict[str, str]:
    """Request context headers for a caller, signed in when `sub` is set."""
    extra = {"authorizer": {"jwt": {"claims": {"sub": sub}}}} if sub else None
    headers = make_request_context_headers(CALLER_IP, extra=extra)
    if bearer:
        headers["authorization"] = f"Bearer {bearer}"
    return headers


def _key(repositories: Any, tenant_id: str = WORKSPACE, user_id: str = MEMBER) -> str:
    """A key minted in `tenant_id` by `user_id`."""
    from webbpulse.identity.api_keys import mint

    from app.common.db.dynamo.api_keys import API_KEY_SCOPES

    return mint(
        user_id=user_id,
        tenant_id=tenant_id,
        scopes=API_KEY_SCOPES,
        name="A key",
        store=repositories.api_keys,
        created_by=user_id,
    ).plaintext


@pytest.fixture
def workspace(repositories: Any) -> Any:
    """A free workspace with a member and a guest, and a business one the outsider owns."""
    rate_limit_tiers.reset_caches()
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    repositories.workspaces.create(Workspace(id=OTHER_WORKSPACE, name="Big", slug="big", plan=Plan.BUSINESS.value))
    add_member(repositories, OTHER_WORKSPACE, OUTSIDER, "owner")
    yield repositories
    rate_limit_tiers.reset_caches()


def _resolve(repositories: Any, path: str, headers: dict[str, str]) -> Any:
    """Run the resolver over one request against an app bound to `repositories`."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = FastAPI()
    bind_repositories(app, repositories)
    raw = [(name.lower().encode(), value.encode()) for name, value in headers.items()]
    request = Request({"type": "http", "method": "GET", "path": path, "headers": raw, "query_string": b"", "app": app})
    return rate_limit_tiers._resolve_subject(request)


def _aggregate(plan: Any) -> int:
    """A plan's workspace aggregate per minute."""
    assert plan.tenant is not None and plan.tenant.read is not None
    return int(plan.tenant.read.per_minute)


def test_every_plan_has_the_same_per_person_and_per_credential_allowance(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only the workspace aggregate differs by plan, and it grows with the seat ceiling."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "BILLING_ENABLED", True)
    limits = rate_limit_tiers.plan_limits()
    assert set(limits) == {Plan.FREE, Plan.STANDARD, Plan.BUSINESS}
    assert {plan.user for plan in limits.values()} == {rate_limit_tiers.USER_LIMITS}
    assert {plan.token for plan in limits.values()} == {rate_limit_tiers.TOKEN_LIMITS}
    aggregates = [_aggregate(limits[plan]) for plan in (Plan.FREE, Plan.STANDARD, Plan.BUSINESS)]
    assert aggregates == sorted(aggregates)
    assert len(set(aggregates)) == 3


def test_free_gets_the_standard_aggregate_while_billing_is_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nobody can upgrade yet, so the free plan is not held to its launch aggregate."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "BILLING_ENABLED", False)
    tenant = rate_limit_tiers.plan_limits()[Plan.FREE].tenant
    assert tenant is not None and tenant.read is not None
    assert tenant.read.per_minute == rate_limit_tiers.PREVIEW_FREE_TENANT_PER_MINUTE


def test_a_member_counts_against_themselves_and_the_workspace(workspace: Any) -> None:
    """A session in its own workspace names the person, the workspace and its plan."""
    subject = _resolve(workspace, f"/api/workspaces/{WORKSPACE}/teams", _headers(sub=MEMBER))
    assert (subject.user, subject.tenant, subject.token, subject.plan) == (MEMBER, WORKSPACE, None, Plan.FREE)


def test_a_guest_counts_against_the_workspace_too(workspace: Any) -> None:
    """Guests hold a workspace role, so their traffic is the workspace's."""
    assert _resolve(workspace, f"/api/workspaces/{WORKSPACE}/issues", _headers(sub=GUEST)).tenant == WORKSPACE


def test_a_non_member_cannot_spend_another_workspace_aggregate(workspace: Any) -> None:
    """Naming a workspace in the path is not membership, so only the person is counted."""
    subject = _resolve(workspace, f"/api/workspaces/{WORKSPACE}/teams", _headers(sub=OUTSIDER))
    assert (subject.user, subject.tenant, subject.plan) == (OUTSIDER, None, Plan.FREE)


def test_the_plan_comes_from_the_workspace(workspace: Any) -> None:
    """A business workspace's member is counted on the business plan."""
    subject = _resolve(workspace, f"/api/workspaces/{OTHER_WORKSPACE}/teams", _headers(sub=OUTSIDER))
    assert (subject.tenant, subject.plan) == (OTHER_WORKSPACE, Plan.BUSINESS)


def test_a_route_outside_any_workspace_counts_the_person_alone(workspace: Any) -> None:
    """Listing workspaces names no tenant."""
    subject = _resolve(workspace, "/api/workspaces", _headers(sub=MEMBER))
    assert (subject.user, subject.tenant) == (MEMBER, None)


def test_an_api_key_counts_against_its_own_workspace_whatever_the_path(workspace: Any) -> None:
    """A key is bound to the workspace it was minted in, and never to its creator's allowance."""
    secret = _key(workspace)
    subject = _resolve(workspace, f"/api/workspaces/{OTHER_WORKSPACE}/teams", _headers(bearer=secret))
    assert subject.tenant == WORKSPACE
    assert subject.user is None
    assert subject.token is not None and subject.token.startswith("key:")
    assert secret not in subject.token


def test_an_unverified_key_or_token_stays_on_the_ip(workspace: Any) -> None:
    """A forged credential would otherwise be a fresh bucket per guess."""
    forged = "wpk_" + "b" * 43
    assert _resolve(workspace, f"/api/workspaces/{WORKSPACE}/teams", _headers(bearer=forged)) is None
    assert _resolve(workspace, "/api/mcp", _headers(bearer="eyJ.not.verified")) is None
    assert _resolve(workspace, f"/api/workspaces/{WORKSPACE}/teams", _headers()) is None


@pytest.fixture
def client(workspace: Any, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """Every domain with the limiter on, a two-read person allowance and a three-request aggregate."""
    from webbpulse.dynamodb import table_name
    from webbpulse.ratelimit import RATE_LIMIT_TABLE

    from app.common.api.dependencies.repositories import bind_repositories
    from app.common.composition.domains import DOMAINS
    from app.common.composition.wiring import build_domain_app
    from app.common.db.dynamo.client import get_client
    from app.common.db.dynamo.tables import RATE_LIMITS

    get_client().create_table(**RATE_LIMITS.create_table_request(table_name(RATE_LIMIT_TABLE)))
    monkeypatch.setattr(rate_limiter, "rate_limiting_enabled", lambda: True)
    monkeypatch.setattr(
        rate_limit_tiers, "USER_LIMITS", ScopeLimits(read=Quota(per_minute=2), write=Quota(per_minute=2))
    )
    monkeypatch.setattr(rate_limit_tiers, "PREVIEW_FREE_TENANT_PER_MINUTE", 3)
    rate_limiter.reset_rate_limit_middleware()

    app = build_domain_app(list(DOMAINS.values()))
    bind_repositories(app, workspace)
    with TestClient(app) as test_client:
        yield test_client
    rate_limiter.reset_rate_limit_middleware()


def test_a_person_is_refused_past_their_allowance_with_the_policy_named(client: TestClient) -> None:
    """The third read in a minute is a 429 naming the person's read counter."""
    path = f"/api/workspaces/{WORKSPACE}/teams"
    first = client.get(path, headers=_headers(sub=MEMBER))
    assert first.status_code == 200, first.text
    assert '"user-read"' in first.headers["ratelimit-policy"] or '"tenant-all"' in first.headers["ratelimit-policy"]
    assert client.get(path, headers=_headers(sub=MEMBER)).status_code == 200
    refused = client.get(path, headers=_headers(sub=MEMBER))
    assert refused.status_code == 429
    assert '"user-read"' in refused.headers["ratelimit-policy"]
    assert int(refused.headers["retry-after"]) <= 60


def test_members_share_the_workspace_aggregate(client: TestClient) -> None:
    """Once the workspace's aggregate is spent, another member is refused on it."""
    path = f"/api/workspaces/{WORKSPACE}/teams"
    assert client.get(path, headers=_headers(sub=MEMBER)).status_code == 200
    assert client.get(path, headers=_headers(sub=MEMBER)).status_code == 200
    assert client.get(path, headers=_headers(sub=OWNER)).status_code == 200
    refused = client.get(path, headers=_headers(sub=GUEST))
    assert refused.status_code == 429
    assert '"tenant-all"' in refused.headers["ratelimit-policy"]


def test_an_outsider_hammering_a_workspace_leaves_its_aggregate_alone(client: TestClient) -> None:
    """Requests from a non-member count only against the non-member."""
    path = f"/api/workspaces/{WORKSPACE}/teams"
    for _ in range(3):
        client.get(path, headers=_headers(sub=OUTSIDER))
    assert client.get(path, headers=_headers(sub=MEMBER)).status_code == 200
