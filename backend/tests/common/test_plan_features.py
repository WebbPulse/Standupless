"""The plan entitlement helper: the feature table, `has_feature` and the 403 it raises."""

from __future__ import annotations

from typing import Any, cast

import pytest
from fastapi import HTTPException

from app.common.db.dynamo.workspaces import Plan, Workspace
from app.common.plan_features import (
    BUSINESS_FEATURES,
    FEATURE_NAMES,
    PLAN_FEATURE_UNAVAILABLE,
    PLAN_FEATURES,
    STANDARD_FEATURES,
    Feature,
    enforce_feature,
    features_of,
    has_feature,
    lowest_plan_with,
    require_feature,
)
from tests.domains.helpers import OWNER, make_workspace

WORKSPACE = "01JB00000000000000000000WS"


def test_every_plan_has_a_feature_set_and_every_feature_a_name() -> None:
    """No plan reads a gap and no feature renders without a label."""
    assert set(PLAN_FEATURES) == set(Plan)
    assert set(FEATURE_NAMES) == set(Feature)


def test_each_tier_includes_everything_below_it() -> None:
    """Upgrading never takes a feature away."""
    assert PLAN_FEATURES[Plan.FREE] <= STANDARD_FEATURES <= BUSINESS_FEATURES


def test_business_alone_carries_private_teams() -> None:
    """Private teams are the Business headline."""
    assert not has_feature("free", Feature.PRIVATE_TEAMS)
    assert not has_feature("standard", "private_teams")
    assert has_feature(Workspace(name="Acme", slug="acme", plan="business"), "private_teams")


def test_an_unknown_or_missing_plan_reads_as_free() -> None:
    """A plan name the table does not hold narrows to free rather than granting features."""
    assert features_of("enterprise") == features_of(None) == PLAN_FEATURES[Plan.FREE]


def test_an_unknown_feature_key_fails_loudly() -> None:
    """A typo in a key raises rather than quietly denying everyone."""
    with pytest.raises(ValueError):
        has_feature("business", "private_team")


def test_the_lowest_plan_is_the_cheapest_that_includes_it() -> None:
    """The upgrade prompt names the smallest step."""
    assert lowest_plan_with(Feature.TRIAGE) == "standard"
    assert lowest_plan_with(Feature.INSIGHTS) == "business"


def test_require_feature_passes_or_raises_a_stable_403() -> None:
    """A plan without the feature is refused with the code, feature and plan a client renders."""
    require_feature("business", Feature.AUDIT_LOG)
    with pytest.raises(HTTPException) as caught:
        require_feature("standard", Feature.AUDIT_LOG)

    assert caught.value.status_code == 403
    detail = cast(dict[str, Any], caught.value.detail)
    assert detail["error_code"] == PLAN_FEATURE_UNAVAILABLE
    assert detail["details"] == {"feature": "audit_log", "plan": "standard", "required_plan": "business"}
    assert "—" not in detail["message"]


def test_enforce_feature_reads_the_stored_plan(repositories: Any) -> None:
    """The route-facing check reads the workspace row, so a webhook's plan change takes effect."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    with pytest.raises(HTTPException):
        enforce_feature(repositories, WORKSPACE, Feature.GUESTS)

    repositories.workspaces.set_billing(WORKSPACE, plan="standard")

    enforce_feature(repositories, WORKSPACE, Feature.GUESTS)
