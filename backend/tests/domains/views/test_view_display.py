"""Saved view display settings and the filter shapes a view may store.

A view is run by expanding its filter into the issue list query, so the filter
checks here hold that anything a view stores is something the list can take:
list values for the repeatable keys, the negation keys, and nothing else.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER, sign_in


def _create(client: TestClient, workspace: str, **payload: Any) -> Any:
    """One create through the route, answering the raw response."""
    body: "dict[str, Any]" = {"name": "Display"}
    body.update(payload)
    return client.post(f"/api/workspaces/{workspace}/views", json=body)


def test_display_settings_round_trip(client: TestClient, workspace: str) -> None:
    """Layout, sub grouping, ordering and visible properties are stored and read back."""
    sign_in(client, MEMBER)

    created = _create(
        client,
        workspace,
        group_by="status",
        sub_group_by="assignee",
        ordering="manual",
        visible_properties=["id", "priority", "id", "labels"],
        layout="board",
    )

    assert created.status_code == 201, created.text
    view = created.json()
    assert view["sub_group_by"] == "assignee"
    assert view["ordering"] == "manual"
    assert view["visible_properties"] == ["id", "priority", "labels"]
    assert view["layout"] == "board"

    read = client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}").json()
    assert read["layout"] == "board"
    assert read["visible_properties"] == ["id", "priority", "labels"]


def test_layout_defaults_to_the_kind(client: TestClient, workspace: str) -> None:
    """A view saved without a layout shows the way its kind says."""
    sign_in(client, MEMBER)

    view = _create(client, workspace, kind="board").json()

    assert view["layout"] == "board"
    assert view["visible_properties"] is None


def test_display_settings_patch(client: TestClient, workspace: str) -> None:
    """Every display field is patchable, unlike the kind and the team."""
    sign_in(client, MEMBER)
    view = _create(client, workspace, group_by="priority").json()

    patched = client.patch(
        f"/api/workspaces/{workspace}/views/{view['view_id']}",
        json={
            "layout": "board",
            "sub_group_by": "label",
            "ordering": "priority_desc",
            "visible_properties": ["due_date"],
        },
    )

    assert patched.status_code == 200, patched.text
    body = patched.json()
    assert (body["layout"], body["sub_group_by"], body["ordering"], body["visible_properties"]) == (
        "board",
        "label",
        "priority_desc",
        ["due_date"],
    )


def test_a_sub_group_needs_a_distinct_group(client: TestClient, workspace: str) -> None:
    """Sub grouping by nothing, or by the grouping itself, is refused."""
    sign_in(client, MEMBER)

    assert _create(client, workspace, sub_group_by="status").status_code == 422
    assert _create(client, workspace, group_by="status", sub_group_by="status").status_code == 422

    view = _create(client, workspace, group_by="status", sub_group_by="assignee").json()
    cleared = client.patch(f"/api/workspaces/{workspace}/views/{view['view_id']}", json={"group_by": None})
    assert cleared.status_code == 422


def test_an_unknown_property_or_layout_is_a_422(client: TestClient, workspace: str) -> None:
    """Both are fixed vocabularies, so a client never meets a value it cannot render."""
    sign_in(client, MEMBER)

    assert _create(client, workspace, visible_properties=["colour"]).status_code == 422
    assert _create(client, workspace, layout="timeline").status_code == 422


def test_a_filter_may_hold_lists_and_negations(client: TestClient, workspace: str) -> None:
    """The list's repeatable keys store lists, and the negation keys are accepted."""
    sign_in(client, MEMBER)
    stored = {
        "status_category": ["started", "unstarted"],
        "assignee_id": ["me", "none"],
        "label_id_not": ["01JB00000000000000000LABEL"],
        "priority": "urgent",
        "q": "payments",
    }

    view = _create(client, workspace, filter=stored, sort="manual")

    assert view.status_code == 201, view.text
    assert view.json()["filter"] == stored
    assert view.json()["sort"] == "manual"


def test_a_malformed_filter_value_is_invalid_filter(client: TestClient, workspace: str) -> None:
    """A list on a key the list takes once, or a non-string value, is `INVALID_FILTER`."""
    sign_in(client, MEMBER)

    for bad in ({"q": ["a", "b"]}, {"status_id": [1, 2]}, {"priority": {"in": ["high"]}}):
        response = _create(client, workspace, filter=bad)
        assert response.status_code == 422, bad
        assert response.json()["error_code"] == "INVALID_FILTER"
