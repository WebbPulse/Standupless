"""Request and response schemas for customers and the requests they make for issues and projects.

Held in `common` because the planning routes and the MCP tools in the integrations
image both take and answer them.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator
from webbpulse.http import cursor_page

from app.common.change_source import ChangeSource

NAME_MAX = 200

TIER_MAX = 40

DOMAINS_MAX = 20

QUOTE_MAX = 5000
"""The longest quote one request keeps, in characters."""

AMOUNT_MAX = 10**15
"""The largest revenue or size a customer takes, far above any real company."""

CustomerTargetKind = Literal["issue", "project"]

CustomerStatusField = Literal["lead", "trial", "active", "paused", "churned"]
"""Where a customer stands: a lead, on a trial, active, paused or churned."""

DOMAIN_PATTERN = re.compile(r"^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
"""A bare host name such as `acme.com`, lowercase, without a scheme, port or path."""


def _check_name(value: Optional[str]) -> Optional[str]:
    """Hold a name to non-blank text under the cap, trimmed."""
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        raise ValueError("name must not be blank")
    if len(trimmed) > NAME_MAX:
        raise ValueError(f"name must be at most {NAME_MAX} characters")
    return trimmed


def normalize_domain(value: str) -> str:
    """One domain as stored: lowercase, with any scheme, `www.`, path and trailing dot dropped."""
    text = value.strip().lower()
    for scheme in ("https://", "http://"):
        if text.startswith(scheme):
            text = text[len(scheme) :]
    text = text.split("/", 1)[0].split(":", 1)[0].rstrip(".")
    if text.startswith("www."):
        text = text[4:]
    return text


def _check_domains(value: Optional[list[str]]) -> Optional[list[str]]:
    """Hold domains to distinct, well formed host names under the cap, in the order given."""
    if value is None:
        return None
    seen: dict[str, None] = {}
    for raw in value:
        domain = normalize_domain(raw)
        if not domain:
            continue
        if not DOMAIN_PATTERN.match(domain):
            raise ValueError(f"{raw!r} is not a domain such as acme.com")
        seen[domain] = None
    if len(seen) > DOMAINS_MAX:
        raise ValueError(f"a customer takes at most {DOMAINS_MAX} domains")
    return list(seen)


def _check_tier(value: Optional[str]) -> Optional[str]:
    """Hold a tier to short text, trimmed; blank clears it."""
    if value is None:
        return None
    trimmed = value.strip()
    if len(trimmed) > TIER_MAX:
        raise ValueError(f"tier must be at most {TIER_MAX} characters")
    return trimmed or None


def _check_quote(value: Optional[str]) -> Optional[str]:
    """Hold a quote under the cap, trimmed; a request without one is allowed."""
    if value is None:
        return None
    trimmed = value.strip()
    if len(trimmed) > QUOTE_MAX:
        raise ValueError(f"body must be at most {QUOTE_MAX} characters")
    return trimmed


class CustomerCreate(BaseModel):
    """The body a customer create takes; only the name is required."""

    name: str
    domains: list[str] = Field(default_factory=list)
    status: Optional[CustomerStatusField] = None
    tier: Optional[str] = None
    owner_id: Optional[str] = None
    revenue: Optional[int] = Field(default=None, ge=0, le=AMOUNT_MAX)
    size: Optional[int] = Field(default=None, ge=0, le=AMOUNT_MAX)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Hold the name to non-blank text under the cap."""
        return _check_name(value) or value

    @field_validator("domains")
    @classmethod
    def check_domains(cls, value: list[str]) -> list[str]:
        """Hold the domains to distinct host names."""
        return _check_domains(value) or []

    @field_validator("tier")
    @classmethod
    def check_tier(cls, value: Optional[str]) -> Optional[str]:
        """Hold the tier to short text."""
        return _check_tier(value)


class CustomerPatch(BaseModel):
    """The body a customer patch takes; a field left out is kept, and `null` clears any but the name."""

    name: Optional[str] = None
    domains: Optional[list[str]] = None
    status: Optional[CustomerStatusField] = None
    tier: Optional[str] = None
    owner_id: Optional[str] = None
    revenue: Optional[int] = Field(default=None, ge=0, le=AMOUNT_MAX)
    size: Optional[int] = Field(default=None, ge=0, le=AMOUNT_MAX)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: Optional[str]) -> Optional[str]:
        """Hold the name to non-blank text under the cap."""
        if value is None:
            raise ValueError("name must not be null")
        return _check_name(value)

    @field_validator("domains")
    @classmethod
    def check_domains(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Hold the domains to distinct host names; `null` clears them."""
        return _check_domains(value) if value is not None else []

    @field_validator("tier")
    @classmethod
    def check_tier(cls, value: Optional[str]) -> Optional[str]:
        """Hold the tier to short text."""
        return _check_tier(value)


class CustomerMerge(BaseModel):
    """The body a merge takes: the customer the one in the path folds into."""

    into_customer_id: str


class CustomerRead(BaseModel):
    """One customer with how many requests this caller can see from it.

    `can_edit` and `can_delete` say what this caller may do, so a client draws
    the controls without repeating the rules.
    """

    customer_id: str
    workspace_id: str
    name: str
    domains: list[str] = Field(default_factory=list)
    status: Optional[CustomerStatusField] = None
    tier: Optional[str] = None
    owner_id: Optional[str] = None
    revenue: Optional[int] = None
    size: Optional[int] = None
    created_by: str
    created_at: datetime
    updated_at: datetime
    request_count: int = 0
    important_count: int = 0
    can_edit: bool = False
    can_delete: bool = False


class CustomerRequestCreate(BaseModel):
    """The body a request create takes; the issue or project comes from the path."""

    customer_id: str
    body: str = ""
    important: bool = False

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        """Hold the quote under the cap."""
        return _check_quote(value) or ""


class CustomerRequestPatch(BaseModel):
    """The body a request patch takes; a field left out is kept.

    `customer_id` hands the request to another customer, and `target_kind` with
    `target_id` moves it to another issue or project; the two go together.
    """

    customer_id: Optional[str] = None
    body: Optional[str] = None
    important: Optional[bool] = None
    target_kind: Optional[CustomerTargetKind] = None
    target_id: Optional[str] = None

    @field_validator("body")
    @classmethod
    def check_body(cls, value: Optional[str]) -> str:
        """Hold the quote under the cap; `null` clears it."""
        return _check_quote(value) or ""


class CustomerRequestRead(BaseModel):
    """One request, with the names a list draws beside it.

    `target_key` is the issue key for an issue and empty for a project.
    """

    request_id: str
    workspace_id: str
    customer_id: str
    customer_name: str = ""
    target_kind: CustomerTargetKind
    target_id: str
    target_key: str = ""
    target_title: str = ""
    body: str = ""
    important: bool = False
    author_id: str
    source: Optional[ChangeSource] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    can_edit: bool = False
    can_delete: bool = False


CustomerListRead = cursor_page(CustomerRead, "customers", model_name="CustomerListRead")

CustomerRequestListRead = cursor_page(CustomerRequestRead, "requests", model_name="CustomerRequestListRead")
