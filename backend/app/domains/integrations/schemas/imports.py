"""The shapes the issue import routes take and answer."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.common.csv_import import MAX_CSV_BYTES, RowProblem
from app.common.issue_import import ImportJob, ImportKind, ImportStatus, Preview, ResolvedRow
from app.common.linear_import import phases
from app.domains.integrations import shortcut_import

ImportPreset = Literal["generic", "jira", "linear", "asana", "shortcut", "pivotal", "trello"]

GITHUB_PHASES: list[tuple[str, Optional[int]]] = [("issues", None)]
"""The one phase a GitHub import walks, its repository's issues a page at a time."""


class IssueImportRequest(BaseModel):
    """The body both the dry run and the import take: a file, a team, a preset and any mapping changes."""

    team_id: str = Field(min_length=1, max_length=64)
    preset: ImportPreset = "generic"
    csv: str = Field(
        min_length=1,
        max_length=MAX_CSV_BYTES,
        description=(
            "The whole CSV file as text, header row first. With the trello preset, the board's JSON export instead."
        ),
    )
    file_name: str = Field(default="", max_length=200)
    mapping: Optional[dict[str, Optional[str]]] = Field(
        default=None,
        description=(
            "Overrides of the preset's mapping, field to header name; null unmaps a field. "
            "Fields are title, description, status, priority, assignee, labels, estimate, "
            "due_date, source_key, created_at, parent and completed. A parent column names another row of "
            "the file by its source key or its title, and a non-empty completed column puts the row in a "
            "completed status."
        ),
    )


class RowProblemRead(BaseModel):
    """One problem with one row: an error skips the row, a warning drops or replaces one value."""

    row: int
    field: Optional[str] = None
    severity: Literal["error", "warning"]
    message: str

    @classmethod
    def from_problem(cls, problem: RowProblem) -> "RowProblemRead":
        """One problem as the API shows it."""
        return cls(row=problem.row, field=problem.field, severity=problem.severity, message=problem.message)


class ImportRowRead(BaseModel):
    """One row of the dry run as the issue it would become."""

    row: int
    title: str
    status_name: str
    priority: str
    assignee_id: Optional[str] = None
    labels: list[str]
    estimate: Optional[str] = None
    due_date: Optional[str] = None
    source_key: Optional[str] = None
    created_at: Optional[datetime] = None
    parent_row: Optional[int] = Field(default=None, description="The row of the file this row becomes a sub-issue of.")
    importable: bool

    @classmethod
    def from_row(cls, row: ResolvedRow) -> "ImportRowRead":
        """One resolved row as the API shows it."""
        return cls(
            row=row.line,
            title=row.title,
            status_name=row.status_name,
            priority=row.priority,
            assignee_id=row.assignee_id,
            labels=row.label_names,
            estimate=row.estimate,
            due_date=row.due_date,
            source_key=row.external_ref,
            created_at=row.created_at,
            parent_row=row.parent_row,
            importable=row.importable,
        )


class StatusMappingRead(BaseModel):
    """How many importable rows carry one source status, and the status they land in."""

    source: str
    status_name: str
    count: int


class IssueImportPreviewRead(BaseModel):
    """What an import of a file would do, computed without writing anything."""

    headers: list[str]
    mapping: dict[str, Optional[str]]
    total_rows: int
    importable_rows: int
    problems: list[RowProblemRead]
    problems_truncated: bool
    rows: list[ImportRowRead]
    new_labels: list[str]
    statuses: list[StatusMappingRead]
    parent_links: int = Field(default=0, description="How many rows would become sub-issues of another row.")

    @classmethod
    def from_preview(cls, preview: Preview) -> "IssueImportPreviewRead":
        """One dry run as the API shows it."""
        return cls(
            headers=preview.headers,
            mapping=preview.mapping,
            total_rows=preview.total_rows,
            importable_rows=preview.importable_rows,
            problems=[RowProblemRead.from_problem(problem) for problem in preview.problems],
            problems_truncated=preview.problems_truncated,
            rows=[ImportRowRead.from_row(row) for row in preview.rows],
            new_labels=preview.new_labels,
            statuses=[
                StatusMappingRead(source=source, status_name=name, count=count)
                for source, name, count in preview.statuses
            ],
            parent_links=preview.parent_links,
        )


class LinearTeamMappingRead(BaseModel):
    """One Linear team a Linear import reads and the Standupless team it writes into."""

    linear_team_id: str
    linear_key: str
    name: str
    team_id: str


class SourceTeamMappingRead(BaseModel):
    """One team of the source tool an API import reads, such as a Shortcut team, and the team it writes into."""

    source_id: str
    key: str
    name: str
    team_id: str


class IssueImportRead(BaseModel):
    """One import job and how far it has got."""

    import_id: str
    workspace_id: str
    team_id: str
    kind: ImportKind = "csv"
    preset: str
    file_name: str
    status: ImportStatus
    requested_by: str
    created_at: datetime
    updated_at: datetime
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    total_rows: int
    processed_rows: int
    created_count: int
    skipped_count: int
    labels_created: int
    linked_count: int = Field(default=0, description="How many imported issues were made sub-issues of another.")
    problem_count: int
    problems: list[RowProblemRead]
    problems_truncated: bool
    error: Optional[str] = None
    updated_count: int = Field(
        default=0, description="How many issues a Linear import found already imported and updated."
    )
    counts: dict[str, int] = Field(
        default_factory=dict,
        description="A Linear import's tallies: issues, comments, labels, cycles, projects, milestones and more.",
    )
    linear_teams: list[LinearTeamMappingRead] = Field(default_factory=list)
    source_teams: list[SourceTeamMappingRead] = Field(
        default_factory=list, description="The teams a Shortcut import reads and the teams each writes into."
    )
    github_repository_id: Optional[str] = Field(
        default=None, description="The repository a GitHub import reads; its full name is the file name."
    )
    phase: Optional[str] = Field(
        default=None, description="What a running Linear, GitHub or Shortcut import is reading now."
    )
    phase_index: int = 0
    phase_count: int = 0

    @classmethod
    def from_job(cls, job: ImportJob, *, with_problems: bool = True) -> "IssueImportRead":
        """One job as the API shows it.

        A list leaves the row problems out, since each job may hold hundreds.
        """
        steps: list[tuple[str, Optional[int]]] = []
        if job.kind == "linear":
            steps = phases(job)
        elif job.kind == "github":
            steps = GITHUB_PHASES
        elif job.kind == "shortcut":
            steps = shortcut_import.phases(job)
        current = steps[job.phase_index] if job.phase_index < len(steps) else None
        return cls(
            import_id=job.import_id,
            workspace_id=job.workspace_id,
            team_id=job.team_id,
            kind=job.kind,
            preset=job.preset,
            file_name=job.file_name,
            status=job.status,
            requested_by=job.requested_by,
            created_at=job.created_at,
            updated_at=job.updated_at,
            started_at=job.started_at,
            finished_at=job.finished_at,
            total_rows=job.total_rows,
            processed_rows=job.processed_rows,
            created_count=job.created_count,
            skipped_count=job.skipped_count,
            labels_created=job.labels_created,
            linked_count=job.linked_count,
            problem_count=len(job.problems),
            problems=[RowProblemRead.from_problem(problem) for problem in job.problems] if with_problems else [],
            problems_truncated=job.problems_truncated,
            error=job.error,
            updated_count=job.updated_count,
            counts=dict(job.counts),
            linear_teams=[LinearTeamMappingRead(**mapping.model_dump()) for mapping in job.linear_teams],
            source_teams=[SourceTeamMappingRead(**mapping.model_dump()) for mapping in job.source_teams],
            github_repository_id=job.github_repository_id or None,
            phase=current[0] if current is not None else None,
            phase_index=min(job.phase_index, len(steps)),
            phase_count=len(steps),
        )


class IssueImportListRead(BaseModel):
    """A workspace's most recent imports, newest first."""

    items: list[IssueImportRead]


class LinearKeyRequest(BaseModel):
    """A Linear personal API key, used for this request only and never stored."""

    api_key: str = Field(min_length=1, max_length=200, description="A Linear personal API key with read access.")


class LinearTeamRead(BaseModel):
    """One team the key can read in Linear."""

    id: str
    key: str
    name: str


class LinearTeamListRead(BaseModel):
    """Every team the key can read in Linear."""

    items: list[LinearTeamRead]


class LinearTeamChoice(BaseModel):
    """One Linear team to import and the Standupless team it goes into."""

    linear_team_id: str = Field(min_length=1, max_length=64)
    team_id: str = Field(min_length=1, max_length=64)


class LinearImportRequest(BaseModel):
    """A Linear import: the key, sealed while the job runs and deleted after, and the team mapping."""

    api_key: str = Field(min_length=1, max_length=200, description="A Linear personal API key with read access.")
    teams: list[LinearTeamChoice] = Field(min_length=1, max_length=50)


class GitHubImportRepositoryRead(BaseModel):
    """One repository the workspace's installed GitHub App covers, to import the Issues of."""

    repository_id: str
    full_name: str
    private: bool
    team_id: Optional[str] = Field(default=None, description="The team the repository is pinned to, if any.")


class GitHubImportRepositoryListRead(BaseModel):
    """Every repository the installation covers, by name; empty when the App is not installed or is suspended."""

    items: list[GitHubImportRepositoryRead]


class GitHubImportRequest(BaseModel):
    """A GitHub import: one repository the installation covers and the team its issues go into."""

    repository_id: str = Field(min_length=1, max_length=32, pattern=r"^[0-9]+$")
    team_id: str = Field(min_length=1, max_length=64)


class ShortcutTokenRequest(BaseModel):
    """A Shortcut API token, used for this request only and never stored."""

    api_token: str = Field(min_length=1, max_length=200, description="A Shortcut API token from Settings, API Tokens.")


class ShortcutTeamRead(BaseModel):
    """One team the token can read in Shortcut."""

    id: str
    key: str = Field(description="The team's mention name in Shortcut.")
    name: str


class ShortcutTeamListRead(BaseModel):
    """Every team the token can read in Shortcut that is not archived."""

    items: list[ShortcutTeamRead]


class ShortcutTeamChoice(BaseModel):
    """One Shortcut team to import and the Standupless team it goes into."""

    shortcut_team_id: str = Field(min_length=1, max_length=64)
    team_id: str = Field(min_length=1, max_length=64)


class ShortcutImportRequest(BaseModel):
    """A Shortcut import or its preview: the token, sealed while the job runs and deleted after, and the teams."""

    api_token: str = Field(min_length=1, max_length=200, description="A Shortcut API token from Settings, API Tokens.")
    teams: list[ShortcutTeamChoice] = Field(min_length=1, max_length=50)


class ShortcutPreviewTeamRead(BaseModel):
    """What importing one Shortcut team would bring over."""

    shortcut_team_id: str
    name: str
    team_id: str
    stories: int
    stories_capped: bool = Field(description="Whether the team holds more stories than the preview counts.")
    epics: int
    iterations: int
    statuses: list[StatusMappingRead]
    new_labels: list[str]
    matched_owners: int = Field(description="Story owners who match a member by email.")
    unmatched_owners: int = Field(description="Story owners who match no member, whose stories are left unassigned.")


class ShortcutImportPreviewRead(BaseModel):
    """What a Shortcut import would do, team by team, computed without writing anything."""

    teams: list[ShortcutPreviewTeamRead]
