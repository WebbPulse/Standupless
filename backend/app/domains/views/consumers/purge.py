"""The views stage of the team purge: team views, search postings and share links.

Share links are revoked rather than deleted: the store has no single-row delete,
and a revoked link stops resolving at once and expires with the rest. Inbox rows
are left to their own expiry, since each names an issue that is about to be gone
and the inbox is partitioned by user rather than by team.

A workspace purge ends by deleting the whole views partition, every member's
inbox in the workspace and every share link of the tenant. An account purge
deletes the person's own views and inbox in each workspace they belonged to, and
leaves the team views they saved, which belong to the team.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.share_links import ShareLinkView
from app.common.team_purge import Deadline, PurgeJob
from app.common.team_purge import build_router as build_purge_router

STAGE = "views"


def revoke_share_links(repositories: Repositories, workspace_id: str, team_id: str) -> int:
    """Revoke every live share link onto the team, returning how many."""
    revoked = 0
    for record in repositories.share_links.list_for_tenant(workspace_id):
        if record.is_revoked or ShareLinkView(record).team_id != team_id:
            continue
        if repositories.share_links.revoke(record.token_hash) is not None:
            revoked += 1
    return revoked


def step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Remove the team's views and search postings and revoke its share links."""
    workspace_id, team_id = job.workspace_id, job.team_id
    while views := repositories.views.list_for_team(workspace_id, team_id):
        for view in views:
            repositories.views.delete(workspace_id, view.view_key)
    while repositories.search_index.delete_team_page(workspace_id, team_id):
        if deadline.expired():
            return 0
    revoke_share_links(repositories, workspace_id, team_id)
    return None


def workspace_step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Remove every view, every member's inbox and every share link of the workspace."""
    workspace_id = job.workspace_id
    repositories.views.delete_workspace_rows(workspace_id)
    workspace = repositories.workspaces.get(workspace_id)
    for user_id in workspace.purge_member_ids if workspace is not None else []:
        repositories.inbox.delete_all(workspace_id, user_id)
        if deadline.expired():
            return 0
    repositories.share_links.delete_all_for_tenant(workspace_id)
    return None


def account_step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Remove the person's own views and inbox in each workspace they belonged to."""
    user = repositories.users.get(job.user_id)
    if user is None:
        return None
    for workspace_id in user.purge_workspace_ids:
        while views := repositories.views.list_personal(workspace_id, job.user_id):
            for view in views:
                repositories.views.delete(workspace_id, view.view_key)
        repositories.inbox.delete_all(workspace_id, job.user_id)
    return None


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """This stage's consumer router."""
    return build_purge_router(
        STAGE, STAGE, step, repositories, workspace_step=workspace_step, account_step=account_step
    )
