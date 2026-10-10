"""The Stripe billing service: status mapping, event handling, stale subscriptions, seat sync and purge."""

from __future__ import annotations

from typing import Any

import pytest
import stripe
from webbpulse.integrations.stripe import StripeEvent
from webbpulse.testing import FakeIdempotencyStore, FakeStripeGateway

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


PRICES = {lookup_key: f"price_{lookup_key}" for lookup_key in billing.LOOKUP_KEYS}
"""Every catalog lookup key, priced."""


def fake_gateway(subscriptions: dict[str, dict[str, Any]] | None = None, **kwargs: Any) -> FakeStripeGateway:
    """The shared in-memory Stripe with every plan priced and the given subscriptions seeded."""
    gateway = FakeStripeGateway(prices=PRICES, **kwargs)
    gateway.subscriptions.update(subscriptions or {})
    return gateway


def failing(gateway: FakeStripeGateway, monkeypatch: pytest.MonkeyPatch) -> FakeStripeGateway:
    """Make the gateway's subscription reads fail as a Stripe outage would."""

    def down(subscription_id: str) -> dict[str, Any]:
        """Raise a connection error."""
        raise stripe.APIConnectionError("down")

    monkeypatch.setattr(gateway, "retrieve_subscription", down)
    return gateway


def recorded_quantities(gateway: FakeStripeGateway, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, int]]:
    """Record every `set_quantity` call the gateway receives, passing each through."""
    calls: list[tuple[str, str, int]] = []
    original = gateway.set_quantity

    def spy(subscription_id: str, item_id: str, quantity: int) -> dict[str, Any]:
        """Note the call, then apply it."""
        calls.append((subscription_id, item_id, quantity))
        return original(subscription_id, item_id, quantity)

    monkeypatch.setattr(gateway, "set_quantity", spy)
    return calls


def event(event_type: str, obj: dict[str, Any], event_id: str = "evt_1") -> StripeEvent:
    """A verified event, as the gateway's `verify_webhook` answers it."""
    return StripeEvent.from_payload({"id": event_id, "type": event_type, "data": {"object": obj}})


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
    gateway = fake_gateway()
    ws = repositories.workspaces.get(workspace)
    url = billing.start_checkout(
        repositories, ws, gateway, plan=billing.Plan.STANDARD, interval=billing.BillingInterval.YEAR, email=None
    )
    assert url.startswith("https://checkout.stripe.test")
    checkout = gateway.checkout_sessions[0]
    assert checkout["quantity"] == 3
    assert checkout["price"] == "price_standard_annual"
    assert checkout["client_reference_id"] == workspace
    assert checkout["metadata"] == {"workspace_id": workspace, "plan": "standard"}
    customer_id = repositories.workspaces.get(workspace).stripe_customer_id
    assert customer_id == checkout["customer"]
    assert gateway.customers[customer_id]["metadata"] == {"workspace_id": workspace}
    assert gateway.customers[customer_id]["name"] == ws.name

    billing.start_checkout(
        repositories,
        repositories.workspaces.get(workspace),
        gateway,
        plan=billing.Plan.STANDARD,
        interval=billing.BillingInterval.MONTH,
        email=None,
    )
    assert gateway.customer_creates == 1
    assert gateway.checkout_sessions[1]["customer"] == customer_id


def test_checkout_finds_an_unstored_customer_instead_of_creating_another(repositories: Any, workspace: str) -> None:
    """A customer tagged with the workspace but never stored is found again, not duplicated."""
    gateway = fake_gateway()
    existing = gateway.ensure_customer(owner_key="workspace_id", owner_id=workspace)
    billing.start_checkout(
        repositories,
        repositories.workspaces.get(workspace),
        gateway,
        plan=billing.Plan.STANDARD,
        interval=billing.BillingInterval.YEAR,
        email=None,
    )
    assert gateway.customer_creates == 1
    assert repositories.workspaces.get(workspace).stripe_customer_id == existing


def test_checkout_without_a_price_raises(repositories: Any, workspace: str) -> None:
    """A missing price is its own error, never a Stripe call."""
    gateway = FakeStripeGateway()
    with pytest.raises(billing.PriceNotFound):
        billing.start_checkout(
            repositories,
            repositories.workspaces.get(workspace),
            gateway,
            plan=billing.Plan.STANDARD,
            interval=billing.BillingInterval.YEAR,
            email=None,
        )
    assert gateway.checkout_sessions == []
    assert gateway.customer_creates == 0


def test_checkout_completion_upgrades_the_workspace(repositories: Any, workspace: str) -> None:
    """The completed session's subscription is mirrored onto the workspace."""
    gateway = fake_gateway({"sub_1": subscription()})
    handled, duplicate = billing.process_webhook_event(
        event("checkout.session.completed", {"subscription": "sub_1", "client_reference_id": workspace}),
        repositories,
        gateway,
        FakeIdempotencyStore(),
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
    gateway = fake_gateway({"sub_1": subscription()})
    store = FakeIdempotencyStore()
    delivery = event("customer.subscription.updated", {"id": "sub_1"})
    assert billing.process_webhook_event(delivery, repositories, gateway, store) == (True, False)
    assert billing.process_webhook_event(delivery, repositories, gateway, store) == (False, True)


def test_a_failed_event_releases_its_claim(repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Stripe's retry can do the work a failed delivery could not."""
    gateway = failing(fake_gateway({"sub_1": subscription()}), monkeypatch)
    store = FakeIdempotencyStore()
    delivery = event("customer.subscription.updated", {"id": "sub_1"})
    with pytest.raises(stripe.StripeError):
        billing.process_webhook_event(delivery, repositories, gateway, store)
    assert store.claim("stripe:event:evt_1", 60) is True


def test_an_unhandled_event_type_is_ignored(repositories: Any, workspace: str) -> None:
    """Events outside the handled set are neither claimed nor applied."""
    store = FakeIdempotencyStore()
    assert billing.process_webhook_event(event("charge.refunded", {}), repositories, fake_gateway(), store) == (
        False,
        False,
    )
    assert store.claims == []


def test_a_past_due_update_drops_the_workspace_to_free(repositories: Any, workspace: str) -> None:
    """A lapse in payment is free at once."""
    gateway = fake_gateway({"sub_1": subscription()})
    billing.apply_event(event("customer.subscription.created", {"id": "sub_1"}), repositories, gateway)
    gateway.subscriptions["sub_1"] = subscription(status="past_due")
    billing.apply_event(event("invoice.payment_failed", {"subscription": "sub_1"}), repositories, gateway)
    ws = repositories.workspaces.get(workspace)
    assert ws.plan == "free"
    assert ws.subscription_status == "past_due"


def test_a_stale_subscription_never_downgrades_a_newer_one(repositories: Any, workspace: str) -> None:
    """An event for an old cancelled subscription leaves the current one alone."""
    gateway = fake_gateway({"sub_new": subscription("sub_new"), "sub_old": subscription("sub_old", status="canceled")})
    billing.apply_event(event("customer.subscription.created", {"id": "sub_new"}), repositories, gateway)
    stale = event("customer.subscription.deleted", {"id": "sub_old"})
    assert billing.apply_event(stale, repositories, gateway) is False
    ws = repositories.workspaces.get(workspace)
    assert ws.plan == "standard"
    assert ws.stripe_subscription_id == "sub_new"


def test_an_invoice_in_the_new_api_shape_finds_its_subscription(repositories: Any, workspace: str) -> None:
    """Newer API versions nest the subscription under the invoice's parent."""
    gateway = fake_gateway({"sub_1": subscription(status="unpaid")})
    obj = {"parent": {"subscription_details": {"subscription": "sub_1"}}}
    assert billing.apply_event(event("invoice.payment_failed", obj), repositories, gateway) is True


def test_a_subscription_naming_no_workspace_is_ignored(repositories: Any) -> None:
    """Nothing is written when the metadata names an unknown workspace."""
    gateway = fake_gateway({"sub_1": subscription(workspace_id="01JB0000000000000000NOPE00")})
    assert billing.apply_event(event("customer.subscription.updated", {"id": "sub_1"}), repositories, gateway) is False


def _make_paid(repositories: Any, workspace_id: str, seats: int) -> None:
    """Put the workspace on a live Standard subscription billed for `seats`."""
    repositories.workspaces.set_billing(
        workspace_id,
        plan="standard",
        stripe_subscription_id="sub_1",
        subscription_status="active",
        billed_seats=seats,
    )


def test_seat_sync_is_inert_while_billing_is_off(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No Stripe call and no write with the flag off."""
    _make_paid(repositories, workspace, 1)
    gateway = fake_gateway({"sub_1": subscription()})
    quantities = recorded_quantities(gateway, monkeypatch)
    assert billing.sync_seats(repositories, workspace, gateway) is False
    assert quantities == []


def test_seat_sync_updates_the_quantity(
    repositories: Any, workspace: str, enabled: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A differing seat count is pushed to Stripe and recorded."""
    _make_paid(repositories, workspace, 1)
    gateway = fake_gateway({"sub_1": subscription(quantity=1)})
    quantities = recorded_quantities(gateway, monkeypatch)
    assert billing.sync_seats(repositories, workspace, gateway) is True
    assert quantities == [("sub_1", "si_1", 3)]
    assert gateway.subscriptions["sub_1"]["items"]["data"][0]["quantity"] == 3
    assert repositories.workspaces.get(workspace).billed_seats == 3


def test_seat_sync_skips_a_matching_count(
    repositories: Any, workspace: str, enabled: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nothing is sent when the billed quantity is already right."""
    _make_paid(repositories, workspace, 3)
    gateway = fake_gateway({"sub_1": subscription()})
    quantities = recorded_quantities(gateway, monkeypatch)
    assert billing.sync_seats(repositories, workspace, gateway) is False
    assert quantities == []


def test_seat_sync_skips_a_free_workspace(repositories: Any, workspace: str, enabled: None) -> None:
    """A free workspace has nothing to bill."""
    gateway = fake_gateway()
    assert billing.sync_seats(repositories, workspace, gateway) is False


def test_seat_sync_survives_a_stripe_failure(
    repositories: Any, workspace: str, enabled: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A Stripe outage is logged and never raised into the membership change."""
    _make_paid(repositories, workspace, 1)
    gateway = failing(fake_gateway({"sub_1": subscription()}), monkeypatch)
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


def test_a_purged_workspace_cancels_its_live_subscriptions(repositories: Any, workspace: str, enabled: None) -> None:
    """Every live subscription of every customer tagged with the workspace is cancelled, once."""
    gateway = fake_gateway()
    customer_id = gateway.ensure_customer(owner_key="workspace_id", owner_id=workspace)
    live = gateway.add_subscription(customer_id, lookup_key="standard_annual")
    gateway.add_subscription(customer_id, status="canceled")
    other = gateway.ensure_customer(owner_key="workspace_id", owner_id="01JB0000000000000000OTHER0")
    untouched = gateway.add_subscription(other)
    assert billing.cancel_workspace_subscriptions(workspace, gateway) == [live["id"]]
    assert gateway.subscriptions[live["id"]]["status"] == "canceled"
    assert gateway.subscriptions[untouched["id"]]["status"] == "active"
    assert billing.cancel_workspace_subscriptions(workspace, gateway) == []


def test_a_purge_cancels_nothing_while_billing_is_off(repositories: Any, workspace: str) -> None:
    """With the flag off the purge makes no Stripe call."""
    gateway = fake_gateway()
    customer_id = gateway.ensure_customer(owner_key="workspace_id", owner_id=workspace)
    live = gateway.add_subscription(customer_id)
    assert billing.cancel_workspace_subscriptions(workspace, gateway) == []
    assert gateway.subscriptions[live["id"]]["status"] == "active"
