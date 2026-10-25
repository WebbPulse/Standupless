"""Deleting an issue to its team's trash, restoring it, and purging it for good.

The properties worth holding are that a delete keeps the row but drops it from
every list while a lookup by key or id still answers it with `deleted_at`, that a
restore brings it back whole and is allowed to exactly the people a delete is,
that the trash lists who deleted what, that only a team admin purges by hand, and
that the hourly sweep purges what has sat in the trash past 30 days and nothing
younger.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.domains.issues import trash_purge
from app.domains.issues.consumers.rollup import handle_record
from app.domains.issues.cycle_close import CYCLE_CLOSE_SOURCE
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


def _base(workspace: str) -> str:
    """The issues collection path of one workspace."""
    return f"/api/workspaces/{workspace}/issues"


def _listed(client: TestClient, workspace: str, team_id: str = TEAM) -> list[str]:
    """The ids the team's default issue list answers."""
    response = client.get(_base(workspace), params={"team_id": team_id})
    assert response.status_code == 200, response.text
    return [row["id"] for row in response.json()["issues"]]


def _trash(client: TestClient, workspace: str, team_id: str = TEAM) -> Any:
    """The team's recently deleted listing."""
    response = client.get(f"{_base(workspace)}/deleted", params={"team_id": team_id})
    assert response.status_code == 200, response.text
    return response.json()


def _delete(client: TestClient, workspace: str, issue: Any) -> None:
    """Move one issue to the trash, failing loudly on a refusal."""
    response = client.delete(f"{_base(workspace)}/{issue['id']}")
    assert response.status_code == 204, response.text


def _backdate(repositories: Any, workspace: str, issue_id: str, days: int) -> None:
    """Stamp a trashed issue as deleted `days` ago, as if it had sat there that long."""
    row = repositories.issues.get(workspace, issue_id, include_deleted=True)
    assert row is not None and row.deleted_at is not None
    repositories.issues.replace(
        row.model_copy(update={"deleted_at": utc_now() - timedelta(days=days)}).at_revision(row.read_revision()),
        restoring=True,
    )


def test_a_delete_stamps_the_issue_and_drops_it_from_the_list(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """The row stays with who deleted it and when, and the list no longer shows it."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace, title="Mine")
    kept = create_issue(client, workspace, title="Kept")

    _delete(client, workspace, issue)

    stored = repositories.issues.get(workspace, issue["id"], include_deleted=True)
    assert stored is not None
    assert stored.deleted_at is not None
    assert stored.deleted_by == MEMBER
    assert repositories.issues.get(workspace, issue["id"]) is None
    assert _listed(client, workspace) == [kept["id"]]


def test_a_deleted_issue_still_answers_by_key_and_id(client: TestClient, workspace: str, statuses: Any) -> None:
    """The issue page can show the deleted banner and offer a restore."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    _delete(client, workspace, issue)

    by_key = client.get(f"{_base(workspace)}/by-key/{issue['key']}")
    by_id = client.get(f"{_base(workspace)}/{issue['id']}")

    assert by_key.status_code == 200, by_key.text
    assert by_key.json()["deleted_at"] is not None
    assert by_key.json()["deleted_by"] == OWNER
    assert by_id.json()["deleted_at"] == by_key.json()["deleted_at"]


def test_a_deleted_issue_leaves_its_parent_s_children(client: TestClient, workspace: str, statuses: Any) -> None:
    """A trashed sub-issue no longer counts under its parent."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    _delete(client, workspace, child)

    listed = client.get(f"{_base(workspace)}/{parent['id']}/children").json()
    assert listed["issues"] == []


def test_a_restore_brings_the_issue_back_with_its_history(client: TestClient, workspace: str, statuses: Any) -> None:
    """The issue rejoins the list, and its history records both the delete and the restore."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    _delete(client, workspace, issue)

    response = client.post(f"{_base(workspace)}/{issue['id']}/restore")

    assert response.status_code == 200, response.text
    assert response.json()["deleted_at"] is None
    assert response.json()["deleted_by"] is None
    assert _listed(client, workspace) == [issue["id"]]
    assert _trash(client, workspace)["issues"] == []
    kinds = [row["kind"] for row in client.get(f"{_base(workspace)}/{issue['id']}/activity").json()["activity"]]
    assert kinds[:2] == ["restored", "deleted"]


def test_restoring_a_live_issue_changes_nothing(client: TestClient, workspace: str, statuses: Any) -> None:
    """A second restore, or an Undo that raced one, answers the live issue."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    _delete(client, workspace, issue)
    first = client.post(f"{_base(workspace)}/{issue['id']}/restore").json()

    again = client.post(f"{_base(workspace)}/{issue['id']}/restore")

    assert again.status_code == 200, again.text
    assert again.json()["updated_at"] == first["updated_at"]


def test_a_restored_parent_gets_its_children_back(client: TestClient, workspace: str, statuses: Any) -> None:
    """Children wait in place while the parent sits in the trash."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])
    _delete(client, workspace, parent)

    client.post(f"{_base(workspace)}/{parent['id']}/restore")

    listed = client.get(f"{_base(workspace)}/{parent['id']}/children").json()
    assert [row["id"] for row in listed["issues"]] == [child["id"]]


def test_a_restore_puts_the_links_back_in_the_counts(client: TestClient, workspace: str, statuses: Any) -> None:
    """The far side of a link stops counting it in the trash and counts it again after a restore."""
    sign_in(client, OWNER)
    doomed = create_issue(client, workspace, title="Doomed")
    survivor = create_issue(client, workspace, title="Survivor")
    link = client.post(
        f"{_base(workspace)}/{doomed['id']}/links", json={"type": "blocks", "target_issue_id": survivor["id"]}
    )
    assert link.status_code == 201, link.text

    _delete(client, workspace, doomed)
    hidden = client.get(f"{_base(workspace)}/{survivor['id']}").json()
    client.post(f"{_base(workspace)}/{doomed['id']}/restore")
    back = client.get(f"{_base(workspace)}/{survivor['id']}").json()

    assert hidden["relation_count"] == 0
    assert hidden["blocked_by_open_count"] == 0
    assert back["relation_count"] == 1
    assert back["blocked_by_open_count"] == 1
    links = client.get(f"{_base(workspace)}/{survivor['id']}/links").json()["links"]
    assert [row["target_issue_id"] for row in links] == [doomed["id"]]


def test_a_creator_restores_their_own_issue(client: TestClient, workspace: str, statuses: Any) -> None:
    """Whoever may delete an issue may restore it."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)
    _delete(client, workspace, issue)

    assert client.post(f"{_base(workspace)}/{issue['id']}/restore").status_code == 200


def test_a_member_cannot_restore_someone_else_s_issue(client: TestClient, workspace: str, statuses: Any) -> None:
    """Not the creator and not an admin is refused, as for the delete."""
    sign_in(client, ADMIN)
    issue = create_issue(client, workspace)
    _delete(client, workspace, issue)

    sign_in(client, MEMBER)
    assert client.post(f"{_base(workspace)}/{issue['id']}/restore").status_code == 403


def test_a_guest_outside_the_team_sees_no_trash(client: TestClient, workspace: str, statuses: Any) -> None:
    """Invisible beats unauthorised: the issue, its restore and the team's trash all answer 404."""
    sign_in(client, OWNER)
    hidden = create_issue(client, workspace, team_id=OTHER_TEAM)
    _delete(client, workspace, hidden)

    sign_in(client, GUEST)
    assert client.get(f"{_base(workspace)}/{hidden['id']}").status_code == 404
    assert client.post(f"{_base(workspace)}/{hidden['id']}/restore").status_code == 404
    assert client.get(f"{_base(workspace)}/deleted", params={"team_id": OTHER_TEAM}).status_code == 404


def test_the_trash_lists_who_deleted_what_newest_first(client: TestClient, workspace: str, statuses: Any) -> None:
    """Each row names its deleter and time, and the answer carries the retention."""
    sign_in(client, OWNER)
    first = create_issue(client, workspace, title="First")
    second = create_issue(client, workspace, title="Second")
    create_issue(client, workspace, title="Live")
    _delete(client, workspace, first)
    sign_in(client, ADMIN)
    _delete(client, workspace, second)

    body = _trash(client, workspace)

    assert body["retention_days"] == 30
    assert [(row["id"], row["deleted_by"]) for row in body["issues"]] == [(second["id"], ADMIN), (first["id"], OWNER)]
    assert all(row["deleted_at"] for row in body["issues"])


def test_only_a_team_admin_purges_by_hand(client: TestClient, workspace: str, statuses: Any, repositories: Any) -> None:
    """A member is refused, a live issue is a conflict, and an admin's purge removes the row."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)
    live = create_issue(client, workspace, title="Live")
    _delete(client, workspace, issue)

    assert client.delete(f"{_base(workspace)}/{issue['id']}/permanent").status_code == 403

    sign_in(client, ADMIN)
    conflict = client.delete(f"{_base(workspace)}/{live['id']}/permanent")
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "NOT_DELETED"

    assert client.delete(f"{_base(workspace)}/{issue['id']}/permanent").status_code == 204
    assert repositories.issues.get(workspace, issue["id"], include_deleted=True) is None
    assert client.get(f"{_base(workspace)}/by-key/{issue['key']}").status_code == 404
    assert _trash(client, workspace)["issues"] == []


def test_the_sweep_purges_only_issues_past_the_retention(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """Thirty days in the trash is the limit; a younger deletion stays restorable."""
    sign_in(client, OWNER)
    old = create_issue(client, workspace, title="Old")
    young = create_issue(client, workspace, title="Young")
    child = create_issue(client, workspace, title="Child", parent_id=old["id"])
    _delete(client, workspace, old)
    _delete(client, workspace, young)
    _backdate(repositories, workspace, old["id"], 31)
    _backdate(repositories, workspace, young["id"], 29)

    summary = trash_purge.sweep(repositories)

    assert summary.purged == 1
    assert repositories.issues.get(workspace, old["id"], include_deleted=True) is None
    assert repositories.issues.get(workspace, young["id"], include_deleted=True) is not None
    assert client.get(f"{_base(workspace)}/{child['id']}").json()["parent_id"] is None
    assert repositories.activity.list_for_issue(workspace, old["id"], limit=50).items == []


def test_the_sweep_leaves_live_issues_alone(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """Only the trash partition is read, so a live issue is never purged, however old."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)

    summary = trash_purge.sweep(repositories, now=utc_now() + timedelta(days=365))

    assert summary.purged == 0
    assert _listed(client, workspace) == [issue["id"]]


def test_the_hourly_record_runs_the_sweep(client: TestClient, workspace: str, statuses: Any, repositories: Any) -> None:
    """The cycle close schedule's record purges the trash too, so it needs no schedule of its own."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    _delete(client, workspace, issue)
    _backdate(repositories, workspace, issue["id"], 45)

    handle_record(repositories, {"eventSource": CYCLE_CLOSE_SOURCE, "eventName": "SWEEP", "eventID": "cycle-close"})

    assert repositories.issues.get(workspace, issue["id"], include_deleted=True) is None


def test_a_trashed_issue_cannot_be_edited(client: TestClient, workspace: str, statuses: Any) -> None:
    """A stale writer never pulls an issue back out of the trash by patching it."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    _delete(client, workspace, issue)

    response = client.patch(f"{_base(workspace)}/{issue['id']}", json={"title": "Edited"})

    assert response.status_code == 404
