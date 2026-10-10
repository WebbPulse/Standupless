"""The workspace plan's limits, the one source every cap reads, and the refusal each answers.

The refusal is a 403 carrying `PLAN_LIMIT_REACHED` on every resource, so the
frontend has one code to render and the message carries the resource and number.

The limits are enforced by conditional counters in `app.common.plan_usage`, which
moves a usage row in the same transaction as the row it creates or frees. This
module holds the numbers and the checks those counters are judged against.

Storage and guests are checked here too but are not `LimitedResource`s: storage
is a byte total the discussion domain keeps as a counter, and the guest ceiling
scales with the paid seats, so each has its own check with the same refusal.

Issues are not limited here. Nothing holds a live issue count: the per-team
counter only ever grows, so it counts deleted issues and allocation gaps, and a
true count means reading every issue row.

Until `BILLING_ENABLED` is on there is no way to upgrade, so the free plan keeps
the generous `PREVIEW_FREE_LIMITS` and the launch numbers wait in `PLAN_LIMITS`.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Mapping

from fastapi import HTTPException, status

from app.common.core.config import settings
from app.common.db.dynamo.workspaces import DEFAULT_PLAN, Plan, Workspace

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

STORAGE_RESOURCE = "storage"

GUESTS_RESOURCE = "guests"

GIB = 1024**3

FREE_TEAMS = 2
FREE_MEMBERS = 10
FREE_INVITES = 10
FREE_WEBHOOKS = 2
FREE_API_KEYS = 5
FREE_STORAGE_BYTES = 2 * GIB
FREE_GUESTS_PER_SEAT = 0

STANDARD_TEAMS = 10
STANDARD_MEMBERS = 1000
STANDARD_INVITES = 100
STANDARD_WEBHOOKS = 20
STANDARD_API_KEYS = 25
STANDARD_STORAGE_BYTES = 100 * GIB
STANDARD_GUESTS_PER_SEAT = 5

BUSINESS_TEAMS = 250
BUSINESS_MEMBERS = 2500
BUSINESS_INVITES = 250
BUSINESS_WEBHOOKS = 50
BUSINESS_API_KEYS = 100
BUSINESS_STORAGE_BYTES = 250 * GIB
BUSINESS_GUESTS_PER_SEAT = 5

PLAN_LIMITS: dict[str, dict[LimitedResource, int]] = {
    Plan.FREE: {
        LimitedResource.TEAMS: FREE_TEAMS,
        LimitedResource.MEMBERS: FREE_MEMBERS,
        LimitedResource.INVITES: FREE_INVITES,
        LimitedResource.WEBHOOKS: FREE_WEBHOOKS,
        LimitedResource.API_KEYS: FREE_API_KEYS,
    },
    Plan.STANDARD: {
        LimitedResource.TEAMS: STANDARD_TEAMS,
        LimitedResource.MEMBERS: STANDARD_MEMBERS,
        LimitedResource.INVITES: STANDARD_INVITES,
        LimitedResource.WEBHOOKS: STANDARD_WEBHOOKS,
        LimitedResource.API_KEYS: STANDARD_API_KEYS,
    },
    Plan.BUSINESS: {
        LimitedResource.TEAMS: BUSINESS_TEAMS,
        LimitedResource.MEMBERS: BUSINESS_MEMBERS,
        LimitedResource.INVITES: BUSINESS_INVITES,
        LimitedResource.WEBHOOKS: BUSINESS_WEBHOOKS,
        LimitedResource.API_KEYS: BUSINESS_API_KEYS,
    },
}
"""Each plan's ceiling per resource at launch, from the approved pricing.

"Unlimited" in the pricing is a high safety ceiling here. An unknown plan reads as
the default one, so a typo in a plan name narrows rather than lifts the limits.
"""

PREVIEW_FREE_LIMITS: dict[LimitedResource, int] = {
    LimitedResource.TEAMS: 50,
    LimitedResource.MEMBERS: 250,
    LimitedResource.INVITES: 100,
    LimitedResource.WEBHOOKS: 20,
    LimitedResource.API_KEYS: 25,
}
"""The free plan's ceilings while billing is off and nobody can upgrade."""

PLAN_STORAGE_BYTES: dict[str, int] = {
    Plan.FREE: FREE_STORAGE_BYTES,
    Plan.STANDARD: STANDARD_STORAGE_BYTES,
    Plan.BUSINESS: BUSINESS_STORAGE_BYTES,
}
"""Each plan's pooled attachment storage per workspace. Placeholders the owner will tune."""

PLAN_GUESTS_PER_SEAT: dict[str, int] = {
    Plan.FREE: FREE_GUESTS_PER_SEAT,
    Plan.STANDARD: STANDARD_GUESTS_PER_SEAT,
    Plan.BUSINESS: BUSINESS_GUESTS_PER_SEAT,
}
"""How many guests each paid seat admits. Placeholders the owner will tune."""

PREVIEW_FREE_STORAGE_BYTES = STANDARD_STORAGE_BYTES
"""The free plan's pooled storage while billing is off and nobody can upgrade."""

PREVIEW_FREE_GUESTS_PER_SEAT = STANDARD_GUESTS_PER_SEAT
"""The free plan's guests per seat while billing is off and nobody can upgrade."""


def plan_of(workspace: Workspace | str | None) -> str:
    """The plan name a workspace, or a bare plan name, resolves to.

    A workspace resolves through `Workspace.effective_plan`, so a live comp grant
    counts as an active subscription of its plan at every gate.
    """
    plan = workspace.effective_plan() if isinstance(workspace, Workspace) else workspace
    return plan if plan in PLAN_LIMITS else DEFAULT_PLAN


def limits_of(workspace: Workspace | str | None) -> Mapping[LimitedResource, int]:
    """Every ceiling this workspace's plan enforces right now."""
    plan = plan_of(workspace)
    if _previewing(plan):
        return PREVIEW_FREE_LIMITS
    return PLAN_LIMITS[plan]


def limit_for(workspace: Workspace | str | None, resource: LimitedResource) -> int:
    """How many of `resource` this workspace's plan allows."""
    return limits_of(workspace)[resource]


def _previewing(plan: str) -> bool:
    """Whether the free plan's preview ceilings apply, because nobody can upgrade yet."""
    return plan == DEFAULT_PLAN and not settings.BILLING_ENABLED


def storage_limit_of(workspace: Workspace | str | None) -> int:
    """The pooled attachment storage, in bytes, this workspace's plan allows right now."""
    plan = plan_of(workspace)
    return PREVIEW_FREE_STORAGE_BYTES if _previewing(plan) else PLAN_STORAGE_BYTES[plan]


def guests_per_seat_of(workspace: Workspace | str | None) -> int:
    """How many guests each seat of this workspace's plan admits right now."""
    plan = plan_of(workspace)
    return PREVIEW_FREE_GUESTS_PER_SEAT if _previewing(plan) else PLAN_GUESTS_PER_SEAT[plan]


def plan_limit_reached(plan: str, resource: str, limit: int, message: str) -> HTTPException:
    """The 403 every plan ceiling answers, with the resource, limit and plan in `details`."""
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error_code": PLAN_LIMIT_REACHED,
            "message": message,
            "details": {"resource": resource, "limit": limit, "plan": plan},
        },
    )


def check_limit(workspace: Workspace | str | None, resource: LimitedResource, current_count: int) -> None:
    """Refuse one more `resource` when the workspace already holds its plan's limit.

    Raises a 403 carrying `PLAN_LIMIT_REACHED`, with the resource, limit and plan in
    the envelope's `details`, so a client can render it without parsing the sentence.
    """
    plan = plan_of(workspace)
    limit = limit_for(plan, resource)
    if current_count < limit:
        return
    raise plan_limit_reached(
        plan,
        resource.value,
        limit,
        f"This workspace has reached its {plan} plan limit of {limit} {RESOURCE_NOUNS[resource]}. "
        "Remove one to make room.",
    )


def check_storage(workspace: Workspace | str | None, used_bytes: int, adding_bytes: int) -> None:
    """Refuse an upload that would take the workspace past its plan's pooled storage."""
    plan = plan_of(workspace)
    limit = storage_limit_of(plan)
    if used_bytes + adding_bytes <= limit:
        return
    raise plan_limit_reached(
        plan,
        STORAGE_RESOURCE,
        limit,
        f"This upload would take the workspace past its {plan} plan limit of {_gib(limit)} of storage. "
        "Delete attachments or upgrade to make room.",
    )


def guest_allowance(workspace: Workspace | str | None, seats: int) -> int:
    """How many guests a workspace with `seats` paid seats may hold, counting at least one seat."""
    return guests_per_seat_of(workspace) * max(1, seats)


def check_guests(workspace: Workspace | str | None, guests: int, seats: int) -> None:
    """Refuse one more guest when `guests` already fill the allowance `seats` earn."""
    plan = plan_of(workspace)
    allowance = guest_allowance(plan, seats)
    if guests < allowance:
        return
    if allowance == 0:
        message = f"The {plan} plan does not include guests. Upgrade to invite guests."
    else:
        message = (
            f"This workspace has reached its {plan} plan limit of {allowance} guests, "
            f"{guests_per_seat_of(plan)} for each member. Add a member or upgrade to make room."
        )
    raise plan_limit_reached(plan, GUESTS_RESOURCE, allowance, message)


def _gib(size: int) -> str:
    """A byte count as whole GiB for a refusal message."""
    return f"{size // GIB} GiB"
