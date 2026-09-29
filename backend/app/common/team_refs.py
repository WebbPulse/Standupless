"""One way to turn a team reference into a team id, shared by the routes and the tools.

A person writes a team as its key prefix, SUP, because that is what every issue key
shows, while a client chaining calls holds the id a listing answered. Both
spellings resolve here, case-insensitively and inside one workspace, so the REST
layer and the MCP layer cannot disagree about what a reference means.

An unknown reference and a team the caller may not see answer the same message,
naming the reference and the workspace rather than a permission, so the answer is
actionable without letting a guest probe for teams outside their reach.
"""

from __future__ import annotations

from contextvars import ContextVar
from types import MappingProxyType
from typing import TYPE_CHECKING, Mapping, Optional

from fastapi import HTTPException, status

from app.common.db.dynamo.teams import is_valid_key_prefix

if TYPE_CHECKING:
    from app.common.db.dynamo.teams import Team, TeamRepository

TEAM_NOT_FOUND_CODE = "TEAM_NOT_FOUND"

SPELLINGS: ContextVar[Mapping[str, str]] = ContextVar("team_reference_spellings", default=MappingProxyType({}))
"""Each team id this request resolved from a prefix, mapped to the prefix as written.

Set by the REST middleware, so a not-found raised later names the reference the
caller sent rather than the id it resolved to, which would otherwise hand a guest
the id of a team they are outside.
"""


def team_not_found_message(reference: str) -> str:
    """The sentence an unknown or invisible team reference answers, as the caller spelled it."""
    return f"No team {SPELLINGS.get().get(reference, reference)} in this workspace"


def team_not_found(reference: str) -> HTTPException:
    """The 404 an unknown or invisible team answers, naming the reference given."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error_code": TEAM_NOT_FOUND_CODE, "message": team_not_found_message(reference)},
    )


def is_key_prefix_shaped(reference: str) -> bool:
    """Whether a reference could be a key prefix, which no ULID team id can be."""
    return is_valid_key_prefix(reference.strip().upper())


def find_team(teams: "TeamRepository", workspace_id: str, reference: str) -> Optional["Team"]:
    """The team a reference names by id or by key prefix, or `None`.

    The id is tried first, and the prefix only when the reference has a prefix's
    shape, so an id costs one read and a prefix at most two.
    """
    candidate = reference.strip()
    if not candidate:
        return None
    team = teams.get(workspace_id, candidate)
    if team is None and is_key_prefix_shaped(candidate):
        team = teams.get_by_key_prefix(workspace_id, candidate.upper())
    return team


def resolve_team_id(teams: "TeamRepository", workspace_id: str, reference: str) -> str:
    """The id a reference names, or the reference unchanged when nothing matches.

    Cheap for the common case: an id is passed through without a read, because only
    a prefix-shaped reference can need resolving. Leaving an unknown reference as
    it was lets the authorized path that reads it answer the not-found, so nothing
    about the workspace is revealed before the caller is known.
    """
    candidate = reference.strip()
    if not is_key_prefix_shaped(candidate):
        return reference
    team = find_team(teams, workspace_id, candidate)
    return team.team_id if team is not None else reference
