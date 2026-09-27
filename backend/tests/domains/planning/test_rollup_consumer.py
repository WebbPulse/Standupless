"""The planning rollup consumer: keeps each cycle's and project's counts current.

The properties worth holding are that counters move atomically rather than by a
recount, that a redelivered record is dropped because its `eventID` is already
claimed, that moving an issue between cycles decrements the one it left in the same
pass, and that nothing here writes back into the issues table.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.planning import cycle_key, project_key
from app.domains.planning.consumers.rollup import deltas_for, handle_record
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.planning.conftest import TEAM, WORKSPACE, seed_cycle, seed_project

ISSUE = "01JB0000000000000000ISSUE1"


def _image(**attributes: str) -> "dict[str, Any]":
    """One stream image in DynamoDB's wire encoding, strings throughout."""
    return {name: {"S": value} for name, value in attributes.items()}


def _record(
    event_name: str,
    new: "dict[str, Any] | None" = None,
    old: "dict[str, Any] | None" = None,
    event_id: str = "1",
) -> "dict[str, Any]":
    """One stream record shaped the way Lambda delivers it."""
    dynamodb: "dict[str, Any]" = {}
    if new is not None:
        dynamodb["NewImage"] = new
    if old is not None:
        dynamodb["OldImage"] = old
    return {"eventName": event_name, "eventID": event_id, "dynamodb": dynamodb}


def _status_ids(repositories: Any) -> "dict[str, str]":
    """The seeded statuses of TEAM, keyed by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def _counts(repositories: Any, planning_key: str) -> "dict[str, int]":
    """The counters currently on one planning row."""
    if "#cycle#" in planning_key:
        row = repositories.planning.get_cycle(WORKSPACE, TEAM, planning_key.rsplit("#", 1)[-1])
    else:
        row = repositories.planning.get_project(WORKSPACE, planning_key.rsplit("#", 1)[-1])
    assert row is not None
    return row.counts.model_dump()


def test_an_insert_counts_the_issue_into_its_cycle(client: TestClient, repositories: Any, workspace: str) -> None:
    """A new issue attached to a cycle adds one to the bucket its status folds into."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    backlog = _status_ids(repositories)["backlog"]

    handle_record(
        repositories,
        _record(
            "INSERT",
            new=_image(
                workspace_id=WORKSPACE,
                team_id=TEAM,
                issue_id=ISSUE,
                status_id=backlog,
                cycle_id=cycle["cycle_id"],
            ),
        ),
    )

    counts = _counts(repositories, cycle_key(TEAM, cycle["cycle_id"]))
    assert counts["todo"] == 1
    assert counts["in_progress"] == 0


def test_a_redelivered_record_does_not_count_twice(client: TestClient, repositories: Any, workspace: str) -> None:
    """`ADD` is not idempotent, so each record claims its own eventID first."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    backlog = _status_ids(repositories)["backlog"]
    record = _record(
        "INSERT",
        new=_image(
            workspace_id=WORKSPACE,
            team_id=TEAM,
            issue_id=ISSUE,
            status_id=backlog,
            cycle_id=cycle["cycle_id"],
        ),
    )

    handle_record(repositories, record)
    handle_record(repositories, record)

    assert _counts(repositories, cycle_key(TEAM, cycle["cycle_id"]))["todo"] == 1


def test_a_status_move_shifts_the_issue_between_buckets(client: TestClient, repositories: Any, workspace: str) -> None:
    """One record decrements the bucket the issue left and increments the one it joined."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    statuses = _status_ids(repositories)
    attached = {
        "workspace_id": WORKSPACE,
        "team_id": TEAM,
        "issue_id": ISSUE,
        "cycle_id": cycle["cycle_id"],
    }

    handle_record(repositories, _record("INSERT", new=_image(**attached, status_id=statuses["backlog"])))
    handle_record(
        repositories,
        _record(
            "MODIFY",
            new=_image(**attached, status_id=statuses["completed"]),
            old=_image(**attached, status_id=statuses["backlog"]),
            event_id="2",
        ),
    )

    counts = _counts(repositories, cycle_key(TEAM, cycle["cycle_id"]))
    assert counts["todo"] == 0
    assert counts["done"] == 1


def test_moving_between_cycles_decrements_the_one_it_left(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A move touches both rows in one pass, so neither is left overcounting."""
    sign_in(client, MEMBER)
    first = seed_cycle(client, workspace, name="First")
    second = seed_cycle(client, workspace, name="Second")
    backlog = _status_ids(repositories)["backlog"]
    base = {"workspace_id": WORKSPACE, "team_id": TEAM, "issue_id": ISSUE, "status_id": backlog}

    handle_record(repositories, _record("INSERT", new=_image(**base, cycle_id=first["cycle_id"])))
    handle_record(
        repositories,
        _record(
            "MODIFY",
            new=_image(**base, cycle_id=second["cycle_id"]),
            old=_image(**base, cycle_id=first["cycle_id"]),
            event_id="2",
        ),
    )

    assert _counts(repositories, cycle_key(TEAM, first["cycle_id"]))["todo"] == 0
    assert _counts(repositories, cycle_key(TEAM, second["cycle_id"]))["todo"] == 1


def test_a_remove_takes_the_issue_out_of_its_cycle(client: TestClient, repositories: Any, workspace: str) -> None:
    """A deleted issue still has to leave the counts, so the old image is read."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    backlog = _status_ids(repositories)["backlog"]
    attached = {
        "workspace_id": WORKSPACE,
        "team_id": TEAM,
        "issue_id": ISSUE,
        "status_id": backlog,
        "cycle_id": cycle["cycle_id"],
    }

    handle_record(repositories, _record("INSERT", new=_image(**attached)))
    handle_record(repositories, _record("REMOVE", old=_image(**attached), event_id="2"))

    assert _counts(repositories, cycle_key(TEAM, cycle["cycle_id"]))["todo"] == 0


def test_an_issue_counts_into_its_cycle_and_its_project(client: TestClient, repositories: Any, workspace: str) -> None:
    """The two attachments are independent, so one issue moves both rows."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    project = seed_project(client, workspace)
    backlog = _status_ids(repositories)["backlog"]

    handle_record(
        repositories,
        _record(
            "INSERT",
            new=_image(
                workspace_id=WORKSPACE,
                team_id=TEAM,
                issue_id=ISSUE,
                status_id=backlog,
                cycle_id=cycle["cycle_id"],
                project_id=project["project_id"],
            ),
        ),
    )

    assert _counts(repositories, cycle_key(TEAM, cycle["cycle_id"]))["todo"] == 1
    assert _counts(repositories, project_key(project["project_id"]))["todo"] == 1


def test_an_unattached_issue_moves_nothing(client: TestClient, repositories: Any, workspace: str) -> None:
    """Most records are read and dropped, which is what keeps the consumer cheap."""
    sign_in(client, MEMBER)
    backlog = _status_ids(repositories)["backlog"]

    moves = deltas_for(
        repositories,
        WORKSPACE,
        _record(
            "INSERT",
            new=_image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, status_id=backlog),
        ),
    )

    assert moves == {}


def test_a_count_against_a_deleted_cycle_is_dropped(client: TestClient, repositories: Any, workspace: str) -> None:
    """The write is conditional on the row existing, so nothing is resurrected."""
    sign_in(client, MEMBER)
    backlog = _status_ids(repositories)["backlog"]

    handle_record(
        repositories,
        _record(
            "INSERT",
            new=_image(
                workspace_id=WORKSPACE,
                team_id=TEAM,
                issue_id=ISSUE,
                status_id=backlog,
                cycle_id="01JB00000000000000000GONE",
            ),
        ),
    )

    assert repositories.planning.get_cycle(WORKSPACE, TEAM, "01JB00000000000000000GONE") is None


def test_a_record_with_no_workspace_is_dropped(repositories: Any) -> None:
    """A record neither image identifies cannot be attributed, so it does nothing."""
    handle_record(repositories, _record("INSERT", new=_image(team_id=TEAM, issue_id=ISSUE)))


def test_a_status_the_team_does_not_hold_counts_into_nothing(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """An unknown status folds into no bucket rather than into a default that would be wrong."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)

    moves = deltas_for(
        repositories,
        WORKSPACE,
        _record(
            "INSERT",
            new=_image(
                workspace_id=WORKSPACE,
                team_id=TEAM,
                issue_id=ISSUE,
                status_id="01JB000000000000000NOSUCH",
                cycle_id=cycle["cycle_id"],
            ),
        ),
    )

    assert moves == {}
