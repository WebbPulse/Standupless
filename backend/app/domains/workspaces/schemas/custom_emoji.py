"""Request and response shapes for a workspace's custom emoji."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.common.account_deletion import DELETED_USER_NAME
from app.common.api.schemas.workspaces import display_name_for
from app.common.custom_emoji import check_name
from app.common.db.dynamo.custom_emoji import CustomEmoji
from app.common.db.dynamo.users import User
from app.common.icons import icon_url


class CustomEmojiCreate(BaseModel):
    """The body that adds a custom emoji: its name and the upload holding its image."""

    name: str = Field(min_length=1, max_length=64)
    upload_id: str = Field(min_length=1, max_length=64)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Hold the name to the shortcode rules and off the built-in shortcodes."""
        return check_name(value)


class CustomEmojiRead(BaseModel):
    """One custom emoji as the picker and the settings page render it."""

    name: str
    shortcode: str
    url: str
    created_by: str
    created_by_name: str
    created_at: datetime

    @classmethod
    def from_row(cls, row: CustomEmoji, uploader: Optional[User]) -> "CustomEmojiRead":
        """Build the read model from a row and the person who uploaded it."""
        return cls(
            name=row.name,
            shortcode=f":{row.name}:",
            url=icon_url(row.image_key) or "",
            created_by=row.created_by,
            created_by_name=display_name_for(uploader) if uploader is not None else DELETED_USER_NAME,
            created_at=row.created_at,
        )


class CustomEmojiListRead(BaseModel):
    """Every custom emoji of a workspace, by name."""

    emoji: list[CustomEmojiRead]
