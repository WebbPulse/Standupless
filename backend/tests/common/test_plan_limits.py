"""The plan limit table and its pure checks: `limit_for`, `check_limit`, storage and guests.

How each resource is counted and held to these numbers lives with the counters,
in `test_plan_usage`.
"""

from __future__ import annotations

from typing import Any, cast

import pytest
from fastapi import HTTPException

from app.common.core.config import settings
from app.common.db.dynamo.workspaces import Workspace
from app.common.plan_limits import (
    FREE_MEMBERS,
    FREE_TEAMS,
    PLAN_GUESTS_PER_SEAT,
    PLAN_LIMIT_REACHED,
    PLAN_LIMITS,
    PLAN_STORAGE_BYTES,
    PREVIEW_FREE_GUESTS_PER_SEAT,
    PREVIEW_FREE_LIMITS,
    PREVIEW_FREE_STORAGE_BYTES,
    LimitedResource,
    check_guests,
    check_limit,
    check_storage,
    guest_allowance,
    guests_per_seat_of,
    limit_for,
    storage_limit_of,
)


def test_every_plan_caps_every_resource() -> None:
    """Every plan has a number for every limited resource, so no create route reads a gap."""
    assert set(PLAN_LIMITS) == {"free", "standard", "business"}
    for limits in (*PLAN_LIMITS.values(), PREVIEW_FREE_LIMITS):
        assert set(limits) == set(LimitedResource)
    assert set(PLAN_STORAGE_BYTES) == set(PLAN_LIMITS) == set(PLAN_GUESTS_PER_SEAT)


def test_each_tier_is_at_least_as_generous_as_the_one_below() -> None:
    """Upgrading never lowers a ceiling."""
    for lower_plan, higher_plan in (("free", "standard"), ("standard", "business")):
        for resource in LimitedResource:
            assert PLAN_LIMITS[lower_plan][resource] <= PLAN_LIMITS[higher_plan][resource]
        assert PLAN_STORAGE_BYTES[lower_plan] <= PLAN_STORAGE_BYTES[higher_plan]
        assert PLAN_GUESTS_PER_SEAT[lower_plan] <= PLAN_GUESTS_PER_SEAT[higher_plan]


def test_free_keeps_its_preview_limits_until_billing_is_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """With no way to upgrade the free plan stays generous; billing turns on the launch numbers."""
    assert limit_for("free", LimitedResource.TEAMS) == PREVIEW_FREE_LIMITS[LimitedResource.TEAMS]

    monkeypatch.setattr(settings, "BILLING_ENABLED", True)

    assert limit_for("free", LimitedResource.TEAMS) == FREE_TEAMS
    assert limit_for("free", LimitedResource.MEMBERS) == FREE_MEMBERS


def test_paid_plans_read_their_own_limits_either_way(monkeypatch: pytest.MonkeyPatch) -> None:
    """A paid workspace is never held to the preview numbers."""
    for enabled in (False, True):
        monkeypatch.setattr(settings, "BILLING_ENABLED", enabled)
        workspace = Workspace(name="Acme", slug="acme", plan="standard")
        assert limit_for(workspace, LimitedResource.WEBHOOKS) == PLAN_LIMITS["standard"][LimitedResource.WEBHOOKS]


def test_under_the_limit_passes() -> None:
    """A count below the limit is allowed through without a word."""
    check_limit("free", LimitedResource.TEAMS, limit_for("free", LimitedResource.TEAMS) - 1)


def test_at_the_limit_is_a_403_with_a_stable_code() -> None:
    """Reaching the limit refuses with the code, resource and number a client renders."""
    limit = limit_for("free", LimitedResource.WEBHOOKS)
    with pytest.raises(HTTPException) as caught:
        check_limit(Workspace(name="Acme", slug="acme"), LimitedResource.WEBHOOKS, limit)

    assert caught.value.status_code == 403
    detail = cast(dict[str, Any], caught.value.detail)
    assert detail["error_code"] == PLAN_LIMIT_REACHED
    assert detail["details"] == {"resource": "webhooks", "limit": limit, "plan": "free"}
    assert f"{limit} webhooks" in detail["message"]
    assert "\u2014" not in detail["message"]


def test_an_unknown_or_missing_plan_reads_as_free() -> None:
    """A plan name the table does not hold narrows to free rather than lifting the cap."""
    free = limit_for("free", LimitedResource.MEMBERS)
    assert limit_for("enterprise", LimitedResource.MEMBERS) == free
    assert limit_for(None, LimitedResource.MEMBERS) == free


def test_storage_and_guests_keep_preview_numbers_until_billing_is_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """Free is generous on storage and guests until an upgrade exists, then reads its launch numbers."""
    assert storage_limit_of("free") == PREVIEW_FREE_STORAGE_BYTES
    assert guests_per_seat_of("free") == PREVIEW_FREE_GUESTS_PER_SEAT

    monkeypatch.setattr(settings, "BILLING_ENABLED", True)

    assert storage_limit_of("free") == PLAN_STORAGE_BYTES["free"]
    assert guests_per_seat_of("free") == PLAN_GUESTS_PER_SEAT["free"]
    assert storage_limit_of("business") == PLAN_STORAGE_BYTES["business"]


def test_an_upload_past_the_pooled_storage_is_refused() -> None:
    """Storage refuses the upload that would cross the limit, not the one that lands on it."""
    limit = storage_limit_of("free")
    check_storage("free", limit - 10, 10)

    with pytest.raises(HTTPException) as caught:
        check_storage("free", limit - 10, 11)

    detail = cast(dict[str, Any], caught.value.detail)
    assert caught.value.status_code == 403
    assert detail["error_code"] == PLAN_LIMIT_REACHED
    assert detail["details"] == {"resource": "storage", "limit": limit, "plan": "free"}
    assert "GiB" in detail["message"]
    assert "\u2014" not in detail["message"]


def test_the_guest_allowance_scales_with_seats() -> None:
    """Each seat earns its plan's guests, and an empty workspace still counts one seat."""
    per_seat = guests_per_seat_of("standard")
    assert guest_allowance("standard", 3) == 3 * per_seat
    assert guest_allowance("standard", 0) == per_seat

    check_guests("standard", 2 * per_seat - 1, 2)
    with pytest.raises(HTTPException) as caught:
        check_guests("standard", 2 * per_seat, 2)
    detail = cast(dict[str, Any], caught.value.detail)
    assert detail["details"] == {"resource": "guests", "limit": 2 * per_seat, "plan": "standard"}


def test_free_admits_no_guests_once_billing_is_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """With billing on the free plan includes no guests at all, and says so."""
    monkeypatch.setattr(settings, "BILLING_ENABLED", True)

    with pytest.raises(HTTPException) as caught:
        check_guests("free", 0, 5)

    detail = cast(dict[str, Any], caught.value.detail)
    assert detail["details"]["limit"] == 0
    assert "does not include guests" in detail["message"]
