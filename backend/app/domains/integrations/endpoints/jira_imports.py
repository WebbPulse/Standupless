"""Jira import routes: the projects an account can browse, a preview of an import, and the import itself.

Every route is for a workspace owner or admin, like the other import routes. The
admin gives the Jira Cloud site, an account email and an Atlassian API token,
which are checked against Jira on each call. The project list and the preview
use them for that request only; the import seals them beside the job until the
job ends. They never appear in a response, a log or the audit row. The job itself
is followed and cancelled through the shared import routes.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.common import audit, issue_import
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.issue_rules import require_team_member, unprocessable
from app.domains.integrations import jira_api, jira_import
from app.domains.integrations.jira_api import JiraAuthFailed, JiraError
from app.domains.integrations.schemas.imports import IssueImportRead
from app.domains.integrations.schemas.jira_imports import (
    JiraCredentialsRequest,
    JiraImportPreviewRead,
    JiraImportRequest,
    JiraProjectListRead,
    JiraProjectPreviewRead,
    JiraProjectRead,
)

router = APIRouter()

UNKNOWN_PROJECT = "A chosen Jira project is not one this account can browse, or was chosen twice"

INVALID_SITE = "The site must be a Jira Cloud site such as https://your-team.atlassian.net"


def jira_refusal(exc: JiraError) -> HTTPException:
    """The answer to a Jira call that failed: 400 for refused credentials, 502 for anything else."""
    if isinstance(exc, JiraAuthFailed):
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error_code": "JIRA_CREDENTIALS_REFUSED",
                "message": "Jira refused the email and API token. Check the token has not expired or been revoked.",
            },
        )
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail={"error_code": "JIRA_UNAVAILABLE", "message": "Jira did not answer, try again shortly."},
    )


def _site(value: str) -> str:
    """The site as a Jira Cloud base URL, refusing any other host."""
    try:
        return jira_api.site_url(value)
    except jira_api.InvalidSite:
        raise unprocessable(INVALID_SITE) from None


@router.post("/{workspace_id}/imports/jira/projects", response_model=JiraProjectListRead)
def list_jira_projects(
    body: JiraCredentialsRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
) -> JiraProjectListRead:
    """The Jira projects an account can browse on a site, to choose from; the credentials are not kept."""
    site = _site(body.site_url)
    credentials = body.credentials()
    try:
        projects = jira_import.read_projects(site, credentials.email, credentials.token)
    except JiraError as exc:
        raise jira_refusal(exc) from None
    return JiraProjectListRead(site_url=site, items=[JiraProjectRead(**project) for project in projects])


def _refusal(exc: Exception) -> HTTPException:
    """The answer to a preview or import the chosen projects do not fit."""
    if isinstance(exc, JiraError):
        return jira_refusal(exc)
    if isinstance(exc, jira_import.UnknownJiraProject):
        return unprocessable(UNKNOWN_PROJECT)
    return unprocessable(str(exc))


CHOICE_ERRORS = (JiraError, jira_import.UnknownJiraProject, jira_import.InvalidJql, jira_import.UnknownStatusChoice)


@router.post("/{workspace_id}/imports/jira/preview", response_model=JiraImportPreviewRead)
def preview_jira_import(
    body: JiraImportRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> JiraImportPreviewRead:
    """What importing the chosen Jira projects would do, read from Jira and writing nothing."""
    site = _site(body.site_url)
    for choice in body.projects:
        require_team_member(repositories, context, choice.team_id)
    try:
        previews = jira_import.preview_projects(
            repositories, context.workspace_id, site, body.credentials(), [choice.choice() for choice in body.projects]
        )
    except CHOICE_ERRORS as exc:
        raise _refusal(exc) from None
    return JiraImportPreviewRead(
        site_url=site, projects=[JiraProjectPreviewRead.from_preview(preview) for preview in previews]
    )


@router.post(
    "/{workspace_id}/imports/jira",
    response_model=IssueImportRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_jira_import(
    body: JiraImportRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueImportRead:
    """Queue an import of Jira projects into Standupless teams, refusing a second while one is running."""
    site = _site(body.site_url)
    try:
        job = jira_import.start_jira_import(
            repositories, context, site, body.credentials(), [choice.choice() for choice in body.projects]
        )
    except CHOICE_ERRORS as exc:
        raise _refusal(exc) from None
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
        target_label="Jira",
        after=jira_import.audit_after(job),
    )
    return IssueImportRead.from_job(job)
