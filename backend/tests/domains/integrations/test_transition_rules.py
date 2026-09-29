"""The github-transitions routes with target branch patterns and whole-set replacement."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, sign_in
from tests.domains.integrations.conftest import TEAM, WORKSPACE

PATH = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/github-transitions"


def statuses_by_category(repositories: Any) -> dict[str, str]:
    """The seeded team's status ids by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def test_a_rule_carries_its_branch_pattern(client: TestClient, workspace: str, repositories: Any) -> None:
    """A pattern is stored normalized and read back, and a rule without one reads as null."""
    status_ids = statuses_by_category(repositories)
    sign_in(client, ADMIN)

    created = client.post(
        PATH, json={"trigger": "pr_merged", "status_id": status_ids["completed"], "branch_pattern": "refs/heads/main"}
    )
    plain = client.post(PATH, json={"trigger": "pr_opened", "status_id": status_ids["started"]})

    assert created.status_code == 201
    assert created.json()["branch_pattern"] == "main"
    assert plain.json()["branch_pattern"] is None
    listed = client.get(PATH).json()
    assert [(row["trigger"], row["branch_pattern"]) for row in listed] == [("pr_opened", None), ("pr_merged", "main")]


def test_one_trigger_takes_one_rule_per_branch_pattern(client: TestClient, workspace: str, repositories: Any) -> None:
    """Two branches for one trigger are fine, the same branch twice is a conflict."""
    status_ids = statuses_by_category(repositories)
    sign_in(client, ADMIN)

    first = client.post(
        PATH, json={"trigger": "pr_merged", "status_id": status_ids["started"], "branch_pattern": "staging"}
    )
    second = client.post(
        PATH, json={"trigger": "pr_merged", "status_id": status_ids["completed"], "branch_pattern": "main"}
    )
    again = client.post(
        PATH, json={"trigger": "pr_merged", "status_id": status_ids["completed"], "branch_pattern": "main"}
    )

    assert (first.status_code, second.status_code, again.status_code) == (201, 201, 409)


def test_a_pattern_no_branch_could_match_is_refused(client: TestClient, workspace: str) -> None:
    """A space or a colon never appears in a git branch name."""
    sign_in(client, ADMIN)

    response = client.post(PATH, json={"trigger": "pr_merged", "branch_pattern": "main branch"})

    assert response.status_code == 422


def test_a_patch_changes_and_clears_the_branch_pattern(client: TestClient, workspace: str, repositories: Any) -> None:
    """Setting a pattern then an empty one leaves the status as it was."""
    status_ids = statuses_by_category(repositories)
    sign_in(client, ADMIN)
    created = client.post(PATH, json={"trigger": "pr_merged", "status_id": status_ids["completed"]}).json()

    moved = client.patch(f"{PATH}/{created['transition_id']}", json={"branch_pattern": "release/*"})
    cleared = client.patch(f"{PATH}/{created['transition_id']}", json={"branch_pattern": ""})

    assert moved.json()["branch_pattern"] == "release/*"
    assert moved.json()["status_id"] == status_ids["completed"]
    assert cleared.json()["branch_pattern"] is None


def test_a_put_replaces_the_whole_set_and_an_empty_one_restores_the_defaults(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The preset lands in one call, and an empty list goes back to the design defaults."""
    status_ids = statuses_by_category(repositories)
    sign_in(client, ADMIN)
    client.post(PATH, json={"trigger": "pr_closed", "status_id": status_ids["cancelled"]})

    replaced = client.put(
        PATH,
        json={
            "rules": [
                {"trigger": "pr_opened", "status_id": status_ids["started"]},
                {"trigger": "pr_merged", "status_id": status_ids["started"], "branch_pattern": "staging"},
                {"trigger": "pr_merged", "status_id": status_ids["completed"], "branch_pattern": "main"},
            ]
        },
    )

    assert replaced.status_code == 200
    body = replaced.json()
    assert [(row["trigger"], row["branch_pattern"]) for row in body] == [
        ("pr_opened", None),
        ("pr_merged", "main"),
        ("pr_merged", "staging"),
    ]
    assert not any(row["is_default"] for row in body)

    restored = client.put(PATH, json={"rules": []})

    assert restored.status_code == 200
    assert all(row["is_default"] for row in restored.json())
    assert repositories.team_config.list_transitions(WORKSPACE, TEAM) == []


def test_a_put_with_a_repeated_rule_writes_nothing(client: TestClient, workspace: str, repositories: Any) -> None:
    """The set is checked whole before the old one is removed."""
    status_ids = statuses_by_category(repositories)
    sign_in(client, ADMIN)
    client.post(PATH, json={"trigger": "pr_closed", "status_id": status_ids["cancelled"]})

    response = client.put(
        PATH,
        json={
            "rules": [
                {"trigger": "pr_merged", "status_id": status_ids["completed"], "branch_pattern": "main"},
                {"trigger": "pr_merged", "status_id": status_ids["started"], "branch_pattern": "main"},
            ]
        },
    )

    assert response.status_code == 422
    assert [row.trigger for row in repositories.team_config.list_transitions(WORKSPACE, TEAM)] == ["pr_closed"]


def test_a_guest_cannot_replace_the_rules(client: TestClient, workspace: str) -> None:
    """Replacing the set is team admin, as every other rule write is."""
    sign_in(client, GUEST)

    response = client.put(PATH, json={"rules": []})

    assert response.status_code == 403
