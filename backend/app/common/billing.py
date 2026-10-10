"""Stripe billing for workspaces: per-seat Checkout, the portal, webhook sync and seat sync.

A workspace buys one per-seat subscription. Its quantity is the workspace's seat
count, every member but guests, and `sync_seats` keeps Stripe's quantity in step
as people join, leave or change role. The webhook is the only writer of `plan`:
it retrieves the subscription an event names and mirrors its state onto the
workspace named in the subscription's metadata. Only `active` and `trialing`
count as paid, so `past_due`, `unpaid` and `incomplete` drop the workspace to
free at once.

Prices are found by lookup key, never by id, so the same code runs against the
sandbox and live accounts. Everything here is inert unless `BILLING_ENABLED` is on.
The Stripe calls go through `webbpulse.integrations.stripe.StripeGateway`, typed as
its `BillingGateway` protocol so tests pass `webbpulse.testing.FakeStripeGateway`.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any, Callable

import stripe
from webbpulse.integrations.stripe import (
    BillingGateway,
    EventClaimStore,
    StripeEvent,
    StripeGateway,
    StripeNotConfigured,
    StripeSettings,
    claim_webhook_event,
    event_claim_key,
    load_stripe_settings,
)

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.workspaces import BillingInterval, Plan, Workspace

_log = logging.getLogger(__name__)

PAID_STATUSES = frozenset({"active", "trialing"})
"""The Stripe subscription statuses that hold a paid plan. Anything else is free."""

SUBSCRIPTION_EVENTS = frozenset(
    {
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
    }
)

HANDLED_EVENTS = SUBSCRIPTION_EVENTS | {"checkout.session.completed", "invoice.payment_failed"}
"""Every event type the webhook acts on; the endpoint should subscribe to exactly these."""

OWNER_KEY = "workspace_id"
"""The Stripe metadata key naming the workspace a customer and its subscriptions belong to."""

PAID_PLANS = (Plan.STANDARD, Plan.BUSINESS)

INTERVAL_WORDS = {BillingInterval.MONTH: "monthly", BillingInterval.YEAR: "annual"}


def price_lookup_key(plan: Plan | str, interval: BillingInterval | str) -> str:
    """The Stripe price lookup key for a paid plan and interval, such as `standard_annual`."""
    return f"{Plan(plan).value}_{INTERVAL_WORDS[BillingInterval(interval)]}"


LOOKUP_KEYS: dict[str, tuple[Plan, BillingInterval]] = {
    price_lookup_key(plan, interval): (plan, interval) for plan in PAID_PLANS for interval in BillingInterval
}
"""Every lookup key the sandbox and live accounts must carry, mapped back to its plan."""


class PriceNotFound(Exception):
    """No active Stripe price carries the lookup key a plan needs."""


def billing_enabled() -> bool:
    """Whether workspaces can buy a paid plan on this stage."""
    return bool(settings.BILLING_ENABLED)


def business_available() -> bool:
    """Whether the Business plan is on sale yet."""
    return billing_enabled() and bool(settings.BILLING_BUSINESS_ENABLED)


def is_paid(workspace: Workspace) -> bool:
    """Whether the workspace holds a live paid subscription."""
    return workspace.plan != Plan.FREE and workspace.subscription_status in PAID_STATUSES


def load_billing_settings() -> StripeSettings:
    """The Stripe settings from the environment or the app secret.

    Raises StripeNotConfigured when the API key is missing or invalid.
    """
    return load_stripe_settings(settings.APP_SECRETS_ARN or None)


GatewayFactory = Callable[[StripeSettings], BillingGateway]


def get_gateway_factory() -> GatewayFactory:
    """The dependency building a Stripe gateway from settings, overridden in tests."""
    return StripeGateway


def seat_count(repositories: Repositories, workspace_id: str) -> int:
    """How many billable seats a workspace has: every member but guests, and at least one."""
    members = repositories.memberships.list_members(workspace_id, limit=5000)
    return max(1, sum(1 for member in members if member.role != "guest"))


def billing_page_url(workspace: Workspace) -> str:
    """The workspace's billing settings page, where Checkout and the portal return to."""
    return f"{settings.frontend_base_url}/w/{workspace.slug}/settings/billing"


def ensure_customer(
    repositories: Repositories, workspace: Workspace, gateway: BillingGateway, email: str | None
) -> str:
    """The workspace's one Stripe customer id, found or created at most once and stored when new.

    Concurrent checkouts for a workspace with no stored customer all answer the same
    customer, so the stored id never strands another customer's subscription.
    """
    customer_id = gateway.ensure_customer(
        owner_key=OWNER_KEY,
        owner_id=workspace.id,
        email=email,
        name=workspace.name,
        customer_id=workspace.stripe_customer_id,
    )
    if customer_id != workspace.stripe_customer_id:
        repositories.workspaces.set_billing(workspace.id, stripe_customer_id=customer_id)
    return customer_id


def start_checkout(
    repositories: Repositories,
    workspace: Workspace,
    gateway: BillingGateway,
    *,
    plan: Plan,
    interval: BillingInterval,
    email: str | None,
) -> str:
    """Create a Checkout Session for `plan` billed per seat, returning its URL.

    Raises PriceNotFound when no active price carries the plan's lookup key.
    """
    lookup_key = price_lookup_key(plan, interval)
    price_id = gateway.find_price_id(lookup_key)
    if price_id is None:
        raise PriceNotFound(lookup_key)
    customer_id = ensure_customer(repositories, workspace, gateway, email)
    page = billing_page_url(workspace)
    return gateway.create_checkout_session(
        customer_id=customer_id,
        price_id=price_id,
        reference_id=workspace.id,
        success_url=f"{page}?checkout=success",
        cancel_url=f"{page}?checkout=cancelled",
        quantity=seat_count(repositories, workspace.id),
        metadata={OWNER_KEY: workspace.id, "plan": plan.value},
    )


def _object_id(value: Any) -> str | None:
    """The id of a Stripe reference that may be an id string or an expanded object."""
    if isinstance(value, dict):
        return value.get("id")
    return value or None


def _first_item(subscription: dict[str, Any]) -> dict[str, Any]:
    """The subscription's one line item, or an empty dict."""
    items = (subscription.get("items") or {}).get("data") or []
    return items[0] if items else {}


def _period_end(subscription: dict[str, Any]) -> datetime | None:
    """When the current period ends, read from the items first and the subscription second."""
    ends = [
        item["current_period_end"]
        for item in (subscription.get("items") or {}).get("data") or []
        if item.get("current_period_end")
    ]
    if not ends and subscription.get("current_period_end"):
        ends = [subscription["current_period_end"]]
    return datetime.fromtimestamp(max(ends), UTC) if ends else None


def subscription_state(subscription: dict[str, Any]) -> dict[str, Any]:
    """The billing fields a Stripe subscription maps to on its workspace.

    The plan comes from the price's lookup key, so a price without a known key
    never grants a plan. A status outside `PAID_STATUSES` is free at once.
    """
    status = str(subscription.get("status") or "")
    item = _first_item(subscription)
    price = item.get("price") or {}
    known = LOOKUP_KEYS.get(str(price.get("lookup_key") or ""))
    paid = status in PAID_STATUSES and known is not None
    plan, interval = known if known else (Plan.FREE, None)
    return {
        "plan": plan.value if paid else Plan.FREE.value,
        "billing_interval": interval.value if paid and interval else None,
        "stripe_subscription_id": subscription.get("id"),
        "subscription_status": status or None,
        "billed_seats": item.get("quantity"),
        "current_period_end": _period_end(subscription),
        "cancel_at_period_end": bool(subscription.get("cancel_at_period_end")),
    }


def _sync_subscription(
    repositories: Repositories,
    gateway: BillingGateway,
    subscription_id: str,
    workspace_ref: str | None = None,
) -> bool:
    """Fetch a subscription and mirror it onto the workspace it belongs to.

    A subscription other than the one the workspace holds is applied only when it
    is paid, so an event about an old, cancelled subscription never downgrades a
    workspace that has since bought a new one.
    """
    subscription = gateway.retrieve_subscription(subscription_id)
    workspace_id = (subscription.get("metadata") or {}).get(OWNER_KEY) or workspace_ref
    workspace = repositories.workspaces.get(workspace_id) if workspace_id else None
    if workspace is None:
        _log.warning("A Stripe subscription matches no workspace.", extra={"subscription_id": subscription_id})
        return False
    changes = subscription_state(subscription)
    held = workspace.stripe_subscription_id
    if held and held != subscription_id and changes["subscription_status"] not in PAID_STATUSES:
        _log.info(
            "Ignored an event for a subscription the workspace no longer holds.",
            extra={"workspace_id": workspace.id, "subscription_id": subscription_id},
        )
        return False
    customer_id = _object_id(subscription.get("customer"))
    if customer_id and customer_id != workspace.stripe_customer_id:
        changes["stripe_customer_id"] = customer_id
    repositories.workspaces.set_billing(workspace.id, **changes)
    if changes["plan"] != workspace.plan:
        from app.common import audit

        audit.record_system(
            repositories,
            workspace.id,
            "plan.changed",
            actor_id="stripe",
            target_type="workspace",
            target_id=workspace.id,
            target_label=workspace.name,
            before={"plan": workspace.plan},
            after={"plan": changes["plan"], "status": changes["subscription_status"]},
        )
    _log.info(
        "Synced a Stripe subscription onto a workspace.",
        extra={
            "event": "billing.subscription.synced",
            "workspace_id": workspace.id,
            "subscription_id": subscription_id,
            "plan": changes["plan"],
            "status": changes["subscription_status"],
        },
    )
    return True


def apply_event(event: StripeEvent, repositories: Repositories, gateway: BillingGateway) -> bool:
    """Apply one verified Stripe event, answering whether it changed a workspace."""
    if event.type == "checkout.session.completed":
        subscription_id = event.subscription_id
        if not subscription_id:
            return False
        return _sync_subscription(repositories, gateway, subscription_id, event.reference_id)
    if event.type in SUBSCRIPTION_EVENTS:
        return _sync_subscription(repositories, gateway, event.data_object["id"])
    if event.type == "invoice.payment_failed":
        subscription_id = event.subscription_id
        if not subscription_id:
            return False
        return _sync_subscription(repositories, gateway, subscription_id)
    return False


def process_webhook_event(
    event: StripeEvent,
    repositories: Repositories,
    gateway: BillingGateway,
    store: EventClaimStore,
) -> tuple[bool, bool]:
    """Claim and apply a verified event, answering (handled, duplicate).

    A failure while applying releases the claim so Stripe's retry can do the work.
    """
    if event.type not in HANDLED_EVENTS:
        return False, False
    if not claim_webhook_event(event, store):
        return False, True
    try:
        apply_event(event, repositories, gateway)
    except Exception:
        release = getattr(store, "release", None)
        if callable(release):
            release(event_claim_key(event.id))
        raise
    return True, False


def _build_gateway() -> BillingGateway:
    """A gateway from the stage's Stripe settings, for callers outside a request's dependencies."""
    return get_gateway_factory()(load_billing_settings())


def sync_seats(repositories: Repositories, workspace_id: str, gateway: BillingGateway | None = None) -> bool:
    """Bring a paid subscription's quantity in step with the seat count, answering whether it changed.

    Best effort: a Stripe failure is logged and never fails the membership change
    that triggered it, and the next change or webhook reconciles again. A free
    workspace, or any stage with billing off, makes no Stripe call at all.
    """
    if not billing_enabled():
        return False
    workspace = repositories.workspaces.get(workspace_id)
    if workspace is None or not is_paid(workspace) or not workspace.stripe_subscription_id:
        return False
    seats = seat_count(repositories, workspace_id)
    if seats == workspace.billed_seats:
        return False
    try:
        stripe_gateway = gateway or _build_gateway()
        subscription = stripe_gateway.retrieve_subscription(workspace.stripe_subscription_id)
        item_id = _first_item(subscription).get("id")
        if not item_id:
            return False
        stripe_gateway.set_quantity(workspace.stripe_subscription_id, item_id, seats)
    except (stripe.StripeError, StripeNotConfigured) as error:
        _log.warning(
            "Could not sync the seat count to Stripe.",
            extra={"workspace_id": workspace_id, "seats": seats, "error": type(error).__name__},
        )
        return False
    repositories.workspaces.set_billing(workspace_id, billed_seats=seats)
    _log.info(
        "Synced the seat count to Stripe.",
        extra={"event": "billing.seats.synced", "workspace_id": workspace_id, "seats": seats},
    )
    return True


def cancel_workspace_subscriptions(workspace_id: str, gateway: BillingGateway | None = None) -> list[str]:
    """Cancel every live subscription of every Stripe customer the workspace holds, for its purge.

    Found by the customers' `workspace_id` metadata, so it needs no stored id and covers
    duplicate customers too. Inert with billing off. A Stripe failure or a missing
    configuration raises, so the purge message fails and the queue retries it.
    """
    if not billing_enabled():
        return []
    stripe_gateway = gateway or _build_gateway()
    cancelled = stripe_gateway.cancel_owner_subscriptions(OWNER_KEY, workspace_id)
    if cancelled:
        _log.info(
            "Cancelled a purged workspace's Stripe subscriptions.",
            extra={
                "event": "billing.subscriptions.cancelled",
                "workspace_id": workspace_id,
                "subscriptions": len(cancelled),
            },
        )
    return cancelled
