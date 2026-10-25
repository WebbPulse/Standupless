"""The pull request search route, which the editor's `#` reference picker and its chips read.

It sits under the workspace's `github` prefix, which the integrations function
already serves and which is the only function holding the `github` table, so
the picker asks it alongside workspace search rather than search reaching into
a table its function has no grant on.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.domains.integrations.pull_request_search import search_pull_requests
from app.domains.integrations.schemas.pull_requests import (
    PULL_REQUEST_QUERY_MAX,
    PULL_REQUEST_QUERY_MIN,
    PULL_REQUEST_SEARCH_DEFAULT_LIMIT,
    PULL_REQUEST_SEARCH_MAX_LIMIT,
    PullRequestSearchRead,
)

router = APIRouter()


@router.get("/{workspace_id}/github/pull-requests", response_model=PullRequestSearchRead)
def list_pull_requests(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    q: Annotated[str, Query(min_length=PULL_REQUEST_QUERY_MIN, max_length=PULL_REQUEST_QUERY_MAX)],
    limit: Annotated[int, Query(ge=1, le=PULL_REQUEST_SEARCH_MAX_LIMIT)] = PULL_REQUEST_SEARCH_DEFAULT_LIMIT,
) -> PullRequestSearchRead:
    """Linked pull requests matching `q` by `owner/repo#number`, a bare number or title words.

    Only a pull request linked to an issue in a team the caller sees is
    answered, and a query shaped like an issue key answers none.
    """
    return PullRequestSearchRead(pull_requests=search_pull_requests(repositories, context, q, limit))
