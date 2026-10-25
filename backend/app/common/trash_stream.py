"""How a stream consumer reads an issue record that moved it into or out of the trash.

A delete keeps the row and stamps `deleted_at`, so the stream sees a `MODIFY`
where every counter, rollup and search posting expects a `REMOVE`. Rewriting the
record here once, rather than teaching each consumer about the trash, keeps them
all in step: a move into the trash reads as a removal, a restore as an insert, and
any change to a row that was already in the trash, its purge included, as nothing
at all, since its counts left with the delete.

Held in `common` because the consumers live in several domain images.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from webbpulse.events import deserialize_image

Image = Literal["NewImage", "OldImage"]
"""The two images a stream record can carry."""


def _in_trash(record: Mapping[str, Any], image: Image) -> bool:
    """Whether one image of the record is an issue row sitting in the trash."""
    return deserialize_image(record, image).get("deleted_at") not in (None, "")


def _without(record: Mapping[str, Any], image: Image, event_name: str) -> dict[str, Any]:
    """The record with one image dropped and its event renamed."""
    section = record.get("dynamodb")
    stripped = {key: value for key, value in section.items() if key != image} if isinstance(section, Mapping) else {}
    return {**record, "eventName": event_name, "dynamodb": stripped}


def touches_trash(record: Mapping[str, Any]) -> bool:
    """Whether either image of the record is an issue in the trash."""
    return _in_trash(record, "NewImage") or _in_trash(record, "OldImage")


def live_view(record: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """The record as the live issue set saw it, or `None` when the live set did not change.

    A record with neither image in the trash comes back unchanged.
    """
    new_deleted = _in_trash(record, "NewImage")
    old_deleted = _in_trash(record, "OldImage")
    if not new_deleted and not old_deleted:
        return record
    if old_deleted:
        if new_deleted or not deserialize_image(record, "NewImage"):
            return None
        return _without(record, "OldImage", "INSERT")
    return _without(record, "NewImage", "REMOVE")
