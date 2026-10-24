"""Asana import routes: the projects a token can read, a preview of an import, and the import itself.

Every route is for a workspace owner or admin, like the other import routes. The
admin pastes an Asana personal access token, which is checked against Asana on
each call. The project list and the preview use it for that request only; the
import seals it beside the job until the job ends. It never appears in a
response, a log or the audit row. The job itself is followed and cancelled
through the shared import routes.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.common import audit, issue_import
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.issue_rules import require_team_member, unprocessable
from app.domains.integrations import asana_import
from app.domains.integrations.asana_api import AsanaAuthFailed, AsanaError
from app.domains.integrations.schemas.asana_imports import (
    AsanaImportPreviewRead,
    AsanaImportRequest,
    AsanaProjectListRead,
    AsanaProjectPreviewRead,
    AsanaProjectRead,
    AsanaTokenRequest,
)
from app.domains.integrations.schemas.imports import IssueImportRead

router = APIRouter()

UNKNOWN_PROJECT = "A chosen Asana project is not readable with this token, or was chosen twice"


def asana_refusal(exc: AsanaError) -> HTTPException:
    """The answer to an Asana call that failed: 400 for a refused token, 502 for anything else."""
    if isinstance(exc, AsanaAuthFailed):
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error_code": "ASANA_TOKEN_REFUSED",
                "message": "Asana refused the personal access token. Check it has not expired or been revoked.",
            },
        )
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail={"error_code": "ASANA_UNAVAILABLE", "message": "Asana did not answer, try again shortly."},
    )


@router.post("/{workspace_id}/imports/asana/projects", response_model=AsanaProjectListRead)
def list_asana_projects(
    body: AsanaTokenRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
) -> AsanaProjectListRead:
    """The Asana projects a personal access token can read, to choose from; the token is not kept."""
    try:
        projects = asana_import.read_projects(body.token.strip())
    except AsanaError as exc:
        raise asana_refusal(exc) from None
    return AsanaProjectListRead(items=[AsanaProjectRead(**project) for project in projects])


@router.post("/{workspace_id}/imports/asana/preview", response_model=AsanaImportPreviewRead)
def preview_asana_import(
    body: AsanaImportRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> AsanaImportPreviewRead:
    """What importing the chosen Asana projects would do, read from Asana and writing nothing."""
    for choice in body.projects:
        require_team_member(repositories, context, choice.team_id)
    try:
        previews = asana_import.preview_projects(
            repositories, context.workspace_id, body.token.strip(), [choice.choice() for choice in body.projects]
        )
    except AsanaError as exc:
        raise asana_refusal(exc) from None
    except asana_import.UnknownAsanaProject:
        raise unprocessable(UNKNOWN_PROJECT) from None
    except asana_import.UnknownStatusChoice as exc:
        raise unprocessable(str(exc)) from None
    return AsanaImportPreviewRead(projects=[AsanaProjectPreviewRead.from_preview(preview) for preview in previews])


@router.post(
    "/{workspace_id}/imports/asana",
    response_model=IssueImportRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_asana_import(
    body: AsanaImportRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueImportRead:
    """Queue an import of Asana projects into Standupless teams, refusing a second while one is running."""
    try:
        job = asana_import.start_asana_import(
            repositories, context, body.token.strip(), [choice.choice() for choice in body.projects]
        )
    except AsanaError as exc:
        raise asana_refusal(exc) from None
    except asana_import.UnknownAsanaProject:
        raise unprocessable(UNKNOWN_PROJECT) from None
    except asana_import.UnknownStatusChoice as exc:
        raise unprocessable(str(exc)) from None
    except issue_import.ImportUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error_code": "NOT_CONFIGURED", "message": str(exc)},
        ) from exc
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
        target_label="Asana",
        after={
            "preset": job.preset,
            "projects": [
                {"project_gid": mapping.project_gid, "team_id": mapping.team_id} for mapping in job.asana_projects
            ],
        },
    )
    return IssueImportRead.from_job(job)
