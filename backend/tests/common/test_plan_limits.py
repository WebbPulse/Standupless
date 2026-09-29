"""The plan limit hooks: the table, `check_limit`, and how each resource is counted.

The free tier's real numbers are far above anything a test should seed, so each
count test lowers its resource's limit to two and seeds up to it. What these hold
is that the count reads the right rows, that rows which no longer occupy a slot are
left out, and that the refusal is the stable 403 the frontend renders.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, cast

import pytest
from fastapi import HTTPException
from webbpulse.identity.api_keys import mint

from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import WebhookEndpoint, new_webhook_id, webhook_key
from app.common.db.dynamo.invites import Invite, hash_token, new_invite_token
from app.common.db.dynamo.workspaces import Workspace
from app.common.plan_limits import (
    FREE_MEMBERS,
    FREE_TEAMS,
    PLAN_GUESTS_PER_SEAT,
    PLAN_LIMIT_REACHED,
    PLAN_LIMITS,
    PLAN_STORAGE_BYTES,
    PREVIEW_FREE_LIMITS,
    LimitedResource,
    check_limit,
    enforce_limit,
    limit_for,
)
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_team, make_workspace

WORKSPACE = "01JB00000000000000000000WS"

TEST_LIMIT = 2


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A free workspace with its owner as the only member."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    return WORKSPACE


def lower(monkeypatch: pytest.MonkeyPatch, resource: LimitedResource) -> None:
    """Drop one resource's free limit to `TEST_LIMIT` for this test."""
    monkeypatch.setitem(PREVIEW_FREE_LIMITS, resource, TEST_LIMIT)


def refusal(repositories: Any, resource: LimitedResource) -> dict[str, Any]:
    """The 403 body `enforce_limit` raises for this resource, failing if it raises none."""
    with pytest.raises(HTTPException) as caught:
        enforce_limit(repositories, WORKSPACE, resource)
    assert caught.value.status_code == 403
    return cast(dict[str, Any], caught.value.detail)


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
    assert "—" not in detail["message"]


def test_an_unknown_or_missing_plan_reads_as_free() -> None:
    """A plan name the table does not hold narrows to free rather than lifting the cap."""
    free = limit_for("free", LimitedResource.MEMBERS)
    assert limit_for("enterprise", LimitedResource.MEMBERS) == free
    assert limit_for(None, LimitedResource.MEMBERS) == free


def test_teams_count_live_teams(repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Teams stop at the limit, and a team being deleted frees its slot."""
    lower(monkeypatch, LimitedResource.TEAMS)
    make_team(repositories, WORKSPACE, "01JB000000000000000000PRJ1", "APO")
    make_team(repositories, WORKSPACE, "01JB000000000000000000PRJ2", "GEM")

    assert refusal(repositories, LimitedResource.TEAMS)["error_code"] == PLAN_LIMIT_REACHED

    repositories.teams.mark_deleting(WORKSPACE, "01JB000000000000000000PRJ2")
    enforce_limit(repositories, WORKSPACE, LimitedResource.TEAMS)


def test_members_count_workspace_memberships_only(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Workspace members stop at the limit, and team memberships are not people."""
    lower(monkeypatch, LimitedResource.MEMBERS)
    make_team(repositories, WORKSPACE, "01JB000000000000000000PRJ1", "APO")
    enforce_limit(repositories, WORKSPACE, LimitedResource.MEMBERS)

    add_member(repositories, WORKSPACE, MEMBER, "member")

    assert refusal(repositories, LimitedResource.MEMBERS)["details"]["resource"] == "members"


def test_invites_count_unexpired_ones(repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Pending invites stop at the limit, and one past its expiry holds no slot."""
    lower(monkeypatch, LimitedResource.INVITES)

    def invite(email: str, *, expired: bool = False) -> None:
        """Store one invite, optionally already past its expiry."""
        row = Invite(
            workspace_id=WORKSPACE,
            email=email,
            role="member",
            invited_by=OWNER,
            token_hash=hash_token(new_invite_token()),
        )
        if expired:
            row.expires_at = utc_now() - timedelta(days=1)
        repositories.invites.create(row)

    invite("one@example.com")
    invite("old@example.com", expired=True)
    enforce_limit(repositories, WORKSPACE, LimitedResource.INVITES)

    invite("two@example.com")

    assert refusal(repositories, LimitedResource.INVITES)["details"]["resource"] == "invites"


def test_webhooks_count_every_endpoint(repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Webhooks stop at the limit, team scoped ones counting toward the workspace."""
    lower(monkeypatch, LimitedResource.WEBHOOKS)
    for team_id in (None, "01JB000000000000000000PRJ1"):
        webhook_id = new_webhook_id()
        repositories.github.create_endpoint(
            WebhookEndpoint(
                workspace_id=WORKSPACE,
                github_key=webhook_key(webhook_id),
                webhook_id=webhook_id,
                url="https://example.test/hook",
                team_id=team_id,
                resource_types=["issues"],
                created_by=ADMIN,
                created_at=utc_now(),
                updated_at=utc_now(),
            )
        )

    assert refusal(repositories, LimitedResource.WEBHOOKS)["details"]["resource"] == "webhooks"


def test_api_keys_count_unrevoked_ones(repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """API keys stop at the limit, and a revoked key frees its slot."""
    lower(monkeypatch, LimitedResource.API_KEYS)
    minted = [
        mint(
            user_id=MEMBER,
            tenant_id=WORKSPACE,
            scopes=["issues:read"],
            name=f"Key {index}",
            store=repositories.api_keys,
            created_by=MEMBER,
        )
        for index in range(TEST_LIMIT)
    ]

    assert refusal(repositories, LimitedResource.API_KEYS)["details"]["resource"] == "api_keys"

    repositories.api_keys.revoke_by_id(WORKSPACE, minted[0].record.key_id)
    enforce_limit(repositories, WORKSPACE, LimitedResource.API_KEYS)
