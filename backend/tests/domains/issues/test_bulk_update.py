"""The bulk patch: one partial patch over many issues, validated all or nothing.

The properties held are that each issue is authorized exactly as a single patch
would be, that any refusal leaves every issue untouched, and that the history a
bulk edit leaves is the same per issue history a single edit leaves.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.domains.issues.schemas.issue import BULK_MAX_ISSUES
from tests.domains.helpers import GUEST, MEMBER, OUTSIDER, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


def _bulk(client: TestClient, workspace: str, issue_ids: "list[str]", patch: "dict[str, Any]") -> Any:
    """One bulk patch through the route."""
    return client.patch(f"/api/workspaces/{workspace}/issues", json={"issue_ids": issue_ids, "patch": patch})


def _label(repositories: Any, workspace: str, name: str) -> str:
    """Seed one label on `TEAM` and answer its id."""
    from app.common.db.dynamo.team_config import Label, label_key, new_config_id

    label_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=workspace,
            config_key=label_key(TEAM, label_id),
            team_id=TEAM,
            label_id=label_id,
            name=name,
            color="#00ff00",
        )
    )
    return label_id


def test_a_bulk_patch_moves_every_named_issue(client: TestClient, workspace: str, statuses: Any) -> None:
    """Status, priority and assignee land on each issue, answered in request order."""
    sign_in(client, OWNER)
    first = create_issue(client, workspace, title="First")
    second = create_issue(client, workspace, title="Second")

    response = _bulk(
        client,
        workspace,
        [second["id"], first["id"]],
        {"status_id": statuses["started"].status_id, "priority": "high", "assignee_id": MEMBER},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [row["id"] for row in body["issues"]] == [second["id"], first["id"]]
    assert body["skipped"] == []
    for row in body["issues"]:
        assert row["status_id"] == statuses["started"].status_id
        assert row["priority"] == "high"
        assert row["assignee_id"] == MEMBER


def test_an_explicit_null_clears_and_an_absent_field_is_left_alone(
    client: TestClient, workspace: str, statuses: Any
) -> None:
    """A null assignee unassigns; an unnamed priority is not reset."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace, assignee_id=MEMBER, priority="urgent")

    body = _bulk(client, workspace, [created["id"]], {"assignee_id": None}).json()

    assert body["issues"][0]["assignee_id"] is None
    assert body["issues"][0]["priority"] == "urgent"


def test_labels_are_added_and_removed_without_touching_the_rest(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """Tagging a selection keeps each issue's other labels."""
    bug = _label(repositories, workspace, "Bug")
    ui = _label(repositories, workspace, "UI")
    stale = _label(repositories, workspace, "Stale")
    sign_in(client, OWNER)
    first = create_issue(client, workspace, label_ids=[ui, stale])
    second = create_issue(client, workspace, label_ids=[bug])

    body = _bulk(
        client, workspace, [first["id"], second["id"]], {"add_label_ids": [bug], "remove_label_ids": [stale]}
    ).json()

    labels = {row["id"]: row["label_ids"] for row in body["issues"]}
    assert labels[first["id"]] == [ui, bug]
    assert labels[second["id"]] == [bug]


def test_a_label_both_added_and_removed_is_a_422(client: TestClient, workspace: str, statuses: Any) -> None:
    """Add and remove overlapping has no single meaning, so it is refused."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)

    response = _bulk(client, workspace, [created["id"]], {"add_label_ids": ["x"], "remove_label_ids": ["x"]})

    assert response.status_code == 422


def test_each_issue_records_its_own_activity(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """History cannot tell a bulk edit from one issue edited at a time."""
    sign_in(client, OWNER)
    first = create_issue(client, workspace)
    second = create_issue(client, workspace)

    _bulk(client, workspace, [first["id"], second["id"]], {"priority": "low"})

    for issue in (first, second):
        rows = repositories.activity.list_for_issue(workspace, issue["id"]).items
        changed = [row for row in rows if row["kind"] == "field_changed"]
        assert [(row["field"], row["to_value"]) for row in changed] == [("priority", "low")]
        assert changed[0]["actor_id"] == OWNER


def test_an_invisible_issue_fails_the_whole_batch_as_a_404(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """A guest naming an issue in a team they are outside changes nothing and learns nothing."""
    sign_in(client, OWNER)
    visible = create_issue(client, workspace)
    hidden = create_issue(client, workspace, team_id=OTHER_TEAM)

    sign_in(client, GUEST)
    response = _bulk(client, workspace, [visible["id"], hidden["id"]], {"priority": "urgent"})

    assert response.status_code == 404
    assert repositories.issues.get(workspace, visible["id"]).priority == "none"


def test_a_missing_issue_fails_the_whole_batch(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """An absent id reads exactly like an invisible one."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)

    response = _bulk(client, workspace, [created["id"], "01JB0000000000000000MISSNG"], {"priority": "urgent"})

    assert response.status_code == 404
    assert repositories.issues.get(workspace, created["id"]).priority == "none"


def test_a_value_one_team_refuses_fails_the_whole_batch(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """A status belongs to one team, so naming it across two teams is a 422 with nothing written."""
    sign_in(client, OWNER)
    here = create_issue(client, workspace)
    there = create_issue(client, workspace, team_id=OTHER_TEAM)

    response = _bulk(client, workspace, [here["id"], there["id"]], {"status_id": statuses["started"].status_id})

    assert response.status_code == 422
    assert repositories.issues.get(workspace, here["id"]).status_id != statuses["started"].status_id


def test_a_non_member_is_refused(client: TestClient, workspace: str, statuses: Any) -> None:
    """Someone outside the workspace cannot reach the route at all."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)

    sign_in(client, OUTSIDER)
    assert _bulk(client, workspace, [created["id"]], {"priority": "low"}).status_code == 404


def test_the_batch_size_is_capped(client: TestClient, workspace: str, statuses: Any) -> None:
    """More than the cap is a 422 before anything is read."""
    sign_in(client, OWNER)
    ids = [f"01JB{n:022d}" for n in range(BULK_MAX_ISSUES + 1)]

    assert _bulk(client, workspace, ids, {"priority": "low"}).status_code == 422
    assert _bulk(client, workspace, [], {"priority": "low"}).status_code == 422


def test_repeated_ids_are_patched_once(client: TestClient, workspace: str, statuses: Any, repositories: Any) -> None:
    """A repeat would otherwise write its activity twice."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)

    body = _bulk(client, workspace, [created["id"], created["id"]], {"priority": "low"}).json()

    assert len(body["issues"]) == 1
    rows = repositories.activity.list_for_issue(workspace, created["id"]).items
    assert len([row for row in rows if row["kind"] == "field_changed"]) == 1


def test_a_team_member_guest_may_bulk_edit_their_team(client: TestClient, workspace: str, statuses: Any) -> None:
    """A guest with a membership writes in bulk exactly where they may write singly."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace, team_id=TEAM)

    sign_in(client, GUEST)
    response = _bulk(client, workspace, [created["id"]], {"priority": "medium"})

    assert response.status_code == 200
    assert response.json()["issues"][0]["priority"] == "medium"
