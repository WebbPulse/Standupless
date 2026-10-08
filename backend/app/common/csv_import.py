"""Reading a CSV of issues: the presets, the column mapping and the per-row conversion.

Everything here is deterministic text handling with no reads or writes, so the
dry run and the import job turn the same file into the same rows. A preset is a
list of header names to look for per field, so a Jira or Linear export maps
itself and a hand-made file maps whatever headers it shares with the generic
preset. A field mapped to a header that appears more than once, such as Jira's
repeated `Labels` columns, reads every column of that name.

The conversion to a team's statuses, labels, members and estimates lives in
`app.common.issue_import`, because it needs the team's rows; this module answers
the raw values and the problems that need no lookup.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Literal, Mapping, Optional, Sequence

from pydantic import BaseModel

Preset = Literal["generic", "jira", "linear"]

PRESETS: tuple[str, ...] = ("generic", "jira", "linear")

ImportField = Literal[
    "title",
    "description",
    "status",
    "priority",
    "assignee",
    "labels",
    "estimate",
    "due_date",
    "source_key",
    "created_at",
]

IMPORT_FIELDS: tuple[str, ...] = (
    "title",
    "description",
    "status",
    "priority",
    "assignee",
    "labels",
    "estimate",
    "due_date",
    "source_key",
    "created_at",
)
"""Every issue field a column can map to, in the order the mapping screen lists them."""

GENERIC_HEADERS: dict[str, tuple[str, ...]] = {
    "title": ("title", "summary", "name"),
    "description": ("description", "body", "details"),
    "status": ("status", "state"),
    "priority": ("priority",),
    "assignee": ("assignee email", "assignee", "owner"),
    "labels": ("labels", "label", "tags"),
    "estimate": ("estimate", "points", "story points"),
    "due_date": ("due date", "due", "due_date"),
    "source_key": ("id", "key", "issue key", "identifier"),
    "created_at": ("created", "created at", "created_at"),
}

PRESET_HEADERS: dict[str, dict[str, tuple[str, ...]]] = {
    "generic": GENERIC_HEADERS,
    "jira": {
        "title": ("summary",),
        "description": ("description",),
        "status": ("status",),
        "priority": ("priority",),
        "assignee": ("assignee",),
        "labels": ("labels",),
        "estimate": ("custom field (story points)", "story points", "custom field (story point estimate)"),
        "due_date": ("due date", "due"),
        "source_key": ("issue key",),
        "created_at": ("created",),
    },
    "linear": {
        "title": ("title",),
        "description": ("description",),
        "status": ("status",),
        "priority": ("priority",),
        "assignee": ("assignee",),
        "labels": ("labels",),
        "estimate": ("estimate",),
        "due_date": ("due date",),
        "source_key": ("id",),
        "created_at": ("created",),
    },
}
"""Per preset, the header names each field is found under, best match first, compared without case."""

MAX_CSV_BYTES = 4 * 1024 * 1024
"""The largest file one import takes, under the request size the API accepts."""

MAX_ROWS = 5000
"""The most data rows one import takes."""

MAX_CELL_BYTES = 256 * 1024
"""The largest single cell the reader accepts, so one runaway quote cannot read the rest of the file."""

TITLE_MAX = 200

LABEL_MAX = 60

SOURCE_KEY_MAX = 120

PRIORITY_WORDS: dict[str, str] = {
    "": "none",
    "0": "none",
    "none": "none",
    "no priority": "none",
    "1": "urgent",
    "urgent": "urgent",
    "highest": "urgent",
    "blocker": "urgent",
    "critical": "urgent",
    "p0": "urgent",
    "2": "high",
    "high": "high",
    "major": "high",
    "p1": "high",
    "3": "medium",
    "medium": "medium",
    "normal": "medium",
    "p2": "medium",
    "4": "low",
    "low": "low",
    "lowest": "low",
    "minor": "low",
    "trivial": "low",
    "p3": "low",
    "p4": "low",
}
"""Source priority words and Linear's 0 to 4 numbers, as the five priorities."""

STATUS_CATEGORY_WORDS: dict[str, str] = {
    "backlog": "backlog",
    "icebox": "backlog",
    "triage": "backlog",
    "todo": "unstarted",
    "to do": "unstarted",
    "open": "unstarted",
    "new": "unstarted",
    "ready": "unstarted",
    "selected for development": "unstarted",
    "unstarted": "unstarted",
    "in progress": "started",
    "doing": "started",
    "started": "started",
    "in development": "started",
    "in review": "started",
    "review": "started",
    "code review": "started",
    "testing": "started",
    "in qa": "started",
    "qa": "started",
    "blocked": "started",
    "done": "completed",
    "closed": "completed",
    "resolved": "completed",
    "complete": "completed",
    "completed": "completed",
    "fixed": "completed",
    "shipped": "completed",
    "released": "completed",
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "won't do": "cancelled",
    "wont do": "cancelled",
    "won't fix": "cancelled",
    "duplicate": "cancelled",
    "rejected": "cancelled",
    "declined": "cancelled",
}
"""Common workflow names in other trackers, as the status category they mean."""

DATE_FORMATS: tuple[str, ...] = (
    "%Y-%m-%d",
    "%d/%b/%y %I:%M %p",
    "%d/%b/%y",
    "%d/%b/%Y %I:%M %p",
    "%d/%b/%Y",
    "%m/%d/%Y",
    "%m/%d/%Y %H:%M",
    "%Y/%m/%d",
    "%a %b %d %Y %H:%M:%S GMT%z",
)
"""Date shapes tried after ISO 8601: Jira's `12/Oct/26 3:45 PM`, US slashes, and a JavaScript date string."""

Severity = Literal["error", "warning"]


class RowProblem(BaseModel):
    """Something wrong with one row: an error skips the row, a warning drops one value."""

    row: int
    field: Optional[str] = None
    severity: Severity = "warning"
    message: str


class CsvRejected(Exception):
    """The file as a whole cannot be imported: empty, too large, or not CSV."""


@dataclass(frozen=True)
class ParsedCsv:
    """A file split into its header row and its data rows, blank rows dropped."""

    headers: tuple[str, ...]
    rows: tuple[tuple[str, ...], ...]


@dataclass
class RawRow:
    """One data row's mapped values before any lookup against the team.

    `line` is the row's position counting the header as row 1, which is what a
    spreadsheet shows beside it.
    """

    line: int
    title: str = ""
    description: Optional[str] = None
    status: str = ""
    priority: str = "none"
    assignee: str = ""
    labels: list[str] = field(default_factory=list)
    estimate: Optional[str] = None
    due_date: Optional[str] = None
    source_key: Optional[str] = None
    created_at: Optional[datetime] = None
    problems: list[RowProblem] = field(default_factory=list)

    @property
    def importable(self) -> bool:
        """Whether no error stops this row from becoming an issue."""
        return not any(problem.severity == "error" for problem in self.problems)


def parse_csv(text: str) -> ParsedCsv:
    """Split a file into its headers and rows, raising `CsvRejected` when it cannot be read."""
    if len(text.encode("utf-8")) > MAX_CSV_BYTES:
        raise CsvRejected(f"The file is larger than {MAX_CSV_BYTES // (1024 * 1024)} MB")
    text = text.lstrip("﻿")
    if not text.strip():
        raise CsvRejected("The file is empty")
    previous = csv.field_size_limit()
    csv.field_size_limit(MAX_CELL_BYTES)
    try:
        records = list(csv.reader(io.StringIO(text, newline="")))
    except csv.Error as exc:
        raise CsvRejected(f"The file is not valid CSV: {exc}") from exc
    finally:
        csv.field_size_limit(previous)
    headers = tuple(cell.strip() for cell in records[0]) if records else ()
    if not any(headers):
        raise CsvRejected("The first row must name the columns")
    rows = tuple(tuple(record) for record in records[1:] if any(cell.strip() for cell in record))
    if len(rows) > MAX_ROWS:
        raise CsvRejected(f"The file has {len(rows)} rows; one import takes at most {MAX_ROWS}")
    return ParsedCsv(headers=headers, rows=rows)


def auto_mapping(headers: Sequence[str], preset: str) -> dict[str, Optional[str]]:
    """The header each field maps to under one preset, or `None` where no header matches.

    The preset's own names are tried first, then the generic ones, so a Jira file
    with an extra `Story Points` column still finds it.
    """
    present = {header.lower(): header for header in reversed(headers) if header}
    wanted = PRESET_HEADERS.get(preset, GENERIC_HEADERS)
    mapping: dict[str, Optional[str]] = {}
    for name in IMPORT_FIELDS:
        candidates = (*wanted.get(name, ()), *GENERIC_HEADERS.get(name, ()))
        mapping[name] = next((present[candidate] for candidate in candidates if candidate in present), None)
    return mapping


def resolve_mapping(
    headers: Sequence[str], preset: str, overrides: Optional[Mapping[str, Optional[str]]] = None
) -> dict[str, Optional[str]]:
    """The preset's mapping with the caller's choices laid over it.

    Raises `CsvRejected` for an unknown field, a header the file lacks, or a
    mapping that leaves the title unmapped.
    """
    mapping = auto_mapping(headers, preset)
    for name, header in (overrides or {}).items():
        if name not in IMPORT_FIELDS:
            raise CsvRejected(f"Unknown field: {name}")
        if header is not None and header not in headers:
            raise CsvRejected(f"The file has no column named {header}")
        mapping[name] = header or None
    if not mapping.get("title"):
        raise CsvRejected("Map a column to the title")
    return mapping


def _cells(row: Sequence[str], headers: Sequence[str], header: Optional[str]) -> list[str]:
    """Every non-empty value under one header, from each column that carries it."""
    if not header:
        return []
    values = []
    for index, name in enumerate(headers):
        if name == header and index < len(row) and row[index].strip():
            values.append(row[index].strip())
    return values


def _cell(row: Sequence[str], headers: Sequence[str], header: Optional[str]) -> str:
    """The first non-empty value under one header, or the empty string."""
    values = _cells(row, headers, header)
    return values[0] if values else ""


def split_labels(values: Sequence[str]) -> list[str]:
    """Label names from one or more cells, split on commas, trimmed and deduplicated without case."""
    seen: dict[str, str] = {}
    for value in values:
        for part in value.split(","):
            name = part.strip()[:LABEL_MAX].strip()
            if name and name.lower() not in seen:
                seen[name.lower()] = name
    return list(seen.values())


def parse_priority(value: str) -> Optional[str]:
    """One of the five priorities, or `None` for a word no tracker uses."""
    return PRIORITY_WORDS.get(value.strip().lower())


def status_category(value: str) -> Optional[str]:
    """The status category a source status name means, or `None` when it is not a common one."""
    return STATUS_CATEGORY_WORDS.get(value.strip().lower())


_JS_ZONE_NAME = re.compile(r"\s*\([^)]*\)\s*$")


def parse_datetime(value: str) -> Optional[datetime]:
    """A timestamp in any of the shapes trackers export, in UTC, or `None` when it is none of them."""
    text = _JS_ZONE_NAME.sub("", value.strip())
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        parsed = None
        for shape in DATE_FORMATS:
            try:
                parsed = datetime.strptime(text, shape)
                break
            except ValueError:
                continue
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def parse_date(value: str) -> Optional[str]:
    """A calendar date as `YYYY-MM-DD`, or `None` when the value is not a date."""
    text = value.strip()
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        pass
    parsed = parse_datetime(text)
    return parsed.date().isoformat() if parsed is not None else None


def normalise_estimate(value: str) -> Optional[str]:
    """An estimate as the team scales write it, so `3.0` reads as `3`."""
    text = value.strip()
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return text.upper() if len(text) <= 3 else text
    return str(int(number)) if number.is_integer() else text


def read_row(line: int, row: Sequence[str], headers: Sequence[str], mapping: Mapping[str, Optional[str]]) -> RawRow:
    """One data row's mapped values, with the problems that need no lookup against the team."""
    raw = RawRow(line=line)

    title = " ".join(_cell(row, headers, mapping.get("title")).split())
    if not title:
        raw.problems.append(RowProblem(row=line, field="title", severity="error", message="The title is empty"))
    elif len(title) > TITLE_MAX:
        raw.problems.append(
            RowProblem(row=line, field="title", message=f"The title was cut to {TITLE_MAX} characters")
        )
        title = title[:TITLE_MAX].rstrip()
    raw.title = title

    description = _cell(row, headers, mapping.get("description"))
    raw.description = description or None

    raw.status = _cell(row, headers, mapping.get("status"))

    priority_text = _cell(row, headers, mapping.get("priority"))
    priority = parse_priority(priority_text)
    if priority is None:
        raw.problems.append(
            RowProblem(row=line, field="priority", message=f"Unknown priority {priority_text!r}, left as none")
        )
        priority = "none"
    raw.priority = priority

    raw.assignee = _cell(row, headers, mapping.get("assignee"))
    raw.labels = split_labels(_cells(row, headers, mapping.get("labels")))
    raw.estimate = normalise_estimate(_cell(row, headers, mapping.get("estimate")))

    due_text = _cell(row, headers, mapping.get("due_date"))
    if due_text:
        raw.due_date = parse_date(due_text)
        if raw.due_date is None:
            raw.problems.append(
                RowProblem(row=line, field="due_date", message=f"Unreadable due date {due_text!r}, left empty")
            )

    source_key = _cell(row, headers, mapping.get("source_key"))
    raw.source_key = source_key[:SOURCE_KEY_MAX] or None

    created_text = _cell(row, headers, mapping.get("created_at"))
    if created_text:
        raw.created_at = parse_datetime(created_text)
        if raw.created_at is None:
            raw.problems.append(
                RowProblem(
                    row=line, field="created_at", message=f"Unreadable created date {created_text!r}, used today"
                )
            )
    return raw


def read_rows(
    parsed: ParsedCsv, mapping: Mapping[str, Optional[str]], start: int = 0, stop: Optional[int] = None
) -> list[RawRow]:
    """The mapped values of the data rows from `start` up to `stop`, numbered as a spreadsheet numbers them."""
    end = len(parsed.rows) if stop is None else min(stop, len(parsed.rows))
    return [read_row(index + 2, parsed.rows[index], parsed.headers, mapping) for index in range(start, end)]
