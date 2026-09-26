"""Request and response schemas for an issue's subscribers."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class SubscriberRead(BaseModel):
    """One person following the issue, named so the rail needs no second read."""

    user_id: str
    display_name: str
    reason: str
    created_at: datetime


class SubscribersRead(BaseModel):
    """Everyone following the issue, and whether the caller is one of them."""

    subscribers: list[SubscriberRead]
    subscribed: bool
