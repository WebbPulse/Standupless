"""Resolving the `@handle` mentions a body carries to workspace members.

Shared because an issue description and a comment mention people the same way,
and the two are written by different domains that must agree on who a handle names.
"""

from __future__ import annotations

from webbpulse.messages import extract_mentions

from app.common.api.dependencies.repositories import Repositories


def resolve_mentions(repositories: Repositories, workspace_id: str, handles: list[str]) -> list[str]:
    """The workspace members the `@handle` mentions in a body name, as user ids.

    A handle is matched against the local part of a member's email and against
    their display name with spaces removed, both case insensitively, because the
    identity package stores no handle of its own and the contract's `mentions` is a
    list of user ids rather than of the text that was typed.

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

    by_handle: dict[str, str] = {}
    for user_id in member_ids:
        user = users.get(user_id)
        if user is None:
            continue
        local_part = str(user.email).split("@", 1)[0].strip().lower()
        if local_part:
            by_handle.setdefault(local_part, user_id)
        display = user.display_name.replace(" ", "").strip().lower()
        if display:
            by_handle.setdefault(display, user_id)

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
