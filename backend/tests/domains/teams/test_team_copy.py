"""Creating a team from another team's settings, as Linear's "Copy settings from an existing team" does.

The new team starts with the source's statuses, labels and groups, templates and
their sub-issues, estimates and its cycle, triage, SLA, archive, auto-close and
display settings, every reference pointed at its own copies. Members and work
stay behind, a source the caller cannot read is a 422, the field is exclusive
with a parent, and a refused create leaves none of the copied rows behind.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common import team_writes
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import MEMBER, OWNER, add_member, add_team_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

SOURCE = "01JB000000000000000000SRC1"

VAULT = "01JB000000000000000000VLT1"

BASE = f"/api/workspaces/{WORKSPACE}"

ESTIMATES = {
    "estimate_scale": "tshirt",
    "estimate_extended": True,
    "estimate_allow_zero": True,
    "estimate_count_unestimated": True,
}

CYCLES = {"enabled": True, "duration_weeks": 1, "cooldown_weeks": 1, "start_weekday": 2, "upcoming_count": 2}


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application signed in as the owner, on a Business workspace with a source team."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_team(repositories, WORKSPACE, SOURCE, "SRC")
    add_team_member(repositories, WORKSPACE, SOURCE, MEMBER, "member")
    with TestClient(app) as test_client:
        sign_in(test_client, OWNER)
        yield test_client


def _ok(response: Any, code: int = 200) -> Any:
    """The body of a response that answered `code`."""
    assert response.status_code == code, response.text
    return response.json()


def _statuses(client: TestClient, team_id: str) -> list[dict[str, Any]]:
    """A team's statuses in order."""
    return _ok(client.get(f"{BASE}/teams/{team_id}/statuses"))["statuses"]


def _labels(client: TestClient, team_id: str) -> list[dict[str, Any]]:
    """A team's labels."""
    return _ok(client.get(f"{BASE}/teams/{team_id}/labels"))["labels"]


def _settings(client: TestClient, team_id: str, path: str) -> dict[str, Any]:
    """One settings page of a team without its team id and save time."""
    body = _ok(client.get(f"{BASE}/teams/{team_id}/{path}"))
    return {key: value for key, value in body.items() if key not in ("team_id", "updated_at", "updated_by")}


def _copy(client: TestClient, **extra: Any) -> Any:
    """Create a team copying the source's settings."""
    return client.post(
        f"{BASE}/teams",
        json={"name": "Copy", "key_prefix": "CPY", "copy_settings_from_team_id": SOURCE, **extra},
    )


def _by_name(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Rows keyed by name."""
    return {row["name"]: row for row in rows}


def _configure(client: TestClient) -> dict[str, str]:
    """Give the source a custom workflow, labels, a template and every settings page, answering the ids used."""
    review = _ok(
        client.post(
            f"{BASE}/teams/{SOURCE}/statuses",
            json={"name": "Review", "category": "started", "position": 3, "color": "blue"},
        ),
        201,
    )["id"]
    group = _ok(
        client.post(f"{BASE}/teams/{SOURCE}/labels", json={"name": "Area", "color": "#112233", "is_group": True}),
        201,
    )["id"]
    backend = _ok(
        client.post(f"{BASE}/teams/{SOURCE}/labels", json={"name": "Backend", "color": "#223344", "parent_id": group}),
        201,
    )["id"]
    bug = _ok(client.post(f"{BASE}/teams/{SOURCE}/labels", json={"name": "Bug", "color": "#ff0000"}), 201)["id"]
    template = _ok(
        client.post(
            f"{BASE}/teams/{SOURCE}/templates",
            json={
                "name": "Bug report",
                "title": "Bug: ",
                "status_id": review,
                "label_ids": [bug],
                "sub_issues": [{"title": "Reproduce", "status_id": review, "label_ids": [backend]}],
            },
        ),
        201,
    )["id"]
    cancelled = next(row["id"] for row in _statuses(client, SOURCE) if row["category"] == "cancelled")
    _ok(
        client.patch(
            f"{BASE}/teams/{SOURCE}/template-settings",
            json={"default_template_id": template, "non_member_default_template_id": template},
        )
    )
    _ok(client.patch(f"{BASE}/teams/{SOURCE}", json=ESTIMATES))
    _ok(client.patch(f"{BASE}/teams/{SOURCE}/cycle-settings", json=CYCLES))
    _ok(client.patch(f"{BASE}/teams/{SOURCE}/archive-settings", json={"period_months": 3}))
    _ok(
        client.patch(
            f"{BASE}/teams/{SOURCE}/sla-settings",
            json={"enabled": True, "urgent_hours": 4, "paused_status_ids": [review]},
        )
    )
    _ok(client.patch(f"{BASE}/teams/{SOURCE}/auto-close-settings", json={"period_months": 6, "status_id": cancelled}))
    _ok(client.patch(f"{BASE}/teams/{SOURCE}/parent-auto-close-settings", json={"close_parent": True}))
    _ok(client.patch(f"{BASE}/teams/{SOURCE}/display-defaults", json={"list_display": {"group_by": "assignee"}}))
    _ok(
        client.patch(
            f"{BASE}/teams/{SOURCE}/triage-settings",
            json={
                "enabled": True,
                "responsible_user_ids": [MEMBER],
                "require_priority": True,
                "rules": [{"name": "Bugs", "filter": {"label_ids": [bug]}, "actions": {"add_label_ids": [backend]}}],
            },
        )
    )
    return {"review": review, "cancelled": cancelled, "bug": bug, "backend": backend, "group": group}


def test_the_workflow_is_copied_in_order_under_fresh_ids(client: TestClient) -> None:
    """Statuses keep their names, categories, colours and order, and are the new team's own."""
    _configure(client)

    created = _ok(_copy(client), 201)

    source = _statuses(client, SOURCE)
    copied = _statuses(client, created["id"])
    shape = [(row["name"], row["category"], row["position"], row["color"]) for row in source]
    assert [(row["name"], row["category"], row["position"], row["color"]) for row in copied] == shape
    assert {row["id"] for row in copied}.isdisjoint({row["id"] for row in source})
    assert all(row["scope"] == "team" for row in copied)


def test_labels_and_groups_are_copied_with_the_grouping_kept(client: TestClient) -> None:
    """A copied label sits in the copied group, not the source's."""
    ids = _configure(client)

    created = _ok(_copy(client), 201)

    labels = _by_name(_labels(client, created["id"]))
    assert set(labels) == {"Area", "Backend", "Bug"}
    assert labels["Area"]["is_group"] is True
    assert labels["Backend"]["parent_id"] == labels["Area"]["id"]
    assert labels["Area"]["id"] != ids["group"]
    assert labels["Bug"]["color"] == "#ff0000"


def test_templates_and_their_sub_issues_point_at_the_copies(client: TestClient) -> None:
    """A copied template and its sub-issues take the new team's status and labels, and stay its default."""
    _configure(client)

    created = _ok(_copy(client), 201)

    team_id = created["id"]
    statuses = _by_name(_statuses(client, team_id))
    labels = _by_name(_labels(client, team_id))
    listed = _ok(client.get(f"{BASE}/teams/{team_id}/templates"))
    [template] = [row for row in listed["templates"] if row["scope"] == "team"]
    assert template["name"] == "Bug report"
    assert template["team_id"] == team_id
    assert template["status_id"] == statuses["Review"]["id"]
    assert template["label_ids"] == [labels["Bug"]["id"]]
    [sub_issue] = template["sub_issues"]
    assert sub_issue["title"] == "Reproduce"
    assert sub_issue["status_id"] == statuses["Review"]["id"]
    assert sub_issue["label_ids"] == [labels["Backend"]["id"]]
    assert listed["default_template_id"] == template["id"]
    settings = _ok(client.get(f"{BASE}/teams/{team_id}/template-settings"))
    assert settings["non_member_default_template_id"] == template["id"]


def test_estimates_and_every_settings_page_are_copied(client: TestClient) -> None:
    """Estimates, cycles, archive, SLA, auto-close, parent auto-close and display defaults read as the source's."""
    _configure(client)

    created = _ok(_copy(client), 201)

    team_id = created["id"]
    assert {name: created[name] for name in ESTIMATES} == ESTIMATES
    for path in ("cycle-settings", "archive-settings", "parent-auto-close-settings", "display-defaults"):
        assert _settings(client, team_id, path) == _settings(client, SOURCE, path), path
    statuses = _by_name(_statuses(client, team_id))
    sla = _settings(client, team_id, "sla-settings")
    assert sla["enabled"] is True
    assert sla["urgent_hours"] == 4
    assert sla["paused_status_ids"] == [statuses["Review"]["id"]]
    auto_close = _settings(client, team_id, "auto-close-settings")
    assert auto_close["period_months"] == 6
    assert auto_close["status_id"] == statuses["Cancelled"]["id"]


def test_copied_cycles_are_stocked(client: TestClient, repositories: Any) -> None:
    """A team copied with cycles on starts with its upcoming cycles, as turning them on would."""
    _configure(client)

    created = _ok(_copy(client), 201)

    cycles, _ = repositories.planning.list_cycles(WORKSPACE, created["id"])
    assert cycles


def test_triage_rules_are_copied_without_the_people_on_duty(client: TestClient) -> None:
    """Triage settings and rules carry over with their labels remapped, and nobody starts on duty."""
    _configure(client)

    created = _ok(_copy(client), 201)

    labels = _by_name(_labels(client, created["id"]))
    triage = _settings(client, created["id"], "triage-settings")
    assert triage["enabled"] is True
    assert triage["require_priority"] is True
    assert triage["responsible_user_ids"] == []
    [rule] = triage["rules"]
    assert rule["name"] == "Bugs"
    assert rule["filter"]["label_ids"] == [labels["Bug"]["id"]]
    assert rule["actions"]["add_label_ids"] == [labels["Backend"]["id"]]


def test_members_stay_behind(client: TestClient, repositories: Any) -> None:
    """Only the creator joins the copy, as its admin."""
    created = _ok(_copy(client), 201)

    members = repositories.memberships.list_team_members(WORKSPACE, created["id"])
    assert [(row.user_id, row.role) for row in members] == [(OWNER, "admin")]


def test_a_source_that_was_never_configured_gives_the_defaults(client: TestClient) -> None:
    """Copying a fresh team gives the default workflow and no saved settings."""
    created = _ok(_copy(client), 201)

    assert [row["name"] for row in _statuses(client, created["id"])] == [
        row["name"] for row in _statuses(client, SOURCE)
    ]
    assert _labels(client, created["id"]) == []


def test_a_source_the_caller_cannot_read_is_a_422(client: TestClient, repositories: Any) -> None:
    """A private team the caller is not in, or a team that does not exist, is refused and nothing is made."""
    make_team(repositories, WORKSPACE, VAULT, "VLT")
    repositories.memberships.set_team_private(WORKSPACE, VAULT, True)
    sign_in(client, MEMBER)

    hidden = client.post(
        f"{BASE}/teams", json={"name": "Copy", "key_prefix": "CPY", "copy_settings_from_team_id": VAULT}
    )
    missing = client.post(
        f"{BASE}/teams", json={"name": "Copy", "key_prefix": "CPY", "copy_settings_from_team_id": "nope"}
    )

    assert hidden.status_code == 422, hidden.text
    assert missing.status_code == 422, missing.text
    assert VAULT in hidden.text
    assert repositories.teams.get_by_key_prefix(WORKSPACE, "CPY") is None


def test_copying_and_a_parent_are_exclusive(client: TestClient) -> None:
    """A create naming both a parent and a copy source is a 422."""
    response = _copy(client, parent_team_id=SOURCE)

    assert response.status_code == 422, response.text


def test_a_refused_create_leaves_no_copied_rows(
    client: TestClient, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A taken prefix is a 409, and the rows written ahead of the transaction are removed again."""
    _configure(client)
    monkeypatch.setattr(team_writes, "new_team_id", lambda: "01JB000000000000000000LOST")

    response = _copy(client, key_prefix="SRC")

    assert response.status_code == 409, response.text
    config = repositories.team_config
    assert config.list_labels(WORKSPACE, "01JB000000000000000000LOST") == []
    assert [row for row in config.list_statuses(WORKSPACE, "01JB000000000000000000LOST") if row.scope == "team"] == []
    assert config.list_team_templates(WORKSPACE, "01JB000000000000000000LOST", kind="issue_template") == []
