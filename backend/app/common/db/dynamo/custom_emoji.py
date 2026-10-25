"""Custom emoji rows in the `planning` table: the images a workspace adds to the emoji picker.

One row per emoji, at `emoji#<name>` in the workspace partition, so the name is
the key: uniqueness is a conditional put, and the workspace's set is one query
under `emoji#`. The image itself is an icon object in the attachments bucket,
and the row carries only its key. The `custom_emoji` kind passes none of the
planning stream filters, so no consumer reads these rows.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import build_repository, utc_now
from app.common.db.dynamo.tables import PLANNING

CUSTOM_EMOJI = "custom_emoji"

CUSTOM_EMOJI_KEY_PREFIX = "emoji#"

LIST_MAX = 2000
"""The most custom emoji one workspace holds, and so the most one listing reads."""


def custom_emoji_key(name: str) -> str:
    """The sort key of one custom emoji row."""
    return f"{CUSTOM_EMOJI_KEY_PREFIX}{name}"


class CustomEmoji(BaseModel):
    """One custom emoji of a workspace: its shortcode name, image key and uploader."""

    workspace_id: str
    planning_key: str = ""
    kind: str = CUSTOM_EMOJI
    name: str
    image_key: str
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)

    def model_post_init(self, _context: Any) -> None:
        """Derive the sort key from the name when none was given."""
        if not self.planning_key:
            self.planning_key = custom_emoji_key(self.name)


def _key(workspace_id: str, name: str) -> dict[str, str]:
    """The primary key of one custom emoji row."""
    return {"workspace_id": workspace_id, "planning_key": custom_emoji_key(name)}


class CustomEmojiRepository:
    """Reads and writes custom emoji rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build the planning table's own."""
        self._repository = build_repository(PLANNING, repository)

    def get(self, workspace_id: str, name: str) -> CustomEmoji | None:
        """One custom emoji by name, or `None`."""
        if not workspace_id or not name:
            return None
        item = self._repository.get(_key(workspace_id, name))
        if item is None or item.get("kind") != CUSTOM_EMOJI:
            return None
        return CustomEmoji.model_validate(dict(item))

    def list_for_workspace(self, workspace_id: str, *, max_items: int = LIST_MAX) -> list[CustomEmoji]:
        """Every custom emoji of the workspace, by name."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(CUSTOM_EMOJI_KEY_PREFIX),
            max_items=max_items,
        )
        return [CustomEmoji.model_validate(dict(item)) for item in items if item.get("kind") == CUSTOM_EMOJI]

    def create(self, emoji: CustomEmoji) -> CustomEmoji:
        """Store a new custom emoji, raising `ConditionFailed` when the name is taken."""
        self._repository.put(emoji.model_dump(mode="json"), condition=Attr("planning_key").not_exists())
        return emoji

    def delete(self, workspace_id: str, name: str) -> None:
        """Remove one custom emoji row; a missing one is a no-op."""
        self._repository.delete(_key(workspace_id, name))
