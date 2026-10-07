"""The CSV export route: filters, visibility, names, formula defusing and the page walk.

An export is read by spreadsheets and by other trackers' importers, so these hold
the header, that names rather than ids reach the cells, that a title a spreadsheet
would evaluate stays text, and that walking the cursor yields every row once.
"""

from __future__ import annotations

import csv
import io
from typing import Any

from fastapi.testclient import TestClient

from app.domains.issues import export as export_module
from app.domains.issues.export import COLUMNS, safe_cell
from tests.domains.helpers import GUEST, MEMBER, OWNER, make_user, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


def _export(client: TestClient, workspace: str, **params: Any) -> list[dict[str, str]]:
    """Every row of an export, following the cursor to the end."""
    text = ""
    cursor = None
    for _ in range(100):
        query = dict(params)
        if cursor:
            query["cursor"] = cursor
        response = client.get(f"/api/workspaces/{workspace}/issues/export", params=query)
        assert response.status_code == 200, response.text
        body = response.json()
        text += body["csv"]
        cursor = body["next_cursor"]
        if cursor is None:
            break
    reader = csv.DictReader(io.StringIO(text))
    assert tuple(reader.fieldnames or ()) == COLUMNS
    return list(reader)


def test_an_export_names_its_values(client: TestClient, workspace: str, repositories: Any, statuses: Any) -> None:
    """Status, priority, people, labels and the parent key come out as people read them."""
    from app.common.db.dynamo.team_config import Label, label_key, new_config_id

    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    label_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=workspace,
            config_key=label_key(TEAM, label_id),
            team_id=TEAM,
            label_id=label_id,
            name="Bug",
            color="#ff0000",
        )
    )
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent", body="Line one\nLine, two")
    child = create_issue(
        client,
        workspace,
        title="Child",
        priority="high",
        assignee_id=OWNER,
        label_ids=[label_id],
        parent_id=parent["id"],
        status_id=statuses["started"].status_id,
    )

    rows = {row["ID"]: row for row in _export(client, workspace, team_id=TEAM)}

    assert rows[parent["key"]]["Description"] == "Line one\nLine, two"
    shown = rows[child["key"]]
    assert shown["Status"] == statuses["started"].name
    assert shown["Status type"] == "started"
    assert shown["Priority"] == "High"
    assert shown["Assignee"] == "Olive Owner"
    assert shown["Creator"] == "Olive Owner"
    assert shown["Labels"] == "Bug"
    assert shown["Parent"] == parent["key"]
    assert shown["UUID"] == child["id"]


def test_the_list_filters_narrow_an_export(client: TestClient, workspace: str, statuses: Any) -> None:
    """The same query a list sends selects the same issues."""
    sign_in(client, OWNER)
    urgent = create_issue(client, workspace, title="Urgent", priority="urgent")
    create_issue(client, workspace, title="Calm", priority="low")

    rows = _export(client, workspace, team_id=TEAM, priority=["urgent"])

    assert [row["ID"] for row in rows] == [urgent["key"]]


def test_archived_issues_stay_out_unless_asked_for(client: TestClient, workspace: str, statuses: Any) -> None:
    """The list's archive rule holds for the export too."""
    sign_in(client, OWNER)
    kept = create_issue(client, workspace, title="Kept")
    gone = create_issue(client, workspace, title="Gone")
    assert client.post(f"/api/workspaces/{workspace}/issues/{gone['id']}/archive").status_code == 200

    assert [row["ID"] for row in _export(client, workspace, team_id=TEAM)] == [kept["key"]]
    archived = _export(client, workspace, team_id=TEAM, archived_only=True)
    assert [row["ID"] for row in archived] == [gone["key"]]
    assert archived[0]["Archived"]


def test_without_a_team_the_export_spans_every_visible_team(client: TestClient, workspace: str, statuses: Any) -> None:
    """An admin's unscoped export is the whole workspace, and a guest's only their teams."""
    sign_in(client, OWNER)
    here = create_issue(client, workspace, title="Here")
    there = create_issue(client, workspace, team_id=OTHER_TEAM, title="There")

    assert {row["ID"] for row in _export(client, workspace)} == {here["key"], there["key"]}

    sign_in(client, GUEST)
    assert {row["ID"] for row in _export(client, workspace)} == {here["key"]}


def test_a_team_the_caller_cannot_see_is_not_found(client: TestClient, workspace: str, statuses: Any) -> None:
    """A guest outside a team gets the same answer as for a team that never existed."""
    sign_in(client, GUEST)
    response = client.get(f"/api/workspaces/{workspace}/issues/export", params={"team_id": OTHER_TEAM})
    assert response.status_code == 404


def test_a_formula_title_stays_text(client: TestClient, workspace: str, statuses: Any) -> None:
    """A cell a spreadsheet would evaluate is quoted so it reads as the title it is."""
    sign_in(client, MEMBER)
    create_issue(client, workspace, title='=HYPERLINK("http://x")')

    rows = _export(client, workspace, team_id=TEAM)

    assert rows[0]["Title"] == '\'=HYPERLINK("http://x")'
    assert safe_cell("-1") == "'-1"
    assert safe_cell("plain") == "plain"


def test_the_cursor_walks_every_row_once(client: TestClient, workspace: str, statuses: Any, monkeypatch: Any) -> None:
    """Small pages and a small read chunk still yield each issue exactly once, header first."""
    monkeypatch.setattr(export_module, "READ_CHUNK", 2)
    sign_in(client, OWNER)
    keys = [create_issue(client, workspace, title=f"Issue {n}")["key"] for n in range(5)]
    keys.append(create_issue(client, workspace, team_id=OTHER_TEAM, title="Other")["key"])

    first = client.get(f"/api/workspaces/{workspace}/issues/export", params={"limit": 2}).json()
    assert first["rows"] == 2
    assert first["csv"].startswith("ID,Team,Title")
    assert first["next_cursor"]
    second = client.get(
        f"/api/workspaces/{workspace}/issues/export", params={"limit": 2, "cursor": first["next_cursor"]}
    ).json()
    assert not second["csv"].startswith("ID,")

    rows = _export(client, workspace, limit=2)
    assert sorted(row["ID"] for row in rows) == sorted(keys)


def test_an_unknown_status_category_is_refused(client: TestClient, workspace: str) -> None:
    """A misspelt category is a 422, not an empty file."""
    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/issues/export", params={"status_category": "nope"})
    assert response.status_code == 422
