"""The issue routes, against real tables in moto.

These cover the contract's shapes and the rules that need a table read: the key
allocated from the team's counter, the estimate validated against the team's
scale, the single-level parenting rule, and one activity row per changed field.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common import issue_keys
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


def test_creating_an_issue_allocates_a_key_from_the_team_counter(
    client: TestClient, workspace: str, statuses: Any
) -> None:
    """The first issue of a team is its prefix and one, and the next is two."""
    sign_in(client, OWNER)
    first = create_issue(client, workspace, title="First")
    second = create_issue(client, workspace, title="Second")

    assert first["key"] == "ABC-1"
    assert first["number"] == 1
    assert second["key"] == "ABC-2"
    assert second["number"] == 2


def test_each_team_numbers_its_own_issues(client: TestClient, workspace: str, statuses: Any) -> None:
    """Counters are per team, so the second team starts at one again."""
    sign_in(client, OWNER)
    create_issue(client, workspace, title="First")
    other = create_issue(client, workspace, team_id=OTHER_TEAM, title="Elsewhere")

    assert other["key"] == "XYZ-1"


def test_a_gap_in_the_numbers_is_tolerated(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A consumed but unused number leaves a gap, and nothing renumbers.

    The counter is allocated with an atomic add, so a failed create burns a
    number; the contract accepts that rather than making creation transactional.
    """
    sign_in(client, OWNER)
    create_issue(client, workspace, title="First")
    repositories.counters.allocate_issue_number(workspace, TEAM)
    third = create_issue(client, workspace, title="Third")

    assert third["key"] == "ABC-3"


def test_a_new_issue_lands_in_the_lowest_backlog_status(client: TestClient, workspace: str, statuses: Any) -> None:
    """With no status named, the issue takes the lowest position backlog one."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)

    assert created["status_id"] == statuses["backlog"].status_id
    assert created["priority"] == "none"
    assert created["progress"] == {"total": 0, "completed": 0}


def test_reading_an_issue_by_key_is_case_insensitive(client: TestClient, workspace: str, statuses: Any) -> None:
    """`abc-1` finds `ABC-1`, which is what a pasted key from chat looks like."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)

    response = client.get(f"/api/workspaces/{workspace}/issues/by-key/abc-1")

    assert response.status_code == 200
    assert response.json()["id"] == created["id"]


def test_an_issue_resolves_by_its_old_and_new_key_after_a_key_change(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A retired prefix is an alias of the team, so `ABC-1` and `NEW-1` are one issue."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)
    repositories.teams.change_key_prefix(workspace, TEAM, "NEW")

    for key in ("ABC-1", "new-1"):
        response = client.get(f"/api/workspaces/{workspace}/issues/by-key/{key}")
        assert response.status_code == 200
        assert response.json()["id"] == created["id"]


def test_reads_show_the_current_key_after_a_key_change(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The stored row keeps `ABC-1`, but every read shows the team's current prefix."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)
    repositories.teams.change_key_prefix(workspace, TEAM, "NEW")
    issue_keys.clear()

    by_id = client.get(f"/api/workspaces/{workspace}/issues/{created['id']}").json()
    by_key = client.get(f"/api/workspaces/{workspace}/issues/by-key/ABC-1").json()
    listed = client.get(f"/api/workspaces/{workspace}/issues", params={"team_id": TEAM}).json()

    assert by_id["key"] == "NEW-1"
    assert by_key["key"] == "NEW-1"
    assert [row["key"] for row in listed["issues"]] == ["NEW-1"]
    assert repositories.issues.get(workspace, created["id"]).key == "ABC-1"


def test_a_key_that_is_not_a_key_is_a_404(client: TestClient, workspace: str, statuses: Any) -> None:
    """A malformed key is not found rather than a 422, because it names nothing."""
    sign_in(client, OWNER)
    assert client.get(f"/api/workspaces/{workspace}/issues/by-key/not-a-key-at-all").status_code == 404


def test_an_estimate_is_held_to_the_team_scale(client: TestClient, workspace: str, statuses: Any) -> None:
    """A team defaults to estimates off, so any estimate is refused."""
    sign_in(client, OWNER)
    response = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"team_id": TEAM, "title": "Sized", "estimate": "3"},
    )

    assert response.status_code == 422
    assert response.json()["error_code"] == "VALIDATION_ERROR"


def test_a_fibonacci_estimate_is_accepted_and_an_off_scale_one_is_not(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """With the scale set, the allowed values are exactly the contract's set."""
    repositories.teams.update(workspace, TEAM, estimate_scale="fibonacci")
    sign_in(client, OWNER)

    assert create_issue(client, workspace, title="Fits", estimate="8")["estimate"] == "8"

    response = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"team_id": TEAM, "title": "Nope", "estimate": "4"},
    )
    assert response.status_code == 422


def test_a_label_from_another_team_is_refused(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Labels belong to a team, so one from elsewhere would never render."""
    from app.common.db.dynamo.team_config import Label, label_key, new_config_id

    label_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=workspace,
            config_key=label_key(OTHER_TEAM, label_id),
            team_id=OTHER_TEAM,
            label_id=label_id,
            name="Elsewhere",
            color="#ff0000",
        )
    )
    sign_in(client, OWNER)

    response = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"team_id": TEAM, "title": "Labelled", "label_ids": [label_id]},
    )
    assert response.status_code == 422


def test_a_due_date_before_the_start_date_is_refused(client: TestClient, workspace: str, statuses: Any) -> None:
    """The contract makes the order a rule rather than a rendering concern."""
    sign_in(client, OWNER)
    response = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={
            "team_id": TEAM,
            "title": "Backwards",
            "start_date": "2026-03-10",
            "due_date": "2026-03-01",
        },
    )
    assert response.status_code == 422


def test_parenting_is_one_level_deep(client: TestClient, workspace: str, statuses: Any) -> None:
    """A child cannot itself be a parent, which is what keeps progress a count."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    response = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"team_id": TEAM, "title": "Grandchild", "parent_id": child["id"]},
    )
    assert response.status_code == 422


def test_a_parent_must_be_in_the_same_team(client: TestClient, workspace: str, statuses: Any) -> None:
    """Cross team parenting would put a key from one team under another."""
    sign_in(client, OWNER)
    elsewhere = create_issue(client, workspace, team_id=OTHER_TEAM, title="Elsewhere")

    response = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"team_id": TEAM, "title": "Child", "parent_id": elsewhere["id"]},
    )
    assert response.status_code == 422


def test_an_issue_cannot_be_its_own_parent(client: TestClient, workspace: str, statuses: Any) -> None:
    """The one cycle a single level of nesting still allows."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)

    response = client.patch(
        f"/api/workspaces/{workspace}/issues/{issue['id']}",
        json={"parent_id": issue["id"]},
    )
    assert response.status_code == 422


def test_patching_writes_one_activity_row_per_changed_field(client: TestClient, workspace: str, statuses: Any) -> None:
    """History records fields, not requests, so a reviewer sees what moved."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)

    response = client.patch(
        f"/api/workspaces/{workspace}/issues/{issue['id']}",
        json={"title": "Renamed", "priority": "high", "assignee_id": MEMBER},
    )
    assert response.status_code == 200

    feed = client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}/activity").json()["activity"]
    changed = {row["field"] for row in feed if row["kind"] == "field_changed"}

    assert changed == {"title", "priority", "assignee_id"}
    assert feed[-1]["kind"] == "created"


def test_patching_a_field_to_its_current_value_writes_no_activity(
    client: TestClient, workspace: str, statuses: Any
) -> None:
    """A no-op patch is not a change, so history stays readable."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, title="Steady")

    client.patch(f"/api/workspaces/{workspace}/issues/{issue['id']}", json={"title": "Steady"})

    feed = client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}/activity").json()["activity"]
    assert [row["kind"] for row in feed] == ["created"]


def test_activity_records_the_values_on_both_sides(client: TestClient, workspace: str, statuses: Any) -> None:
    """`from` and `to` are the wire names the contract fixes."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, title="Before")

    client.patch(f"/api/workspaces/{workspace}/issues/{issue['id']}", json={"title": "After"})

    feed = client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}/activity").json()["activity"]
    row = next(entry for entry in feed if entry["field"] == "title")

    assert row["from"] == "Before"
    assert row["to"] == "After"
    assert row["actor_kind"] == "user"


def test_the_team_of_an_issue_never_changes(client: TestClient, workspace: str, statuses: Any) -> None:
    """A patch carrying `team_id` leaves the issue where it was.

    The field is not in the patch schema at all, so the value is ignored rather
    than refused: the key and every index composite are derived from the team.
    """
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)

    response = client.patch(
        f"/api/workspaces/{workspace}/issues/{issue['id']}",
        json={"team_id": OTHER_TEAM, "title": "Moved"},
    )

    assert response.status_code == 200
    assert response.json()["team_id"] == TEAM


def test_deleting_an_issue_reparents_its_children(client: TestClient, workspace: str, statuses: Any) -> None:
    """A deleted parent leaves its children in place with no parent."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    assert client.delete(f"/api/workspaces/{workspace}/issues/{parent['id']}").status_code == 204

    remaining = client.get(f"/api/workspaces/{workspace}/issues/{child['id']}").json()
    assert remaining["parent_id"] is None


def test_deleting_an_issue_removes_its_activity(client: TestClient, workspace: str, statuses: Any) -> None:
    """History is partitioned per issue, so it would otherwise be unreachable."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)

    client.delete(f"/api/workspaces/{workspace}/issues/{issue['id']}")

    assert client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}/activity").status_code == 404


def test_listing_children_is_oldest_first(client: TestClient, workspace: str, statuses: Any) -> None:
    """The contract orders children by `created_at`."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    first = create_issue(client, workspace, title="First child", parent_id=parent["id"])
    second = create_issue(client, workspace, title="Second child", parent_id=parent["id"])

    listed = client.get(f"/api/workspaces/{workspace}/issues/{parent['id']}/children").json()

    assert [row["id"] for row in listed["issues"]] == [first["id"], second["id"]]


def test_the_body_is_capped_in_bytes(client: TestClient, workspace: str, statuses: Any) -> None:
    """The cap exists to keep the item under DynamoDB's limit, so it counts bytes."""
    from app.common.core.constants import ISSUE_BODY_MAX_BYTES

    sign_in(client, OWNER)
    response = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"team_id": TEAM, "title": "Huge", "body": "x" * (ISSUE_BODY_MAX_BYTES + 1)},
    )
    assert response.status_code == 422
