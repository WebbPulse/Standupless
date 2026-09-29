"""The Stripe billing service: status mapping, event handling, stale subscriptions and seat sync."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
import stripe

from app.common import billing
from app.common.core.config import settings
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, make_workspace

WORKSPACE = "01JB00000000000000000000WS"


def subscription(
    sub_id: str = "sub_1",
    *,
    status: str = "active",
    lookup_key: str = "standard_annual",
    quantity: int = 3,
    workspace_id: str = WORKSPACE,
) -> dict[str, Any]:
    """A Stripe subscription dict in the shape `retrieve_subscription` answers."""
    return {
        "id": sub_id,
        "status": status,
        "customer": "cus_1",
        "cancel_at_period_end": False,
        "metadata": {"workspace_id": workspace_id},
        "items": {
            "data": [
                {
                    "id": "si_1",
                    "quantity": quantity,
                    "current_period_end": 1_800_000_000,
                    "price": {"id": "price_1", "lookup_key": lookup_key},
                }
            ]
        },
    }


class FakeGateway:
    """An in-memory stand-in for Stripe that records what billing asked of it."""

    def __init__(self, subscriptions: dict[str, dict[str, Any]] | None = None) -> None:
        """Start with the given subscriptions and no calls."""
        self.subscriptions = subscriptions or {}
        self.quantities: list[tuple[str, str, int]] = []
        self.customers: list[str] = []
        self.checkouts: list[dict[str, Any]] = []
        self.fail = False

    def find_price_id(self, lookup_key: str) -> str | None:
        """Every known lookup key has a price."""
        return f"price_{lookup_key}" if lookup_key in billing.LOOKUP_KEYS else None

    def create_customer(self, *, workspace_id: str, name: str, email: str | None) -> str:
        """Record and answer a new customer id."""
        self.customers.append(workspace_id)
        return "cus_new"

    def create_checkout_session(self, **kwargs: Any) -> str:
        """Record the session and answer a Checkout URL."""
        self.checkouts.append(kwargs)
        return "https://checkout.stripe.test/session"

    def create_portal_session(self, *, customer_id: str, return_url: str) -> str:
        """Answer a portal URL."""
        return "https://billing.stripe.test/portal"

    def retrieve_subscription(self, subscription_id: str) -> dict[str, Any]:
        """The stored subscription, or a Stripe error when failing."""
        if self.fail:
            raise stripe.APIConnectionError("down")
        return self.subscriptions[subscription_id]

    def set_quantity(self, subscription_id: str, item_id: str, quantity: int) -> dict[str, Any]:
        """Record the quantity change."""
        self.quantities.append((subscription_id, item_id, quantity))
        return self.subscriptions[subscription_id]


class NoPriceGateway(FakeGateway):
    """A Stripe account with no prices configured."""

    def find_price_id(self, lookup_key: str) -> str | None:
        """No lookup key has a price."""
        return None


class FakeStore:
    """An in-memory event claim store with release."""

    def __init__(self) -> None:
        """Start with no claims."""
        self.claims: set[str] = set()

    def claim(self, key: str, ttl_seconds: float) -> bool:
        """Win the key once."""
        if key in self.claims:
            return False
        self.claims.add(key)
        return True

    def release(self, key: str) -> None:
        """Drop a claim."""
        self.claims.discard(key)


def event(event_type: str, obj: dict[str, Any], event_id: str = "evt_1") -> Any:
    """A verified event in the shape `process_webhook_event` reads."""
    payload = {"id": event_id, "type": event_type, "data": {"object": obj}}
    return SimpleNamespace(id=event_id, type=event_type, to_dict=lambda: payload)


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with an owner, an admin, a member and a guest."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    return WORKSPACE


@pytest.fixture
def enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Billing on for the test."""
    monkeypatch.setattr(settings, "BILLING_ENABLED", True)


def test_lookup_keys_cover_every_paid_plan_and_interval() -> None:
    """The four keys the Stripe account must carry."""
    assert set(billing.LOOKUP_KEYS) == {"standard_monthly", "standard_annual", "business_monthly", "business_annual"}


@pytest.mark.parametrize("status", ["active", "trialing"])
def test_a_paid_status_grants_the_plan(status: str) -> None:
    """Active and trialing subscriptions map to the plan their price names."""
    state = billing.subscription_state(subscription(status=status, lookup_key="business_monthly"))
    assert state["plan"] == "business"
    assert state["billing_interval"] == "month"
    assert state["billed_seats"] == 3
    assert state["current_period_end"] is not None


@pytest.mark.parametrize("status", ["past_due", "unpaid", "incomplete", "canceled", "incomplete_expired"])
def test_an_unpaid_status_drops_to_free_at_once(status: str) -> None:
    """Anything but active or trialing is free, whatever the price."""
    state = billing.subscription_state(subscription(status=status))
    assert state["plan"] == "free"
    assert state["billing_interval"] is None
    assert state["subscription_status"] == status


def test_an_unknown_lookup_key_never_grants_a_plan() -> None:
    """A price outside the catalog is free even when paid."""
    assert billing.subscription_state(subscription(lookup_key="mystery"))["plan"] == "free"


def test_seat_count_excludes_guests(repositories: Any, workspace: str) -> None:
    """Owner, admin and member are seats; the guest is not."""
    assert billing.seat_count(repositories, workspace) == 3


def test_checkout_creates_a_customer_once_and_bills_every_seat(repositories: Any, workspace: str) -> None:
    """The first checkout stores a customer, and the quantity is the seat count."""
    gateway = FakeGateway()
    ws = repositories.workspaces.get(workspace)
    url = billing.start_checkout(
        repositories, ws, gateway, plan=billing.Plan.STANDARD, interval=billing.BillingInterval.YEAR, email=None
    )
    assert url.startswith("https://checkout.stripe.test")
    assert gateway.checkouts[0]["quantity"] == 3
    assert gateway.checkouts[0]["price_id"] == "price_standard_annual"
    assert repositories.workspaces.get(workspace).stripe_customer_id == "cus_new"

    billing.start_checkout(
        repositories,
        repositories.workspaces.get(workspace),
        gateway,
        plan=billing.Plan.STANDARD,
        interval=billing.BillingInterval.MONTH,
        email=None,
    )
    assert gateway.customers == [workspace]


def test_checkout_without_a_price_raises(repositories: Any, workspace: str) -> None:
    """A missing price is its own error, never a Stripe call."""
    gateway = NoPriceGateway()
    with pytest.raises(billing.PriceNotFound):
        billing.start_checkout(
            repositories,
            repositories.workspaces.get(workspace),
            gateway,
            plan=billing.Plan.STANDARD,
            interval=billing.BillingInterval.YEAR,
            email=None,
        )
    assert gateway.checkouts == []


def test_checkout_completion_upgrades_the_workspace(repositories: Any, workspace: str) -> None:
    """The completed session's subscription is mirrored onto the workspace."""
    gateway = FakeGateway({"sub_1": subscription()})
    handled, duplicate = billing.process_webhook_event(
        event("checkout.session.completed", {"subscription": "sub_1", "client_reference_id": workspace}),
        repositories,
        gateway,
        FakeStore(),
    )
    assert (handled, duplicate) == (True, False)
    ws = repositories.workspaces.get(workspace)
    assert ws.plan == "standard"
    assert ws.billing_interval == "year"
    assert ws.stripe_subscription_id == "sub_1"
    assert ws.stripe_customer_id == "cus_1"
    assert ws.billed_seats == 3


def test_a_duplicate_event_is_acknowledged_without_acting(repositories: Any, workspace: str) -> None:
    """The second delivery of one event id does nothing."""
    gateway = FakeGateway({"sub_1": subscription()})
    store = FakeStore()
    delivery = event("customer.subscription.updated", {"id": "sub_1"})
    assert billing.process_webhook_event(delivery, repositories, gateway, store) == (True, False)
    assert billing.process_webhook_event(delivery, repositories, gateway, store) == (False, True)


def test_a_failed_event_releases_its_claim(repositories: Any, workspace: str) -> None:
    """Stripe's retry can do the work a failed delivery could not."""
    gateway = FakeGateway({"sub_1": subscription()})
    gateway.fail = True
    store = FakeStore()
    delivery = event("customer.subscription.updated", {"id": "sub_1"})
    with pytest.raises(stripe.StripeError):
        billing.process_webhook_event(delivery, repositories, gateway, store)
    assert store.claims == set()


def test_an_unhandled_event_type_is_ignored(repositories: Any, workspace: str) -> None:
    """Events outside the handled set are neither claimed nor applied."""
    store = FakeStore()
    assert billing.process_webhook_event(event("charge.refunded", {}), repositories, FakeGateway(), store) == (
        False,
        False,
    )
    assert store.claims == set()


def test_a_past_due_update_drops_the_workspace_to_free(repositories: Any, workspace: str) -> None:
    """A lapse in payment is free at once."""
    gateway = FakeGateway({"sub_1": subscription()})
    billing.apply_event("customer.subscription.created", {"id": "sub_1"}, repositories, gateway)
    gateway.subscriptions["sub_1"] = subscription(status="past_due")
    billing.apply_event("invoice.payment_failed", {"subscription": "sub_1"}, repositories, gateway)
    ws = repositories.workspaces.get(workspace)
    assert ws.plan == "free"
    assert ws.subscription_status == "past_due"


def test_a_stale_subscription_never_downgrades_a_newer_one(repositories: Any, workspace: str) -> None:
    """An event for an old cancelled subscription leaves the current one alone."""
    gateway = FakeGateway({"sub_new": subscription("sub_new"), "sub_old": subscription("sub_old", status="canceled")})
    billing.apply_event("customer.subscription.created", {"id": "sub_new"}, repositories, gateway)
    assert billing.apply_event("customer.subscription.deleted", {"id": "sub_old"}, repositories, gateway) is False
    ws = repositories.workspaces.get(workspace)
    assert ws.plan == "standard"
    assert ws.stripe_subscription_id == "sub_new"


def test_an_invoice_in_the_new_api_shape_finds_its_subscription(repositories: Any, workspace: str) -> None:
    """Newer API versions nest the subscription under the invoice's parent."""
    gateway = FakeGateway({"sub_1": subscription(status="unpaid")})
    obj = {"parent": {"subscription_details": {"subscription": "sub_1"}}}
    assert billing.apply_event("invoice.payment_failed", obj, repositories, gateway) is True


def test_a_subscription_naming_no_workspace_is_ignored(repositories: Any) -> None:
    """Nothing is written when the metadata names an unknown workspace."""
    gateway = FakeGateway({"sub_1": subscription(workspace_id="01JB0000000000000000NOPE00")})
    assert billing.apply_event("customer.subscription.updated", {"id": "sub_1"}, repositories, gateway) is False


def _make_paid(repositories: Any, workspace_id: str, seats: int) -> None:
    """Put the workspace on a live Standard subscription billed for `seats`."""
    repositories.workspaces.set_billing(
        workspace_id,
        plan="standard",
        stripe_subscription_id="sub_1",
        subscription_status="active",
        billed_seats=seats,
    )


def test_seat_sync_is_inert_while_billing_is_off(repositories: Any, workspace: str) -> None:
    """No Stripe call and no write with the flag off."""
    _make_paid(repositories, workspace, 1)
    gateway = FakeGateway({"sub_1": subscription()})
    assert billing.sync_seats(repositories, workspace, gateway) is False
    assert gateway.quantities == []


def test_seat_sync_updates_the_quantity(repositories: Any, workspace: str, enabled: None) -> None:
    """A differing seat count is pushed to Stripe and recorded."""
    _make_paid(repositories, workspace, 1)
    gateway = FakeGateway({"sub_1": subscription()})
    assert billing.sync_seats(repositories, workspace, gateway) is True
    assert gateway.quantities == [("sub_1", "si_1", 3)]
    assert repositories.workspaces.get(workspace).billed_seats == 3


def test_seat_sync_skips_a_matching_count(repositories: Any, workspace: str, enabled: None) -> None:
    """Nothing is sent when the billed quantity is already right."""
    _make_paid(repositories, workspace, 3)
    gateway = FakeGateway({"sub_1": subscription()})
    assert billing.sync_seats(repositories, workspace, gateway) is False
    assert gateway.quantities == []


def test_seat_sync_skips_a_free_workspace(repositories: Any, workspace: str, enabled: None) -> None:
    """A free workspace has nothing to bill."""
    gateway = FakeGateway()
    assert billing.sync_seats(repositories, workspace, gateway) is False


def test_seat_sync_survives_a_stripe_failure(repositories: Any, workspace: str, enabled: None) -> None:
    """A Stripe outage is logged and never raised into the membership change."""
    _make_paid(repositories, workspace, 1)
    gateway = FakeGateway({"sub_1": subscription()})
    gateway.fail = True
    assert billing.sync_seats(repositories, workspace, gateway) is False
    assert repositories.workspaces.get(workspace).billed_seats == 1


def test_seat_sync_survives_missing_stripe_configuration(
    repositories: Any, workspace: str, enabled: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without Stripe keys the sync gives up quietly."""
    _make_paid(repositories, workspace, 1)
    monkeypatch.delenv("STRIPE_API_KEY", raising=False)
    monkeypatch.setattr(settings, "APP_SECRETS_ARN", "")
    assert billing.sync_seats(repositories, workspace) is False
