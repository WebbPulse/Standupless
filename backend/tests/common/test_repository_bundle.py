"""The bundle fails closed: a domain reaches only the tables it declared."""

from __future__ import annotations

import pytest

from app.common.api.dependencies.repositories import (
    RepositoryNotInBundle,
    build_bundle,
)


def test_a_repository_outside_the_bundle_raises() -> None:
    """Reaching past the declared set is the error, not a silent cross-tenant read.

    The function's IAM grant covers only the declared tables, so a call that got
    this far would fail at DynamoDB anyway. Failing here names the fix instead.
    """
    bundle = build_bundle(["workspaces"], name="workspaces")
    with pytest.raises(RepositoryNotInBundle) as raised:
        bundle.users
    assert "users" in str(raised.value)
    assert "workspaces" in str(raised.value)


def test_an_unknown_repository_is_rejected_at_build_time() -> None:
    """A typo in a domain's declared set fails at import, not at request time."""
    with pytest.raises(ValueError, match="unknown repositories"):
        build_bundle(["workspaces", "not-a-repository"], name="workspaces")


def test_building_a_bundle_constructs_nothing() -> None:
    """Declaring a bundle must reach no DynamoDB client, so cold start stays cheap."""
    bundle = build_bundle(["users", "workspaces"], name="tests")
    assert "built=[]" in repr(bundle)


def test_tables_are_derived_from_the_declared_repositories() -> None:
    """The bundle reports the data surface Terraform has to grant."""
    assert build_bundle(["workspaces"], name="workspaces").tables == ("workspaces",)
