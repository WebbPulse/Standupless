"""The workspace row's plan and billing fields and the one write that sets them."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from app.common.db.dynamo.workspaces import DEFAULT_PLAN, Workspace
from tests.domains.helpers import OWNER, make_workspace

WORKSPACE = "01JB00000000000000000000WS"


def test_a_new_workspace_is_free_with_no_billing() -> None:
    """Nothing is billed until a checkout completes."""
    workspace = Workspace(name="Acme", slug="acme")
    assert workspace.plan == DEFAULT_PLAN == "free"
    assert workspace.stripe_customer_id is None
    assert workspace.billed_seats is None
    assert workspace.cancel_at_period_end is False


def test_set_billing_writes_and_reads_back(repositories: Any) -> None:
    """Every billing field round-trips, the period end as a datetime."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    period_end = datetime(2027, 1, 1, tzinfo=UTC)

    updated = repositories.workspaces.set_billing(
        WORKSPACE,
        plan="standard",
        billing_interval="year",
        stripe_customer_id="cus_1",
        stripe_subscription_id="sub_1",
        subscription_status="active",
        billed_seats=3,
        current_period_end=period_end,
        cancel_at_period_end=False,
    )

    assert updated is not None
    stored = repositories.workspaces.get(WORKSPACE)
    assert stored is not None
    assert stored.plan == "standard"
    assert stored.billed_seats == 3
    assert stored.current_period_end == period_end
    assert stored.name == "Acme"


def test_set_billing_refuses_other_fields_and_missing_rows(repositories: Any) -> None:
    """The webhook cannot rename a workspace, and a gone workspace answers None."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    with pytest.raises(ValueError):
        repositories.workspaces.set_billing(WORKSPACE, name="Hijacked")

    assert repositories.workspaces.set_billing("01JB0000000000000000000GONE", plan="standard") is None
    assert repositories.workspaces.get("01JB0000000000000000000GONE") is None
