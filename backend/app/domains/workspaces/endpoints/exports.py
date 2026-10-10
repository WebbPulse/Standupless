"""Workspace export routes: start an export of the whole workspace, and read its jobs.

Every route is for a workspace owner or admin. The export itself runs in its own
function behind a queue, so the start route answers 202 with the queued job and
the caller polls the job, or waits for the inbox notice, until it is ready. A
ready job's read carries a fresh short-lived download link each time, so a link
that leaks expires within minutes while the bundle stays fetchable for its
retention window.

A personal API key of an owner or admin may start and read exports with the
`settings:write` or `settings:read` scope plus `admin`, because a scripted backup
is the main reason to want one. A workspace key never holds `admin`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Path, status

from app.common import audit, workspace_export
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.domains.workspaces.schemas.export import (
    WorkspaceExportCreate,
    WorkspaceExportListRead,
    WorkspaceExportRead,
)

router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}


def _unavailable(exc: Exception) -> HTTPException:
    """The 503 an environment without exports answers with."""
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={"error_code": "NOT_CONFIGURED", "message": str(exc)},
    )


@router.post(
    "/{workspace_id}/exports",
    response_model=WorkspaceExportRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_workspace_export(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    body: Annotated[WorkspaceExportCreate | None, Body()] = None,
) -> WorkspaceExportRead:
    """Queue an export of the whole workspace, refusing a second while one is running."""
    request = body or WorkspaceExportCreate()
    try:
        job = workspace_export.start_export(context, include_emails=request.include_emails)
    except workspace_export.ExportUnavailable as exc:
        raise _unavailable(exc) from exc
    except workspace_export.ExportInProgress as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": str(exc)},
        ) from exc
    audit.record(
        repositories,
        context,
        "export.started",
        target_type="export",
        target_id=job.export_id,
        after={"emails_masked": job.emails_masked},
    )
    return WorkspaceExportRead.from_job(job, workspace_export.download_for(job))


@router.get("/{workspace_id}/exports", response_model=WorkspaceExportListRead)
def list_workspace_exports(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
) -> WorkspaceExportListRead:
    """The workspace's most recent exports, newest first, without download links."""
    try:
        jobs = workspace_export.list_jobs(context.workspace_id)
    except workspace_export.ExportUnavailable as exc:
        raise _unavailable(exc) from exc
    return WorkspaceExportListRead(items=[WorkspaceExportRead.from_job(job) for job in jobs])


@router.get("/{workspace_id}/exports/{export_id}", response_model=WorkspaceExportRead)
def get_workspace_export(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    export_id: Annotated[str, Path(min_length=1, max_length=64)],
) -> WorkspaceExportRead:
    """One export, with a fresh download link once it is ready."""
    try:
        job = workspace_export.load_job(context.workspace_id, export_id)
    except workspace_export.ExportUnavailable as exc:
        raise _unavailable(exc) from exc
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return WorkspaceExportRead.from_job(job, workspace_export.download_for(job))
