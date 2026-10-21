"""Resolving the `@handle` mentions a body carries to workspace members.

Shared because an issue description and a comment mention people the same way,
and the two are written by different domains that must agree on who a handle names.
"""

from __future__ import annotations

from webbpulse.messages import extract_mentions

from app.common.api.dependencies.repositories import Repositories
from app.common.handles import current_handles


def resolve_mentions(repositories: Repositories, workspace_id: str, handles: list[str]) -> list[str]:
    """The workspace members the `@handle` mentions in a body name, as user ids.

    A handle is matched against a member's current handles, their display name
    with spaces removed and the local part of their email, and then against the
    handles they gave up in a rename, all case insensitively. A current handle
    always wins over a former one, so a rename keeps old mentions pointing at the
    same person without ever taking a handle from someone who holds it now.

    Scoped to the workspace's own members, so a mention can only ever name someone
    the author could already see, and an unmatched handle is dropped rather than
    stored as a dangling id.
    """
    if not handles:
        return []
    memberships = repositories.memberships.list_members(workspace_id)
    member_ids = [membership.user_id for membership in memberships if membership.user_id]
    if not member_ids:
        return []
    users = repositories.users.get_many(member_ids)
    present = [users[user_id] for user_id in member_ids if user_id in users]

    by_handle: dict[str, str] = {}
    for user in present:
        for handle in current_handles(user):
            by_handle.setdefault(handle, user.id)
    for user in present:
        for handle in user.previous_handles:
            if handle:
                by_handle.setdefault(handle, user.id)

    resolved: list[str] = []
    for handle in handles:
        user_id = by_handle.get(handle.strip().lower())
        if user_id is not None and user_id not in resolved:
            resolved.append(user_id)
    return resolved


def mentioned_user_ids(repositories: Repositories, workspace_id: str, body: str | None) -> list[str]:
    """The workspace members a body's `@handle` mentions name, as user ids."""
    if not body:
        return []
    return resolve_mentions(repositories, workspace_id, extract_mentions(body))
