"""The Reviews list route: the pull requests waiting on the caller as a reviewer.

Read by any member of the workspace, and only ever about the caller: the list is
found from the GitHub account the caller linked, never from a parameter, so there
is no way to read someone else's queue.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.domains.integrations.reviews import list_reviews
from app.domains.integrations.schemas.reviews import ReviewsRead

router = APIRouter()


@router.get("/{workspace_id}/reviews", response_model=ReviewsRead)
def get_reviews(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ReviewsRead:
    """Open pull requests asking the caller for a review, or holding their changes request or approval."""
    return list_reviews(repositories, context)
