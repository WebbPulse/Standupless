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

A GitHub import reads one repository's Issues through the workspace's installed
GitHub App, so it needs no key: the admin picks a repository the installation
covers and the team the issues go into.

A Shortcut import reads Shortcut's REST API with an API token the admin pastes,
handled exactly as a Linear key is: checked against Shortcut first, sealed beside
the job until it ends, and never in a response, a log or the audit row. Its
preview reads the chosen teams and answers what would come over without writing.
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
from app.domains.integrations import github_import, shortcut_import
from app.domains.integrations.schemas.imports import (
    GitHubImportRepositoryListRead,
    GitHubImportRepositoryRead,
    GitHubImportRequest,
    IssueImportListRead,
    IssueImportPreviewRead,
    IssueImportRead,
    IssueImportRequest,
    LinearImportPreviewRead,
    LinearImportRequest,
    LinearKeyRequest,
    LinearPreviewTeamRead,
    LinearTeamListRead,
    LinearTeamRead,
    ShortcutImportPreviewRead,
    ShortcutImportRequest,
    ShortcutPreviewTeamRead,
    ShortcutTeamListRead,
    ShortcutTeamRead,
    ShortcutTokenRequest,
)
from app.domains.integrations.shortcut_api import ShortcutAuthFailed, ShortcutError

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


def shortcut_refusal(exc: ShortcutError) -> HTTPException:
    """The answer to a Shortcut call that failed: 400 for a refused token, 502 for anything else."""
    if isinstance(exc, ShortcutAuthFailed):
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error_code": "SHORTCUT_TOKEN_REFUSED",
                "message": "Shortcut refused the API token. Check it is current and has not been revoked.",
            },
        )
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail={"error_code": "SHORTCUT_UNAVAILABLE", "message": "Shortcut did not answer, try again shortly."},
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


def _linear_choices(body: LinearImportRequest) -> list[tuple[str, str, bool, bool]]:
    """The chosen Linear teams as `team_mappings` takes them."""
    return [
        (choice.linear_team_id, choice.team_id, choice.create_statuses, choice.import_templates)
        for choice in body.teams
    ]


@router.post("/{workspace_id}/imports/linear/preview", response_model=LinearImportPreviewRead)
def preview_linear_import(
    body: LinearImportRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LinearImportPreviewRead:
    """The statuses and templates importing the chosen Linear teams would create, team by team, writing nothing."""
    for choice in body.teams:
        require_team_member(repositories, context, choice.team_id)
    api_key = body.api_key.strip()
    try:
        mappings = linear_import.team_mappings(api_key, _linear_choices(body))
        teams = linear_import.preview(repositories, context.workspace_id, api_key, mappings)
    except LinearError as exc:
        raise linear_refusal(exc) from None
    except linear_import.UnknownLinearTeam:
        raise unprocessable("A chosen Linear team is not readable with this key, or was chosen twice") from None
    return LinearImportPreviewRead(
        teams=[
            LinearPreviewTeamRead(
                **team, status_count=len(team["new_statuses"]), template_count=len(team["new_templates"])
            )
            for team in teams
        ]
    )


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
        mappings = linear_import.team_mappings(api_key, _linear_choices(body))
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


@router.post("/{workspace_id}/imports/shortcut/teams", response_model=ShortcutTeamListRead)
def list_shortcut_teams(
    body: ShortcutTokenRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
) -> ShortcutTeamListRead:
    """The Shortcut teams an API token can read, to choose from; the token is not kept."""
    try:
        teams = shortcut_import.read_teams(body.api_token.strip())
    except ShortcutError as exc:
        raise shortcut_refusal(exc) from None
    return ShortcutTeamListRead(
        items=[ShortcutTeamRead(id=team["id"], key=team["key"], name=team["name"]) for team in teams]
    )


def _shortcut_mappings(
    body: ShortcutImportRequest, context: AuthzContext, repositories: Repositories
) -> list[shortcut_import.SourceTeamMapping]:
    """The checked team mapping of a Shortcut import or preview, refusing a team the caller or token cannot use."""
    for choice in body.teams:
        require_team_member(repositories, context, choice.team_id)
    choices = [(choice.shortcut_team_id, choice.team_id) for choice in body.teams]
    try:
        return shortcut_import.team_mappings(body.api_token.strip(), choices)
    except ShortcutError as exc:
        raise shortcut_refusal(exc) from None
    except shortcut_import.UnknownShortcutTeam:
        raise unprocessable("A chosen Shortcut team is not readable with this token, or was chosen twice") from None


@router.post("/{workspace_id}/imports/shortcut/preview", response_model=ShortcutImportPreviewRead)
def preview_shortcut_import(
    body: ShortcutImportRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ShortcutImportPreviewRead:
    """What importing the chosen Shortcut teams would bring over, team by team, writing nothing."""
    mappings = _shortcut_mappings(body, context, repositories)
    try:
        teams = shortcut_import.preview(repositories, context.workspace_id, body.api_token.strip(), mappings)
    except ShortcutError as exc:
        raise shortcut_refusal(exc) from None
    return ShortcutImportPreviewRead(teams=[ShortcutPreviewTeamRead(**team) for team in teams])


@router.post(
    "/{workspace_id}/imports/shortcut",
    response_model=IssueImportRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_shortcut_import(
    body: ShortcutImportRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueImportRead:
    """Queue an import of Shortcut teams into Standupless teams, refusing a second while one is running."""
    mappings = _shortcut_mappings(body, context, repositories)
    try:
        job = shortcut_import.start_shortcut_import(repositories, context, body.api_token.strip(), mappings)
    except ShortcutError as exc:
        raise shortcut_refusal(exc) from None
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
        target_label="Shortcut",
        after={
            "preset": job.preset,
            "teams": [
                {"shortcut_team": mapping.key or mapping.source_id, "team_id": mapping.team_id} for mapping in mappings
            ],
        },
    )
    return IssueImportRead.from_job(job)


@router.get("/{workspace_id}/imports/github/repositories", response_model=GitHubImportRepositoryListRead)
def list_github_import_repositories(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> GitHubImportRepositoryListRead:
    """The repositories the installed GitHub App covers, to choose the one whose Issues are imported."""
    rows = github_import.importable_repositories(repositories, context.workspace_id)
    return GitHubImportRepositoryListRead(
        items=[
            GitHubImportRepositoryRead(
                repository_id=row.repository_id, full_name=row.full_name, private=row.private, team_id=row.team_id
            )
            for row in rows
        ]
    )


@router.post(
    "/{workspace_id}/imports/github",
    response_model=IssueImportRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_github_import(
    body: GitHubImportRequest,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueImportRead:
    """Queue an import of one repository's Issues into one team, refusing a second while one is running."""
    try:
        job = github_import.start_github_import(repositories, context, body.team_id, body.repository_id)
    except github_import.RepositoryNotAvailable as exc:
        raise unprocessable(str(exc)) from None
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
        target_label=job.file_name,
        after={"preset": job.preset, "team_id": job.team_id, "repository_id": job.github_repository_id},
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
