"""API key policy: the scopes this product fixes and the principal a workspace key acts as.

The storage is not here. Keys live in the identity package's own `api-keys` table
through `DynamoApiKeyStore`, and the package's `mint`, `verify`, `revoke` and
`effective_scopes` are what run, so this module holds only what the package has no
opinion about: which scopes exist in this product, and what a per-workspace key is
a principal for.
"""

from __future__ import annotations

from typing import Iterable

KEY_KINDS: tuple[str, ...] = ("user", "workspace")

API_KEY_SCOPES: tuple[str, ...] = (
    "issues:read",
    "issues:write",
    "comments:write",
    "projects:read",
    "views:read",
)
"""The five scopes design section 5 fixes, and the only ones a key may carry.

Exported so the route validation, the MCP tool table and the frontend's checkbox
list all read one definition rather than three that drift.
"""

SERVICE_SCOPES: tuple[str, ...] = API_KEY_SCOPES
"""What a per-workspace key intersects against, in place of a membership row.

A workspace key acts as the workspace rather than as a person, so there is no
membership to read. It still intersects, against this fixed set, which is what
keeps the intersection rule a single code path for both kinds.
"""


def service_subject(workspace_id: str) -> str:
    """The synthetic principal a per-workspace key acts as.

    Prefixed so it can never collide with a real user id and so a row written by a
    workspace key is recognisable as one in the activity feed.
    """
    return f"svc#{workspace_id}"


def is_service_subject(user_id: str) -> bool:
    """Whether a subject is a workspace key's synthetic principal."""
    return user_id.startswith("svc#")


def normalise_scopes(scopes: Iterable[str]) -> list[str]:
    """The requested scopes, deduplicated and in the canonical order.

    Ordered by `API_KEY_SCOPES` rather than alphabetically so a stored row and a
    rendered checkbox list read the same way round.
    """
    wanted = {scope.strip() for scope in scopes if scope.strip()}
    return [scope for scope in API_KEY_SCOPES if scope in wanted]


def unknown_scopes(scopes: Iterable[str]) -> list[str]:
    """Which requested scopes are outside the five, sorted, for a 422 to name."""
    return sorted({scope.strip() for scope in scopes if scope.strip()} - set(API_KEY_SCOPES))
