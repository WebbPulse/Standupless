"""Issue import routes: a dry run of a CSV against a team, the import itself, and its jobs.

Every route is for a workspace owner or admin, since an import writes hundreds
of issues and creates labels in a team at once. The dry run reads the whole file
and writes nothing, so the settings screen can show every row problem before the
admin commits. The import runs behind a queue a page at a time, so the start
route answers 202 with the queued job and the caller polls it, or waits for the
inbox notice.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status

from app.common import audit, issue_import
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.csv_import import CsvRejected
from app.common.issue_rules import require_team_member, unprocessable
from app.domains.integrations.schemas.imports import (
    IssueImportListRead,
    IssueImportPreviewRead,
    IssueImportRead,
    IssueImportRequest,
)

router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}


def _unavailable(exc: Exception) -> HTTPException:
    """The 503 an environment without imports answers with."""
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={"error_code": "NOT_CONFIGURED", "message": str(exc)},
    )


def _rejected(exc: CsvRejected) -> HTTPException:
    """The 422 a file that cannot be imported answers with."""
    return unprocessable(str(exc))


@router.post("/{workspace_id}/imports/preview", response_model=IssueImportPreviewRead)
def preview_issue_import(
    body: IssueImportRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueImportPreviewRead:
    """Read a file against one team and answer what an import would do, row by row, writing nothing."""
    require_team_member(repositories, context, body.team_id)
    try:
        preview = issue_import.preview_import(
            repositories, context.workspace_id, body.team_id, body.preset, body.csv, body.mapping
        )
    except CsvRejected as exc:
        raise _rejected(exc) from exc
    return IssueImportPreviewRead.from_preview(preview)


@router.post(
    "/{workspace_id}/imports",
    response_model=IssueImportRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_issue_import(
    body: IssueImportRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueImportRead:
    """Queue an import of a file into one team, refusing a second while one is running."""
    try:
        job = issue_import.start_import(
            repositories,
            context,
            body.team_id,
            body.preset,
            body.csv,
            body.mapping,
            file_name=body.file_name,
        )
    except issue_import.ImportUnavailable as exc:
        raise _unavailable(exc) from exc
    except CsvRejected as exc:
        raise _rejected(exc) from exc
    except issue_import.ImportInProgress as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": str(exc)},
        ) from exc
    audit.record(
        repositories,
        context,
        "import.started",
        target_type="import",
        target_id=job.import_id,
        target_label=job.file_name,
        after={"team_id": job.team_id, "preset": job.preset, "total_rows": job.total_rows},
    )
    return IssueImportRead.from_job(job)


@router.get("/{workspace_id}/imports", response_model=IssueImportListRead)
def list_issue_imports(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
) -> IssueImportListRead:
    """The workspace's most recent imports, newest first, without their row problems."""
    try:
        jobs = issue_import.list_jobs(context.workspace_id)
    except issue_import.ImportUnavailable as exc:
        raise _unavailable(exc) from exc
    return IssueImportListRead(items=[IssueImportRead.from_job(job, with_problems=False) for job in jobs])


@router.get("/{workspace_id}/imports/{import_id}", response_model=IssueImportRead)
def get_issue_import(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    import_id: Annotated[str, Path(min_length=1, max_length=64)],
) -> IssueImportRead:
    """One import with its progress and every row problem it kept."""
    try:
        job = issue_import.load_job(context.workspace_id, import_id)
    except issue_import.ImportUnavailable as exc:
        raise _unavailable(exc) from exc
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return IssueImportRead.from_job(job)
