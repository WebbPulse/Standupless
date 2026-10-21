"""Handles: the `@` word a person is mentioned by, and the rules for changing one.

A handle is the person's display name with spaces removed, compared case
insensitively, or the local part of their email. A rename keeps the old handle
on the account, so mentions written under it still name the same person, and a
new handle must be free in every workspace the person belongs to, among current
and former handles alike, or a mention would start naming somebody else.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.users import User

HANDLE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$")
"""The shape a handle takes, which is the shape the mention parser reads."""

PREVIOUS_HANDLE_LIMIT = 20
"""How many former handles an account keeps, oldest dropped first."""


def normalise_handle(text: str) -> str:
    """A handle as it is compared: spaces removed and lowercased."""
    return re.sub(r"\s+", "", text).strip().lower()


def current_handles(user: User) -> list[str]:
    """The handles a person answers to now: their display name, then their email's local part."""
    found: list[str] = []
    for candidate in (normalise_handle(user.display_name), str(user.email).split("@", 1)[0].strip().lower()):
        if candidate and candidate not in found:
            found.append(candidate)
    return found


def all_handles(user: User) -> list[str]:
    """Every handle that names a person: the current ones, then the ones they gave up."""
    found = current_handles(user)
    for previous in user.previous_handles:
        if previous and previous not in found:
            found.append(previous)
    return found


def previous_after_rename(user: User, new_display_name: str) -> list[str]:
    """The former handles to store once `user` takes `new_display_name`.

    The handle being given up joins the list, the one being taken leaves it, and
    only the newest `PREVIOUS_HANDLE_LIMIT` are kept.
    """
    given_up = normalise_handle(user.display_name)
    taken = normalise_handle(new_display_name)
    kept = [handle for handle in user.previous_handles if handle and handle not in (given_up, taken)]
    if given_up and given_up != taken:
        kept.append(given_up)
    return kept[-PREVIOUS_HANDLE_LIMIT:]


@dataclass(frozen=True)
class HandleConflict:
    """A workspace where another member already answers to the handle."""

    workspace_id: str
    workspace_name: str


def handle_conflicts(repositories: Repositories, user_id: str, handle: str) -> list[HandleConflict]:
    """Every workspace of `user_id` where another member answers to `handle`.

    Another member answers to it when it is their display handle, their email's
    local part, or a handle they gave up, because a mention written under any of
    those resolves to them.
    """
    wanted = normalise_handle(handle)
    if not wanted:
        return []
    conflicts: list[HandleConflict] = []
    for membership in repositories.memberships.list_workspaces_for_user(user_id):
        workspace_id = membership.workspace_id
        others = [
            row.user_id
            for row in repositories.memberships.list_members(workspace_id)
            if row.user_id and row.user_id != user_id
        ]
        if not others:
            continue
        users = repositories.users.get_many(others)
        if any(wanted in all_handles(other) for other in users.values()):
            workspace = repositories.workspaces.get(workspace_id)
            conflicts.append(HandleConflict(workspace_id, workspace.name if workspace is not None else ""))
    return conflicts
