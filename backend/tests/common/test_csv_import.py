"""Reading a CSV of issues: the presets, the mapping and the per-row conversion.

Everything here is pure text handling, so these tests need no tables. What they
watch: each preset maps its own tracker's export by itself, a caller's mapping
is checked against the file, Jira's repeated label columns are read together,
the date and priority shapes other trackers write are understood, a row with
no title is an error while a bad optional value is only a warning, and a parent
column resolves against the other rows by key, tracker id or unique title, with
every link it cannot make left as a warning. The Asana, Shortcut and Pivotal
Tracker presets are read against a small fixture export of each tool.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.common.csv_import import (
    MAX_ROWS,
    CsvRejected,
    ParentPlan,
    auto_mapping,
    first_assignee,
    normalise_estimate,
    parse_completed,
    parse_csv,
    parse_date,
    parse_datetime,
    parse_priority,
    plan_parent_links,
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

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "imports"


def fixture(name: str) -> str:
    """One fixture export's text."""
    return (FIXTURES / name).read_text(encoding="utf-8")


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
        "parent": None,
        "completed": None,
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


JIRA_TREE = (
    "Summary,Issue key,Issue id,Parent,Parent summary\n"
    "Login fails on Safari,PROJ-3,10003,10001,Auth epic\n"
    "Auth epic,PROJ-1,10001,,\n"
    "Reset password,PROJ-2,10002,PROJ-1,Auth epic\n"
)

LINEAR_TREE = "ID,Title,Parent issue\nENG-2,Child by key,ENG-1\nENG-1,Parent,\nENG-3,Child by title,parent\n"


def _plan(text: str, preset: str) -> tuple[dict[str, str | None], ParentPlan]:
    """The mapping and the parent plan for one whole file."""
    parsed = parse_csv(text)
    mapping = auto_mapping(parsed.headers, preset)
    return mapping, plan_parent_links(read_rows(parsed, mapping))


def test_a_jira_parent_resolves_by_issue_id_or_key_in_any_row_order() -> None:
    """Jira's `Parent` names the numeric `Issue id` or the key, and a child above its parent still links."""
    mapping, plan = _plan(JIRA_TREE, "jira")

    assert mapping["parent"] == "Parent"
    assert plan.links == {2: 3, 4: 3}
    assert plan.problems == {}


def test_jiras_older_parent_id_column_is_mapped() -> None:
    """An export from before Jira renamed the column still finds the parent."""
    assert auto_mapping(("Summary", "Issue key", "Parent id"), "jira")["parent"] == "Parent id"


def test_a_linear_parent_resolves_by_identifier_or_title() -> None:
    """Linear's `Parent issue` column names the parent's identifier, and a title also finds it."""
    mapping, plan = _plan(LINEAR_TREE, "linear")

    assert mapping["parent"] == "Parent issue"
    assert plan.links == {2: 3, 4: 3}


def test_a_parent_missing_from_the_file_is_a_warning() -> None:
    """The child still imports, without a parent, and says why."""
    _, plan = _plan("ID,Title,Parent issue\nENG-2,Child,ENG-99\n", "linear")

    assert plan.links == {}
    problem = plan.problems[2]
    assert (problem.field, problem.severity) == ("parent", "warning")
    assert "ENG-99" in problem.message


def test_an_ambiguous_title_or_a_skipped_parent_row_is_a_warning() -> None:
    """A title two rows share is not guessed, and a parent row that will not import is not linked."""
    text = "Title,Parent,Key\nTwin,,A\nTwin,,B\nChild,Twin,C\n,,D\nOrphan,D,E\n"

    _, plan = _plan(text, "generic")

    assert plan.links == {}
    assert "More than one row" in plan.problems[4].message
    assert "No row in the file" in plan.problems[6].message


def test_sub_issues_stay_one_level_deep_and_loops_are_refused() -> None:
    """A grandchild is left at the top, and two rows naming each other are both left unlinked."""
    text = "Key,Title,Parent\nA,Top,\nB,Middle,A\nC,Bottom,B\nX,Loop one,Y\nY,Loop two,X\nZ,Self,Z\n"

    _, plan = _plan(text, "generic")

    assert plan.links == {3: 2}
    assert set(plan.problems) == {4, 5, 6, 7}
    assert "one level deep" in plan.problems[4].message
    assert "own parent" in plan.problems[7].message


def test_the_asana_preset_maps_an_asana_export() -> None:
    """Asana's task export maps its section, notes, tags, parent task and completion columns."""
    parsed = parse_csv(fixture("asana.csv"))
    mapping = auto_mapping(parsed.headers, "asana")

    assert mapping == {
        "title": "Name",
        "description": "Notes",
        "status": "Section/Column",
        "priority": None,
        "assignee": "Assignee Email",
        "labels": "Tags",
        "estimate": "Story Points",
        "due_date": "Due Date",
        "source_key": "Task ID",
        "created_at": "Created At",
        "parent": "Parent task",
        "completed": "Completed At",
    }
    first, second, third = read_rows(parsed, mapping)
    assert (first.title, first.status, first.assignee) == ("Plan the launch", "In Progress", "member@example.com")
    assert first.labels == ["Launch", "Marketing"]
    assert (first.estimate, first.due_date, first.source_key) == ("5", "2026-10-15", "1205000000000001")
    assert first.created_at == datetime(2026, 9, 1, tzinfo=UTC)
    assert not first.completed
    assert second.completed
    assert second.parent == "Plan the launch"
    assert plan_parent_links([first, second, third]).links == {3: 2, 4: 2}


def test_the_shortcut_preset_maps_a_shortcut_export() -> None:
    """Shortcut's story export maps its state, owners, labels and completion, in Shortcut's date shape."""
    parsed = parse_csv(fixture("shortcut.csv"))
    mapping = auto_mapping(parsed.headers, "shortcut")

    assert (mapping["title"], mapping["status"], mapping["assignee"]) == ("name", "state", "owners")
    assert (mapping["source_key"], mapping["parent"], mapping["completed"]) == ("id", "parent_story_id", "completed_at")
    first, second = read_rows(parsed, mapping)
    assert first.assignee == "member@example.com"
    assert first.labels == ["auth", "web"]
    assert first.priority == "high"
    assert status_category(first.status) == "started"
    assert first.created_at == datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
    assert first.due_date == "2026-10-20"
    assert not first.completed
    assert second.completed
    assert plan_parent_links([first, second]).links == {3: 2}


def test_the_pivotal_preset_maps_a_pivotal_tracker_export() -> None:
    """Pivotal Tracker's export maps its current state, owner, deadline and acceptance."""
    parsed = parse_csv(fixture("pivotal.csv"))
    mapping = auto_mapping(parsed.headers, "pivotal")

    assert (mapping["title"], mapping["status"], mapping["assignee"]) == ("Title", "Current State", "Owned By")
    assert (mapping["due_date"], mapping["completed"], mapping["source_key"]) == ("Deadline", "Accepted at", "Id")
    first, second, third = read_rows(parsed, mapping)
    assert first.assignee == "Mel Member"
    assert first.priority == "high"
    assert first.labels == ["onboarding", "web"]
    assert first.due_date == "2026-10-12"
    assert first.created_at == datetime(2026, 9, 1, tzinfo=UTC)
    assert status_category(first.status) == "started"
    assert second.priority == "low"
    assert second.completed
    assert status_category(second.status) == "completed"
    assert status_category(third.status) == "backlog"
    assert all(row.importable for row in (first, second, third))


@pytest.mark.parametrize(
    ("value", "expected"),
    [("2026-09-05", True), ("TRUE", True), ("true", True), ("FALSE", False), ("no", False), ("", False)],
)
def test_a_completion_cell_is_any_value_but_an_explicit_false(value: str, expected: bool) -> None:
    """A completion date or a true flag finishes the row; an empty cell or a false flag does not."""
    assert parse_completed(value) is expected


def test_a_cell_listing_several_people_names_the_first_email() -> None:
    """An issue has one assignee, so a list of owners keeps its first."""
    assert first_assignee("member@example.com, admin@example.com") == "member@example.com"
    assert first_assignee("Mel Member") == "Mel Member"
