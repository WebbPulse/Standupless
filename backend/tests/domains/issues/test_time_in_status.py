"""Time in status: `status_changed_at` is stamped on every status move and read back with a fallback.

The properties worth holding are that a new issue enters its status when it is
created, that only a status, team or triage move restamps it, and that a row
written before the field existed reads the latest lifecycle stamp instead.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.common.sla import stamp_status_change
from tests.domains.helpers import OWNER, sign_in
from tests.domains.issues.conftest import create_issue

BASE = datetime(2026, 10, 1, tzinfo=timezone.utc)


def bare_issue(**fields: Any) -> Issue:
    """An unsaved issue for pure stamp checks."""
    base: "dict[str, Any]" = {
        "workspace_id": "ws",
        "team_id": "team",
        "key": "ABC-1",
        "number": 1,
        "title": "One",
        "status_id": "todo",
        "created_by": "user",
        "created_at": BASE,
    }
    base.update(fields)
    return Issue(**base)


def test_a_new_issue_enters_its_status_when_created() -> None:
    """Creating stamps `created_at`, and an imported stamp already set is kept."""
    created = bare_issue()
    stamp_status_change(None, created, BASE + timedelta(hours=5))
    assert created.status_changed_at == BASE

    kept = bare_issue(status_changed_at=BASE + timedelta(hours=2))
    stamp_status_change(None, kept, BASE + timedelta(hours=5))
    assert kept.status_changed_at == BASE + timedelta(hours=2)


def test_only_a_status_team_or_triage_move_restamps() -> None:
    """A title edit keeps the stamp; a status, team or triage move takes the new moment."""
    before = bare_issue(status_changed_at=BASE)
    moment = BASE + timedelta(days=3)

    retitled = before.model_copy(update={"title": "Two"})
    stamp_status_change(before, retitled, moment)
    assert retitled.status_changed_at == BASE

    for change in ({"status_id": "doing"}, {"team_id": "other"}, {"in_triage": True}):
        moved = before.model_copy(update=change)
        stamp_status_change(before, moved, moment)
        assert moved.status_changed_at == moment


def test_an_unstamped_row_reads_its_latest_lifecycle_stamp() -> None:
    """With no stamp the latest of created, started, completed, cancelled and triaged wins."""
    assert bare_issue().entered_status_at() == BASE
    started = bare_issue(started_at=BASE + timedelta(days=1))
    assert started.entered_status_at() == BASE + timedelta(days=1)
    done = bare_issue(started_at=BASE + timedelta(days=1), completed_at=BASE + timedelta(days=4))
    assert done.entered_status_at() == BASE + timedelta(days=4)
    triaged = bare_issue(triaged_at=BASE + timedelta(days=2))
    assert triaged.entered_status_at() == BASE + timedelta(days=2)
    stamped = bare_issue(completed_at=BASE + timedelta(days=4), status_changed_at=BASE + timedelta(days=1))
    assert stamped.entered_status_at() == BASE + timedelta(days=1)


def test_the_api_stamps_on_create_and_on_a_status_patch(client: TestClient, workspace: str, statuses: Any) -> None:
    """IssueRead carries the stamp; a title patch keeps it and a status patch moves it."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, title="Timed")
    assert issue["status_changed_at"] == issue["created_at"]

    url = f"/api/workspaces/{workspace}/issues/{issue['id']}"
    retitled = client.patch(url, json={"title": "Timed again"})
    assert retitled.status_code == 200, retitled.text
    assert retitled.json()["status_changed_at"] == issue["status_changed_at"]

    moved = client.patch(url, json={"status_id": statuses["started"].status_id})
    assert moved.status_code == 200, moved.text
    assert moved.json()["status_changed_at"] > issue["status_changed_at"]
