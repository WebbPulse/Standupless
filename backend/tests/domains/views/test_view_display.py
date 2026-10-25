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


def test_a_view_groups_by_a_label_group(client: TestClient, workspace: str) -> None:
    """A label group grouping is stored as `label_group:<id>`, and a malformed one is refused."""
    sign_in(client, MEMBER)

    created = _create(client, workspace, group_by="label_group:01M3NKM0BRRYEXPKVW8BTWV7RB", sub_group_by="status")
    assert created.status_code == 201, created.text
    view_id = created.json()["view_id"]
    patched = client.patch(
        f"/api/workspaces/{workspace}/views/{view_id}",
        json={"group_by": "status", "sub_group_by": "label_group:grp-type"},
    )
    read = client.get(f"/api/workspaces/{workspace}/views/{view_id}").json()

    assert created.json()["group_by"] == "label_group:01M3NKM0BRRYEXPKVW8BTWV7RB"
    assert patched.status_code == 200, patched.text
    assert (read["group_by"], read["sub_group_by"]) == ("status", "label_group:grp-type")
    for bad in ("label_group:", "label_group:a b", "label_group", "labels:abc"):
        assert _create(client, workspace, group_by=bad).status_code == 422, bad
    same = _create(client, workspace, group_by="label_group:grp", sub_group_by="label_group:grp")
    assert same.status_code == 422


def test_an_unknown_property_or_layout_is_a_422(client: TestClient, workspace: str) -> None:
    """Both are fixed vocabularies, so a client never meets a value it cannot render."""
    sign_in(client, MEMBER)

    assert _create(client, workspace, visible_properties=["colour"]).status_code == 422
    assert _create(client, workspace, layout="timeline").status_code == 422


def test_the_my_issues_focus_grouping_is_not_storable(client: TestClient, workspace: str) -> None:
    """Focus is a client-only grouping of My issues, so a view refuses it as a grouping or sub-grouping."""
    sign_in(client, MEMBER)

    assert _create(client, workspace, group_by="focus").status_code == 422
    assert _create(client, workspace, group_by="status", sub_group_by="focus").status_code == 422


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


def test_display_switches_default_to_shown_and_round_trip(client: TestClient, workspace: str) -> None:
    """Sub-issues and completed issues show unless a view turns them off, and the choice is kept."""
    sign_in(client, MEMBER)

    default = _create(client, workspace).json()
    assert (default["show_sub_issues"], default["show_completed"]) == (True, True)

    view = _create(client, workspace, show_sub_issues=False, show_completed=False).json()
    assert (view["show_sub_issues"], view["show_completed"]) == (False, False)
    read = client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}").json()
    assert (read["show_sub_issues"], read["show_completed"]) == (False, False)

    patched = client.patch(f"/api/workspaces/{workspace}/views/{view['view_id']}", json={"show_completed": True})
    assert patched.status_code == 200, patched.text
    assert (patched.json()["show_sub_issues"], patched.json()["show_completed"]) == (False, True)


def test_display_switches_are_strict_booleans(client: TestClient, workspace: str) -> None:
    """A string or a number is not read as a switch, and a patch may not clear one to null."""
    sign_in(client, MEMBER)

    assert _create(client, workspace, show_sub_issues="false").status_code == 422
    assert _create(client, workspace, show_completed=0).status_code == 422

    view = _create(client, workspace).json()
    cleared = client.patch(f"/api/workspaces/{workspace}/views/{view['view_id']}", json={"show_sub_issues": None})
    assert cleared.status_code == 422


def test_the_completed_window_round_trips_beside_the_switch(client: TestClient, workspace: str) -> None:
    """The window keeps `show_completed` in step, and setting either one moves the other."""
    sign_in(client, MEMBER)

    default = _create(client, workspace).json()
    assert (default["completed_window"], default["show_completed"]) == ("all", True)
    hidden = _create(client, workspace, show_completed=False).json()
    assert hidden["completed_window"] == "none"

    view = _create(client, workspace, completed_window="past_week").json()
    assert (view["completed_window"], view["show_completed"]) == ("past_week", True)
    path = f"/api/workspaces/{workspace}/views/{view['view_id']}"

    month = client.patch(path, json={"completed_window": "past_month"}).json()
    assert (month["completed_window"], month["show_completed"]) == ("past_month", True)
    none = client.patch(path, json={"completed_window": "none"}).json()
    assert (none["completed_window"], none["show_completed"]) == ("none", False)
    shown = client.patch(path, json={"show_completed": True}).json()
    assert (shown["completed_window"], shown["show_completed"]) == ("all", True)

    assert client.patch(path, json={"completed_window": None}).status_code == 422
    assert client.patch(path, json={"completed_window": "past_year"}).status_code == 422


def test_the_milestone_and_links_properties_round_trip(client: TestClient, workspace: str) -> None:
    """A view may show the milestone and the link count beside the other row properties."""
    sign_in(client, MEMBER)

    created = _create(client, workspace, visible_properties=["id", "milestone", "links"])
    assert created.status_code == 201, created.text
    assert created.json()["visible_properties"] == ["id", "milestone", "links"]


def test_the_release_property_and_filter_round_trip(client: TestClient, workspace: str) -> None:
    """A view may show each row's releases and keep or drop issues by release."""
    sign_in(client, MEMBER)

    created = _create(
        client,
        workspace,
        visible_properties=["id", "release"],
        filter={"release_id": ["none"], "release_id_not": ["01JB000000000000000000REL1"]},
    )
    assert created.status_code == 201, created.text
    assert created.json()["visible_properties"] == ["id", "release"]
    assert created.json()["filter"]["release_id"] == ["none"]


def test_the_new_groupings_and_sorts_round_trip(client: TestClient, workspace: str) -> None:
    """Project, cycle, parent, team, SLA, customer and release groupings and the newer sorts are kept."""
    sign_in(client, MEMBER)

    for group, sub_group in (
        ("project", "cycle"),
        ("parent", "sla"),
        ("team", "milestone"),
        ("cycle", "project"),
        ("customer", "status"),
        ("release", "assignee"),
        ("status", "release"),
    ):
        created = _create(client, workspace, group_by=group, sub_group_by=sub_group)
        assert created.status_code == 201, created.text
        read = client.get(f"/api/workspaces/{workspace}/views/{created.json()['view_id']}").json()
        assert (read["group_by"], read["sub_group_by"]) == (group, sub_group)

    for sort in ("status_asc", "start_asc", "estimate_desc", "completed_desc", "links_desc"):
        created = _create(client, workspace, sort=sort, ordering=sort)
        assert created.status_code == 201, created.text
        assert (created.json()["sort"], created.json()["ordering"]) == (sort, sort)


def test_the_ordering_direction_defaults_forward_and_round_trips(client: TestClient, workspace: str) -> None:
    """A view reads forward unless it saves the reversed direction, and a patch may turn it back."""
    sign_in(client, MEMBER)

    assert _create(client, workspace).json()["ordering_reversed"] is False

    view = _create(client, workspace, ordering="status_asc", ordering_reversed=True).json()
    assert view["ordering_reversed"] is True
    read = client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}").json()
    assert read["ordering_reversed"] is True

    patched = client.patch(f"/api/workspaces/{workspace}/views/{view['view_id']}", json={"ordering_reversed": False})
    assert patched.status_code == 200, patched.text
    assert patched.json()["ordering_reversed"] is False


def test_the_ordering_direction_is_a_strict_boolean(client: TestClient, workspace: str) -> None:
    """A string is not read as a direction, and a patch may not clear it to null."""
    sign_in(client, MEMBER)

    assert _create(client, workspace, ordering_reversed="true").status_code == 422

    view = _create(client, workspace).json()
    cleared = client.patch(f"/api/workspaces/{workspace}/views/{view['view_id']}", json={"ordering_reversed": None})
    assert cleared.status_code == 422


def test_the_group_header_defaults_to_the_count_and_round_trips(client: TestClient, workspace: str) -> None:
    """A view reads the issue count until it saves the total estimate, and a patch may never clear the choice."""
    sign_in(client, MEMBER)

    default = _create(client, workspace).json()
    assert default["group_header"] == "count"

    view = _create(client, workspace, group_header="estimate").json()
    assert view["group_header"] == "estimate"
    path = f"/api/workspaces/{workspace}/views/{view['view_id']}"
    assert client.get(path).json()["group_header"] == "estimate"

    assert client.patch(path, json={"group_header": "count"}).json()["group_header"] == "count"
    assert client.patch(path, json={"group_header": None}).status_code == 422
    assert client.patch(path, json={"group_header": "points"}).status_code == 422
    assert _create(client, workspace, group_header="points").status_code == 422
