"""Request and response schemas for a member's away status, and the rule that ends it.

Kept apart from the context-aware helpers in `app.common.member_status` so every
member schema can carry the status without importing authorization.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.memberships import StoredUserStatus

STATUS_TEXT_MAX = 80

STATUS_EMOJI_MAX = 32


class UserStatusRead(BaseModel):
    """A member's current status, as every read surface answers it.

    `until` is when it clears itself, or null for a status that stays until it is
    changed. `away` marks someone who should not be expected to answer soon.
    """

    emoji: str
    text: str
    away: bool
    until: Optional[datetime] = None
    set_at: datetime


class UserStatusUpdate(BaseModel):
    """The body `PUT /api/workspaces/{workspace_id}/members/me/status` takes.

    At least one of `emoji` and `text` must be set, and `until`, when given, must be
    in the future. A timestamp without a zone is read as UTC.
    """

    emoji: str = Field(default="", max_length=STATUS_EMOJI_MAX)
    text: str = Field(default="", max_length=STATUS_TEXT_MAX)
    away: bool = False
    until: Optional[datetime] = None

    @field_validator("emoji", "text")
    @classmethod
    def _trimmed(cls, value: str) -> str:
        """Trim surrounding whitespace."""
        return value.strip()

    @field_validator("until")
    @classmethod
    def _aware(cls, value: Optional[datetime]) -> Optional[datetime]:
        """Read a naive timestamp as UTC."""
        return _aware(value) if value is not None else None

    @model_validator(mode="after")
    def _meaningful(self) -> "UserStatusUpdate":
        """Refuse an empty status and an end already past."""
        if not self.emoji and not self.text:
            raise ValueError("A status needs an emoji or some text")
        if self.until is not None and self.until <= utc_now():
            raise ValueError("A status must end in the future")
        return self

    def stored(self) -> StoredUserStatus:
        """The stored form of this update, stamped now."""
        return StoredUserStatus(emoji=self.emoji, text=self.text, away=self.away, until=self.until)


def current_status(stored: Optional[StoredUserStatus], now: Optional[datetime] = None) -> Optional[UserStatusRead]:
    """The status still in force, or `None` when there is none or its end has passed."""
    if stored is None:
        return None
    moment = now or utc_now()
    if stored.until is not None and _aware(stored.until) <= moment:
        return None
    return UserStatusRead(
        emoji=stored.emoji,
        text=stored.text,
        away=stored.away,
        until=stored.until,
        set_at=stored.set_at,
    )


def _aware(value: datetime) -> datetime:
    """A timestamp with a zone, reading a naive one as UTC."""
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
