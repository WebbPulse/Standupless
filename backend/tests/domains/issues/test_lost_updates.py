"""Issue writes refuse to overwrite a row someone else wrote after it was read.

The properties held: two writers racing on one issue never lose either field,
a person's patch racing a system move answers 409 rather than reverting it, a
system write retries on the fresh row, and a patch built before a rollup landed
never restores the stale rollup counts.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import issue_writes
from app.common.db.dynamo.issues import Issue, IssueWriteConflict
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.issues.conftest import WORKSPACE, create_issue


def _read(repositories: Any, issue_id: str) -> Issue:
    """One issue as it stands now."""
    row = repositories.issues.get(WORKSPACE, issue_id)
    assert row is not None
    return row


def test_a_write_from_a_stale_read_is_refused_and_keeps_the_other_field(
    client: TestClient, workspace: str, repositories: Any, statuses: dict[str, Any]
) -> None:
    sign_in(client, MEMBER)
    issue_id = create_issue(client, workspace)["id"]
    first = _read(repositories, issue_id)
    second = _read(repositories, issue_id)

    repositories.issues.replace(first.model_copy(update={"title": "Renamed"}))
    with pytest.raises(IssueWriteConflict):
        repositories.issues.replace(second.model_copy(update={"status_id": statuses["started"].status_id}))

    stored = _read(repositories, issue_id)
    assert stored.title == "Renamed"


def test_a_system_write_retries_on_the_fresh_row_and_keeps_both_fields(
    client: TestClient, workspace: str, repositories: Any, statuses: dict[str, Any]
) -> None:
    sign_in(client, MEMBER)
    issue_id = create_issue(client, workspace)["id"]
    stale = _read(repositories, issue_id)
    repositories.issues.replace(_read(repositories, issue_id).model_copy(update={"title": "Renamed"}))

    started = statuses["started"].status_id
    stored = repositories.issues.replace_with(stale, lambda current: current.model_copy(update={"status_id": started}))

    assert stored is not None
    fresh = _read(repositories, issue_id)
    assert fresh.title == "Renamed"
    assert fresh.status_id == started


def test_a_patch_racing_another_write_answers_409_and_loses_nothing(
    client: TestClient,
    workspace: str,
    repositories: Any,
    statuses: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sign_in(client, MEMBER)
    issue_id = create_issue(client, workspace)["id"]
    started = statuses["started"].status_id
    original = issue_writes.apply_patch

    def racing(*args: Any, **kwargs: Any) -> Issue:
        """Apply the patch, then let a GitHub move land before it is written."""
        planned = original(*args, **kwargs)
        repositories.issues.replace(_read(repositories, issue_id).model_copy(update={"status_id": started}))
        return planned

    monkeypatch.setattr(issue_writes, "apply_patch", racing)
    response = client.patch(f"/api/workspaces/{workspace}/issues/{issue_id}", json={"title": "Mine"})

    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "ISSUE_CHANGED"
    stored = _read(repositories, issue_id)
    assert stored.status_id == started
    assert stored.title == "An issue"


def test_a_patch_built_before_a_rollup_keeps_the_rollup_counts(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    sign_in(client, MEMBER)
    issue_id = create_issue(client, workspace)["id"]
    stale = _read(repositories, issue_id)

    repositories.issues.set_progress(WORKSPACE, issue_id, 4, 3)
    repositories.issues.set_blocked_by_open_count(WORKSPACE, issue_id, 2)
    repositories.issues.replace(stale.model_copy(update={"title": "Renamed"}))

    stored = _read(repositories, issue_id)
    assert stored.title == "Renamed"
    assert (stored.progress.total, stored.progress.completed) == (4, 3)
    assert stored.blocked_by_open_count == 2


def test_clearing_a_field_drops_its_index_composite(client: TestClient, workspace: str, repositories: Any) -> None:
    sign_in(client, MEMBER)
    issue_id = create_issue(client, workspace, assignee_id=MEMBER)["id"]

    repositories.issues.replace(_read(repositories, issue_id).model_copy(update={"assignee_id": None}))

    raw = repositories.issues._repository.get({"workspace_id": WORKSPACE, "issue_id": issue_id})
    assert raw is not None
    assert "ws_assignee" not in raw
    assert _read(repositories, issue_id).assignee_id is None
