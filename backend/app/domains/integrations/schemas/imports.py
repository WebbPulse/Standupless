"""The shapes the issue import routes take and answer."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.common.csv_import import MAX_CSV_BYTES, RowProblem
from app.common.issue_import import ImportJob, ImportStatus, Preview, ResolvedRow

ImportPreset = Literal["generic", "jira", "linear"]


class IssueImportRequest(BaseModel):
    """The body both the dry run and the import take: a file, a team, a preset and any mapping changes."""

    team_id: str = Field(min_length=1, max_length=64)
    preset: ImportPreset = "generic"
    csv: str = Field(
        min_length=1, max_length=MAX_CSV_BYTES, description="The whole CSV file as text, header row first."
    )
    file_name: str = Field(default="", max_length=200)
    mapping: Optional[dict[str, Optional[str]]] = Field(
        default=None,
        description=(
            "Overrides of the preset's mapping, field to header name; null unmaps a field. "
            "Fields are title, description, status, priority, assignee, labels, estimate, "
            "due_date, source_key and created_at."
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
        )


class IssueImportRead(BaseModel):
    """One import job and how far it has got."""

    import_id: str
    workspace_id: str
    team_id: str
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
    problem_count: int
    problems: list[RowProblemRead]
    problems_truncated: bool
    error: Optional[str] = None

    @classmethod
    def from_job(cls, job: ImportJob, *, with_problems: bool = True) -> "IssueImportRead":
        """One job as the API shows it.

        A list leaves the row problems out, since each job may hold hundreds.
        """
        return cls(
            import_id=job.import_id,
            workspace_id=job.workspace_id,
            team_id=job.team_id,
            preset=job.preset,
            file_name=job.file_name,
            status=job.status,
            requested_by=job.requested_by,
            created_at=job.created_at,
            updated_at=job.updated_at,
            started_at=job.started_at,
            finished_at=job.finished_at,
            total_rows=job.total_rows,
            processed_rows=job.cursor,
            created_count=job.created_count,
            skipped_count=job.skipped_count,
            labels_created=job.labels_created,
            problem_count=len(job.problems),
            problems=[RowProblemRead.from_problem(problem) for problem in job.problems] if with_problems else [],
            problems_truncated=job.problems_truncated,
            error=job.error,
        )


class IssueImportListRead(BaseModel):
    """A workspace's most recent imports, newest first."""

    items: list[IssueImportRead]
