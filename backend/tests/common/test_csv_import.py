"""Reading a CSV of issues: the presets, the mapping and the per-row conversion.

Everything here is pure text handling, so these tests need no tables. What they
watch: each preset maps its own tracker's export by itself, a caller's mapping
is checked against the file, Jira's repeated label columns are read together,
the date and priority shapes other trackers write are understood, and a row with
no title is an error while a bad optional value is only a warning.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.common.csv_import import (
    MAX_ROWS,
    CsvRejected,
    auto_mapping,
    normalise_estimate,
    parse_csv,
    parse_date,
    parse_datetime,
    parse_priority,
    read_rows,
    resolve_mapping,
    split_labels,
    status_category,
)

JIRA = (
    "Summary,Issue key,Issue id,Status,Priority,Assignee,Labels,Labels,Created,Due date,"
    "Custom field (Story Points),Description\n"
    "Fix login,PROJ-12,10012,In Progress,Highest,ada@example.com,auth,web,12/Oct/26 3:45 PM,20/Oct/26,3.0,Broken\n"
)

LINEAR = (
    "ID,Team,Title,Description,Status,Estimate,Priority,Project,Creator,Assignee,Labels,Created,Due Date\n"
    'ENG-7,Engineering,Ship it,Body,Todo,2,2,,ada,Ada Lovelace,"Bug, Frontend",'
    "2026-09-01T10:00:00.000Z,2026-10-01\n"
)


def test_a_byte_order_mark_and_blank_rows_are_ignored() -> None:
    """Spreadsheet exports start with a BOM and often end with empty lines."""
    parsed = parse_csv("﻿Title,Status\nOne,Todo\n,\n\nTwo,Done\n")

    assert parsed.headers == ("Title", "Status")
    assert [row[0] for row in parsed.rows] == ["One", "Two"]


@pytest.mark.parametrize("text", ["", "   \n", ",,\nA,B\n"])
def test_a_file_with_no_header_row_is_refused(text: str) -> None:
    """Without column names there is nothing to map."""
    with pytest.raises(CsvRejected):
        parse_csv(text)


def test_a_file_over_the_row_cap_is_refused() -> None:
    """One import holds a bounded number of rows."""
    text = "Title\n" + "".join(f"Row {index}\n" for index in range(MAX_ROWS + 1))

    with pytest.raises(CsvRejected, match="at most"):
        parse_csv(text)


def test_the_jira_preset_maps_a_jira_export() -> None:
    """A Jira export maps every field without a single choice from the admin."""
    mapping = auto_mapping(parse_csv(JIRA).headers, "jira")

    assert mapping == {
        "title": "Summary",
        "description": "Description",
        "status": "Status",
        "priority": "Priority",
        "assignee": "Assignee",
        "labels": "Labels",
        "estimate": "Custom field (Story Points)",
        "due_date": "Due date",
        "source_key": "Issue key",
        "created_at": "Created",
    }


def test_the_linear_preset_maps_a_linear_export() -> None:
    """A Linear export maps its identifier column as the source key."""
    mapping = auto_mapping(parse_csv(LINEAR).headers, "linear")

    assert mapping["title"] == "Title"
    assert mapping["source_key"] == "ID"
    assert mapping["estimate"] == "Estimate"
    assert mapping["due_date"] == "Due Date"


def test_the_generic_preset_matches_headers_without_case() -> None:
    """A hand-made file maps whichever common names it uses."""
    mapping = auto_mapping(("summary", "STATE", "Tags", "Points"), "generic")

    assert mapping["title"] == "summary"
    assert mapping["status"] == "STATE"
    assert mapping["labels"] == "Tags"
    assert mapping["estimate"] == "Points"
    assert mapping["assignee"] is None


def test_an_override_replaces_and_unmaps_fields() -> None:
    """The admin's choices sit over the preset's, and null unmaps a field."""
    headers = ("Name", "Summary", "Status")

    mapping = resolve_mapping(headers, "generic", {"title": "Name", "status": None})

    assert mapping["title"] == "Name"
    assert mapping["status"] is None


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"title": "Missing"}, "no column"),
        ({"colour": "Status"}, "Unknown field"),
        ({"title": None}, "title"),
    ],
)
def test_a_bad_mapping_is_refused(overrides: dict[str, str | None], message: str) -> None:
    """A header the file lacks, a field that does not exist, or no title cannot import."""
    with pytest.raises(CsvRejected, match=message):
        resolve_mapping(("Title", "Status"), "generic", overrides)


def test_a_jira_row_reads_every_field() -> None:
    """Repeated label columns combine, the Jira date shape reads, and 3.0 is 3."""
    parsed = parse_csv(JIRA)
    [row] = read_rows(parsed, auto_mapping(parsed.headers, "jira"))

    assert row.line == 2
    assert row.title == "Fix login"
    assert row.status == "In Progress"
    assert row.priority == "urgent"
    assert row.assignee == "ada@example.com"
    assert row.labels == ["auth", "web"]
    assert row.estimate == "3"
    assert row.due_date == "2026-10-20"
    assert row.source_key == "PROJ-12"
    assert row.created_at == datetime(2026, 10, 12, 15, 45, tzinfo=UTC)
    assert row.description == "Broken"
    assert row.problems == []
    assert row.importable


def test_a_linear_row_reads_its_numbered_priority_and_label_list() -> None:
    """Linear writes priorities as 0 to 4 and labels comma separated in one cell."""
    parsed = parse_csv(LINEAR)
    [row] = read_rows(parsed, auto_mapping(parsed.headers, "linear"))

    assert row.priority == "high"
    assert row.labels == ["Bug", "Frontend"]
    assert row.created_at == datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
    assert row.due_date == "2026-10-01"


def test_a_row_with_no_title_is_an_error() -> None:
    """A row that cannot be an issue is skipped and says why."""
    parsed = parse_csv("Title,Status\n,Todo\n")
    [row] = read_rows(parsed, auto_mapping(parsed.headers, "generic"))

    assert not row.importable
    assert [(problem.field, problem.severity) for problem in row.problems] == [("title", "error")]


def test_bad_optional_values_are_warnings_and_the_row_still_imports() -> None:
    """An unknown priority or an unreadable date drops that value, not the row."""
    parsed = parse_csv("Title,Priority,Due date,Created\nOne,whenever,soon,yesterday\n")
    [row] = read_rows(parsed, auto_mapping(parsed.headers, "generic"))

    assert row.importable
    assert row.priority == "none"
    assert row.due_date is None
    assert row.created_at is None
    assert {problem.field for problem in row.problems} == {"priority", "due_date", "created_at"}
    assert {problem.severity for problem in row.problems} == {"warning"}


def test_a_long_title_is_cut_with_a_warning() -> None:
    """A title past the limit still imports, shortened."""
    parsed = parse_csv("Title\n" + "x" * 250 + "\n")
    [row] = read_rows(parsed, auto_mapping(parsed.headers, "generic"))

    assert len(row.title) == 200
    assert row.importable
    assert row.problems[0].field == "title"


def test_read_rows_reads_one_page() -> None:
    """A page is a slice of the data rows, numbered as the spreadsheet numbers them."""
    parsed = parse_csv("Title\nA\nB\nC\nD\n")

    rows = read_rows(parsed, auto_mapping(parsed.headers, "generic"), 1, 3)

    assert [(row.line, row.title) for row in rows] == [(3, "B"), (4, "C")]


def test_labels_split_trim_and_deduplicate_without_case() -> None:
    """The same label written twice is one label."""
    assert split_labels(["Bug, frontend", "bug", " ", "Frontend,API"]) == ["Bug", "frontend", "API"]


@pytest.mark.parametrize(
    ("value", "expected"),
    [("", "none"), ("0", "none"), ("Highest", "urgent"), ("P1", "high"), ("Normal", "medium"), ("4", "low")],
)
def test_priorities_from_other_trackers(value: str, expected: str) -> None:
    """Jira words, Linear numbers and P-levels all land on the five priorities."""
    assert parse_priority(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [("To Do", "unstarted"), ("In Review", "started"), ("Resolved", "completed"), ("Won't Do", "cancelled")],
)
def test_status_names_from_other_trackers(value: str, expected: str) -> None:
    """A workflow name another tracker uses is known by its category."""
    assert status_category(value) == expected


def test_an_unknown_status_has_no_category() -> None:
    """A name nobody uses is left for the team's default."""
    assert status_category("Waiting on legal") is None


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("2026-09-01", datetime(2026, 9, 1, tzinfo=UTC)),
        ("2026-09-01T10:00:00+02:00", datetime(2026, 9, 1, 8, 0, tzinfo=UTC)),
        ("2026-09-01T10:00:00Z", datetime(2026, 9, 1, 10, 0, tzinfo=UTC)),
        ("01/Sep/26 9:05 AM", datetime(2026, 9, 1, 9, 5, tzinfo=UTC)),
        ("09/01/2026", datetime(2026, 9, 1, tzinfo=UTC)),
        (
            "Tue Sep 01 2026 10:00:00 GMT+0000 (Coordinated Universal Time)",
            datetime(2026, 9, 1, 10, 0, tzinfo=UTC),
        ),
    ],
)
def test_timestamps_in_the_shapes_trackers_write(value: str, expected: datetime) -> None:
    """ISO, Jira's day-month-year and a JavaScript date string all read, in UTC."""
    assert parse_datetime(value) == expected


def test_a_date_drops_its_time() -> None:
    """A due date is a calendar day."""
    assert parse_date("2026-09-01T23:00:00Z") == "2026-09-01"
    assert parse_date("not a date") is None


@pytest.mark.parametrize(("value", "expected"), [("3.0", "3"), ("2.5", "2.5"), ("m", "M"), ("", None)])
def test_estimates_read_as_the_team_scales_write_them(value: str, expected: str | None) -> None:
    """Whole numbers lose their decimal point and T-shirt sizes read in capitals."""
    assert normalise_estimate(value) == expected
