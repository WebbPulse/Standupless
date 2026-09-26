"""The teams stage of the team purge, the last: the tombstoned team row itself.

Repeats the delete route's own purges first, so a team deleted before a later
membership or label write landed leaves nothing behind, then removes the row.
The removal is conditional on the tombstone, so a replayed message is a no-op.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.common.api.dependencies.repositories import Repositories
from app.common.team_purge import Deadline, PurgeJob
from app.common.team_purge import build_router as build_purge_router

STAGE = "teams"


def step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Purge the team's own rows and remove the tombstoned team."""
    workspace_id, team_id = job.workspace_id, job.team_id
    repositories.memberships.delete_team_memberships(workspace_id, team_id)
    repositories.team_config.delete_for_team(workspace_id, team_id)
    repositories.counters.delete_for_team(workspace_id, team_id)
    repositories.teams.delete_aliases(workspace_id, team_id)
    repositories.teams.delete_tombstoned(workspace_id, team_id)
    return None


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """This stage's consumer router."""
    return build_purge_router(STAGE, STAGE, step, repositories)
