"""Turning a Trello board's JSON export into the CSV the issue import reads.

Pure text handling against a small fixture board. What these tests watch: open
cards on open lists become rows ordered by list then card, a list's name is the
status, unnamed labels fall back to their colour, a member is named by email or
full name, a ticked due date or checklist item finishes its row, checklist items
become sub-issue rows of their card, and anything that is not a board is refused.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.common.csv_import import CsvRejected, auto_mapping, parse_csv, plan_parent_links, read_rows
from app.common.trello_import import HEADERS, prepare_source, trello_to_csv

BOARD = (Path(__file__).resolve().parents[1] / "fixtures" / "imports" / "trello.json").read_text(encoding="utf-8")


def test_a_board_becomes_rows_under_the_trello_preset() -> None:
    """Every column the preset reads is mapped, and archived cards and closed lists are left out."""
    parsed = parse_csv(trello_to_csv(BOARD))
    mapping = auto_mapping(parsed.headers, "trello")

    assert parsed.headers == HEADERS
    assert mapping["title"] == "Name"
    assert mapping["status"] == "List"
    assert mapping["parent"] == "Parent"
    assert mapping["completed"] == "Completed"
    titles = [row.title for row in read_rows(parsed, mapping)]
    assert titles == ["Order the banners", "Plan the launch", "Pick the date", "Book the venue"]


def test_cards_carry_their_list_labels_member_and_due_date() -> None:
    """A card reads as an issue in its list's status with its labels and first member."""
    parsed = parse_csv(trello_to_csv(BOARD))
    banners, launch, _pick, _book = read_rows(parsed, auto_mapping(parsed.headers, "trello"))

    assert launch.status == "Doing"
    assert launch.description == "Pick a date."
    assert launch.labels == ["Marketing", "red"]
    assert launch.assignee == "Mel Member"
    assert launch.due_date == "2026-10-15"
    assert launch.source_key == "66f1b0000000000000000040"
    assert launch.created_at is not None
    assert not launch.completed
    assert banners.status == "To Do"
    assert banners.completed


def test_checklist_items_become_sub_issues_of_their_card() -> None:
    """Each item is a row whose parent is its card, finished when ticked, held by its member."""
    parsed = parse_csv(trello_to_csv(BOARD))
    rows = read_rows(parsed, auto_mapping(parsed.headers, "trello"))
    _banners, launch, pick, book = rows

    assert pick.completed
    assert not book.completed
    assert book.assignee == "Mel Member"
    assert book.status == "Doing"
    assert plan_parent_links(rows).links == {pick.line: launch.line, book.line: launch.line}


def test_a_member_with_an_exported_email_is_named_by_it() -> None:
    """Where the export carries a member's email, the import matches by it."""
    board = json.loads(BOARD)
    board["members"][0]["email"] = "member@example.com"

    parsed = parse_csv(trello_to_csv(json.dumps(board)))
    rows = read_rows(parsed, auto_mapping(parsed.headers, "trello"))

    assert rows[1].assignee == "member@example.com"


@pytest.mark.parametrize("text", ["not json", "[]", '{"name": "No cards"}'])
def test_anything_but_a_board_is_refused(text: str) -> None:
    """Invalid JSON, or JSON without cards, is not a Trello board."""
    with pytest.raises(CsvRejected):
        trello_to_csv(text)


def test_only_the_trello_preset_converts_its_upload() -> None:
    """Every other preset's file is read as the CSV it already is."""
    assert prepare_source("generic", "Title\nOne\n") == "Title\nOne\n"
    assert prepare_source("trello", BOARD).startswith("Card ID,Name")
