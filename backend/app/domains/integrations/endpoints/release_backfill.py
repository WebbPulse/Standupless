"""Rebuilding a team's releases from the deployments a GitHub environment already had.

Served by the integrations image because it reads GitHub through the App, beside
the deployment source it replays. A team administrator runs it, a batch per call,
passing the cursor back until it comes back null.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.releases import ReleaseBackfill, ReleaseBackfillRead
from app.common.planning_rules import require_team_admin
from app.domains.integrations import deployments

router = APIRouter()


@router.post("/{workspace_id}/teams/{team_id}/release-backfill", response_model=ReleaseBackfillRead)
def backfill_releases(
    payload: ReleaseBackfill,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ReleaseBackfillRead:
    """Record releases for one batch of an environment's past successful deployments, newest first.

    Issues are not moved and no GitHub Release is published, so replaying history
    changes only the release record.
    """
    team_id = str(context.team_id)
    require_team_admin(repositories, context, team_id)
    return deployments.backfill(repositories, context.workspace_id, team_id, payload)
