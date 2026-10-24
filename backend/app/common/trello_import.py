"""Turning a Trello board's JSON export into the CSV the issue import reads.

A Trello board exports as one JSON document holding its lists, cards, labels,
members and checklists. Rather than a second import path, the board is flattened
here into rows under the `trello` preset's headers, and from then on the file
takes the same preview, mapping and job path as any CSV: the converted text is
what the job stores as its source, so every page reads the same rows.

Each open card on an open list is a row whose status is its list's name. Each
checklist item becomes a sub-issue row whose parent is its card, finished when
the item is checked. A member is named by email where the export carries one,
else by full name, and a label by its name, else by its colour.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import UTC, datetime
from typing import Any, Optional

from app.common.csv_import import CsvRejected

HEADERS: tuple[str, ...] = (
    "Card ID",
    "Name",
    "Description",
    "List",
    "Members",
    "Labels",
    "Due",
    "Created",
    "Parent",
    "Completed",
)
"""The columns a converted board carries, matching the `trello` preset."""


def _load_board(text: str) -> dict[str, Any]:
    """The board object of an export, raising `CsvRejected` for anything that is not one."""
    try:
        board = json.loads(text.lstrip("﻿"))
    except ValueError as exc:
        raise CsvRejected("The file is not valid Trello JSON") from exc
    if not isinstance(board, dict) or not isinstance(board.get("cards"), list):
        raise CsvRejected("The file is not a Trello board export: it has no cards")
    return board


def _objects(board: dict[str, Any], name: str) -> list[dict[str, Any]]:
    """One of the board's arrays, keeping only its objects."""
    value = board.get(name)
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _created(object_id: str) -> str:
    """When a Trello object was made, read from the timestamp its id starts with."""
    try:
        return datetime.fromtimestamp(int(object_id[:8], 16), UTC).isoformat()
    except (ValueError, OverflowError, OSError):
        return ""


def _member_name(member: Optional[dict[str, Any]]) -> str:
    """How the import matches a member: their email when exported, else their full name."""
    if not member:
        return ""
    return str(member.get("email") or member.get("fullName") or member.get("username") or "").strip()


def _position(item: dict[str, Any]) -> float:
    """An object's place in its list, with unpositioned objects last."""
    try:
        return float(item.get("pos", 0) or 0)
    except (TypeError, ValueError):
        return float("inf")


def trello_to_csv(text: str) -> str:
    """Flatten a Trello board export into CSV under the `trello` preset's headers."""
    board = _load_board(text)
    lists = {
        str(item.get("id")): item
        for item in _objects(board, "lists")
        if not item.get("closed")
    }
    members = {str(item.get("id")): item for item in _objects(board, "members")}
    board_labels = {str(item.get("id")): item for item in _objects(board, "labels")}
    checklists: dict[str, list[dict[str, Any]]] = {}
    for checklist in sorted(_objects(board, "checklists"), key=_position):
        checklists.setdefault(str(checklist.get("idCard")), []).append(checklist)

    def label_names(card: dict[str, Any]) -> str:
        """The card's labels as one comma separated cell."""
        found = card.get("labels") if isinstance(card.get("labels"), list) else None
        if found is None:
            ids = [str(label_id) for label_id in card.get("idLabels") or []]
            found = [board_labels[label_id] for label_id in ids if label_id in board_labels]
        names = []
        for label in found:
            if isinstance(label, dict):
                name = str(label.get("name") or label.get("color") or "").replace(",", " ").strip()
                if name:
                    names.append(name)
        return ", ".join(names)

    cards = [
        card
        for card in _objects(board, "cards")
        if not card.get("closed") and str(card.get("idList")) in lists
    ]
    cards.sort(key=lambda card: (_position(lists[str(card.get("idList"))]), _position(card)))

    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(HEADERS)
    for card in cards:
        card_id = str(card.get("id") or "")
        list_name = str(lists[str(card.get("idList"))].get("name") or "")
        first_member = next(iter(card.get("idMembers") or []), None)
        writer.writerow(
            (
                card_id,
                str(card.get("name") or ""),
                str(card.get("desc") or ""),
                list_name,
                _member_name(members.get(str(first_member))),
                label_names(card),
                str(card.get("due") or ""),
                _created(card_id),
                "",
                "true" if card.get("dueComplete") else "",
            )
        )
        for checklist in checklists.get(card_id, []):
            items = [item for item in checklist.get("checkItems") or [] if isinstance(item, dict)]
            for item in sorted(items, key=_position):
                item_id = str(item.get("id") or "")
                writer.writerow(
                    (
                        item_id,
                        str(item.get("name") or ""),
                        "",
                        list_name,
                        _member_name(members.get(str(item.get("idMember")))),
                        "",
                        str(item.get("due") or ""),
                        _created(item_id),
                        card_id,
                        "true" if item.get("state") == "complete" else "",
                    )
                )
    return out.getvalue()


def prepare_source(preset: str, text: str) -> str:
    """The CSV an import reads for one upload: a Trello board converted, any other file as sent."""
    return trello_to_csv(text) if preset == "trello" else text
