"""The relation filters and relative cycles through the issue list route.

The unit tests pin the rules; these hold that the route resolves them against the
real tables: the blocking count for `is_blocking`, the link index for `has_relation`, and each team's
cycles for `current`, with an unknown cycle refused as a 400 naming it. The same
relative cycles name a cycle on create, update and bulk update.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.planning import Cycle, cycle_key
from app.domains.issues.consumers.rollup import handle_record
from tests.domains.helpers import OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


def _titles(client: TestClient, workspace: str, **params: Any) -> "set[str]":
    """The titles the team's issue list answers for one filter."""
    response = client.get(f"/api/workspaces/{workspace}/issues", params={"team_id": TEAM, **params})
    assert response.status_code == 200, response.text
    return {row["title"] for row in response.json()["issues"]}


def _link(client: TestClient, workspace: str, source: Any, target: Any, kind: str) -> None:
    """Create one link through the route, failing loudly on a refusal."""
    response = client.post(
        f"/api/workspaces/{workspace}/issues/{source['id']}/links",
        json={"type": kind, "target_issue_id": target["id"]},
    )
    assert response.status_code == 201, response.text


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


def _cycle(repositories: Any, workspace: str, cycle_id: str, start: date, end: date) -> None:
    """Store one cycle of the team straight in the planning table."""
    repositories.planning.create_cycle(
        Cycle(
            workspace_id=workspace,
            planning_key=cycle_key(TEAM, cycle_id),
            cycle_id=cycle_id,
            team_id=TEAM,
            name=cycle_id,
            start_date=start.isoformat(),
            end_date=end.isoformat(),
            created_by=OWNER,
        )
    )


def test_blocked_blocking_and_has_relation_filter_the_list(client: TestClient, workspace: str, statuses: Any) -> None:
    """A finished blocker blocks nothing, and has_relation reads either side's own row."""
    sign_in(client, OWNER)
    blocker = create_issue(client, workspace, title="Blocker")
    blocked = create_issue(client, workspace, title="Blocked")
    done = create_issue(client, workspace, title="Done", status_id=statuses["completed"].status_id)
    freed = create_issue(client, workspace, title="Freed")
    related = create_issue(client, workspace, title="Related")
    create_issue(client, workspace, title="Alone")
    _link(client, workspace, blocker, blocked, "blocks")
    _link(client, workspace, done, freed, "blocks")
    _link(client, workspace, related, blocker, "relates_to")

    assert _titles(client, workspace, is_blocked="true") == {"Blocked"}
    assert _titles(client, workspace, is_blocking="true") == {"Blocker"}
    assert "Blocker" not in _titles(client, workspace, is_blocking="false")
    assert _titles(client, workspace, has_relation="blocked_by") == {"Blocked", "Freed"}
    assert _titles(client, workspace, has_relation="relates_to") == {"Related", "Blocker"}


def test_is_blocking_skips_a_blocker_whose_blocked_issues_are_finished(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A blocker counts only while an issue it blocks is open, in its team or another."""
    sign_in(client, OWNER)
    done = statuses["completed"].status_id
    holding = create_issue(client, workspace, title="Holding")
    open_blocked = create_issue(client, workspace, title="Open blocked")
    released = create_issue(client, workspace, title="Released")
    finished = create_issue(client, workspace, title="Finished", status_id=done)
    finished_blocker = create_issue(client, workspace, title="Finished blocker", status_id=done)
    still_open = create_issue(client, workspace, title="Still open")
    across = create_issue(client, workspace, title="Across")
    elsewhere = create_issue(client, workspace, team_id=OTHER_TEAM, title="Elsewhere")
    _link(client, workspace, holding, open_blocked, "blocks")
    _link(client, workspace, released, finished, "blocks")
    _link(client, workspace, finished_blocker, still_open, "blocks")
    _link(client, workspace, across, elsewhere, "blocks")

    assert _titles(client, workspace, is_blocking="true") == {"Holding", "Across"}
    assert {"Released", "Finished blocker"} <= _titles(client, workspace, is_blocking="false")

    client.patch(f"/api/workspaces/{workspace}/issues/{open_blocked['id']}", json={"status_id": done})
    handle_record(repositories, _status_record(workspace, open_blocked["id"], open_blocked["status_id"], done))

    assert _titles(client, workspace, is_blocking="true") == {"Across"}
    assert "Holding" in _titles(client, workspace, is_blocking="false")


def test_an_unknown_relation_type_is_refused(client: TestClient, workspace: str) -> None:
    """Only the four link types are a relation filter."""
    sign_in(client, OWNER)

    response = client.get(f"/api/workspaces/{workspace}/issues", params={"team_id": TEAM, "has_relation": "parent"})

    assert response.status_code == 422


def test_relative_cycles_resolve_against_the_team_schedule(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """current, next and previous each name the team's cycle around today."""
    today = date.today()
    _cycle(repositories, workspace, "PREV", today - timedelta(days=20), today - timedelta(days=8))
    _cycle(repositories, workspace, "CURR", today - timedelta(days=7), today + timedelta(days=6))
    _cycle(repositories, workspace, "NEXT", today + timedelta(days=7), today + timedelta(days=20))
    sign_in(client, OWNER)
    for cycle_id in ("PREV", "CURR", "NEXT"):
        create_issue(client, workspace, title=cycle_id, cycle_id=cycle_id)
    create_issue(client, workspace, title="Unplanned")

    assert _titles(client, workspace, cycle_id="current") == {"CURR"}
    assert _titles(client, workspace, cycle_id="next") == {"NEXT"}
    assert _titles(client, workspace, cycle_id="previous") == {"PREV"}
    assert _titles(client, workspace, cycle_id=["current", "none"]) == {"CURR", "Unplanned"}
    assert _titles(client, workspace, cycle_id_not="current") == {"PREV", "NEXT", "Unplanned"}


def test_an_unknown_cycle_is_a_400_naming_the_value(client: TestClient, workspace: str) -> None:
    """A cycle id the teams do not hold is refused rather than matching nothing."""
    sign_in(client, OWNER)

    response = client.get(f"/api/workspaces/{workspace}/issues", params={"team_id": TEAM, "cycle_id": "nope"})

    assert response.status_code == 400
    assert "nope" in response.text


def _schedule(repositories: Any, workspace: str) -> None:
    """A previous, current and next cycle of the team around today."""
    today = date.today()
    _cycle(repositories, workspace, "PREV", today - timedelta(days=20), today - timedelta(days=8))
    _cycle(repositories, workspace, "CURR", today - timedelta(days=7), today + timedelta(days=6))
    _cycle(repositories, workspace, "NEXT", today + timedelta(days=7), today + timedelta(days=20))


RELATIVE = [("current", "CURR"), ("next", "NEXT"), ("previous", "PREV")]


@pytest.mark.parametrize(("alias", "expected"), RELATIVE)
def test_create_resolves_a_relative_cycle(
    client: TestClient, workspace: str, repositories: Any, alias: str, expected: str
) -> None:
    """A new issue filed into current, next or previous lands in that cycle of its team."""
    _schedule(repositories, workspace)
    sign_in(client, OWNER)

    created = create_issue(client, workspace, title="Planned", cycle_id=alias)

    assert created["cycle_id"] == expected


@pytest.mark.parametrize(("alias", "expected"), RELATIVE)
def test_update_resolves_a_relative_cycle(
    client: TestClient, workspace: str, repositories: Any, alias: str, expected: str
) -> None:
    """A patch naming current, next or previous moves the issue into that cycle."""
    _schedule(repositories, workspace)
    sign_in(client, OWNER)
    created = create_issue(client, workspace, title="Moved")

    response = client.patch(f"/api/workspaces/{workspace}/issues/{created['id']}", json={"cycle_id": alias})

    assert response.status_code == 200, response.text
    assert response.json()["cycle_id"] == expected


@pytest.mark.parametrize(("alias", "expected"), RELATIVE)
def test_bulk_update_resolves_a_relative_cycle(
    client: TestClient, workspace: str, repositories: Any, alias: str, expected: str
) -> None:
    """A bulk patch naming a relative cycle moves every issue into it."""
    _schedule(repositories, workspace)
    sign_in(client, OWNER)
    ids = [create_issue(client, workspace, title=title)["id"] for title in ("One", "Two")]

    response = client.patch(
        f"/api/workspaces/{workspace}/issues", json={"issue_ids": ids, "patch": {"cycle_id": alias}}
    )

    assert response.status_code == 200, response.text
    assert {row["cycle_id"] for row in response.json()["issues"]} == {expected}


def test_a_relative_cycle_the_team_lacks_names_the_alias_and_team(client: TestClient, workspace: str) -> None:
    """A team with no cycles refuses current with a 422 naming both."""
    sign_in(client, OWNER)

    response = client.post(
        f"/api/workspaces/{workspace}/issues", json={"team_id": TEAM, "title": "Lost", "cycle_id": "current"}
    )

    assert response.status_code == 422
    assert response.json()["message"] == "Team ABC has no current cycle"
