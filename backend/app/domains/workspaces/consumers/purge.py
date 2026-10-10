"""The workspaces stage of the purge chain, and the hourly sweep that starts every purge.

The sweep reads the schedules on the workspaces and users tables. A workspace
whose grace period has run out is marked as purging, loses its API keys, invites
and memberships at once so nobody can reach it any more, and is handed to the
first stage of the chain. A deleted account is purged at once: the identity route
that deletes it drops a sweep naming the user, and the hourly sweep picks up any
that message missed. The account is checked again against the sole owner rule,
because ownership can change after the route checked it: a blocked account is
logged and left marked deleted, so it still cannot sign in. Otherwise the
workspaces nobody else is in are purged with it, its memberships elsewhere are
removed, its personal API keys are deleted, and the account is handed to the chain.

The chain comes back here last. A workspace's final step deletes whatever the
start left behind and then the workspace row. An account's final step deletes the
users row, whose stream REMOVE is what the identity package's purge consumer reads
to delete the credentials, passkeys, sessions and OAuth links.

Every step is a delete or a conditional write that is a no-op the second time,
so a redelivered message or a restarted stale purge only repeats finished work.
"""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter

from app.common import team_purge
from app.common.account_deletion import plan_account_deletion
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.users import STALE_ACCOUNT_PURGE
from app.common.db.dynamo.workspaces import STALE_PURGE
from app.common.icons import delete_icon_objects, user_owner, workspace_owner
from app.common.team_purge import Deadline, PurgeJob

STAGE = team_purge.WORKSPACE_STAGE

REPOSITORIES: tuple[str, ...] = ("workspaces", "memberships", "invites", "api_keys", "audit", "users")
"""What this stage's function carries, all writable.

The workspaces domain's own tables plus the users table, which the routes only
read but the account purge has to mark and delete.
"""

_log = logging.getLogger(__name__)


def _close_workspace(repositories: Repositories, workspace_id: str) -> None:
    """Revoke the workspace's API keys and delete its invites and memberships.

    Run when the purge starts and again when it ends, because the keys are what a
    service caller authenticates with and the memberships are what every other
    caller is authorised by, so both have to go before anything else is deleted.
    """
    repositories.api_keys.revoke_all_for_tenant(workspace_id)
    repositories.invites.delete_workspace_rows(workspace_id)
    repositories.memberships.delete_workspace_rows(workspace_id)


def begin_workspace_purge(repositories: Repositories, workspace_id: str, *, now: datetime | None = None) -> bool:
    """Mark one due workspace as purging, close it, and start its chain.

    Reports whether this call started it. The member ids are read before the
    memberships go, so the views stage can still find every member's inbox.
    """
    member_ids = [member.user_id for member in repositories.memberships.list_members(workspace_id, limit=5000)]
    if not repositories.workspaces.begin_purge(workspace_id, member_ids, now=now):
        return False
    _close_workspace(repositories, workspace_id)
    _log.info(
        "A workspace purge started.",
        extra={"event": "workspace.purge.started", "workspace_id": workspace_id, "members": len(member_ids)},
    )
    team_purge.start_workspace(workspace_id)
    return True


def begin_account_purge(repositories: Repositories, user_id: str, *, now: datetime | None = None) -> bool:
    """Start one deleted account's purge, unless the sole owner rule now blocks it.

    Reports whether this call started it. A workspace the person is alone in is
    made due at once and purged alongside, and their membership everywhere else is
    removed here, so nothing they were in keeps pointing at them.
    """
    plan = plan_account_deletion(repositories, user_id)
    if plan.blocking:
        _log.warning(
            "An account purge is blocked by a workspace it is the only owner of.",
            extra={
                "event": "account.purge.blocked",
                "user_id": user_id,
                "workspace_ids": [row.id for row in plan.blocking],
            },
        )
        return False
    if not repositories.users.begin_purge(user_id, plan.workspace_ids, now=now):
        return False
    for workspace in plan.sole_member:
        if repositories.workspaces.expedite_deletion(workspace.id, user_id, now=now):
            begin_workspace_purge(repositories, workspace.id, now=now)
    for workspace in plan.leaving:
        repositories.memberships.remove_user(workspace.id, user_id)
    repositories.api_keys.delete_all_for_user(user_id)
    _log.info(
        "An account purge started.",
        extra={
            "event": "account.purge.started",
            "user_id": user_id,
            "workspaces_deleted": len(plan.sole_member),
            "workspaces_left": len(plan.leaving),
        },
    )
    team_purge.start_account(user_id)
    return True


def sweep(repositories: Repositories, deadline: Deadline, user_id: str = "") -> None:
    """Start every due workspace purge and every deleted account's purge, or only `user_id`'s.

    A purge already under way is skipped unless it has gone quiet for longer than
    its stale window, in which case it is started again from the top. Naming a user
    is how the deletion route starts that account's purge at once without waiting
    for the hourly run.
    """
    now = utc_now()
    if user_id:
        user = repositories.users.get(user_id)
        if user is not None and user.is_deleted and not _purge_running(user.purging_at, now):
            begin_account_purge(repositories, user_id, now=now)
        return
    for workspace in repositories.workspaces.list_scheduled():
        if deadline.expired():
            return
        if not workspace.is_due(now):
            continue
        if workspace.purging_at is not None and workspace.purging_at > now - STALE_PURGE:
            continue
        begin_workspace_purge(repositories, workspace.id, now=now)
    for user in repositories.users.list_scheduled():
        if deadline.expired():
            return
        if _purge_running(user.purging_at, now):
            continue
        begin_account_purge(repositories, user.id, now=now)


def _purge_running(purging_at: datetime | None, now: datetime) -> bool:
    """Whether an account purge started recently enough that it is still in flight."""
    return purging_at is not None and purging_at > now - STALE_ACCOUNT_PURGE


def workspace_step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Delete what is left of the workspace, its audit log and its logo, then the workspace row itself."""
    del deadline
    _close_workspace(repositories, job.workspace_id)
    repositories.audit.delete_for_workspace(job.workspace_id)
    delete_icon_objects(workspace_owner(job.workspace_id).prefix)
    repositories.workspaces.delete_purged(job.workspace_id)
    _log.info(
        "A workspace purge finished.",
        extra={"event": "workspace.purge.finished", "workspace_id": job.workspace_id},
    )
    return None


def account_step(repositories: Repositories, job: PurgeJob, deadline: Deadline) -> int | None:
    """Remove any membership still left and the avatar, then delete the users row."""
    del deadline
    for membership in repositories.memberships.list_workspaces_for_user(job.user_id, limit=5000):
        repositories.memberships.remove_user(membership.workspace_id, job.user_id)
    repositories.api_keys.delete_all_for_user(job.user_id)
    delete_icon_objects(user_owner(job.user_id).prefix)
    repositories.users.delete_purged(job.user_id)
    _log.info(
        "An account purge finished.",
        extra={"event": "account.purge.finished", "user_id": job.user_id},
    )
    return None


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """This stage's consumer router, bound to a bundle that can also write the users table."""
    from app.common.api.dependencies.repositories import build_bundle

    bundle = repositories if repositories is not None else build_bundle(REPOSITORIES, name="workspaces-purge")
    return team_purge.build_router(
        "workspaces",
        STAGE,
        None,
        bundle,
        workspace_step=workspace_step,
        account_step=account_step,
        sweep=sweep,
    )
