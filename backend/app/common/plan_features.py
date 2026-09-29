"""Which plans include which features, and the one check a gated route calls.

Numeric ceilings live in `plan_limits`; this module answers yes or no. A feature
a route gates on is a `Feature` member, so a typo fails loudly at import rather
than silently denying everyone. The refusal is a 403 carrying
`PLAN_FEATURE_UNAVAILABLE`, with the feature and the plan in `details`.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Mapping

from fastapi import HTTPException, status

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.workspaces import Plan, Workspace
from app.common.plan_limits import plan_of

PLAN_FEATURE_UNAVAILABLE = "PLAN_FEATURE_UNAVAILABLE"


class Feature(StrEnum):
    """Every capability a plan can include or leave out."""

    GUESTS = "guests"
    TRIAGE = "triage"
    PUBLIC_ROADMAP = "public_roadmap"
    PRIVATE_TEAMS = "private_teams"
    INSIGHTS = "insights"
    ISSUE_SLAS = "issue_slas"
    AUDIT_LOG = "audit_log"
    AUTH_POLICY = "auth_policy"


FEATURE_NAMES: Mapping[Feature, str] = {
    Feature.GUESTS: "Guests",
    Feature.TRIAGE: "Triage",
    Feature.PUBLIC_ROADMAP: "Public roadmap",
    Feature.PRIVATE_TEAMS: "Private teams",
    Feature.INSIGHTS: "Insights",
    Feature.ISSUE_SLAS: "Issue SLAs",
    Feature.AUDIT_LOG: "Audit log",
    Feature.AUTH_POLICY: "Authentication policy",
}

STANDARD_FEATURES: frozenset[Feature] = frozenset({Feature.GUESTS, Feature.TRIAGE, Feature.PUBLIC_ROADMAP})

BUSINESS_FEATURES: frozenset[Feature] = STANDARD_FEATURES | {
    Feature.PRIVATE_TEAMS,
    Feature.INSIGHTS,
    Feature.ISSUE_SLAS,
    Feature.AUDIT_LOG,
    Feature.AUTH_POLICY,
}

PLAN_FEATURES: dict[str, frozenset[Feature]] = {
    Plan.FREE: frozenset(),
    Plan.STANDARD: STANDARD_FEATURES,
    Plan.BUSINESS: BUSINESS_FEATURES,
}
"""The features each plan includes. Each tier includes everything below it."""


def features_of(workspace: Workspace | str | None) -> frozenset[Feature]:
    """Every feature this workspace's plan includes."""
    return PLAN_FEATURES[plan_of(workspace)]


def has_feature(workspace: Workspace | str | None, key: Feature | str) -> bool:
    """Whether this workspace's plan includes `key`.

    Raises `ValueError` for a key that names no `Feature`.
    """
    return Feature(key) in features_of(workspace)


def lowest_plan_with(key: Feature | str) -> str | None:
    """The cheapest plan that includes `key`, for an upgrade prompt."""
    feature = Feature(key)
    for plan in Plan:
        if feature in PLAN_FEATURES[plan]:
            return plan.value
    return None


def require_feature(workspace: Workspace | str | None, key: Feature | str) -> None:
    """Refuse with a 403 unless this workspace's plan includes `key`."""
    feature = Feature(key)
    if has_feature(workspace, feature):
        return
    plan = plan_of(workspace)
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error_code": PLAN_FEATURE_UNAVAILABLE,
            "message": f"{FEATURE_NAMES[feature]} is not included in the {plan} plan.",
            "details": {"feature": feature.value, "plan": plan, "required_plan": lowest_plan_with(feature)},
        },
    )


def enforce_feature(repositories: Repositories, workspace_id: str, key: Feature | str) -> None:
    """Read the workspace's plan, then `require_feature` it."""
    require_feature(repositories.workspaces.get(workspace_id), key)
