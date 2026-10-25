"""The planning stage of the team purge: cycles, the team's documents and its place on projects and initiatives.

A project can span teams, so the team is taken off each project's list and only
a project left with no team is deleted. The first team on the list is the one a
project is filed under, so removing it hands the project to the next team. An
initiative the team led is kept and becomes workspace level.

A workspace purge skips the per-project detaching and clears the whole planning
partition once the cycles are gone, since every project goes with the workspace.
"""

from __future__ import annotations

from fastapi import APIRouter
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import project_key
from app.common.team_purge import WORKSPACE, Deadline, PurgeJob
from app.common.team_purge import build_router as build_purge_router

STAGE = "planning"


def detach_projects(repositories: Repositories, workspace_id: str, team_id: str) -> None:
    """Take the team off every project, deleting any project it was the last team of.

    A deleted project takes its milestones, links and documents with it, so the purge leaves no rows.
    """
    for project in repositories.planning.list_projects(workspace_id):
        if team_id not in project.team_ids:
            continue
        remaining = [other for other in project.team_ids if other != team_id]
        if not remaining:
            repositories.planning.delete_project_milestones(workspace_id, project.project_id)
            repositories.planning.delete_project_links(workspace_id, project.project_id)
            repositories.documents.delete_for_parent(workspace_id, "project", project.project_id)
            repositories.planning.delete(workspace_id, project_key(project.project_id))
            continue
        repositories.planning.replace_project(project.model_copy(update={"team_ids": remaining}))


def detach_initiatives(repositories: Repositories, workspace_id: str, team_id: str) -> None:
    """Clear the team as lead of every initiative it led, leaving each one workspace level."""
    for initiative in repositories.planning.list_initiatives(workspace_id):
        if initiative.team_id != team_id:
            continue
        cleared = initiative.model_copy(update={"team_id": None, "updated_at": utc_now()})
        try:
            repositories.planning.replace_initiative(cleared)
        except ConditionFailed:
            continue


def step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Remove the team's cycles, releases and documents, then detach it from its projects and initiatives."""
    while repositories.planning.delete_cycles_page(job.workspace_id, job.team_id):
        if deadline.expired():
            return 0
    while repositories.releases.delete_team_page(job.workspace_id, job.team_id):
        if deadline.expired():
            return 0
    if job.kind != WORKSPACE:
        repositories.documents.delete_for_parent(job.workspace_id, "team", job.team_id)
        detach_projects(repositories, job.workspace_id, job.team_id)
        detach_initiatives(repositories, job.workspace_id, job.team_id)
    return None


def workspace_step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Remove every project, milestone and cycle left in the workspace's planning partition."""
    repositories.planning.delete_workspace_rows(job.workspace_id)
    return None


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """This stage's consumer router."""
    return build_purge_router(STAGE, STAGE, step, repositories, workspace_step=workspace_step)
