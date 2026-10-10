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
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_cycle, seed_issue, seed_project

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


def _statuses_of(repositories: Any, team_id: str) -> "dict[str, str]":
    """One team's statuses, keyed by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, team_id)}


def _issue_image(repositories: Any, issue_id: str) -> "dict[str, Any]":
    """The stream image of one stored issue, carrying what the project recount reads."""
    issue = repositories.issues.get(WORKSPACE, issue_id)
    assert issue is not None
    attributes = {
        "workspace_id": WORKSPACE,
        "issue_id": issue.issue_id,
        "team_id": issue.team_id,
        "status_id": issue.status_id,
        "project_id": issue.project_id or "",
        "project_milestone_id": issue.project_milestone_id or "",
        "archived_at": issue.archived_at.isoformat() if issue.archived_at is not None else "",
    }
    return _image(**{name: value for name, value in attributes.items() if value})


def _project_counts(repositories: Any, project_id: str) -> "dict[str, int]":
    """The four buckets currently stored on one project."""
    project = repositories.planning.get_project(WORKSPACE, project_id)
    assert project is not None
    return project.counts.model_dump()


def test_a_project_counts_every_team_and_every_status(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """Issues of the project's second team, and ones created finished, all count (SUP-24)."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace, team_ids=[TEAM, OTHER_TEAM])["project_id"]
    mine = _statuses_of(repositories, TEAM)
    theirs = _statuses_of(repositories, OTHER_TEAM)
    first = seed_issue(issues_client, workspace, project_id=project_id, status_id=mine["backlog"])
    seed_issue(issues_client, workspace, team_id=OTHER_TEAM, project_id=project_id, status_id=theirs["unstarted"])
    seed_issue(issues_client, workspace, project_id=project_id, status_id=mine["completed"])
    seed_issue(issues_client, workspace, team_id=OTHER_TEAM, project_id=project_id, status_id=theirs["cancelled"])
    seed_issue(issues_client, workspace, team_id=OTHER_TEAM, project_id=project_id, status_id=theirs["started"])

    handle_record(repositories, _record("INSERT", new=_issue_image(repositories, first["id"])))

    assert _project_counts(repositories, project_id) == {"todo": 2, "in_progress": 1, "done": 1, "cancelled": 1}


def test_an_archived_issue_leaves_its_project_counts(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """Only non-archived issues count, and restoring one counts it again."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    done = _statuses_of(repositories, TEAM)["completed"]
    kept = seed_issue(issues_client, workspace, project_id=project_id, status_id=done)
    archived = seed_issue(issues_client, workspace, project_id=project_id, status_id=done)
    handle_record(repositories, _record("INSERT", new=_issue_image(repositories, kept["id"])))
    assert _project_counts(repositories, project_id)["done"] == 2

    before = _issue_image(repositories, archived["id"])
    response = issues_client.post(f"/api/workspaces/{workspace}/issues/{archived['id']}/archive")
    assert response.status_code == 200, response.text
    handle_record(
        repositories,
        _record("MODIFY", new=_issue_image(repositories, archived["id"]), old=before, event_id="2"),
    )

    assert _project_counts(repositories, project_id)["done"] == 1


def test_a_team_move_keeps_the_issue_in_its_project_counts(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """A moved issue stays counted in its project, which gains the target team when it lacked it (STUP-38)."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    shared = seed_project(client, workspace, team_ids=[TEAM, OTHER_TEAM])["project_id"]
    solo = seed_project(client, workspace, name="Solo")["project_id"]
    backlog = _statuses_of(repositories, TEAM)["backlog"]
    staying = seed_issue(issues_client, workspace, project_id=shared, status_id=backlog)
    leaving = seed_issue(issues_client, workspace, project_id=solo, status_id=backlog)
    handle_record(repositories, _record("INSERT", new=_issue_image(repositories, staying["id"])))
    handle_record(repositories, _record("INSERT", new=_issue_image(repositories, leaving["id"]), event_id="2"))
    assert _project_counts(repositories, shared)["todo"] == 1
    assert _project_counts(repositories, solo)["todo"] == 1

    for event_id, issue in (("3", staying), ("4", leaving)):
        before = _issue_image(repositories, issue["id"])
        response = issues_client.post(
            f"/api/workspaces/{workspace}/issues/{issue['id']}/move", json={"team_id": OTHER_TEAM}
        )
        assert response.status_code == 200, response.text
        handle_record(
            repositories,
            _record("MODIFY", new=_issue_image(repositories, issue["id"]), old=before, event_id=event_id),
        )

    assert sum(_project_counts(repositories, shared).values()) == 1
    assert sum(_project_counts(repositories, solo).values()) == 1
    assert OTHER_TEAM in repositories.planning.get_project(WORKSPACE, solo).team_ids


def test_a_recount_overlays_the_record_on_a_stale_index(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """The record's own new image wins over the index row it may not have caught up with."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    statuses = _statuses_of(repositories, TEAM)
    issue = seed_issue(issues_client, workspace, project_id=project_id, status_id=statuses["backlog"])
    stale = _issue_image(repositories, issue["id"])
    fresh = {**stale, "status_id": {"S": statuses["completed"]}}

    handle_record(repositories, _record("MODIFY", new=fresh, old=stale))

    assert _project_counts(repositories, project_id) == {"todo": 0, "in_progress": 0, "done": 1, "cancelled": 0}


def test_a_project_edit_never_writes_back_the_counts_it_read(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """An edit racing the consumer keeps the consumer's counts and still clears a removed field."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace, target_date="2026-12-01")["project_id"]
    read = repositories.planning.get_project(WORKSPACE, project_id)
    assert read is not None

    assert repositories.planning.set_counts(WORKSPACE, project_key(project_id), {"todo": 3, "done": 2})
    stored = repositories.planning.replace_project(read.model_copy(update={"name": "Renamed", "target_date": None}))

    assert stored.counts.model_dump() == {"todo": 3, "in_progress": 0, "done": 2, "cancelled": 0}
    item = repositories.planning._repository.get({"workspace_id": WORKSPACE, "planning_key": project_key(project_id)})
    assert item["name"] == "Renamed"
    assert "target_date" not in item


def test_a_cycle_edit_never_writes_back_the_counts_it_read(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A cycle patch keeps the counters and revision the consumer moved after the read."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    read = repositories.planning.get_cycle(WORKSPACE, TEAM, cycle["cycle_id"])
    assert read is not None

    repositories.planning.move_cycle_counts(WORKSPACE, cycle_key(TEAM, cycle["cycle_id"]), {"todo": 2})
    stored = repositories.planning.replace_cycle(read.model_copy(update={"goal": "Ship"}))

    assert stored.counts.todo == 2
    assert stored.rollup_rev == 1
    assert stored.goal == "Ship"


def _review_status(repositories: Any) -> str:
    """A second started status on `TEAM`, the way an In Review column sits beside In Progress."""
    from app.common.db.dynamo.team_config import Status, new_config_id, status_key

    status_id = new_config_id()
    repositories.team_config.create_status(
        Status(
            workspace_id=WORKSPACE,
            config_key=status_key(TEAM, status_id),
            team_id=TEAM,
            status_id=status_id,
            name="In Review",
            category="started",
            position=5,
        )
    )
    return status_id


def test_a_project_counts_each_status_beside_its_category(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """Two started statuses share the in progress bucket but keep their own counts, on the project and milestone."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    milestone = client.post(f"/api/workspaces/{workspace}/projects/{project_id}/milestones", json={"name": "Alpha"})
    assert milestone.status_code == 201, milestone.text
    milestone_id = milestone.json()["milestone_id"]
    mine = _statuses_of(repositories, TEAM)
    review = _review_status(repositories)
    first = seed_issue(issues_client, workspace, project_id=project_id, status_id=mine["started"])
    seed_issue(
        issues_client, workspace, project_id=project_id, status_id=review, project_milestone_id=milestone_id
    )
    seed_issue(issues_client, workspace, project_id=project_id, status_id=review)

    handle_record(repositories, _record("INSERT", new=_issue_image(repositories, first["id"])))

    project = repositories.planning.get_project(WORKSPACE, project_id)
    assert project is not None
    assert project.counts.in_progress == 3
    assert project.status_counts == {mine["started"]: 1, review: 2}
    stored = repositories.planning.get_milestone(WORKSPACE, project_id, milestone_id)
    assert stored is not None
    assert stored.status_counts == {review: 1}
    body = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert body["status_counts"] == {mine["started"]: 1, review: 2}

    image = _issue_image(repositories, first["id"])
    moved = {**image, "status_id": {"S": review}}
    handle_record(repositories, _record("MODIFY", new=moved, old=image))

    project = repositories.planning.get_project(WORKSPACE, project_id)
    assert project is not None
    assert project.status_counts == {review: 3}


def test_a_project_edit_keeps_the_status_counts(client: TestClient, repositories: Any, workspace: str) -> None:
    """Status counts are the consumer's alone, so an edit of the row never writes back the ones it read."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    read = repositories.planning.get_project(WORKSPACE, project_id)
    assert read is not None

    assert repositories.planning.set_counts(WORKSPACE, project_key(project_id), {"todo": 2}, {"01STATUS": 2})
    stored = repositories.planning.replace_project(read.model_copy(update={"name": "Renamed"}))

    assert stored.status_counts == {"01STATUS": 2}


def test_the_recount_script_fills_status_counts_once(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """A project from before status counts gains them, and a rerun writes nothing."""
    from scripts.recount_project_status_counts import run

    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    mine = _statuses_of(repositories, TEAM)
    seed_issue(issues_client, workspace, project_id=project_id, status_id=mine["started"])

    assert run(repositories, [WORKSPACE]) == (1, 1, 1)
    project = repositories.planning.get_project(WORKSPACE, project_id)
    assert project is not None
    assert project.status_counts == {mine["started"]: 1}
    assert run(repositories, [WORKSPACE]) == (1, 1, 0)
