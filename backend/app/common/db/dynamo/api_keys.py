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

ADMIN_SCOPE = "admin"
"""The scope that lets a credential exercise its holder's workspace admin role.

Held alongside a resource scope, never instead of one, and cut from the live
ceiling of every role but owner and admin, so it can only ever carry authority the
holder already has.
"""

API_KEY_SCOPES: tuple[str, ...] = (
    "issues:read",
    "issues:write",
    "comments:write",
    "teams:read",
    "teams:write",
    "members:read",
    "members:write",
    "statuses:read",
    "statuses:write",
    "labels:read",
    "labels:write",
    "projects:read",
    "projects:write",
    "milestones:read",
    "milestones:write",
    "cycles:read",
    "cycles:write",
    "views:read",
    "views:write",
    "notifications:read",
    "notifications:write",
    "settings:read",
    "settings:write",
    ADMIN_SCOPE,
)
"""Every scope a key or an MCP token may carry, in the order they are shown.

Exported so the route validation, the MCP tool table, the authorization server and
the frontend's checkbox list all read one definition rather than several that drift.
"""

LEGACY_SCOPE_ALIASES: dict[str, str] = {
    "members:read": "teams:read",
    "statuses:read": "teams:read",
    "labels:read": "teams:read",
    "projects:read": "teams:read",
    "milestones:read": "teams:read",
    "cycles:read": "teams:read",
    "settings:read": "teams:read",
    "notifications:read": "views:read",
    "labels:write": "issues:write",
    "projects:write": "issues:write",
}
"""The broad scope each finer scope was split out of, which still satisfies it.

A key or a grant minted when only five scopes existed keeps working: `teams:read`
covered the team, member, status, label, cycle, project and workspace reads,
`views:read` the inbox, and `issues:write` label and project writes. Such a
credential is read as holding the whole finer scope, so it also reaches the verbs
added to it since, such as deleting a label. `admin`, `settings:write`,
`members:write` and the other new write scopes alias nothing.
"""

SERVICE_SCOPES: tuple[str, ...] = tuple(scope for scope in API_KEY_SCOPES if scope != ADMIN_SCOPE)
"""What a per-workspace key intersects against, in place of a membership row.

A workspace key acts as the workspace rather than as a person, so there is no
membership to read. It still intersects, against this fixed set, which is what
keeps the intersection rule a single code path for both kinds. It never holds
`admin`, because the service role is a member.
"""


def satisfies(scopes: Iterable[str], required: str) -> bool:
    """Whether a credential's scopes cover one required scope, legacy aliases included."""
    held = set(scopes)
    if required in held:
        return True
    alias = LEGACY_SCOPE_ALIASES.get(required)
    return alias is not None and alias in held


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
    """Which requested scopes are outside the known set, sorted, for a 422 to name."""
    return sorted({scope.strip() for scope in scopes if scope.strip()} - set(API_KEY_SCOPES))
