"""The workspace plan's limits, and the one check every create route calls.

The MVP is free with no billing, so the refusal is a 403 rather than a 402: there
is nothing to pay yet, only a ceiling to stop unbounded growth. The error code is
`PLAN_LIMIT_REACHED` on every resource, so the frontend has one code to render and
the message carries the resource and the number.

Counts are read before the write rather than enforced by a conditional write,
because each spans a partition that no single-item condition can express. The race
that leaves a workspace one over is harmless for the same reason.

Issues are not limited here. Nothing holds a live issue count: the per-team
counter only ever grows, so it counts deleted issues and allocation gaps, and a
true count means reading every issue row.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Callable, Mapping

from fastapi import HTTPException, status

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.workspaces import DEFAULT_PLAN, Workspace

PLAN_LIMIT_REACHED = "PLAN_LIMIT_REACHED"


class LimitedResource(StrEnum):
    """Every resource a workspace plan caps."""

    TEAMS = "teams"
    MEMBERS = "members"
    INVITES = "invites"
    WEBHOOKS = "webhooks"
    API_KEYS = "api_keys"


RESOURCE_NOUNS: Mapping[LimitedResource, str] = {
    LimitedResource.TEAMS: "teams",
    LimitedResource.MEMBERS: "members",
    LimitedResource.INVITES: "pending invites",
    LimitedResource.WEBHOOKS: "webhooks",
    LimitedResource.API_KEYS: "live API keys",
}

PLAN_LIMITS: dict[str, dict[LimitedResource, int]] = {
    "free": {
        LimitedResource.TEAMS: 50,
        LimitedResource.MEMBERS: 250,
        LimitedResource.INVITES: 100,
        LimitedResource.WEBHOOKS: 20,
        LimitedResource.API_KEYS: 25,
    },
}
"""Each plan's ceiling per resource.

The MVP contract names no numbers, so the free tier's are generous placeholders
set well above any team the MVP expects. An unknown plan reads as the default one,
so a typo in a plan name narrows rather than lifts the limits.
"""


def plan_of(workspace: Workspace | str | None) -> str:
    """The plan name a workspace, or a bare plan name, resolves to."""
    plan = workspace.plan if isinstance(workspace, Workspace) else workspace
    return plan if plan in PLAN_LIMITS else DEFAULT_PLAN


def limit_for(workspace: Workspace | str | None, resource: LimitedResource) -> int:
    """How many of `resource` this workspace's plan allows."""
    return PLAN_LIMITS[plan_of(workspace)][resource]


def check_limit(workspace: Workspace | str | None, resource: LimitedResource, current_count: int) -> None:
    """Refuse one more `resource` when the workspace already holds its plan's limit.

    Raises a 403 carrying `PLAN_LIMIT_REACHED`, with the resource, limit and plan in
    the envelope's `details`, so a client can render it without parsing the sentence.
    """
    plan = plan_of(workspace)
    limit = limit_for(plan, resource)
    if current_count < limit:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error_code": PLAN_LIMIT_REACHED,
            "message": (
                f"This workspace has reached its {plan} plan limit of {limit} {RESOURCE_NOUNS[resource]}. "
                "Remove one to make room."
            ),
            "details": {"resource": resource.value, "limit": limit, "plan": plan},
        },
    )


def _teams(repositories: Repositories, workspace_id: str, limit: int) -> int:
    """Live teams, aliases and tombstones excluded."""
    return len(repositories.teams.list_for_workspace(workspace_id, limit=limit))


def _members(repositories: Repositories, workspace_id: str, limit: int) -> int:
    """Workspace memberships, team memberships excluded."""
    return len(repositories.memberships.list_members(workspace_id, limit=limit))


def _invites(repositories: Repositories, workspace_id: str, limit: int) -> int:
    """Invites not yet expired, since a TTL delete can lag the expiry."""
    rows = repositories.invites.list_for_workspace(workspace_id, limit=limit * 2)
    return len([row for row in rows if not row.is_expired()])


def _webhooks(repositories: Repositories, workspace_id: str, limit: int) -> int:
    """Outbound endpoints, team scoped ones included."""
    return len(repositories.github.list_endpoints(workspace_id, limit=limit))


def _api_keys(repositories: Repositories, workspace_id: str, limit: int) -> int:
    """Keys not revoked, so a workspace that rotates its keys can still mint one."""
    del limit
    return len([row for row in repositories.api_keys.list_for_tenant(workspace_id) if not row.is_revoked])


COUNTERS: Mapping[LimitedResource, Callable[[Repositories, str, int], int]] = {
    LimitedResource.TEAMS: _teams,
    LimitedResource.MEMBERS: _members,
    LimitedResource.INVITES: _invites,
    LimitedResource.WEBHOOKS: _webhooks,
    LimitedResource.API_KEYS: _api_keys,
}
"""How each resource is counted, every one a single-partition query and none a scan.

Each read stops at the limit, which is all the check needs to know.
"""


def enforce_limit(repositories: Repositories, workspace_id: str, resource: LimitedResource) -> None:
    """Read the workspace's plan and current count, then `check_limit` them.

    The one line a create route calls before it writes.
    """
    workspace = repositories.workspaces.get(workspace_id)
    limit = limit_for(workspace, resource)
    check_limit(workspace, resource, COUNTERS[resource](repositories, workspace_id, limit))
