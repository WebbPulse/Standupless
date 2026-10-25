"""How stream consumers read an issue record that moved it into or out of the trash.

A delete is a `MODIFY` on the table, so each consumer would count it as an edit.
The rewrite has to read a move into the trash as a removal, a restore as an
insert, and anything else that touches a trashed row as no change at all.
"""

from __future__ import annotations

from typing import Any

from app.common.trash_stream import live_view, touches_trash


def _image(**attributes: str) -> "dict[str, Any]":
    """One stream image in DynamoDB's wire encoding, strings throughout."""
    return {name: {"S": value} for name, value in attributes.items()}


def _record(event_name: str, new: "dict[str, Any] | None" = None, old: "dict[str, Any] | None" = None) -> Any:
    """One stream record shaped the way Lambda delivers it."""
    dynamodb: "dict[str, Any]" = {}
    if new is not None:
        dynamodb["NewImage"] = new
    if old is not None:
        dynamodb["OldImage"] = old
    return {"eventName": event_name, "eventID": "1", "dynamodb": dynamodb}


LIVE = _image(issue_id="I1", title="Live")
TRASHED = _image(issue_id="I1", title="Live", deleted_at="2026-10-25T00:00:00+00:00")


def test_a_record_away_from_the_trash_is_untouched() -> None:
    """An ordinary edit reaches every consumer as it was."""
    record = _record("MODIFY", new=LIVE, old=LIVE)

    assert touches_trash(record) is False
    assert live_view(record) is record


def test_a_move_into_the_trash_reads_as_a_removal() -> None:
    """Counts, postings and rollups drop the issue the way a delete used to."""
    seen = live_view(_record("MODIFY", new=TRASHED, old=LIVE))

    assert seen is not None
    assert seen["eventName"] == "REMOVE"
    assert seen["dynamodb"] == {"OldImage": LIVE}


def test_a_restore_reads_as_an_insert() -> None:
    """The issue comes back to every consumer as if newly created."""
    seen = live_view(_record("MODIFY", new=LIVE, old=TRASHED))

    assert seen is not None
    assert seen["eventName"] == "INSERT"
    assert seen["dynamodb"] == {"NewImage": LIVE}


def test_a_change_inside_the_trash_or_its_purge_is_nothing() -> None:
    """Its counts left with the delete, so neither a rewrite nor the purge may count again."""
    assert live_view(_record("MODIFY", new=TRASHED, old=TRASHED)) is None
    assert live_view(_record("REMOVE", old=TRASHED)) is None
    assert touches_trash(_record("REMOVE", old=TRASHED)) is True
