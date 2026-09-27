"""Rendering: rich tables for people, plain JSON for scripts.

`--json` always prints the API's own shapes unchanged, so a script written against
the CLI keeps working as the tables change.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Mapping, Sequence
from typing import Any

from rich.console import Console
from rich.markdown import Markdown
from rich.table import Table

console = Console()
err_console = Console(stderr=True)

PRIORITY_LABELS = {"urgent": "Urgent", "high": "High", "medium": "Medium", "low": "Low", "none": ""}


def print_json(data: Any) -> None:
    """Write JSON to stdout without rich markup, so it pipes cleanly into jq."""
    sys.stdout.write(json.dumps(data, indent=2, sort_keys=True) + "\n")


def error(message: str) -> None:
    """Report a failure on stderr."""
    err_console.print(f"[red]error:[/red] {message}", highlight=False, soft_wrap=True)


def success(message: str) -> None:
    """Confirm a change on stderr, keeping stdout for the thing the change produced."""
    err_console.print(message, highlight=False, soft_wrap=True)


def table(columns: Sequence[str], rows: Sequence[Sequence[Any]], empty: str) -> None:
    """Print rows as a borderless table, or a quiet note when there are none."""
    if not rows:
        err_console.print(empty, style="dim")
        return
    grid = Table(box=None, pad_edge=False, header_style="bold dim")
    for column in columns:
        grid.add_column(column, overflow="fold")
    for row in rows:
        grid.add_row(*("" if cell is None else str(cell) for cell in row))
    console.print(grid)


def issue_rows(
    issues: Sequence[Mapping[str, Any]], statuses: Mapping[str, str], people: Mapping[str, str]
) -> list[list[Any]]:
    """One table row per issue: key, status, priority, assignee, title."""
    return [
        [
            issue["key"],
            statuses.get(issue["status_id"], ""),
            PRIORITY_LABELS.get(issue.get("priority") or "none", ""),
            people.get(issue.get("assignee_id") or "", issue.get("assignee_id") or ""),
            issue["title"],
        ]
        for issue in issues
    ]


def issue_detail(
    issue: Mapping[str, Any],
    status: str,
    assignee: str,
    labels: Sequence[str],
    cycle: str | None,
    project: str | None,
    url: str,
    comments: Sequence[Mapping[str, Any]] = (),
) -> None:
    """Print one issue the way `gh issue view` does: header, fields, body, comments."""
    console.print(f"[bold]{issue['title']}[/bold] [dim]{issue['key']}[/dim]", highlight=False)
    fields = [
        ("Status", status),
        ("Priority", PRIORITY_LABELS.get(issue.get("priority") or "none") or "No priority"),
        ("Assignee", assignee or "Unassigned"),
        ("Labels", ", ".join(labels)),
        ("Cycle", cycle or ""),
        ("Project", project or ""),
        ("Estimate", issue.get("estimate") or ""),
        ("Due", issue.get("due_date") or ""),
        ("Updated", issue.get("updated_at") or ""),
    ]
    grid = Table.grid(padding=(0, 2))
    grid.add_column(style="dim")
    grid.add_column()
    for name, value in fields:
        if value:
            grid.add_row(name, str(value))
    console.print(grid)
    body = issue.get("body")
    console.print()
    console.print(Markdown(body) if body else "[dim]No description.[/dim]")
    for comment in comments:
        author = comment.get("author") or {}
        who = author.get("display_name") or comment.get("author_id")
        console.print()
        console.print(f"[bold]{who}[/bold] [dim]{comment.get('created_at', '')}[/dim]", highlight=False)
        console.print(Markdown(comment.get("body") or ""))
    console.print()
    console.print(f"[dim]{url}[/dim]", highlight=False)
