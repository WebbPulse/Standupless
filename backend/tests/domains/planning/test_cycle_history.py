"""Cycle scope history, points and velocity.

The properties worth holding are that estimate points ride beside the issue
counts, that every counter move of a cycle leaves the day's snapshot behind in
revision order, that the burn-up fills every day from those snapshots without a
scheduled job, and that velocity reads each closed cycle as it stood on its end
date rather than after its unfinished work was carried out.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.planning import (
    Cycle,
    CycleSnapshot,
    RollupCounts,
    cycle_history_key,
    cycle_key,
)
from app.domains.planning.consumers.rollup import (
    carried_issue_ids,
    carry_deltas,
    deltas_for,
    estimate_points,
    handle_record,
    record_day,
)
from app.domains.planning.history import average, burn_up, closed_cycles, planning_cycle, value_on
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.planning.conftest import TEAM, WORKSPACE, seed_cycle

ISSUE = "01JB0000000000000000ISSUE1"


def _day(offset: int) -> str:
    """The ISO day `offset` days from today."""
    return (date.today() + timedelta(days=offset)).isoformat()


def _epoch(day: str) -> int:
    """Noon UTC on one ISO day, as a stream record's creation time."""
    moment = datetime.fromisoformat(day).replace(hour=12, tzinfo=timezone.utc)
    return int(moment.timestamp())


def _image(**attributes: str) -> "dict[str, Any]":
    """One stream image in DynamoDB's wire encoding, strings throughout."""
    return {name: {"S": value} for name, value in attributes.items()}


def _record(
    event_name: str,
    new: "dict[str, Any] | None" = None,
    old: "dict[str, Any] | None" = None,
    event_id: str = "1",
    day: str | None = None,
) -> "dict[str, Any]":
    """One stream record shaped the way Lambda delivers it."""
    dynamodb: "dict[str, Any]" = {}
    if new is not None:
        dynamodb["NewImage"] = new
    if old is not None:
        dynamodb["OldImage"] = old
    if day is not None:
        dynamodb["ApproximateCreationDateTime"] = _epoch(day)
    return {"eventName": event_name, "eventID": event_id, "dynamodb": dynamodb}


def _status_ids(repositories: Any) -> "dict[str, str]":
    """The seeded statuses of TEAM, keyed by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def _cycle(**fields: Any) -> Cycle:
    """One in-memory cycle for the pure folds."""
    values: "dict[str, Any]" = {
        "workspace_id": WORKSPACE,
        "planning_key": cycle_key(TEAM, "C1"),
        "cycle_id": "C1",
        "team_id": TEAM,
        "name": "Cycle",
        "start_date": "2026-03-01",
        "end_date": "2026-03-05",
        "created_by": OWNER,
    }
    values.update(fields)
    return Cycle(**values)


def _counts(todo: int = 0, in_progress: int = 0, done: int = 0, cancelled: int = 0) -> RollupCounts:
    """One bucket set."""
    return RollupCounts(todo=todo, in_progress=in_progress, done=done, cancelled=cancelled)


def test_estimates_weigh_as_points_on_every_scale() -> None:
    """Numbers are their own value, t-shirt sizes map onto a ladder, anything else is zero."""
    assert estimate_points("5") == 5
    assert estimate_points("13") == 13
    assert estimate_points("XS") == 1
    assert estimate_points("m") == 3
    assert estimate_points("XL") == 8
    assert estimate_points(None) == 0
    assert estimate_points("") == 0
    assert estimate_points("huge") == 0
    assert estimate_points("-2") == 0


def test_an_estimated_issue_moves_the_cycle_points_beside_its_count(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """Points move in the same pass as the count, bucket for bucket."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    statuses = _status_ids(repositories)
    base = {"workspace_id": WORKSPACE, "team_id": TEAM, "issue_id": ISSUE, "cycle_id": cycle["cycle_id"]}

    handle_record(repositories, _record("INSERT", new=_image(**base, status_id=statuses["backlog"], estimate="5")))
    handle_record(
        repositories,
        _record(
            "MODIFY",
            new=_image(**base, status_id=statuses["completed"], estimate="3"),
            old=_image(**base, status_id=statuses["backlog"], estimate="5"),
            event_id="2",
        ),
    )

    row = repositories.planning.get_cycle(WORKSPACE, TEAM, cycle["cycle_id"])
    assert row.counts.done == 1
    assert row.points.todo == 0
    assert row.points.done == 3
    assert row.rollup_rev == 2

    body = client.get(f"/api/workspaces/{workspace}/cycles/{cycle['cycle_id']}", params={"team_id": TEAM}).json()
    assert body["points"]["done"] == 3
    assert body["carry"]["carried_in"] == 0


def test_a_project_moves_no_counters_by_delta(client: TestClient, repositories: Any, workspace: str) -> None:
    """Points are a cycle measure, and a project is recounted rather than moved by `ADD`."""
    statuses = _status_ids(repositories)
    moves = deltas_for(
        repositories,
        WORKSPACE,
        _record(
            "INSERT",
            new=_image(
                workspace_id=WORKSPACE,
                team_id=TEAM,
                issue_id=ISSUE,
                status_id=statuses["backlog"],
                project_id="P1",
                estimate="8",
            ),
        ),
    )
    assert moves == {}


def test_a_carry_marker_counts_the_move_on_both_cycles() -> None:
    """A move whose marker names the cycle it left is a carry-over; any other move is not."""
    old = {"team_id": TEAM, "cycle_id": "A", "estimate": "5"}
    carried = {"team_id": TEAM, "cycle_id": "B", "estimate": "5", "cycle_carried_from": "A"}

    assert carry_deltas(old, carried) == {
        cycle_key(TEAM, "A"): {"carried_out": 1, "carried_out_points": 5},
        cycle_key(TEAM, "B"): {"carried_in": 1, "carried_in_points": 5},
    }
    assert carry_deltas(old, {"team_id": TEAM, "cycle_id": "B"}) == {}
    assert carry_deltas(carried, {**carried, "title": "renamed"}) == {}
    assert carry_deltas(old, {**carried, "cycle_carried_from": "Z"}) == {}


def test_a_carried_issue_moves_the_carry_counters(client: TestClient, repositories: Any, workspace: str) -> None:
    """The rollup adds the carry counters on the stream record the close produced."""
    sign_in(client, MEMBER)
    first = seed_cycle(client, workspace, name="First")
    second = seed_cycle(client, workspace, name="Second")
    todo = _status_ids(repositories)["unstarted"]
    base = {"workspace_id": WORKSPACE, "team_id": TEAM, "issue_id": ISSUE, "status_id": todo, "estimate": "2"}

    handle_record(repositories, _record("INSERT", new=_image(**base, cycle_id=first["cycle_id"])))
    handle_record(
        repositories,
        _record(
            "MODIFY",
            new=_image(**base, cycle_id=second["cycle_id"], cycle_carried_from=first["cycle_id"]),
            old=_image(**base, cycle_id=first["cycle_id"]),
            event_id="2",
        ),
    )

    left = repositories.planning.get_cycle(WORKSPACE, TEAM, first["cycle_id"])
    joined = repositories.planning.get_cycle(WORKSPACE, TEAM, second["cycle_id"])
    assert left.carry.carried_out == 1
    assert left.carry.carried_out_points == 2
    assert left.counts.todo == 0
    assert joined.carry.carried_in == 1
    assert joined.carry.carried_in_points == 2
    assert joined.counts.todo == 1
    assert left.carried_out_issue_ids == [ISSUE]
    assert joined.carried_in_issue_ids == [ISSUE]


def test_a_redelivered_carry_records_the_issue_once(client: TestClient, repositories: Any, workspace: str) -> None:
    """The ids are a set, so a repeat of the same record leaves one entry and one count."""
    sign_in(client, MEMBER)
    first = seed_cycle(client, workspace, name="First")
    second = seed_cycle(client, workspace, name="Second")
    todo = _status_ids(repositories)["unstarted"]
    base = {"workspace_id": WORKSPACE, "team_id": TEAM, "issue_id": ISSUE, "status_id": todo}
    carry = _record(
        "MODIFY",
        new=_image(**base, cycle_id=second["cycle_id"], cycle_carried_from=first["cycle_id"]),
        old=_image(**base, cycle_id=first["cycle_id"]),
        event_id="carry",
    )

    handle_record(repositories, carry)
    handle_record(repositories, carry)

    left = repositories.planning.get_cycle(WORKSPACE, TEAM, first["cycle_id"])
    assert left.carried_out_issue_ids == [ISSUE]
    assert left.carry.carried_out == 1


def test_a_planner_edit_keeps_the_carried_ids(client: TestClient, repositories: Any, workspace: str) -> None:
    """A rename rewrites the whole row, so the ids must ride along and stay readable."""
    sign_in(client, MEMBER)
    first = seed_cycle(client, workspace, name="First")
    key = cycle_key(TEAM, first["cycle_id"])
    assert repositories.planning.record_carried_issue(WORKSPACE, key, "carried_out_issue_ids", ISSUE)

    response = client.patch(
        f"/api/workspaces/{workspace}/cycles/{first['cycle_id']}", json={"team_id": TEAM, "name": "Renamed"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["carry"]["carried_out_issue_ids"] == [ISSUE]
    assert repositories.planning.get_cycle(WORKSPACE, TEAM, first["cycle_id"]).carried_out_issue_ids == [ISSUE]


def test_only_a_carry_names_its_issue() -> None:
    """A planner's own move records no ids."""
    old = {"team_id": TEAM, "issue_id": ISSUE, "cycle_id": "A"}
    carried = {**old, "cycle_id": "B", "cycle_carried_from": "A"}
    assert carried_issue_ids(old, carried) == [
        (cycle_key(TEAM, "A"), "carried_out_issue_ids", ISSUE),
        (cycle_key(TEAM, "B"), "carried_in_issue_ids", ISSUE),
    ]
    assert carried_issue_ids(old, {**old, "cycle_id": "B"}) == []


def test_a_record_day_comes_from_its_creation_time() -> None:
    """The stream's own timestamp dates the snapshot, today when it carries none."""
    assert record_day({"dynamodb": {"ApproximateCreationDateTime": _epoch("2026-03-02")}}) == "2026-03-02"
    assert record_day({"dynamodb": {}}) == datetime.now(timezone.utc).date().isoformat()


def test_every_move_leaves_the_days_snapshot(client: TestClient, repositories: Any, workspace: str) -> None:
    """The last move of a day is the day's value, and the first keeps the opening."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace, start_date=_day(-5), end_date=_day(5))
    statuses = _status_ids(repositories)
    base = {"workspace_id": WORKSPACE, "team_id": TEAM, "cycle_id": cycle["cycle_id"], "estimate": "3"}

    handle_record(
        repositories,
        _record("INSERT", new=_image(**base, issue_id="I1", status_id=statuses["backlog"]), day=_day(-4)),
    )
    handle_record(
        repositories,
        _record("INSERT", new=_image(**base, issue_id="I2", status_id=statuses["backlog"]), event_id="2", day=_day(-4)),
    )
    handle_record(
        repositories,
        _record(
            "MODIFY",
            new=_image(**base, issue_id="I1", status_id=statuses["completed"]),
            old=_image(**base, issue_id="I1", status_id=statuses["backlog"]),
            event_id="3",
            day=_day(-2),
        ),
    )

    snapshots = repositories.planning.list_cycle_history(WORKSPACE, TEAM, cycle["cycle_id"])
    assert [row.day for row in snapshots] == [_day(-4), _day(-2)]
    assert snapshots[0].counts.todo == 2
    assert snapshots[0].points.todo == 6
    assert snapshots[0].opening_counts.total == 0
    assert snapshots[1].counts.done == 1
    assert snapshots[1].points.done == 3


def test_a_snapshot_never_goes_back_a_revision(client: TestClient, repositories: Any, workspace: str) -> None:
    """A move that finished second but carries the earlier state is refused."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    planning = repositories.planning
    day = "2026-01-02"

    assert planning.write_cycle_snapshot(WORKSPACE, TEAM, cycle["cycle_id"], day, rev=5, counts={"todo": 5}, opening={})
    assert not planning.write_cycle_snapshot(
        WORKSPACE, TEAM, cycle["cycle_id"], day, rev=4, counts={"todo": 4}, opening={"todo": 9}
    )

    [snapshot] = planning.list_cycle_history(WORKSPACE, TEAM, cycle["cycle_id"])
    assert snapshot.counts.todo == 5
    assert snapshot.opening_counts.todo == 0


def test_a_cycle_patch_keeps_its_points_and_revision(client: TestClient, repositories: Any, workspace: str) -> None:
    """A rename writes the row whole, so the extra counters have to ride along."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    key = cycle_key(TEAM, cycle["cycle_id"])
    repositories.planning.move_cycle_counts(WORKSPACE, key, {"todo": 1, "points_todo": 5, "carried_in": 1})

    response = client.patch(
        f"/api/workspaces/{workspace}/cycles/{cycle['cycle_id']}", json={"team_id": TEAM, "name": "Renamed"}
    )
    assert response.status_code == 200, response.text

    row = repositories.planning.get_cycle(WORKSPACE, TEAM, cycle["cycle_id"])
    assert row.points.todo == 5
    assert row.carry.carried_in == 1
    assert row.rollup_rev == 1


def test_the_burn_up_fills_each_day_from_the_snapshots() -> None:
    """Before the first snapshot reads its opening, a gap carries forward, today is live."""
    cycle = _cycle(counts=_counts(todo=1, done=3), points=_counts(todo=2, done=9))
    snapshots = [
        CycleSnapshot(day="2026-03-02", rev=1, counts=_counts(todo=4), opening_counts=_counts(todo=3)),
        CycleSnapshot(day="2026-03-03", rev=4, counts=_counts(todo=2, in_progress=1, done=1, cancelled=1)),
    ]

    series = burn_up(cycle, snapshots, "2026-03-05")

    assert [point.date for point in series] == ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]
    assert [point.scope for point in series] == [3, 4, 4, 4, 4]
    assert [point.started for point in series] == [0, 0, 2, 2, 3]
    assert [point.completed for point in series] == [0, 0, 1, 1, 3]
    assert series[-1].completed_points == 9


def test_the_burn_up_stops_at_today_and_at_the_end() -> None:
    """An active cycle has no future days, a closed one no days past its end, an upcoming one none."""
    cycle = _cycle(counts=_counts(todo=2))
    assert len(burn_up(cycle, [], "2026-03-03")) == 3
    assert len(burn_up(cycle, [], "2026-04-01")) == 5
    assert burn_up(cycle, [], "2026-02-01") == []
    assert all(point.scope == 2 for point in burn_up(cycle, [], "2026-04-01"))


def test_a_closed_cycle_is_valued_on_its_end_date() -> None:
    """A snapshot after the end, such as the close carrying work out, does not count."""
    cycle = _cycle(counts=_counts(done=4))
    snapshots = [
        CycleSnapshot(day="2026-03-04", counts=_counts(todo=2, done=4)),
        CycleSnapshot(day="2026-03-06", counts=_counts(done=4)),
    ]
    value = value_on("2026-03-05", cycle, snapshots)
    assert value.scope == 6
    assert value.completed == 4


def test_closed_and_planning_cycles_are_picked_by_status() -> None:
    """Velocity folds over completed cycles only; guidance speaks to the active one first."""
    closed = _cycle(cycle_id="A", start_date="2026-02-01", end_date="2026-02-14")
    cancelled = _cycle(cycle_id="B", start_date="2026-02-15", end_date="2026-02-28", cancelled=True)
    active = _cycle(cycle_id="C", start_date="2026-03-01", end_date="2026-03-14")
    upcoming = _cycle(cycle_id="D", start_date="2026-03-15", end_date="2026-03-28")
    everything = [upcoming, active, cancelled, closed]

    assert [cycle.cycle_id for cycle in closed_cycles(everything, "2026-03-05", 6)] == ["A"]
    assert planning_cycle(everything, "2026-03-05") is active
    assert planning_cycle([upcoming, closed], "2026-03-05") is upcoming
    assert planning_cycle([closed], "2026-03-05") is None
    assert average([3, 4, 4]) == 3.7
    assert average([]) == 0.0


def test_the_history_route_answers_the_series(client: TestClient, repositories: Any, workspace: str) -> None:
    """One value per day, today reading the live counters."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace, start_date=_day(-2), end_date=_day(3))
    todo = _status_ids(repositories)["unstarted"]
    handle_record(
        repositories,
        _record(
            "INSERT",
            new=_image(
                workspace_id=WORKSPACE,
                team_id=TEAM,
                issue_id=ISSUE,
                status_id=todo,
                cycle_id=cycle["cycle_id"],
                estimate="5",
            ),
            day=_day(-1),
        ),
    )

    response = client.get(f"/api/workspaces/{workspace}/cycles/{cycle['cycle_id']}/history", params={"team_id": TEAM})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "active"
    assert [point["date"] for point in body["days"]] == [_day(-2), _day(-1), _day(0)]
    assert [point["scope"] for point in body["days"]] == [0, 1, 1]
    assert body["days"][-1]["scope_points"] == 5


def test_the_history_of_another_teams_cycle_is_not_found(client: TestClient, repositories: Any, workspace: str) -> None:
    """History reads through the same visibility as the cycle itself."""
    sign_in(client, MEMBER)
    response = client.get(f"/api/workspaces/{workspace}/cycles/NOPE/history", params={"team_id": TEAM})
    assert response.status_code == 404


def test_velocity_reads_each_closed_cycle_at_its_end(client: TestClient, repositories: Any, workspace: str) -> None:
    """Completed points per closed cycle, the average, and the cycle to plan against."""
    sign_in(client, MEMBER)
    first = seed_cycle(client, workspace, name="One", start_date=_day(-30), end_date=_day(-17))
    second = seed_cycle(client, workspace, name="Two", start_date=_day(-16), end_date=_day(-3))
    current = seed_cycle(client, workspace, name="Three", start_date=_day(-2), end_date=_day(11))
    dropped = seed_cycle(client, workspace, name="Dropped", start_date=_day(-45), end_date=_day(-31))
    cancel = client.patch(
        f"/api/workspaces/{workspace}/cycles/{dropped['cycle_id']}", json={"team_id": TEAM, "cancelled": True}
    )
    assert cancel.status_code == 200, cancel.text
    planning = repositories.planning

    planning.write_cycle_snapshot(
        WORKSPACE, TEAM, first["cycle_id"], _day(-18), rev=1, counts={"done": 3, "points_done": 8}, opening={}
    )
    planning.write_cycle_snapshot(
        WORKSPACE,
        TEAM,
        second["cycle_id"],
        _day(-4),
        rev=1,
        counts={"todo": 2, "done": 4, "points_todo": 3, "points_done": 12},
        opening={},
    )
    planning.write_cycle_snapshot(
        WORKSPACE, TEAM, second["cycle_id"], _day(-2), rev=2, counts={"done": 4, "points_done": 12}, opening={}
    )
    planning.move_cycle_counts(WORKSPACE, cycle_key(TEAM, second["cycle_id"]), {"carried_out": 2})
    planning.move_cycle_counts(
        WORKSPACE, cycle_key(TEAM, current["cycle_id"]), {"todo": 5, "points_todo": 11, "carried_in": 2}
    )

    response = client.get(f"/api/workspaces/{workspace}/cycles/velocity", params={"team_id": TEAM})

    assert response.status_code == 200, response.text
    body = response.json()
    assert [row["name"] for row in body["cycles"]] == ["One", "Two"]
    assert [row["completed_points"] for row in body["cycles"]] == [8, 12]
    assert body["cycles"][1]["scope_issues"] == 6
    assert body["cycles"][1]["scope_points"] == 15
    assert body["cycles"][1]["carried_out"] == 2
    assert body["average_points"] == 10.0
    assert body["average_issues"] == 3.5
    assert body["estimate_scale"] == "off"
    assert body["upcoming"]["name"] == "Three"
    assert body["upcoming"]["scope_points"] == 11
    assert body["upcoming"]["carried_in"] == 2


def test_velocity_honours_its_limit(client: TestClient, repositories: Any, workspace: str) -> None:
    """Only the most recent closed cycles count."""
    sign_in(client, MEMBER)
    seed_cycle(client, workspace, name="Old", start_date=_day(-30), end_date=_day(-17))
    seed_cycle(client, workspace, name="Recent", start_date=_day(-16), end_date=_day(-3))

    body = client.get(f"/api/workspaces/{workspace}/cycles/velocity", params={"team_id": TEAM, "limit": 1}).json()

    assert [row["name"] for row in body["cycles"]] == ["Recent"]
    assert body["upcoming"] is None


def test_deleting_a_cycle_removes_its_history(client: TestClient, repositories: Any, workspace: str) -> None:
    """A deleted cycle leaves no snapshot rows behind."""
    sign_in(client, OWNER)
    cycle = seed_cycle(client, workspace)
    repositories.planning.write_cycle_snapshot(
        WORKSPACE, TEAM, cycle["cycle_id"], "2026-01-02", rev=1, counts={"todo": 1}, opening={}
    )

    response = client.delete(f"/api/workspaces/{workspace}/cycles/{cycle['cycle_id']}", params={"team_id": TEAM})

    assert response.status_code == 204
    assert repositories.planning.list_cycle_history(WORKSPACE, TEAM, cycle["cycle_id"]) == []


def test_the_team_purge_drains_history_after_cycles(client: TestClient, repositories: Any, workspace: str) -> None:
    """The purge page answers zero only once both the cycles and their snapshots are gone."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    repositories.planning.write_cycle_snapshot(
        WORKSPACE, TEAM, cycle["cycle_id"], "2026-01-02", rev=1, counts={"todo": 1}, opening={}
    )

    while repositories.planning.delete_cycles_page(WORKSPACE, TEAM):
        pass

    assert repositories.planning.list_cycle_history(WORKSPACE, TEAM, cycle["cycle_id"]) == []
    key = cycle_history_key(TEAM, cycle["cycle_id"], "2026-01-02")
    assert key.startswith(f"team#{TEAM}#cyclehist#")


def test_history_rows_stay_out_of_the_cycle_list(client: TestClient, repositories: Any, workspace: str) -> None:
    """Snapshots are filed under their own prefix, so the list never pages through them."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    repositories.planning.write_cycle_snapshot(
        WORKSPACE, TEAM, cycle["cycle_id"], "2026-01-02", rev=1, counts={"todo": 1}, opening={}
    )

    rows, _ = repositories.planning.list_cycles(WORKSPACE, TEAM, limit=1)

    assert [row.cycle_id for row in rows] == [cycle["cycle_id"]]
