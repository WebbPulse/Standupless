"""When an issue started, completed or was cancelled, as status writes stamp it and the backfill derives it."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.activity import as_activity
from scripts.backfill_issue_lifecycle_times import run
from tests.domains.helpers import OWNER, sign_in
from tests.domains.issues.conftest import create_issue


def _patch(client: TestClient, workspace: str, issue_id: str, status_id: str) -> Any:
    """Move one issue to a status, failing loudly on a refusal."""
    response = client.patch(f"/api/workspaces/{workspace}/issues/{issue_id}", json={"status_id": status_id})
    assert response.status_code == 200, response.text
    return response.json()


def _list(client: TestClient, workspace: str, **params: Any) -> "list[str]":
    """The ids one list call answers, in order."""
    response = client.get(f"/api/workspaces/{workspace}/issues", params=params)
    assert response.status_code == 200, response.text
    return [row["id"] for row in response.json()["issues"]]


def test_status_moves_stamp_and_clear_the_moments(client: TestClient, workspace: str, statuses: Any) -> None:
    """Starting keeps its first moment, completing stamps, reopening clears, and cancelling stamps its own."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, title="Lifecycle")
    assert issue["started_at"] is None
    assert issue["completed_at"] is None

    started = _patch(client, workspace, issue["id"], statuses["started"].status_id)
    assert started["started_at"] is not None
    done = _patch(client, workspace, issue["id"], statuses["completed"].status_id)
    assert done["started_at"] == started["started_at"]
    assert done["completed_at"] is not None

    reopened = _patch(client, workspace, issue["id"], statuses["unstarted"].status_id)
    assert reopened["completed_at"] is None
    assert reopened["started_at"] == started["started_at"]

    cancelled = _patch(client, workspace, issue["id"], statuses["cancelled"].status_id)
    assert cancelled["cancelled_at"] is not None
    assert cancelled["completed_at"] is None


def test_completed_desc_lists_the_latest_completion_first(client: TestClient, workspace: str, statuses: Any) -> None:
    """Completed issues come newest first and open ones last, in either direction."""
    sign_in(client, OWNER)
    open_issue = create_issue(client, workspace, title="Open")
    first = create_issue(client, workspace, title="First")
    second = create_issue(client, workspace, title="Second")
    _patch(client, workspace, first["id"], statuses["completed"].status_id)
    _patch(client, workspace, second["id"], statuses["completed"].status_id)

    assert _list(client, workspace, sort="completed_desc") == [second["id"], first["id"], open_issue["id"]]
    assert _list(client, workspace, sort="completed_desc", reverse="true") == [
        first["id"],
        second["id"],
        open_issue["id"],
    ]


def test_the_backfill_derives_the_moments_from_status_history(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Moments cleared off the row come back at the status rows' own times, and a rerun writes nothing."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, title="Old")
    _patch(client, workspace, issue["id"], statuses["started"].status_id)
    _patch(client, workspace, issue["id"], statuses["completed"].status_id)
    stored = repositories.issues.get(workspace, issue["id"])
    repositories.issues.replace(stored.model_copy(update={"started_at": None, "completed_at": None}))

    assert run(repositories, [workspace], dry_run=True)[2] == 1
    assert repositories.issues.get(workspace, issue["id"]).completed_at is None
    assert run(repositories, [workspace], dry_run=False)[2] == 1

    rows = [as_activity(item) for item in repositories.activity.list_for_issue(workspace, issue["id"]).items]
    moves = {row.to_value: row.created_at for row in rows if row.field == "status_id"}
    filled = repositories.issues.get(workspace, issue["id"])
    assert filled.started_at == moves[statuses["started"].status_id]
    assert filled.completed_at == moves[statuses["completed"].status_id]
    assert filled.cancelled_at is None
    assert run(repositories, [workspace], dry_run=False)[2] == 0
