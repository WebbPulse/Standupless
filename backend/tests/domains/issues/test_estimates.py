"""A team's estimate settings: each scale's values, the extended and zero toggles, and scale switches.

The properties worth holding are that every scale offers exactly its value set,
that the toggles add exactly their values, that a row stored before the toggles
existed keeps the values it offered, and that a scale switch never refuses or
rewrites an estimate an issue already holds.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.teams import _as_team
from app.common.estimates import allowed_estimates
from tests.domains.helpers import OWNER, sign_in
from tests.domains.issues.conftest import TEAM, create_issue


@pytest.mark.parametrize(
    ("scale", "base", "extended"),
    [
        ("exponential", ("1", "2", "4", "8", "16"), ("32", "64")),
        ("fibonacci", ("1", "2", "3", "5", "8"), ("13", "21")),
        ("linear", ("1", "2", "3", "4", "5"), ("6", "7")),
        ("tshirt", ("XS", "S", "M", "L", "XL"), ("XXL", "XXXL")),
    ],
)
def test_each_scale_offers_its_values_and_the_toggles_add_theirs(
    scale: str, base: tuple[str, ...], extended: tuple[str, ...]
) -> None:
    """The base set, the extended values after it, and zero ahead of everything."""
    assert allowed_estimates(scale) == base
    assert allowed_estimates(scale, extended=True) == base + extended
    assert allowed_estimates(scale, allow_zero=True) == ("0",) + base
    assert allowed_estimates(scale, extended=True, allow_zero=True) == ("0",) + base + extended


def test_a_scale_that_is_off_offers_nothing() -> None:
    """No toggle turns estimates on for a team that has them off."""
    assert allowed_estimates("off", extended=True, allow_zero=True) == ()


def test_a_team_stored_before_the_toggles_keeps_its_larger_values() -> None:
    """A legacy Fibonacci or linear row reads as extended; every other scale, and a stored toggle, does not."""
    row = {"workspace_id": "W", "team_id": "T", "name": "Apollo", "key_prefix": "APO"}
    for scale, extended in (("fibonacci", True), ("linear", True), ("tshirt", False), ("off", False)):
        team = _as_team({**row, "estimate_scale": scale})
        assert team.estimate_extended is extended
        assert team.estimate_allow_zero is False
        assert team.estimate_count_unestimated is False
    assert _as_team({**row, "estimate_scale": "fibonacci", "estimate_extended": False}).estimate_extended is False


def test_an_exponential_team_takes_its_values_and_refuses_others(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """16 fits the exponential scale; 3 and 32 do not until the team extends it."""
    repositories.teams.update(workspace, TEAM, estimate_scale="exponential", estimate_extended=False)
    sign_in(client, OWNER)

    assert create_issue(client, workspace, estimate="16")["estimate"] == "16"
    for refused in ("3", "32", "0"):
        response = client.post(
            f"/api/workspaces/{workspace}/issues",
            json={"team_id": TEAM, "title": "Nope", "estimate": refused},
        )
        assert response.status_code == 422, refused

    repositories.teams.update(workspace, TEAM, estimate_extended=True, estimate_allow_zero=True)
    assert create_issue(client, workspace, estimate="64")["estimate"] == "64"
    assert create_issue(client, workspace, estimate="0")["estimate"] == "0"


def test_a_tshirt_team_extends_to_xxxl(client: TestClient, workspace: str, repositories: Any, statuses: Any) -> None:
    """XXL and XXXL need the extended toggle."""
    repositories.teams.update(workspace, TEAM, estimate_scale="tshirt", estimate_extended=False)
    sign_in(client, OWNER)
    refused = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"team_id": TEAM, "title": "Big", "estimate": "XXXL"},
    )
    assert refused.status_code == 422

    repositories.teams.update(workspace, TEAM, estimate_extended=True)
    assert create_issue(client, workspace, estimate="XXXL")["estimate"] == "XXXL"


def test_a_scale_switch_keeps_the_estimates_issues_hold(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """An off-scale estimate still reads back, survives an echo, and only a new value is checked."""
    repositories.teams.update(workspace, TEAM, estimate_scale="fibonacci", estimate_extended=True)
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, estimate="13")

    repositories.teams.update(workspace, TEAM, estimate_scale="tshirt", estimate_extended=False)
    path = f"/api/workspaces/{workspace}/issues/{issue['id']}"

    assert client.get(path).json()["estimate"] == "13"
    echoed = client.patch(path, json={"title": "Renamed", "estimate": "13"})
    assert echoed.status_code == 200, echoed.text
    assert echoed.json()["estimate"] == "13"
    assert repositories.issues.get(workspace, issue["id"]).estimate == "13"

    assert client.patch(path, json={"estimate": "21"}).status_code == 422
    assert client.patch(path, json={"estimate": "M"}).json()["estimate"] == "M"
