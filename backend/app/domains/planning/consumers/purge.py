"""The planning stage of the team purge: cycles and the team's place on projects.

A project can span teams, so the team is taken off each project's list and only
a project left with no team is deleted. The first team on the list is the one a
project is filed under, so removing it hands the project to the next team.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.planning import project_key
from app.common.team_purge import Deadline, PurgeJob
from app.common.team_purge import build_router as build_purge_router

STAGE = "planning"


def detach_projects(repositories: Repositories, workspace_id: str, team_id: str) -> None:
    """Take the team off every project, deleting any project it was the last team of.

    A deleted project takes its milestones with it, so the purge leaves no rows.
    """
    for project in repositories.planning.list_projects(workspace_id):
        if team_id not in project.team_ids:
            continue
        remaining = [other for other in project.team_ids if other != team_id]
        if not remaining:
            repositories.planning.delete_project_milestones(workspace_id, project.project_id)
            repositories.planning.delete(workspace_id, project_key(project.project_id))
            continue
        repositories.planning.replace_project(project.model_copy(update={"team_ids": remaining}))


def step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Remove the team's cycles, then detach it from its projects."""
    while repositories.planning.delete_cycles_page(job.workspace_id, job.team_id):
        if deadline.expired():
            return 0
    detach_projects(repositories, job.workspace_id, job.team_id)
    return None


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """This stage's consumer router."""
    return build_purge_router(STAGE, STAGE, step, repositories)
