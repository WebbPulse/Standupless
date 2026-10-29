"""The e2e plan limit exemption: who is an e2e user, which workspaces it stamps, and what it lifts.

A workspace an e2e user created keeps the free plan's preview limits with billing
on, but only where `PLAN_LIMIT_E2E_EXEMPTION` is on and never in production. The
plan it reads stays free throughout.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from webbpulse.identity import E2E_USER_ATTRIBUTE

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.core.config import settings
from app.common.db.dynamo.users import User
from app.common.db.dynamo.workspaces import Workspace
from app.common.plan_limits import (
    FREE_TEAMS,
    FREE_WEBHOOKS,
    PLAN_GUESTS_PER_SEAT,
    PLAN_LIMITS,
    PLAN_STORAGE_BYTES,
    PREVIEW_FREE_GUESTS_PER_SEAT,
    PREVIEW_FREE_LIMITS,
    PREVIEW_FREE_STORAGE_BYTES,
    LimitedResource,
    check_guests,
    check_limit,
    creates_e2e_workspaces,
    e2e_exempt,
    guests_per_seat_of,
    limit_for,
    plan_of,
    storage_limit_of,
)
from app.domains.identity.identity_hooks import StanduplessIdentityHooks
from tests.domains.helpers import OWNER, make_user, sign_in

DURABLE = "01JB0000000000000000DURABLE"


@pytest.fixture
def billing_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """Billing on, so the free plan's launch limits apply to everyone not exempt."""
    monkeypatch.setattr(settings, "BILLING_ENABLED", True)


@pytest.fixture
def exemption_on(monkeypatch: pytest.MonkeyPatch, billing_on: None) -> None:
    """The exemption flag on in a staging environment."""
    del billing_on
    monkeypatch.setattr(settings, "PLAN_LIMIT_E2E_EXEMPTION", True)
    monkeypatch.setattr(settings, "APP_ENVIRONMENT", "staging")


def e2e_workspace(**fields: Any) -> Workspace:
    """A free workspace an e2e user created."""
    return Workspace(name="E2E", slug="e2e-run", e2e_owned=True, **fields)


def test_an_exempt_workspace_keeps_the_preview_limits_and_reads_free(exemption_on: None) -> None:
    """With billing on, an e2e owned free workspace holds the preview ceilings and still reads as free."""
    del exemption_on
    workspace = e2e_workspace()

    assert e2e_exempt(workspace)
    assert plan_of(workspace) == "free"
    for resource in LimitedResource:
        assert limit_for(workspace, resource) == PREVIEW_FREE_LIMITS[resource]
    assert storage_limit_of(workspace) == PREVIEW_FREE_STORAGE_BYTES
    assert guests_per_seat_of(workspace) == PREVIEW_FREE_GUESTS_PER_SEAT
    check_limit(workspace, LimitedResource.TEAMS, FREE_TEAMS + 7)
    check_limit(workspace, LimitedResource.WEBHOOKS, FREE_WEBHOOKS + 1)
    check_guests(workspace, 0, 1)


def test_a_workspace_no_e2e_user_created_keeps_the_launch_limits(exemption_on: None) -> None:
    """The flag lifts nothing for a workspace that is not e2e owned."""
    del exemption_on
    workspace = Workspace(name="Acme", slug="acme")

    assert not e2e_exempt(workspace)
    assert limit_for(workspace, LimitedResource.TEAMS) == FREE_TEAMS
    with pytest.raises(HTTPException) as caught:
        check_limit(workspace, LimitedResource.TEAMS, FREE_TEAMS)
    assert caught.value.status_code == 403
    with pytest.raises(HTTPException):
        check_guests(workspace, 0, 1)


def test_a_bare_plan_name_is_never_exempt(exemption_on: None) -> None:
    """Only the workspace itself can lift a limit, so a plan string reads the launch numbers."""
    del exemption_on
    assert not e2e_exempt("free")
    assert limit_for("free", LimitedResource.TEAMS) == FREE_TEAMS


def test_with_the_flag_off_an_e2e_workspace_keeps_the_launch_limits(billing_on: None) -> None:
    """Without `PLAN_LIMIT_E2E_EXEMPTION` an e2e owned workspace is held to the real Free limits."""
    del billing_on
    workspace = e2e_workspace()

    assert not e2e_exempt(workspace)
    assert limit_for(workspace, LimitedResource.TEAMS) == FREE_TEAMS
    assert storage_limit_of(workspace) == PLAN_STORAGE_BYTES["free"]
    assert guests_per_seat_of(workspace) == PLAN_GUESTS_PER_SEAT["free"]
    with pytest.raises(HTTPException):
        check_limit(workspace, LimitedResource.WEBHOOKS, FREE_WEBHOOKS)


def test_production_refuses_the_exemption_whatever_the_flag_says(
    exemption_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A production deployment that somehow carries the flag still enforces the launch limits."""
    del exemption_on
    monkeypatch.setattr(settings, "APP_ENVIRONMENT", "production")

    assert not e2e_exempt(e2e_workspace())
    assert limit_for(e2e_workspace(), LimitedResource.TEAMS) == FREE_TEAMS


def test_a_paid_e2e_workspace_reads_its_own_plan(exemption_on: None) -> None:
    """The exemption touches the free plan only, so a paid e2e workspace reads its plan's numbers."""
    del exemption_on
    workspace = e2e_workspace(plan="standard")

    assert limit_for(workspace, LimitedResource.WEBHOOKS) == PLAN_LIMITS["standard"][LimitedResource.WEBHOOKS]


def test_the_package_marker_reaches_the_row_and_nothing_else_does(repositories: Any) -> None:
    """`create_user` keeps the reserved e2e marker only when it is exactly `True`, and no other privileged field."""
    hooks = StanduplessIdentityHooks(repositories.users)

    registered = hooks.create_user(email="person@example.com", attributes={E2E_USER_ATTRIBUTE: "yes", "is_admin": True})
    oauth = hooks.create_user(email="social@example.com", attributes={})
    ephemeral = hooks.create_user(
        email="e2e-run-1@e2e.invalid", attributes={"email_verified": True, E2E_USER_ATTRIBUTE: True}
    )

    assert repositories.users.get(registered["id"]).e2e_user is False
    assert repositories.users.get(registered["id"]).is_admin is False
    assert repositories.users.get(oauth["id"]).e2e_user is False
    assert repositories.users.get(ephemeral["id"]).e2e_user is True


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def _create(client: TestClient, repositories: Any, subject: str, slug: str) -> Workspace:
    """Create a workspace as `subject` through the route and return the stored row."""
    sign_in(client, subject)
    response = client.post("/api/workspaces", json={"name": slug.title(), "slug": slug})
    assert response.status_code == 201, response.text
    assert "e2e_owned" not in response.json()
    return repositories.workspaces.get(response.json()["id"])


def test_a_workspace_an_ephemeral_e2e_user_creates_is_e2e_owned(client: TestClient, repositories: Any) -> None:
    """The creator's `e2e_user` mark stamps the new workspace."""
    make_user(repositories, OWNER, "e2e-run-2@e2e.invalid")
    repositories.users.update(OWNER, email_verified=True, e2e_user=True)

    assert _create(client, repositories, OWNER, "e2e-ephemeral").e2e_owned is True


def test_a_workspace_a_listed_durable_e2e_user_creates_is_e2e_owned(
    client: TestClient, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A durable e2e user named in `IDENTITY_E2E_USER_IDS` stamps its workspace too."""
    monkeypatch.setattr(settings, "IDENTITY_E2E_USER_IDS", ["someone-else", f" {DURABLE}"])
    make_user(repositories, DURABLE, "durable@example.com")
    repositories.users.update(DURABLE, email_verified=True)

    assert _create(client, repositories, DURABLE, "e2e-durable").e2e_owned is True


def test_production_never_counts_an_e2e_user(monkeypatch: pytest.MonkeyPatch) -> None:
    """In production neither the marker nor a listed id makes a creator's workspaces e2e owned."""
    monkeypatch.setattr(settings, "IDENTITY_E2E_USER_IDS", [DURABLE])
    marked = User(id=DURABLE, email="durable@example.com", e2e_user=True)
    assert creates_e2e_workspaces(marked)

    monkeypatch.setattr(settings, "APP_ENVIRONMENT", "production")

    assert not creates_e2e_workspaces(marked)


def test_settings_refuse_durable_e2e_user_ids_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    """A production deployment carrying `IDENTITY_E2E_USER_IDS` fails at startup."""
    from app.common.core.config import Settings

    monkeypatch.setenv("APP_ENVIRONMENT", "production")
    monkeypatch.setenv("IDENTITY_E2E_USER_IDS", f'["{DURABLE}"]')

    with pytest.raises(ValueError, match="IDENTITY_E2E_USER_IDS"):
        Settings()


def test_a_workspace_anyone_else_creates_is_not_e2e_owned(client: TestClient, repositories: Any) -> None:
    """An ordinary account's workspace carries no stamp, even when the client sends one."""
    make_user(repositories, OWNER, "owner@example.com")
    repositories.users.update(OWNER, email_verified=True)
    sign_in(client, OWNER)

    response = client.post("/api/workspaces", json={"name": "Acme", "slug": "acme", "e2e_owned": True})

    assert response.status_code == 201, response.text
    assert repositories.workspaces.get(response.json()["id"]).e2e_owned is False
