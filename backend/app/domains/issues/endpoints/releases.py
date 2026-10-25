"""The issue side of releases: which releases one issue shipped in and how far each got.

Served by the issues image so the issue page reads it beside the rest of the issue,
while the releases themselves are written by the teams image.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path

from app.common import releases
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.releases import IssueReleaseListRead, ReleaseIndexRead

router = APIRouter()


@router.get("/{workspace_id}/issues/releases", response_model=ReleaseIndexRead)
def list_release_index(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ReleaseIndexRead:
    """Every release of the teams the caller can see with the issues each carries, newest first.

    What an issue list groups and labels its rows by when it shows releases. The
    router is mounted before the issue routes so `releases` is not read as an id.
    """
    return releases.release_index(repositories, context)


@router.get("/{workspace_id}/issues/{issue_id}/releases", response_model=IssueReleaseListRead)
def list_issue_releases(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueReleaseListRead:
    """The releases one issue the caller may read shipped in, newest first."""
    return releases.issue_releases(repositories, context, issue_id)
