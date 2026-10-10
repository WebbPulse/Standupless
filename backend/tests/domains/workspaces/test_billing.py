"""The billing routes: who may buy, what the flags gate, and how the webhook refuses forgeries."""

from __future__ import annotations

import json
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.testing import FakeStripeGateway, sign_stripe_payload

from app.common import billing
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.core.config import settings
from tests.common.test_billing import fake_gateway, subscription
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
    sign_out,
)

WORKSPACE = "01JB00000000000000000000WS"

WEBHOOK_SECRET = "whsec_test_secret"

WEBHOOK = "/api/billing/stripe/webhook"


@pytest.fixture
def gateway() -> FakeStripeGateway:
    """The fake Stripe every route in this module talks to, verifying under the test signing secret."""
    return fake_gateway(webhook_secret=WEBHOOK_SECRET)


@pytest.fixture
def client(repositories: Any, gateway: FakeStripeGateway) -> Iterator[TestClient]:
    """A client for the workspaces application with Stripe faked out."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    app.dependency_overrides[billing.get_gateway_factory] = lambda: lambda stripe_settings: gateway
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
    return WORKSPACE


@pytest.fixture
def stripe_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """Billing on, with test-mode Stripe keys in the environment."""
    monkeypatch.setattr(settings, "BILLING_ENABLED", True)
    monkeypatch.setattr(settings, "APP_SECRETS_ARN", "")
    monkeypatch.setenv("STRIPE_API_KEY", "sk_test_placeholder")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET)


def signed(payload: bytes, secret: str = WEBHOOK_SECRET) -> dict[str, str]:
    """A Stripe-Signature header over `payload`, as Stripe computes it."""
    return {"Stripe-Signature": sign_stripe_payload(payload, secret)}


def delivery(event_type: str, obj: dict[str, Any], event_id: str = "evt_1") -> bytes:
    """A Stripe event body."""
    return json.dumps({"id": event_id, "object": "event", "type": event_type, "data": {"object": obj}}).encode()


def test_any_member_reads_the_plan(client: TestClient, workspace: str) -> None:
    """The billing read shows the plan and seats, and no Stripe ids."""
    sign_in(client, MEMBER)
    response = client.get(f"/api/workspaces/{workspace}/billing")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["plan"] == "free"
    assert body["seats_in_use"] == 3
    assert body["billing_enabled"] is False
    assert body["business_available"] is False
    assert body["has_billing_account"] is False
    assert "stripe_customer_id" not in body
    assert body["features"] == []


def test_an_outsider_reads_nothing(client: TestClient, workspace: str) -> None:
    """A non-member is refused the billing read."""
    sign_in(client, OUTSIDER)
    assert client.get(f"/api/workspaces/{workspace}/billing").status_code in {403, 404}


def test_checkout_is_refused_while_billing_is_off(client: TestClient, workspace: str) -> None:
    """With the flag off no Stripe call is made, and the refusal is a 409 rather than a 5xx."""
    sign_in(client, OWNER)
    response = client.post(f"/api/workspaces/{workspace}/billing/checkout-session", json={})
    assert response.status_code == 409
    assert response.json()["error_code"] == "BILLING_DISABLED"


def test_the_portal_is_refused_while_billing_is_off(client: TestClient, workspace: str, repositories: Any) -> None:
    """With the flag off the portal is a 409 even for a workspace with a billing account."""
    repositories.workspaces.set_billing(workspace, stripe_customer_id="cus_1")
    sign_in(client, OWNER)
    response = client.post(f"/api/workspaces/{workspace}/billing/portal-session")
    assert response.status_code == 409
    assert response.json()["error_code"] == "BILLING_DISABLED"


def test_a_member_may_not_start_checkout(client: TestClient, workspace: str, stripe_on: None) -> None:
    """Buying a plan is an admin act."""
    sign_in(client, MEMBER)
    assert client.post(f"/api/workspaces/{workspace}/billing/checkout-session", json={}).status_code == 403


def test_an_owner_starts_checkout(
    client: TestClient, workspace: str, stripe_on: None, gateway: FakeStripeGateway, repositories: Any
) -> None:
    """Checkout bills every seat and returns to the billing page."""
    sign_in(client, OWNER)
    response = client.post(
        f"/api/workspaces/{workspace}/billing/checkout-session", json={"plan": "standard", "interval": "month"}
    )
    assert response.status_code == 201, response.text
    assert response.json()["url"].startswith("https://checkout.stripe.test")
    checkout = gateway.checkout_sessions[0]
    assert checkout["quantity"] == 3
    assert checkout["price"] == "price_standard_monthly"
    assert checkout["success_url"].endswith("/w/acme/settings/billing?checkout=success")
    assert checkout["metadata"] == {"workspace_id": workspace, "plan": "standard"}
    assert repositories.workspaces.get(workspace).stripe_customer_id == checkout["customer"]
    assert gateway.customers[checkout["customer"]]["email"] == "owner@example.com"


def test_business_is_not_on_sale_behind_its_flag(client: TestClient, workspace: str, stripe_on: None) -> None:
    """Business needs its own flag."""
    sign_in(client, OWNER)
    response = client.post(f"/api/workspaces/{workspace}/billing/checkout-session", json={"plan": "business"})
    assert response.status_code == 409
    assert response.json()["error_code"] == "PLAN_UNAVAILABLE"


def test_business_sells_once_flagged(
    client: TestClient, workspace: str, stripe_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With the Business flag on, checkout proceeds."""
    monkeypatch.setattr(settings, "BILLING_BUSINESS_ENABLED", True)
    sign_in(client, OWNER)
    response = client.post(f"/api/workspaces/{workspace}/billing/checkout-session", json={"plan": "business"})
    assert response.status_code == 201, response.text


def test_a_paid_workspace_cannot_check_out_again(
    client: TestClient, workspace: str, stripe_on: None, repositories: Any
) -> None:
    """A live subscription is managed in the portal, never doubled."""
    repositories.workspaces.set_billing(workspace, plan="standard", subscription_status="active")
    sign_in(client, ADMIN)
    response = client.post(f"/api/workspaces/{workspace}/billing/checkout-session", json={})
    assert response.status_code == 409
    assert response.json()["error_code"] == "ALREADY_SUBSCRIBED"


def test_checkout_without_stripe_keys_is_not_configured(
    client: TestClient, workspace: str, stripe_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Missing keys are a 503, not a crash."""
    monkeypatch.delenv("STRIPE_API_KEY")
    sign_in(client, OWNER)
    response = client.post(f"/api/workspaces/{workspace}/billing/checkout-session", json={})
    assert response.status_code == 503
    assert response.json()["error_code"] == "STRIPE_NOT_CONFIGURED"


def test_the_portal_needs_a_billing_account(client: TestClient, workspace: str, stripe_on: None) -> None:
    """A workspace that never checked out has no portal."""
    sign_in(client, OWNER)
    response = client.post(f"/api/workspaces/{workspace}/billing/portal-session")
    assert response.status_code == 409
    assert response.json()["error_code"] == "NO_BILLING_ACCOUNT"


def test_an_admin_opens_the_portal(client: TestClient, workspace: str, stripe_on: None, repositories: Any) -> None:
    """With a customer on file the portal URL comes back."""
    repositories.workspaces.set_billing(workspace, stripe_customer_id="cus_1")
    sign_in(client, ADMIN)
    response = client.post(f"/api/workspaces/{workspace}/billing/portal-session")
    assert response.status_code == 201, response.text
    assert response.json()["url"].startswith("https://billing.stripe.test")


def test_an_unsigned_webhook_is_refused_even_with_billing_off(client: TestClient) -> None:
    """The refusal holds on every stage, which the e2e suite relies on."""
    sign_out(client)
    response = client.post(WEBHOOK, content=b"{}")
    assert response.status_code == 400
    assert response.json()["error_code"] == "STRIPE_SIGNATURE_INVALID"


def test_a_forged_webhook_is_refused(client: TestClient, stripe_on: None) -> None:
    """A signature under the wrong secret never verifies."""
    payload = delivery("customer.subscription.updated", {"id": "sub_1"})
    response = client.post(WEBHOOK, content=payload, headers=signed(payload, "whsec_wrong"))
    assert response.status_code == 400
    assert response.json()["error_code"] == "STRIPE_SIGNATURE_INVALID"


def test_a_signed_webhook_is_refused_while_billing_is_off(client: TestClient) -> None:
    """Billing off answers 503, so Stripe retries once it is on."""
    payload = delivery("customer.subscription.updated", {"id": "sub_1"})
    response = client.post(WEBHOOK, content=payload, headers=signed(payload))
    assert response.status_code == 503


def test_a_signed_webhook_upgrades_the_workspace_once(
    client: TestClient, workspace: str, stripe_on: None, gateway: FakeStripeGateway, repositories: Any
) -> None:
    """A verified event is applied, and its redelivery is a duplicate."""
    gateway.subscriptions["sub_1"] = subscription()
    payload = delivery("customer.subscription.created", {"id": "sub_1"})

    first = client.post(WEBHOOK, content=payload, headers=signed(payload))
    assert first.status_code == 200, first.text
    assert first.json() == {"received": True, "handled": True, "duplicate": False}
    assert repositories.workspaces.get(workspace).plan == "standard"

    second = client.post(WEBHOOK, content=payload, headers=signed(payload))
    assert second.json() == {"received": True, "handled": False, "duplicate": True}


def test_removing_a_member_syncs_seats(
    client: TestClient, workspace: str, stripe_on: None, gateway: FakeStripeGateway, repositories: Any, monkeypatch: Any
) -> None:
    """A membership change pushes the new seat count to Stripe."""
    gateway.subscriptions["sub_1"] = subscription()
    repositories.workspaces.set_billing(
        workspace, plan="standard", stripe_subscription_id="sub_1", subscription_status="active", billed_seats=3
    )
    monkeypatch.setattr(billing, "_build_gateway", lambda: gateway)
    sign_in(client, OWNER)
    response = client.delete(f"/api/workspaces/{workspace}/members/{MEMBER}")
    assert response.status_code in {200, 204}, response.text
    assert gateway.subscriptions["sub_1"]["items"]["data"][0]["quantity"] == 2
    assert repositories.workspaces.get(workspace).billed_seats == 2
