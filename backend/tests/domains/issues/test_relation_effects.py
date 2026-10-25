"""What a link or a parent change writes beyond its own rows.

Closing a duplicate, the sub-issue history on a parent, the target named in a
removed link, the denormalised blocked and blocking counts and the status a link
carries back. History written before a team key change names its issues under
the current key.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common import issue_keys
from app.common.issue_keys import current_reference_value
from app.domains.issues.consumers.rollup import handle_record, status_moved
from tests.domains.helpers import OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


def _link(client: TestClient, workspace: str, source: Any, target: Any, kind: str) -> Any:
    """Create one link through the route, failing loudly on a refusal."""
    response = client.post(
        f"/api/workspaces/{workspace}/issues/{source['id']}/links",
        json={"type": kind, "target_issue_id": target["id"]},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _unlink(client: TestClient, workspace: str, source: Any, link: Any) -> None:
    """Remove one link through the route."""
    response = client.delete(f"/api/workspaces/{workspace}/issues/{source['id']}/links/{link['link_id']}")
    assert response.status_code == 204, response.text


def _issue(client: TestClient, workspace: str, issue: Any) -> Any:
    """The issue as the API reads it now."""
    return client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}").json()


def _feed(client: TestClient, workspace: str, issue: Any) -> "list[dict[str, Any]]":
    """The issue's activity, newest first."""
    return client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}/activity").json()["activity"]


def _status_record(workspace: str, issue_id: str, old: str, new: str) -> "dict[str, Any]":
    """A stream MODIFY record moving one issue between two statuses."""

    def image(status_id: str) -> "dict[str, Any]":
        """One image in DynamoDB's wire encoding."""
        return {
            "workspace_id": {"S": workspace},
            "issue_id": {"S": issue_id},
            "status_id": {"S": status_id},
        }

    return {"eventName": "MODIFY", "eventID": "1", "dynamodb": {"NewImage": image(new), "OldImage": image(old)}}


def test_marking_a_duplicate_cancels_it_as_the_actor(client: TestClient, workspace: str, statuses: Any) -> None:
    """Linear closes a duplicate, and the history reads as the actor's own move."""
    sign_in(client, OWNER)
    duplicate = create_issue(client, workspace, title="Dupe")
    original = create_issue(client, workspace, title="Original")

    _link(client, workspace, duplicate, original, "duplicate_of")

    assert _issue(client, workspace, duplicate)["status_id"] == statuses["cancelled"].status_id
    assert _issue(client, workspace, original)["status_id"] != statuses["cancelled"].status_id
    moved = next(row for row in _feed(client, workspace, duplicate) if row["field"] == "status_id")
    assert moved["actor_id"] == OWNER
    assert moved["from"] == duplicate["status_id"]
    assert moved["to"] == statuses["cancelled"].status_id


def test_a_finished_duplicate_keeps_its_status(client: TestClient, workspace: str, statuses: Any) -> None:
    """A completed issue marked as a duplicate stays completed."""
    sign_in(client, OWNER)
    done = statuses["completed"].status_id
    duplicate = create_issue(client, workspace, title="Dupe", status_id=done)
    original = create_issue(client, workspace, title="Original")

    _link(client, workspace, duplicate, original, "duplicate_of")

    assert _issue(client, workspace, duplicate)["status_id"] == done
    assert not [row for row in _feed(client, workspace, duplicate) if row["field"] == "status_id"]


def test_removing_the_duplicate_link_leaves_the_status(client: TestClient, workspace: str, statuses: Any) -> None:
    """Unlinking does not reopen the issue, as in Linear."""
    sign_in(client, OWNER)
    duplicate = create_issue(client, workspace, title="Dupe")
    original = create_issue(client, workspace, title="Original")
    link = _link(client, workspace, duplicate, original, "duplicate_of")

    _unlink(client, workspace, duplicate, link)

    assert _issue(client, workspace, duplicate)["status_id"] == statuses["cancelled"].status_id


def test_setting_a_parent_writes_child_added_on_it(client: TestClient, workspace: str, statuses: Any) -> None:
    """The parent's history names the new sub-issue whole."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child")

    client.patch(f"/api/workspaces/{workspace}/issues/{child['id']}", json={"parent_id": parent["id"]})

    added = next(row for row in _feed(client, workspace, parent) if row["kind"] == "child_added")
    assert added["to"] == {"id": child["id"], "key": child["key"], "title": "Child"}
    assert added["actor_id"] == OWNER
    assert any(row["field"] == "parent_id" for row in _feed(client, workspace, child))


def test_history_written_before_a_key_change_shows_the_current_key(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A sub-issue and a link recorded as `ABC-n` read as `NEW-n` once the team is renamed."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child")
    blocker = create_issue(client, workspace, title="Blocker")
    client.patch(f"/api/workspaces/{workspace}/issues/{child['id']}", json={"parent_id": parent["id"]})
    _link(client, workspace, parent, blocker, "blocked_by")
    stored = [row.get("to_value") for row in repositories.activity.list_for_issue(workspace, parent["id"]).items]
    assert {"id": child["id"], "key": child["key"], "title": "Child"} in stored

    repositories.teams.change_key_prefix(workspace, TEAM, "NEW")
    issue_keys.clear()

    feed = _feed(client, workspace, parent)
    added = next(row for row in feed if row["kind"] == "child_added")
    linked = next(row for row in feed if isinstance(row["to"], dict) and row["to"].get("id") == blocker["id"])
    number = child["key"].rpartition("-")[2]
    assert added["to"] == {"id": child["id"], "key": f"NEW-{number}", "title": "Child"}
    assert linked["to"]["key"] == f"NEW-{blocker['key'].rpartition('-')[2]}"


def test_current_reference_value_rewrites_only_retired_issue_keys() -> None:
    """Only the key of an issue reference under a retired prefix changes."""
    renames = {"SUP": "STUP"}

    assert current_reference_value({"id": "i1", "key": "SUP-28", "title": "T"}, renames) == {
        "id": "i1",
        "key": "STUP-28",
        "title": "T",
    }
    assert current_reference_value([{"id": "i1", "key": "SUP-1"}], renames) == [{"id": "i1", "key": "STUP-1"}]
    assert current_reference_value({"id": "i2", "key": "CAR-3"}, renames) == {"id": "i2", "key": "CAR-3"}
    assert current_reference_value("SUP-28", renames) == "SUP-28"
    assert current_reference_value({"id": "i1", "key": "SUP-28"}, {}) == {"id": "i1", "key": "SUP-28"}


def test_moving_a_child_writes_on_both_parents(client: TestClient, workspace: str, statuses: Any) -> None:
    """The old parent loses the sub-issue and the new one gains it."""
    sign_in(client, OWNER)
    first = create_issue(client, workspace, title="First")
    second = create_issue(client, workspace, title="Second")
    child = create_issue(client, workspace, title="Child", parent_id=first["id"])

    client.patch(f"/api/workspaces/{workspace}/issues/{child['id']}", json={"parent_id": second["id"]})

    removed = next(row for row in _feed(client, workspace, first) if row["kind"] == "child_removed")
    added = next(row for row in _feed(client, workspace, second) if row["kind"] == "child_added")
    assert removed["from"]["id"] == added["to"]["id"] == child["id"]


def test_clearing_a_parent_writes_child_removed(client: TestClient, workspace: str, statuses: Any) -> None:
    """Clearing the parent is the same history as moving it away."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    client.patch(f"/api/workspaces/{workspace}/issues/{child['id']}", json={"parent_id": None})

    kinds = [row["kind"] for row in _feed(client, workspace, parent)]
    assert kinds.count("child_added") == 1
    assert kinds.count("child_removed") == 1


def test_creating_a_sub_issue_writes_on_both_sides(client: TestClient, workspace: str, statuses: Any) -> None:
    """A sub-issue born under a parent shows in both histories."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    added = next(row for row in _feed(client, workspace, parent) if row["kind"] == "child_added")
    set_parent = next(row for row in _feed(client, workspace, child) if row["field"] == "parent_id")
    assert added["to"]["id"] == child["id"]
    assert set_parent["from"] is None
    assert set_parent["to"] == parent["id"]


def test_purging_a_sub_issue_writes_child_removed(client: TestClient, workspace: str, statuses: Any) -> None:
    """The parent's history keeps the sub-issue's name after it is gone."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    client.delete(f"/api/workspaces/{workspace}/issues/{child['id']}")
    client.delete(f"/api/workspaces/{workspace}/issues/{child['id']}/permanent")

    removed = next(row for row in _feed(client, workspace, parent) if row["kind"] == "child_removed")
    assert removed["from"]["title"] == "Child"


def test_purging_a_parent_writes_on_its_orphans(client: TestClient, workspace: str, statuses: Any) -> None:
    """Each orphaned child records that its parent was cleared."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    client.delete(f"/api/workspaces/{workspace}/issues/{parent['id']}")
    client.delete(f"/api/workspaces/{workspace}/issues/{parent['id']}/permanent")

    cleared = [row for row in _feed(client, workspace, child) if row["field"] == "parent_id"]
    assert cleared[0]["from"] == parent["id"]
    assert cleared[0]["to"] is None


def test_a_removed_link_names_its_target(client: TestClient, workspace: str, statuses: Any) -> None:
    """The timeline can read "removed blocking ABC-2 Target" with no other lookup."""
    sign_in(client, OWNER)
    source = create_issue(client, workspace, title="Source")
    target = create_issue(client, workspace, title="Target")
    link = _link(client, workspace, source, target, "blocks")

    _unlink(client, workspace, source, link)

    removed = next(row for row in _feed(client, workspace, source) if row["kind"] == "link_removed")
    assert removed["field"] == "blocks"
    assert removed["from"] == {"id": target["id"], "key": target["key"], "title": "Target"}


def test_a_blocked_by_link_counts_an_open_blocker(client: TestClient, workspace: str, statuses: Any) -> None:
    """Either direction of the write lands the count on the blocked issue."""
    sign_in(client, OWNER)
    blocker = create_issue(client, workspace, title="Blocker")
    blocked = create_issue(client, workspace, title="Blocked")
    other = create_issue(client, workspace, title="Other")

    _link(client, workspace, blocker, blocked, "blocks")
    link = _link(client, workspace, blocked, other, "blocked_by")

    assert _issue(client, workspace, blocked)["blocked_by_open_count"] == 2
    assert _issue(client, workspace, blocker)["blocked_by_open_count"] == 0

    _unlink(client, workspace, blocked, link)

    assert _issue(client, workspace, blocked)["blocked_by_open_count"] == 1


def test_a_finished_blocker_does_not_count(client: TestClient, workspace: str, statuses: Any) -> None:
    """A completed blocker no longer blocks."""
    sign_in(client, OWNER)
    blocker = create_issue(client, workspace, title="Blocker", status_id=statuses["completed"].status_id)
    blocked = create_issue(client, workspace, title="Blocked")

    _link(client, workspace, blocker, blocked, "blocks")

    assert _issue(client, workspace, blocked)["blocked_by_open_count"] == 0


def test_a_blocker_status_change_recounts_through_the_stream(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The rollup consumer carries a blocker's status move to what it blocks."""
    sign_in(client, OWNER)
    blocker = create_issue(client, workspace, title="Blocker")
    blocked = create_issue(client, workspace, title="Blocked")
    _link(client, workspace, blocker, blocked, "blocks")
    done = statuses["completed"].status_id

    client.patch(f"/api/workspaces/{workspace}/issues/{blocker['id']}", json={"status_id": done})
    record = _status_record(workspace, blocker["id"], blocker["status_id"], done)
    handle_record(repositories, record)
    handle_record(repositories, record)

    assert _issue(client, workspace, blocked)["blocked_by_open_count"] == 0


def test_only_a_status_move_wakes_the_blocked_recount(workspace: str) -> None:
    """Creates, deletes and unrelated edits leave the blocked count alone."""
    moved = _status_record(workspace, "I1", "A", "B")
    unchanged = _status_record(workspace, "I1", "A", "A")
    insert = {"eventName": "INSERT", "eventID": "1", "dynamodb": {"NewImage": moved["dynamodb"]["NewImage"]}}

    assert status_moved(moved) == "I1"
    assert status_moved(unchanged) == ""
    assert status_moved(insert) == ""


def test_deleting_a_blocker_clears_the_count(client: TestClient, workspace: str, statuses: Any) -> None:
    """A deleted blocker stops blocking at once, not on the next stream record."""
    sign_in(client, OWNER)
    blocker = create_issue(client, workspace, title="Blocker")
    blocked = create_issue(client, workspace, title="Blocked")
    _link(client, workspace, blocker, blocked, "blocks")

    client.delete(f"/api/workspaces/{workspace}/issues/{blocker['id']}")

    assert _issue(client, workspace, blocked)["blocked_by_open_count"] == 0


def test_a_blocking_link_counts_on_the_blocker(client: TestClient, workspace: str, statuses: Any) -> None:
    """Either direction of the write lands the blocking count on the blocker."""
    sign_in(client, OWNER)
    blocker = create_issue(client, workspace, title="Blocker")
    first = create_issue(client, workspace, title="First")
    second = create_issue(client, workspace, title="Second")

    _link(client, workspace, blocker, first, "blocks")
    link = _link(client, workspace, second, blocker, "blocked_by")

    assert _issue(client, workspace, blocker)["blocking_count"] == 2
    assert _issue(client, workspace, first)["blocking_count"] == 0

    _unlink(client, workspace, second, link)

    assert _issue(client, workspace, blocker)["blocking_count"] == 1


def test_a_finished_blocker_stops_blocking_through_the_stream(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A blocker moved to a finished status loses its blocking count, and regains it on reopen."""
    sign_in(client, OWNER)
    blocker = create_issue(client, workspace, title="Blocker")
    blocked = create_issue(client, workspace, title="Blocked")
    _link(client, workspace, blocker, blocked, "blocks")
    done = statuses["completed"].status_id

    client.patch(f"/api/workspaces/{workspace}/issues/{blocker['id']}", json={"status_id": done})
    handle_record(repositories, _status_record(workspace, blocker["id"], blocker["status_id"], done))

    assert _issue(client, workspace, blocker)["blocking_count"] == 0

    client.patch(f"/api/workspaces/{workspace}/issues/{blocker['id']}", json={"status_id": blocker["status_id"]})
    handle_record(repositories, _status_record(workspace, blocker["id"], done, blocker["status_id"]))

    assert _issue(client, workspace, blocker)["blocking_count"] == 1


def test_a_finished_blocked_issue_does_not_count_on_its_blocker(
    client: TestClient, workspace: str, statuses: Any
) -> None:
    """A link to a blocked issue that is already done leaves the blocking count alone."""
    sign_in(client, OWNER)
    blocker = create_issue(client, workspace, title="Blocker")
    done = create_issue(client, workspace, title="Done", status_id=statuses["completed"].status_id)
    open_issue = create_issue(client, workspace, title="Open")

    _link(client, workspace, blocker, done, "blocks")
    _link(client, workspace, blocker, open_issue, "blocks")

    assert _issue(client, workspace, blocker)["blocking_count"] == 1


def test_a_blocked_issue_finishing_drops_out_of_the_blocking_count(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The stream recounts a blocker when an issue it blocks is finished, and again on reopen."""
    sign_in(client, OWNER)
    blocker = create_issue(client, workspace, title="Blocker")
    first = create_issue(client, workspace, title="First")
    second = create_issue(client, workspace, title="Second")
    _link(client, workspace, blocker, first, "blocks")
    _link(client, workspace, second, blocker, "blocked_by")
    done = statuses["completed"].status_id

    assert _issue(client, workspace, blocker)["blocking_count"] == 2

    client.patch(f"/api/workspaces/{workspace}/issues/{first['id']}", json={"status_id": done})
    record = _status_record(workspace, first["id"], first["status_id"], done)
    handle_record(repositories, record)
    handle_record(repositories, record)

    assert _issue(client, workspace, blocker)["blocking_count"] == 1

    client.patch(f"/api/workspaces/{workspace}/issues/{first['id']}", json={"status_id": first["status_id"]})
    handle_record(repositories, _status_record(workspace, first["id"], done, first["status_id"]))

    assert _issue(client, workspace, blocker)["blocking_count"] == 2


def test_deleting_a_blocked_issue_clears_the_blocking_count(client: TestClient, workspace: str, statuses: Any) -> None:
    """A deleted blocked issue stops counting on its blocker at once."""
    sign_in(client, OWNER)
    blocker = create_issue(client, workspace, title="Blocker")
    blocked = create_issue(client, workspace, title="Blocked")
    _link(client, workspace, blocker, blocked, "blocks")

    client.delete(f"/api/workspaces/{workspace}/issues/{blocked['id']}")

    assert _issue(client, workspace, blocker)["blocking_count"] == 0


def test_the_recount_script_fills_blocking_counts_once(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A blocker from before the count gains it, and a rerun writes nothing."""
    from scripts.recount_blocking_counts import run

    sign_in(client, OWNER)
    blocker = create_issue(client, workspace, title="Blocker")
    blocked = create_issue(client, workspace, title="Blocked")
    _link(client, workspace, blocker, blocked, "blocks")
    repositories.issues.set_blocking_count(workspace, blocker["id"], 0)

    assert run(repositories, [workspace]) == (1, 1, 1)
    assert _issue(client, workspace, blocker)["blocking_count"] == 1
    assert run(repositories, [workspace]) == (1, 1, 0)


def test_a_link_carries_its_target_status_across_teams(client: TestClient, workspace: str, statuses: Any) -> None:
    """Any related issue's status resolves, including one in another team."""
    sign_in(client, OWNER)
    source = create_issue(client, workspace, title="Source")
    elsewhere = create_issue(client, workspace, team_id=OTHER_TEAM, title="Elsewhere")
    created = _link(client, workspace, source, elsewhere, "relates_to")

    listed = client.get(f"/api/workspaces/{workspace}/issues/{source['id']}/links").json()["links"]

    assert listed[0]["target_status"]["id"] == elsewhere["status_id"]
    assert listed[0]["target_status"]["category"]
    assert created["target_status"]["id"] == elsewhere["status_id"]


def test_a_link_counts_on_both_sides_and_clears_on_removal(client: TestClient, workspace: str) -> None:
    """Each side of a link holds one more link, and removing it takes the count back."""
    sign_in(client, OWNER)
    source = create_issue(client, workspace, title="Source")
    target = create_issue(client, workspace, title="Target")
    link = _link(client, workspace, source, target, "relates_to")

    assert _issue(client, workspace, source)["relation_count"] == 1
    assert _issue(client, workspace, target)["relation_count"] == 1

    _unlink(client, workspace, source, link)

    assert _issue(client, workspace, source)["relation_count"] == 0
    assert _issue(client, workspace, target)["relation_count"] == 0


def test_deleting_an_issue_recounts_the_issues_it_linked(client: TestClient, workspace: str) -> None:
    """The far side of every link of a deleted issue loses that link from its count."""
    sign_in(client, OWNER)
    doomed = create_issue(client, workspace, title="Doomed")
    survivor = create_issue(client, workspace, title="Survivor")
    _link(client, workspace, doomed, survivor, "blocks")

    response = client.delete(f"/api/workspaces/{workspace}/issues/{doomed['id']}")
    assert response.status_code == 204, response.text

    assert _issue(client, workspace, survivor)["relation_count"] == 0


def test_the_relation_backfill_counts_old_links_and_reruns_clean(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Issues linked before the count gain it, and a rerun writes nothing."""
    from scripts.recount_relation_counts import run

    sign_in(client, OWNER)
    source = create_issue(client, workspace, title="Source")
    target = create_issue(client, workspace, title="Target")
    _link(client, workspace, source, target, "relates_to")
    repositories.issues.set_relation_count(workspace, source["id"], 0)
    repositories.issues.set_relation_count(workspace, target["id"], 0)

    assert run(repositories, [workspace]) == (1, 2, 2)
    assert _issue(client, workspace, source)["relation_count"] == 1
    assert run(repositories, [workspace]) == (1, 2, 0)
