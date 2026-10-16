"""Issue import routes: a dry run of a CSV against a team, the import itself, and its jobs.

Every route is for a workspace owner or admin, since an import writes hundreds
of issues and creates labels in a team at once. The dry run reads the whole file
and writes nothing, so the settings screen can show every row problem before the
admin commits. The import runs behind a queue a page at a time, so the start
route answers 202 with the queued job and the caller polls it, or waits for the
inbox notice.

A Linear import reads a Linear workspace through Linear's API with a personal
key the admin pastes. The key is checked against Linear first, then sealed
beside the job until it ends, and never appears in a response, a log or the
audit row. Any import can be cancelled; what it already wrote stays.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status

from app.common import audit, issue_import, linear_import
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.csv_import import CsvRejected
from app.common.issue_rules import require_team_member, unprocessable
from app.common.linear_api import LinearAuthFailed, LinearError
from app.domains.integrations.schemas.imports import (
    IssueImportListRead,
    IssueImportPreviewRead,
    IssueImportRead,
    IssueImportRequest,
    LinearImportRequest,
    LinearKeyRequest,
    LinearTeamListRead,
    LinearTeamRead,
)

router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}


def _unavailable(exc: Exception) -> HTTPException:
    """The 503 an environment without imports answers with."""
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={"error_code": "NOT_CONFIGURED", "message": str(exc)},
    )


def linear_refusal(exc: LinearError) -> HTTPException:
    """The answer to a Linear call that failed: 400 for a refused key, 502 for anything else."""
    if isinstance(exc, LinearAuthFailed):
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error_code": "LINEAR_KEY_REFUSED",
                "message": "Linear refused the API key. Check it has read access and has not been revoked.",
            },
        )
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail={"error_code": "LINEAR_UNAVAILABLE", "message": "Linear did not answer, try again shortly."},
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


@router.post("/{workspace_id}/imports/linear/teams", response_model=LinearTeamListRead)
def list_linear_teams(
    body: LinearKeyRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
) -> LinearTeamListRead:
    """The Linear teams a personal API key can read, to choose from; the key is not kept."""
    try:
        teams = linear_import.read_teams(body.api_key.strip())
    except LinearError as exc:
        raise linear_refusal(exc) from None
    return LinearTeamListRead(items=[LinearTeamRead(**team) for team in teams])


@router.post(
    "/{workspace_id}/imports/linear",
    response_model=IssueImportRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_linear_import(
    body: LinearImportRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueImportRead:
    """Queue an import of Linear teams into Standupless teams, refusing a second while one is running."""
    for choice in body.teams:
        require_team_member(repositories, context, choice.team_id)
    try:
        api_key = body.api_key.strip()
        choices = [(choice.linear_team_id, choice.team_id) for choice in body.teams]
        mappings = linear_import.team_mappings(api_key, choices)
        job = issue_import.start_linear_import(repositories, context, api_key, mappings)
    except LinearError as exc:
        raise linear_refusal(exc) from None
    except linear_import.UnknownLinearTeam:
        raise unprocessable("A chosen Linear team is not readable with this key, or was chosen twice") from None
    except issue_import.ImportUnavailable as exc:
        raise _unavailable(exc) from exc
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
        target_label="Linear",
        after={
            "preset": job.preset,
            "teams": [{"linear_key": mapping.linear_key, "team_id": mapping.team_id} for mapping in mappings],
        },
    )
    return IssueImportRead.from_job(job)


@router.post("/{workspace_id}/imports/{import_id}/cancel", response_model=IssueImportRead)
def cancel_issue_import(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    import_id: Annotated[str, Path(min_length=1, max_length=64)],
) -> IssueImportRead:
    """Stop an import that is queued or running, keeping what it already wrote; a finished one is answered as is."""
    try:
        job = issue_import.cancel_import(context.workspace_id, import_id)
    except issue_import.ImportUnavailable as exc:
        raise _unavailable(exc) from exc
    except issue_import.ImportNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND) from None
    audit.record(
        repositories,
        context,
        "import.cancelled",
        target_type="import",
        target_id=job.import_id,
        target_label=job.file_name,
        after={"status": job.status},
    )
    return IssueImportRead.from_job(job)
