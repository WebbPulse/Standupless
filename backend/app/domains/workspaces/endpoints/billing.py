"""Workspace billing routes: the plan read, Checkout, the Customer Portal and the Stripe webhook.

Buying and managing a subscription is an owner or admin act by a signed-in person,
never an API key, because it spends money. The webhook is the only route that
changes `plan`, and it verifies the Stripe signature over the raw body before
anything else, so an unsigned or forged delivery is a 400 on every stage, even
one where billing is off or Stripe is not configured.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

import stripe
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from webbpulse.integrations.stripe import (
    StripeNotConfigured,
    StripeSignatureError,
    verify_webhook_event,
)

from app.common import billing
from app.common.api.dependencies.authz import (
    AuthzContext,
    Capability,
    refuse_api_key_actor,
    require,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.workspaces import BillingInterval, Plan, Workspace
from app.common.plan_features import features_of
from app.common.plan_limits import PLAN_GUESTS_PER_SEAT, PLAN_STORAGE_BYTES, limits_of, plan_of
from app.domains.workspaces.schemas.billing import (
    BillingRead,
    BillingSessionRead,
    CheckoutCreate,
    StripeWebhookAck,
)

_log = logging.getLogger(__name__)

router = APIRouter()

webhook_router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

BILLING_DISABLED = {"error_code": "BILLING_DISABLED", "message": "Billing is not enabled"}

PLAN_UNAVAILABLE = {"error_code": "PLAN_UNAVAILABLE", "message": "That plan is not on sale yet"}

ALREADY_SUBSCRIBED = {
    "error_code": "ALREADY_SUBSCRIBED",
    "message": "This workspace already has a subscription; manage it from the billing portal",
}

NO_BILLING_ACCOUNT = {"error_code": "NO_BILLING_ACCOUNT", "message": "This workspace has no billing account yet"}

STRIPE_NOT_CONFIGURED = {"error_code": "STRIPE_NOT_CONFIGURED", "message": "Billing is not configured"}

STRIPE_PRICE_MISSING = {"error_code": "STRIPE_PRICE_MISSING", "message": "That plan has no price configured"}

STRIPE_ERROR = {"error_code": "STRIPE_ERROR", "message": "The payment provider could not complete the request"}

STRIPE_SIGNATURE_INVALID = {
    "error_code": "STRIPE_SIGNATURE_INVALID",
    "message": "The webhook signature did not verify",
}


def _workspace(repositories: Repositories, workspace_id: str) -> Workspace:
    """The workspace the authorized path names, or a 404."""
    workspace = repositories.workspaces.get(workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return workspace


def _require_billing() -> None:
    """Refuse a billing write on a stage where billing is off."""
    if not billing.billing_enabled():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=BILLING_DISABLED)


def _gateway(factory: billing.GatewayFactory) -> billing.BillingGateway:
    """A Stripe gateway for this stage, or a 503 when Stripe is not configured."""
    try:
        return factory(billing.load_billing_settings())
    except StripeNotConfigured:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=STRIPE_NOT_CONFIGURED) from None


def _stripe_failed(error: stripe.StripeError, workspace_id: str) -> HTTPException:
    """Log a Stripe API failure and turn it into a 502."""
    _log.warning(
        "A Stripe call failed.",
        extra={"workspace_id": workspace_id, "error": type(error).__name__},
    )
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=STRIPE_ERROR)


@router.get("/{workspace_id}/billing", response_model=BillingRead)
def read_billing(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> BillingRead:
    """The workspace's plan, subscription state, seat use and what the plan grants.

    Any member may read it, so the product can explain a limit to whoever hit it;
    the Stripe ids themselves never leave the server.
    """
    workspace = _workspace(repositories, context.workspace_id)
    plan = plan_of(workspace)
    return BillingRead(
        plan=plan,
        billing_interval=workspace.billing_interval,
        subscription_status=workspace.subscription_status,
        billed_seats=workspace.billed_seats,
        seats_in_use=billing.seat_count(repositories, workspace.id),
        current_period_end=workspace.current_period_end,
        cancel_at_period_end=workspace.cancel_at_period_end,
        has_billing_account=bool(workspace.stripe_customer_id),
        billing_enabled=billing.billing_enabled(),
        business_available=billing.business_available(),
        features=sorted(str(feature) for feature in features_of(workspace)),
        limits={str(resource): value for resource, value in limits_of(workspace).items()},
        storage_bytes=PLAN_STORAGE_BYTES[plan],
        guests_per_seat=PLAN_GUESTS_PER_SEAT[plan],
    )


@router.post(
    "/{workspace_id}/billing/checkout-session",
    response_model=BillingSessionRead,
    status_code=status.HTTP_201_CREATED,
)
def create_checkout_session(
    body: CheckoutCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    factory: Annotated[billing.GatewayFactory, Depends(billing.get_gateway_factory)],
) -> BillingSessionRead:
    """Start a per-seat Stripe Checkout for a paid plan and return its URL.

    A workspace that already holds a live subscription changes plan, interval or
    payment method in the portal instead, so two subscriptions never bill at once.
    """
    refuse_api_key_actor(context)
    _require_billing()
    plan = Plan(body.plan)
    if plan == Plan.BUSINESS and not billing.business_available():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PLAN_UNAVAILABLE)
    workspace = _workspace(repositories, context.workspace_id)
    if billing.is_paid(workspace):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ALREADY_SUBSCRIBED)
    gateway = _gateway(factory)
    user = repositories.users.get(context.user_id)
    try:
        url = billing.start_checkout(
            repositories,
            workspace,
            gateway,
            plan=plan,
            interval=BillingInterval(body.interval),
            email=user.email if user else None,
        )
    except billing.PriceNotFound:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=STRIPE_PRICE_MISSING) from None
    except stripe.StripeError as error:
        raise _stripe_failed(error, workspace.id) from None
    return BillingSessionRead(url=url)


@router.post(
    "/{workspace_id}/billing/portal-session",
    response_model=BillingSessionRead,
    status_code=status.HTTP_201_CREATED,
)
def create_portal_session(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    factory: Annotated[billing.GatewayFactory, Depends(billing.get_gateway_factory)],
) -> BillingSessionRead:
    """Open the Stripe Customer Portal for the workspace's billing account."""
    refuse_api_key_actor(context)
    _require_billing()
    workspace = _workspace(repositories, context.workspace_id)
    if not workspace.stripe_customer_id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=NO_BILLING_ACCOUNT)
    gateway = _gateway(factory)
    try:
        url = gateway.create_portal_session(
            customer_id=workspace.stripe_customer_id,
            return_url=billing.billing_page_url(workspace),
        )
    except stripe.StripeError as error:
        raise _stripe_failed(error, workspace.id) from None
    return BillingSessionRead(url=url)


def _handle_webhook(
    payload: bytes,
    signature: str,
    repositories: Repositories,
    factory: billing.GatewayFactory,
) -> StripeWebhookAck:
    """Verify, claim and apply one Stripe delivery, off the event loop."""
    if not billing.billing_enabled():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=BILLING_DISABLED)
    try:
        stripe_settings = billing.load_billing_settings()
        event = verify_webhook_event(payload, signature, stripe_settings)
    except StripeNotConfigured:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=STRIPE_NOT_CONFIGURED) from None
    except StripeSignatureError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=STRIPE_SIGNATURE_INVALID) from None
    gateway = factory(stripe_settings)
    try:
        handled, duplicate = billing.process_webhook_event(
            event, repositories, gateway, repositories.idempotency.event_store
        )
    except stripe.StripeError as error:
        _log.warning("A Stripe webhook could not be applied.", extra={"error": type(error).__name__})
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=STRIPE_ERROR) from None
    return StripeWebhookAck(handled=handled, duplicate=duplicate)


@webhook_router.post("/stripe/webhook", response_model=StripeWebhookAck)
async def stripe_webhook(
    request: Request,
    repositories: Annotated[Repositories, Depends(get_repositories)],
    factory: Annotated[billing.GatewayFactory, Depends(billing.get_gateway_factory)],
    stripe_signature: Annotated[str | None, Header(alias="Stripe-Signature")] = None,
) -> Any:
    """Receive one Stripe event, answering 400 to anything unsigned or forged.

    A missing signature is refused before the stage's billing state is consulted,
    so the refusal is the same everywhere and the e2e suite can prove it.
    """
    if not stripe_signature:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=STRIPE_SIGNATURE_INVALID)
    payload = await request.body()
    return await run_in_threadpool(_handle_webhook, payload, stripe_signature, repositories, factory)
