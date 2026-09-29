"""Request and response schemas for workspace billing: plan state, Checkout, the portal and webhooks."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

PaidPlanField = Literal["standard", "business"]

IntervalField = Literal["month", "year"]


class BillingRead(BaseModel):
    """A workspace's plan, subscription and the ceilings and features that plan grants."""

    plan: str
    billing_interval: Optional[str] = None
    subscription_status: Optional[str] = None
    billed_seats: Optional[int] = None
    seats_in_use: int
    current_period_end: Optional[datetime] = None
    cancel_at_period_end: bool = False
    has_billing_account: bool = False
    billing_enabled: bool
    business_available: bool
    features: list[str] = Field(default_factory=list)
    limits: dict[str, int] = Field(default_factory=dict)
    storage_bytes: int
    guests_per_seat: int


class CheckoutCreate(BaseModel):
    """The plan and billing interval a Checkout Session is started for."""

    plan: PaidPlanField = "standard"
    interval: IntervalField = "year"


class BillingSessionRead(BaseModel):
    """A hosted Stripe page the browser is sent to."""

    url: str


class StripeWebhookAck(BaseModel):
    """The acknowledgement returned to Stripe for a webhook delivery."""

    received: bool = True
    handled: bool
    duplicate: bool = False
