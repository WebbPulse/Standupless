"""Request and response bodies for the statuses and tiers a workspace sets up for its customers.

A status says where a customer stands and a tier how big an account it is. Both
are workspace lists of named, coloured, ordered entries that a workspace admin
edits in settings, and a customer points at one of each by id.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.common.api.schemas.project_labels import _check_color, _check_name
from app.common.db.dynamo.customers import CustomerFieldRow

CUSTOMER_FIELD_NAME_MAX = 40


class CustomerFieldCreate(BaseModel):
    """The body a customer status or tier create takes; it lands last unless a position is given."""

    name: str = Field(min_length=1, max_length=CUSTOMER_FIELD_NAME_MAX)
    color: Optional[str] = None
    position: Optional[int] = Field(default=None, ge=0)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Trim the name and refuse a blank one."""
        return _check_name(value) or ""

    @field_validator("color")
    @classmethod
    def check_color(cls, value: Optional[str]) -> Optional[str]:
        """Hold the colour to `#rrggbb` when one is given."""
        return _check_color(value)


class CustomerFieldUpdate(BaseModel):
    """The body a customer status or tier patch takes; an omitted field is kept and a null colour clears it."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=CUSTOMER_FIELD_NAME_MAX)
    color: Optional[str] = None
    position: Optional[int] = Field(default=None, ge=0)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: Optional[str]) -> Optional[str]:
        """Trim the name and refuse a blank one."""
        return _check_name(value)

    @field_validator("color")
    @classmethod
    def check_color(cls, value: Optional[str]) -> Optional[str]:
        """Hold the colour to `#rrggbb` when one is being set."""
        return _check_color(value)


class CustomerFieldRead(BaseModel):
    """One customer status or tier as the API returns it, with how many customers hold it."""

    id: str
    name: str
    color: Optional[str] = Field(default=None, description="A `#rrggbb` colour, or null for a neutral dot")
    position: int
    customer_count: int = Field(default=0, description="Customers that hold this status or tier")
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row: CustomerFieldRow, *, customer_count: int = 0) -> "CustomerFieldRead":
        """Build the response shape from a stored or seeded row."""
        return cls(
            id=row.field_id,
            name=row.name,
            color=row.color,
            position=row.position,
            customer_count=customer_count,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class CustomerStatusListRead(BaseModel):
    """The workspace's customer statuses by position."""

    statuses: list[CustomerFieldRead]


class CustomerTierListRead(BaseModel):
    """The workspace's customer tiers by position."""

    tiers: list[CustomerFieldRead]
