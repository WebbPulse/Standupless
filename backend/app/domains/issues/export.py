"""CSV export of the issues one list filter selects, one bounded page at a time.

A Lambda answer is capped in size and time, so an export is not one response but a
walk: each page reads teams in a fixed order and each team by issue number, and the
cursor is the team and the last number read. That keeps every page a key-bounded
query continued from where the last one stopped, so a workspace of any size exports
in pages of the same cost, and an issue created mid-walk lands in a later page
rather than shifting the ones already written.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from typing import Optional

from webbpulse.dynamodb import encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import digest_scope, resume_key
from app.common.db.dynamo.issues import Issue
from app.common.filter_resolution import resolve_issue_filter
from app.common.issue_filters import IssueFilter
from app.common.issue_keys import current
from app.common.issue_rules import require_team_reader, visible_team_ids

COLUMNS: tuple[str, ...] = (
    "ID",
    "Team",
    "Title",
    "Description",
    "Status",
    "Status type",
    "Priority",
    "Assignee",
    "Creator",
    "Labels",
    "Estimate",
    "Project",
    "Milestone",
    "Cycle",
    "Parent",
    "Start date",
    "Due date",
    "Created",
    "Updated",
    "Archived",
    "UUID",
)
"""The export's header row, named the way other trackers' CSV exports name them so an import maps them."""

PRIORITY_NAMES = {"none": "No priority", "urgent": "Urgent", "high": "High", "medium": "Medium", "low": "Low"}
"""Each stored priority as a person reads it."""

FORMULA_LEADS = ("=", "+", "-", "@", "\t", "\r")
"""Leading characters a spreadsheet reads as a formula, which a cell is defused against."""

DEFAULT_ROWS = 500

MAX_ROWS = 1000

SCAN_BUDGET = 4000
"""The most issue rows one page reads, so a narrow filter over a large team still answers in time."""

BYTE_BUDGET = 3_000_000
"""Roughly how much CSV one page carries, kept under the Lambda response cap after JSON escaping."""

READ_CHUNK = 200


def safe_cell(value: str) -> str:
    """A cell value a spreadsheet will show rather than evaluate.

    A title such as `=HYPERLINK(...)` is data in Standupless and must stay data in
    the sheet, so a leading formula character gets a quote in front of it.
    """
    if value and value.startswith(FORMULA_LEADS):
        return "'" + value
    return value


@dataclass
class _Names:
    """Every id-to-name lookup one page needs, each read at most once per page."""

    repositories: Repositories
    workspace_id: str
    teams: dict[str, tuple[str, str]] = field(default_factory=dict)
    statuses: dict[str, dict[str, tuple[str, str]]] = field(default_factory=dict)
    labels: dict[str, dict[str, str]] = field(default_factory=dict)
    cycles: dict[tuple[str, str], str] = field(default_factory=dict)
    projects: Optional[dict[str, str]] = None
    milestones: dict[tuple[str, str], str] = field(default_factory=dict)
    people: dict[str, str] = field(default_factory=dict)
    parents: dict[str, str] = field(default_factory=dict)

    def team(self, team_id: str) -> str:
        """The team's name."""
        if team_id not in self.teams:
            row = self.repositories.teams.get(self.workspace_id, team_id)
            self.teams[team_id] = (row.name, row.key_prefix) if row is not None else ("", "")
        return self.teams[team_id][0]

    def status(self, team_id: str, status_id: str) -> tuple[str, str]:
        """The status's name and category, hidden statuses included."""
        if team_id not in self.statuses:
            rows = self.repositories.team_config.list_statuses(self.workspace_id, team_id)
            self.statuses[team_id] = {row.status_id: (row.name, row.category) for row in rows}
        return self.statuses[team_id].get(status_id, (status_id, ""))

    def label(self, team_id: str, label_id: str) -> str:
        """The label's name, or its id when the label is gone."""
        if team_id not in self.labels:
            rows = self.repositories.team_config.list_labels(self.workspace_id, team_id)
            self.labels[team_id] = {row.label_id: row.name for row in rows}
        return self.labels[team_id].get(label_id, label_id)

    def cycle(self, team_id: str, cycle_id: Optional[str]) -> str:
        """The cycle's name, falling back to its number."""
        if not cycle_id:
            return ""
        key = (team_id, cycle_id)
        if key not in self.cycles:
            row = self.repositories.planning.get_cycle(self.workspace_id, team_id, cycle_id)
            if row is None:
                self.cycles[key] = ""
            else:
                self.cycles[key] = row.name or (f"Cycle {row.number}" if row.number is not None else "")
        return self.cycles[key]

    def project(self, project_id: Optional[str]) -> str:
        """The project's name, read with every other project in one query."""
        if not project_id:
            return ""
        if self.projects is None:
            self.projects = {
                row.project_id: row.name for row in self.repositories.planning.list_projects(self.workspace_id)
            }
        return self.projects.get(project_id, "")

    def milestone(self, project_id: Optional[str], milestone_id: Optional[str]) -> str:
        """The milestone's name."""
        if not project_id or not milestone_id:
            return ""
        key = (project_id, milestone_id)
        if key not in self.milestones:
            row = self.repositories.planning.get_milestone(self.workspace_id, project_id, milestone_id)
            self.milestones[key] = row.name if row is not None else ""
        return self.milestones[key]

    def load_people_and_parents(self, issues: list[Issue]) -> None:
        """Batch read every assignee, creator and parent the page names."""
        wanted_people = sorted(
            {person for issue in issues for person in (issue.assignee_id, issue.created_by) if person}
            - set(self.people)
        )
        if wanted_people:
            users = self.repositories.users.get_many(wanted_people)
            for user_id in wanted_people:
                user = users.get(user_id)
                self.people[user_id] = (user.display_name or user.email) if user is not None else ""
        wanted_parents = sorted({issue.parent_id for issue in issues if issue.parent_id} - set(self.parents))
        if wanted_parents:
            found = self.repositories.issues.get_many(self.workspace_id, wanted_parents)
            for parent_id in wanted_parents:
                parent = found.get(parent_id)
                self.parents[parent_id] = current(self.repositories.teams, parent).key if parent is not None else ""

    def person(self, user_id: Optional[str]) -> str:
        """A person's display name, loaded by `load_people_and_parents`."""
        return self.people.get(user_id, "") if user_id else ""

    def parent(self, parent_id: Optional[str]) -> str:
        """A parent issue's current key, loaded by `load_people_and_parents`."""
        return self.parents.get(parent_id, "") if parent_id else ""


def _row(names: _Names, issue: Issue) -> list[str]:
    """One issue as its CSV cells, in `COLUMNS` order."""
    status_name, category = names.status(issue.team_id, issue.status_id)
    return [
        issue.key,
        names.team(issue.team_id),
        issue.title,
        issue.body or "",
        status_name,
        category,
        PRIORITY_NAMES.get(issue.priority, issue.priority),
        names.person(issue.assignee_id),
        names.person(issue.created_by),
        ", ".join(names.label(issue.team_id, label_id) for label_id in issue.label_ids),
        issue.estimate or "",
        names.project(issue.project_id),
        names.milestone(issue.project_id, issue.project_milestone_id),
        names.cycle(issue.team_id, issue.cycle_id),
        names.parent(issue.parent_id),
        issue.start_date or "",
        issue.due_date or "",
        issue.created_at.isoformat(),
        issue.updated_at.isoformat(),
        issue.archived_at.isoformat() if issue.archived_at is not None else "",
        issue.issue_id,
    ]


@dataclass(frozen=True)
class ExportPage:
    """One page of an export: its CSV text, how many issues it holds and where the next starts."""

    csv: str
    rows: int
    next_cursor: Optional[str]


def export_page(
    repositories: Repositories,
    context: AuthzContext,
    wanted: IssueFilter,
    *,
    team_id: Optional[str],
    cursor: Optional[str],
    limit: int,
) -> ExportPage:
    """One page of the CSV export of every issue the caller may see that `wanted` keeps.

    The first page, the one asked for without a cursor, starts with the header row,
    so concatenating the pages in order is the whole file. A page may hold fewer
    than `limit` issues, even none, when it stops at the read or size budget; only
    a missing `next_cursor` means the export is finished.
    """
    if team_id is not None:
        require_team_reader(repositories, context, team_id)
        teams = [team_id]
    else:
        teams = visible_team_ids(repositories, context)

    scope = digest_scope(f"export:{context.workspace_id}:{','.join(teams)}:{wanted.fingerprint()}")
    position = resume_key(cursor, scope) if cursor else None
    team_index = int(position.get("team", 0)) if position else 0
    after = int(position.get("after", 0)) if position else 0

    wanted = resolve_issue_filter(repositories, context.workspace_id, teams, wanted)
    categories: dict[str, str] = {}
    if wanted.needs_categories:
        for candidate in teams:
            categories.update(
                {
                    row.status_id: row.category
                    for row in repositories.team_config.list_statuses(context.workspace_id, candidate)
                }
            )

    matched: list[Issue] = []
    scanned = 0
    size = 0
    finished = True
    while team_index < len(teams):
        if len(matched) >= limit or scanned >= SCAN_BUDGET or size >= BYTE_BUDGET:
            finished = False
            break
        chunk = repositories.issues.page_after(context.workspace_id, teams[team_index], after, limit=READ_CHUNK)
        for issue in chunk:
            scanned += 1
            after = issue.number
            shown = current(repositories.teams, issue)
            if wanted.matches(shown, categories):
                matched.append(shown)
                size += len(shown.title) + len(shown.body or "") + 200
            if len(matched) >= limit or size >= BYTE_BUDGET:
                break
        else:
            if len(chunk) < READ_CHUNK:
                team_index += 1
                after = 0

    names = _Names(repositories, context.workspace_id)
    names.load_people_and_parents(matched)
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    if not position:
        writer.writerow(COLUMNS)
    for issue in matched:
        writer.writerow([safe_cell(cell) for cell in _row(names, issue)])

    next_cursor = None if finished else encode_start_key({"team": team_index, "after": after}, scope=scope)
    return ExportPage(csv=buffer.getvalue(), rows=len(matched), next_cursor=next_cursor)
