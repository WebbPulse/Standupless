"""The "Added to cycle" filter and the `cycle_added_at` stamp through the issue routes, and its backfill.

The unit tests pin the phase rules; these hold that writes stamp the moment an
issue joins a cycle, that the list route resolves each cycle's start against the
real tables, and that the backfill reads the stamp back out of cycle history.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.activity import as_activity
from app.common.db.dynamo.planning import Cycle, cycle_key
from scripts.backfill_cycle_added_at import run
from tests.domains.helpers import OWNER, sign_in
from tests.domains.issues.conftest import TEAM, create_issue


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


def _cycles(repositories: Any, workspace: str) -> None:
    """A cycle that began a week ago and one that starts next week."""
    today = date.today()
    _cycle(repositories, workspace, "CURR", today - timedelta(days=7), today + timedelta(days=6))
    _cycle(repositories, workspace, "NEXT", today + timedelta(days=7), today + timedelta(days=20))


def _titles(client: TestClient, workspace: str, **params: Any) -> "set[str]":
    """The titles the team's issue list answers for one filter."""
    response = client.get(f"/api/workspaces/{workspace}/issues", params={"team_id": TEAM, **params})
    assert response.status_code == 200, response.text
    return {row["title"] for row in response.json()["issues"]}


def _patch(client: TestClient, workspace: str, issue_id: str, **fields: Any) -> Any:
    """Patch one issue, failing loudly on a refusal."""
    response = client.patch(f"/api/workspaces/{workspace}/issues/{issue_id}", json=fields)
    assert response.status_code == 200, response.text
    return response.json()


def test_cycle_writes_stamp_and_clear_the_moment(client: TestClient, workspace: str, repositories: Any) -> None:
    """Filing into a cycle reads the creation, a move restamps, and a removal clears."""
    sign_in(client, OWNER)
    _cycles(repositories, workspace)
    filed = create_issue(client, workspace, title="Filed", cycle_id="NEXT")
    loose = create_issue(client, workspace, title="Loose")
    assert filed["cycle_added_at"] is not None
    assert loose["cycle_added_at"] is None

    moved = _patch(client, workspace, loose["id"], cycle_id="CURR")
    assert moved["cycle_added_at"] is not None
    retitled = _patch(client, workspace, loose["id"], title="Moved")
    assert retitled["cycle_added_at"] == moved["cycle_added_at"]

    removed = _patch(client, workspace, loose["id"], cycle_id=None)
    assert removed["cycle_added_at"] is None


def test_the_list_splits_planned_from_added_after_start(client: TestClient, workspace: str, repositories: Any) -> None:
    """Issues in next week's cycle were planned, ones added a week into a cycle were not, and no cycle is neither."""
    sign_in(client, OWNER)
    _cycles(repositories, workspace)
    create_issue(client, workspace, title="Planned", cycle_id="NEXT")
    create_issue(client, workspace, title="Late", cycle_id="CURR")
    moved = create_issue(client, workspace, title="Moved")
    _patch(client, workspace, moved["id"], cycle_id="CURR")
    create_issue(client, workspace, title="Unplanned")

    assert _titles(client, workspace, cycle_added="planned") == {"Planned"}
    assert _titles(client, workspace, cycle_added="after_start") == {"Late", "Moved"}
    assert _titles(client, workspace, cycle_added_not="after_start") == {"Planned"}
    assert _titles(client, workspace, cycle_added_after="-1d") == {"Planned", "Late", "Moved"}
    assert _titles(client, workspace, cycle_added_before="-1d") == set()


def test_an_unknown_phase_is_a_422(client: TestClient, workspace: str) -> None:
    """A phase the filter does not know is refused rather than matching nothing."""
    sign_in(client, OWNER)

    response = client.get(f"/api/workspaces/{workspace}/issues", params={"team_id": TEAM, "cycle_added": "late"})

    assert response.status_code == 422, response.text


def test_the_backfill_derives_the_moment_from_cycle_history(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A move reads its activity row, a filing reads its creation, and a rerun writes nothing."""
    sign_in(client, OWNER)
    _cycles(repositories, workspace)
    filed = create_issue(client, workspace, title="Filed", cycle_id="CURR")
    moved = create_issue(client, workspace, title="Moved")
    _patch(client, workspace, moved["id"], cycle_id="NEXT")
    for issue in (filed, moved):
        stored = repositories.issues.get(workspace, issue["id"])
        repositories.issues.replace(stored.model_copy(update={"cycle_added_at": None}))

    assert run(repositories, [workspace], dry_run=True)[2] == 2
    assert repositories.issues.get(workspace, moved["id"]).cycle_added_at is None
    assert run(repositories, [workspace], dry_run=False)[2] == 2

    rows = [as_activity(item) for item in repositories.activity.list_for_issue(workspace, moved["id"]).items]
    joined = [row.created_at for row in rows if row.field == "cycle_id" and row.to_value == "NEXT"]
    filed_row = repositories.issues.get(workspace, filed["id"])
    assert filed_row.cycle_added_at == filed_row.created_at
    assert repositories.issues.get(workspace, moved["id"]).cycle_added_at == joined[-1]
    assert run(repositories, [workspace], dry_run=False)[2] == 0
