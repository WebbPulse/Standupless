"""The internal comp grant: plan resolution, the gates, the webhook's reach and the admin script."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import HTTPException
from webbpulse.testing import FakeIdempotencyStore

from app.common import billing
from app.common.core.config import settings
from app.common.db.dynamo.workspaces import BILLING_FIELDS, COMP_FIELDS, Workspace
from app.common.plan_features import Feature, require_feature
from app.common.plan_limits import plan_of
from scripts.grant_comp_plan import GRANTED, NOT_FOUND, REVOKED, UNCHANGED, grant, main, revoke
from tests.common.test_billing import event, fake_gateway, subscription
from tests.domains.helpers import OWNER, make_workspace

WORKSPACE = "01JB00000000000000000000WS"

NOW = datetime(2026, 10, 10, tzinfo=UTC)

REASON = "Internal dogfooding"


def comped(plan: str = "business", *, expires_at: datetime | None = None, paid: str = "free") -> Workspace:
    """A workspace on `paid` through Stripe and comped `plan`."""
    return Workspace(
        name="Acme",
        slug="acme",
        plan=paid,
        comp_plan=plan,
        comp_reason=REASON,
        comp_expires_at=expires_at,
    )


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A free workspace with its owner."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    return WORKSPACE


def test_a_comp_grant_resolves_as_its_plan() -> None:
    """A live grant counts as an active subscription of its plan."""
    assert comped().effective_plan(NOW) == "business"
    assert comped(expires_at=NOW + timedelta(days=1)).effective_plan(NOW) == "business"
    assert plan_of(comped()) == "business"


def test_an_expired_comp_grant_falls_back_to_the_subscription() -> None:
    """Once its expiry passes the grant counts for nothing."""
    expired = comped(expires_at=NOW - timedelta(seconds=1))
    assert expired.comp_active(NOW) is False
    assert expired.effective_plan(NOW) == "free"
    assert comped(expires_at=NOW - timedelta(days=1), paid="standard").effective_plan(NOW) == "standard"


def test_a_naive_expiry_reads_as_utc() -> None:
    """A stored expiry without a zone is compared as UTC rather than raising."""
    assert comped(expires_at=datetime(2026, 10, 11)).effective_plan(NOW) == "business"
    assert comped(expires_at=datetime(2026, 10, 9)).effective_plan(NOW) == "free"


def test_the_higher_of_a_comp_grant_and_a_subscription_wins() -> None:
    """A subscription above the grant keeps its plan, and a grant above it lifts the workspace."""
    assert comped("business", paid="standard").effective_plan(NOW) == "business"
    assert comped("standard", paid="business").effective_plan(NOW) == "business"
    assert comped("standard", paid="standard").effective_plan(NOW) == "standard"


def test_an_unknown_comp_plan_grants_nothing() -> None:
    """A typo in the grant narrows rather than lifts."""
    assert comped("enterprise").effective_plan(NOW) == "free"


def test_every_gate_respects_the_grant() -> None:
    """The feature gate that refuses SLA and triage on free lets a comped workspace through."""
    with pytest.raises(HTTPException):
        require_feature(Workspace(name="Acme", slug="acme"), Feature.ISSUE_SLAS)
    require_feature(comped(), Feature.ISSUE_SLAS)
    require_feature(comped(), Feature.TRIAGE)


def test_the_grant_is_outside_every_field_a_webhook_writes() -> None:
    """`set_billing` refuses every comp field, so no webhook can write one."""
    assert not set(COMP_FIELDS) & set(BILLING_FIELDS)


def test_set_billing_refuses_comp_fields(repositories: Any, workspace: str) -> None:
    """The one write the webhook uses cannot touch a grant."""
    with pytest.raises(ValueError):
        repositories.workspaces.set_billing(workspace, comp_plan=None)


def test_a_cancelled_subscription_never_clears_the_grant(repositories: Any, workspace: str) -> None:
    """A webhook that drops the subscription to free leaves the comped workspace on its plan."""
    repositories.workspaces.set_comp_grant(workspace, plan="business", reason=REASON)
    gateway = fake_gateway({"sub_1": subscription()})
    billing.process_webhook_event(
        event("customer.subscription.created", {"id": "sub_1"}), repositories, gateway, FakeIdempotencyStore()
    )
    gateway.subscriptions["sub_1"] = subscription(status="canceled")
    billing.apply_event(event("customer.subscription.deleted", {"id": "sub_1"}, "evt_2"), repositories, gateway)

    stored = repositories.workspaces.get(workspace)
    assert stored.plan == "free"
    assert stored.comp_plan == "business"
    assert stored.comp_reason == REASON
    assert plan_of(stored) == "business"


def test_a_comp_grant_is_not_paid_for_seat_sync(repositories: Any, workspace: str) -> None:
    """A grant has no subscription, so it never reaches Stripe."""
    repositories.workspaces.set_comp_grant(workspace, plan="business", reason=REASON)
    assert billing.is_paid(repositories.workspaces.get(workspace)) is False


def test_set_comp_grant_refuses_the_free_plan(repositories: Any, workspace: str) -> None:
    """Comping free means nothing, so it is refused rather than stored."""
    with pytest.raises(ValueError):
        repositories.workspaces.set_comp_grant(workspace, plan="free", reason=REASON)


def test_grant_and_revoke_round_trip(repositories: Any, workspace: str) -> None:
    """The script grants once, finds a repeat unchanged, then revokes once."""
    expires = NOW + timedelta(days=365)
    assert grant(repositories, "acme", plan="business", reason=REASON, expires_at=expires, dry_run=False) == GRANTED
    stored = repositories.workspaces.get(workspace)
    assert (stored.comp_plan, stored.comp_reason, stored.comp_expires_at) == ("business", REASON, expires)
    assert stored.comp_granted_at is not None
    assert grant(repositories, "acme", plan="business", reason=REASON, expires_at=expires, dry_run=False) == UNCHANGED
    assert grant(repositories, "acme", plan="standard", reason=REASON, expires_at=expires, dry_run=False) == GRANTED
    assert repositories.workspaces.get(workspace).comp_plan == "standard"

    assert revoke(repositories, "acme", dry_run=False) == REVOKED
    stored = repositories.workspaces.get(workspace)
    assert all(getattr(stored, field) is None for field in COMP_FIELDS)
    assert plan_of(stored) == "free"
    assert revoke(repositories, "acme", dry_run=False) == UNCHANGED


def test_a_missing_workspace_is_reported(repositories: Any) -> None:
    """An unknown slug changes nothing."""
    assert grant(repositories, "nobody", plan="business", reason=REASON, dry_run=False) == NOT_FOUND
    assert revoke(repositories, "nobody", dry_run=False) == NOT_FOUND


def test_a_dry_run_writes_nothing(repositories: Any, workspace: str, capsys: pytest.CaptureFixture[str]) -> None:
    """The command line says what it would do, prints no ids, and leaves the row alone."""
    stage = settings.dynamodb_table_prefix.removeprefix("standupless-")
    assert main(["--stage", stage, "--workspace", "acme", "--reason", REASON, "--dry-run"]) == 0

    printed = capsys.readouterr().out.strip()
    assert printed == "dry-run grant plan=business workspace=acme outcome=granted"
    assert WORKSPACE not in printed
    assert repositories.workspaces.get(workspace).comp_plan is None


def test_the_command_line_grants_with_an_expiry(
    repositories: Any, workspace: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--expires` is a UTC date, and a revoke from the command line clears it."""
    stage = settings.dynamodb_table_prefix.removeprefix("standupless-")
    assert main(["--stage", stage, "--workspace", "acme", "--reason", REASON, "--expires", "2027-10-10"]) == 0
    assert repositories.workspaces.get(workspace).comp_expires_at == datetime(2027, 10, 10, tzinfo=UTC)
    assert main(["--stage", stage, "--workspace", "acme", "--revoke"]) == 0
    assert capsys.readouterr().out.strip().splitlines()[-1] == "revoke workspace=acme outcome=revoked"
    assert repositories.workspaces.get(workspace).comp_plan is None
