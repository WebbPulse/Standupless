"""Saved view display settings and the filter shapes a view may store.

A view is run by expanding its filter into the issue list query, so the filter
checks here hold that anything a view stores is something the list can take:
list values for the repeatable keys, the negation keys, and nothing else.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.api.schemas.views import SLA_HIDDEN, ViewRead, read_visible_properties, stored_visible_properties
from app.common.db.dynamo.views import SavedView
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


def test_the_sla_and_customer_properties_round_trip(client: TestClient, workspace: str) -> None:
    """A view may show the SLA badge, the requesting customers and their summed revenue."""
    sign_in(client, MEMBER)

    created = _create(client, workspace, visible_properties=["id", "sla", "customers", "customer_revenue"])

    assert created.status_code == 201, created.text
    assert created.json()["visible_properties"] == ["id", "sla", "customers", "customer_revenue"]
    read = client.get(f"/api/workspaces/{workspace}/views/{created.json()['view_id']}").json()
    assert read["visible_properties"] == ["id", "sla", "customers", "customer_revenue"]


def test_a_view_that_hides_the_sla_badge_keeps_it_hidden(client: TestClient, workspace: str) -> None:
    """A list without sla saved now reads back without it, through create and patch alike."""
    sign_in(client, MEMBER)
    view = _create(client, workspace, visible_properties=["id", "sla"]).json()

    patched = client.patch(f"/api/workspaces/{workspace}/views/{view['view_id']}", json={"visible_properties": ["id"]})

    assert patched.status_code == 200, patched.text
    assert patched.json()["visible_properties"] == ["id"]
    assert client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}").json()["visible_properties"] == ["id"]


def test_a_list_saved_before_the_sla_property_reads_with_it_on() -> None:
    """Every view saved before sla was a property showed the badge, so its stored list reads with sla added."""
    legacy = SavedView(
        workspace_id="w",
        view_key="k",
        view_id="v",
        name="Old",
        owner_id="u",
        visible_properties=["id", "labels"],
    )

    assert ViewRead.from_row(legacy).visible_properties == ["id", "labels", "sla"]
    assert stored_visible_properties(["id"]) == ["id", SLA_HIDDEN]
    assert stored_visible_properties(["id", "sla"]) == ["id", "sla"]
    assert stored_visible_properties([SLA_HIDDEN, "sla"]) == ["sla"]
    assert stored_visible_properties(None) is None
    assert read_visible_properties(["id", SLA_HIDDEN]) == ["id"]
    assert read_visible_properties(["sla", "id"]) == ["sla", "id"]
    assert read_visible_properties(None) is None


def test_the_hidden_sla_marker_is_not_a_property_a_client_may_send(client: TestClient, workspace: str) -> None:
    """The stored marker stays internal, so a create naming it is refused."""
    sign_in(client, MEMBER)

    assert _create(client, workspace, visible_properties=["-sla"]).status_code == 422


def test_collapsed_groups_round_trip_and_clear(client: TestClient, workspace: str) -> None:
    """Folded groups and hidden columns save with the view, drop repeats, and clear on an empty list or null."""
    sign_in(client, MEMBER)

    default = _create(client, workspace).json()
    assert default["collapsed_groups"] == []

    view = _create(client, workspace, collapsed_groups=["hidden:started:doing", "lane/high", "hidden:started:doing"])
    assert view.status_code == 201, view.text
    assert view.json()["collapsed_groups"] == ["hidden:started:doing", "lane/high"]
    path = f"/api/workspaces/{workspace}/views/{view.json()['view_id']}"
    assert client.get(path).json()["collapsed_groups"] == ["hidden:started:doing", "lane/high"]

    patched = client.patch(path, json={"collapsed_groups": ["todo"]})
    assert patched.status_code == 200, patched.text
    assert patched.json()["collapsed_groups"] == ["todo"]
    assert client.patch(path, json={"collapsed_groups": None}).json()["collapsed_groups"] == []
    assert client.patch(path, json={"collapsed_groups": ["x"] * 2 + [""]}).status_code == 422
    assert client.patch(path, json={"collapsed_groups": ["k" * 301]}).status_code == 422
    assert client.patch(path, json={"collapsed_groups": [f"g{n}" for n in range(501)]}).status_code == 422


def test_the_customer_field_filters_round_trip(client: TestClient, workspace: str) -> None:
    """A view keeps the customer status, tier, bounds and important flag, a JSON number or bool stored as text."""
    sign_in(client, MEMBER)

    created = _create(
        client,
        workspace,
        filter={
            "customer_status_id": ["active", "none"],
            "customer_tier_id_not": ["tier-1"],
            "customer_revenue_min": 50_000,
            "customer_size_max": "200",
            "customer_request_count_max": 0,
            "customer_important": True,
            "groups": [{"match": "any", "customer_tier_id": ["tier-2"], "customer_request_count_min": 2}],
        },
    )

    assert created.status_code == 201, created.text
    assert created.json()["filter"] == {
        "customer_status_id": ["active", "none"],
        "customer_tier_id_not": ["tier-1"],
        "customer_revenue_min": "50000",
        "customer_size_max": "200",
        "customer_request_count_max": "0",
        "customer_important": "true",
        "groups": [{"match": "any", "customer_tier_id": ["tier-2"], "customer_request_count_min": "2"}],
    }
    for bad in (
        {"customer_revenue_min": "-1"},
        {"customer_size_max": "1.5"},
        {"customer_request_count_min": ["1"]},
        {"customer_important": "maybe"},
        {"groups": [{"customer_size_min": "lots"}]},
    ):
        response = _create(client, workspace, filter=bad)
        assert response.status_code == 422, bad
        assert response.json()["error_code"] == "INVALID_FILTER"


def test_order_completed_by_recency_defaults_off_and_round_trips(client: TestClient, workspace: str) -> None:
    """A view orders closed issues by the main ordering unless it saves the switch, and a patch may turn it off."""
    sign_in(client, MEMBER)

    assert _create(client, workspace).json()["order_completed_by_recency"] is False

    view = _create(client, workspace, order_completed_by_recency=True).json()
    assert view["order_completed_by_recency"] is True
    read = client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}").json()
    assert read["order_completed_by_recency"] is True

    url = f"/api/workspaces/{workspace}/views/{view['view_id']}"
    patched = client.patch(url, json={"order_completed_by_recency": False})
    assert patched.status_code == 200, patched.text
    assert patched.json()["order_completed_by_recency"] is False

    assert _create(client, workspace, order_completed_by_recency="true").status_code == 422
    assert client.patch(url, json={"order_completed_by_recency": None}).status_code == 422
