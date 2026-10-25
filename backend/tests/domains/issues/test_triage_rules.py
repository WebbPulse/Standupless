"""Triage rules, through the issue routes.

These pin that a team's rules run in order on every issue entering its triage
inbox, that the first match applies and stops unless it asks to continue, that
each filter field narrows the match, that a move rule sends the issue to the
other team and ends the run, that a rule whose target was deleted is skipped,
and that each applied rule is recorded on the issue as Standupless.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.team_config import (
    Label,
    TriageRule,
    TriageRuleActions,
    TriageRuleFilter,
    default_triage_settings,
    label_key,
    new_config_id,
)
from tests.domains.helpers import MEMBER, OWNER, add_team_member, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, WORKSPACE, create_issue

BASE = f"/api/workspaces/{WORKSPACE}/issues"


def _rule(name: str, *, continue_after: bool = False, enabled: bool = True, **parts: Any) -> TriageRule:
    """One rule with its filter and action fields split out of `parts`."""
    filter_fields = {key: value for key, value in parts.items() if key in TriageRuleFilter.model_fields}
    action_fields = {key: value for key, value in parts.items() if key in TriageRuleActions.model_fields}
    return TriageRule(
        rule_id=new_config_id(),
        name=name,
        enabled=enabled,
        continue_after=continue_after,
        filter=TriageRuleFilter(**filter_fields),
        actions=TriageRuleActions(**action_fields),
    )


def _rules(repositories: Any, *rules: TriageRule, team_id: str = TEAM) -> None:
    """Save one team's triage settings straight in the table, triage on with `rules`."""
    repositories.team_config.put_triage_settings(
        default_triage_settings(WORKSPACE, team_id).model_copy(update={"enabled": True, "rules": list(rules)})
    )


def _label(repositories: Any, name: str, team_id: str = TEAM) -> str:
    """Seed one label on `team_id`, answering its id."""
    label_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=WORKSPACE,
            config_key=label_key(team_id, label_id),
            team_id=team_id,
            label_id=label_id,
            name=name,
            color="#ff0000",
        )
    )
    return label_id


def _history(repositories: Any, issue_id: str) -> "list[dict[str, Any]]":
    """The activity rows of one issue, newest first."""
    return [dict(item) for item in repositories.activity.list_for_issue(WORKSPACE, issue_id, limit=200).items]


def _applied(repositories: Any, issue_id: str) -> "list[str]":
    """The names of the rules recorded as applied on one issue, oldest first."""
    rows = [row for row in _history(repositories, issue_id) if row.get("field") == "triage_rule"]
    return [row["to_value"]["name"] for row in reversed(rows)]


@pytest.fixture
def team(repositories: Any, workspace: str) -> str:
    """`TEAM` with the owner as an explicit admin, so the owner's own issues land in triage."""
    add_team_member(repositories, workspace, TEAM, OWNER, "admin")
    return TEAM


def test_the_first_matching_rule_applies_and_stops(client: TestClient, team: str, repositories: Any) -> None:
    """Rules run in order, a non-matching rule is passed over, and a match ends the run."""
    _rules(
        repositories,
        _rule("Billing", text="invoice", priority="low"),
        _rule("Crashes", text="crash", priority="urgent"),
        _rule("Everything", priority="medium"),
    )
    sign_in(client, OWNER)

    filed = create_issue(client, WORKSPACE, title="App crash on launch")

    assert filed["in_triage"] is True
    assert filed["priority"] == "urgent"
    assert _applied(repositories, filed["id"]) == ["Crashes"]


def test_continue_runs_later_rules_too(client: TestClient, team: str, repositories: Any) -> None:
    """A rule that continues hands on to the next match, whose actions add to its own."""
    first, second = _label(repositories, "Bug"), _label(repositories, "Mobile")
    _rules(
        repositories,
        _rule("Bugs", text="crash", add_label_ids=[first], continue_after=True),
        _rule("Mobile", text="ios", add_label_ids=[second], assignee_id=MEMBER),
        _rule("Never", priority="low"),
    )
    sign_in(client, OWNER)

    filed = create_issue(client, WORKSPACE, title="iOS crash", body="Seen on iOS 26")

    assert sorted(filed["label_ids"]) == sorted([first, second])
    assert filed["assignee_id"] == MEMBER
    assert filed["priority"] == "none"
    assert _applied(repositories, filed["id"]) == ["Bugs", "Mobile"]


def test_every_filter_field_must_hold(client: TestClient, team: str, repositories: Any) -> None:
    """Labels, priority, creator, source and text are each a condition, all ANDed."""
    bug = _label(repositories, "Bug")
    _rules(
        repositories,
        _rule(
            "Narrow",
            label_ids=[bug],
            priorities=["high"],
            creator_ids=[OWNER],
            sources=["web"],
            text="login",
            assignee_id=MEMBER,
        ),
        _rule("Agents", sources=["mcp"], priority="low"),
    )
    sign_in(client, OWNER)

    matched = create_issue(client, WORKSPACE, title="Login fails", label_ids=[bug], priority="high")
    wrong_priority = create_issue(client, WORKSPACE, title="Login fails", label_ids=[bug], priority="low")
    no_label = create_issue(client, WORKSPACE, title="Login fails", priority="high")
    no_text = create_issue(client, WORKSPACE, title="Signup fails", label_ids=[bug], priority="high")

    assert matched["assignee_id"] == MEMBER
    for issue in (wrong_priority, no_label, no_text):
        assert issue["assignee_id"] is None
        assert _applied(repositories, issue["id"]) == []


def test_a_move_rule_sends_the_issue_to_the_other_team(client: TestClient, team: str, repositories: Any) -> None:
    """The issue takes the other team's next key, lands in its status there, and the move ends the run."""
    _rules(
        repositories,
        _rule("Infra", text="deploy", priority="high", team_id=OTHER_TEAM),
        _rule("Never", priority="low"),
    )
    sign_in(client, OWNER)

    filed = create_issue(client, WORKSPACE, title="Deploy is stuck")
    history = _history(repositories, filed["id"])

    assert filed["team_id"] == OTHER_TEAM
    assert filed["key"].startswith("XYZ-")
    assert filed["in_triage"] is False
    assert filed["priority"] == "high"
    moved = [row for row in history if row.get("field") == "team_id"]
    assert len(moved) == 1 and moved[0]["actor_kind"] == "system"
    assert _applied(repositories, filed["id"]) == ["Infra"]


def test_a_move_lands_in_the_targets_triage_without_running_its_rules(
    client: TestClient, team: str, repositories: Any
) -> None:
    """The issue waits in the other team's inbox, and that team's rules leave it alone."""
    _rules(repositories, _rule("Infra", team_id=OTHER_TEAM))
    _rules(repositories, _rule("Bounce back", team_id=TEAM), team_id=OTHER_TEAM)
    sign_in(client, OWNER)

    filed = create_issue(client, WORKSPACE, title="Anything")

    assert filed["team_id"] == OTHER_TEAM
    assert filed["in_triage"] is True
    assert _applied(repositories, filed["id"]) == ["Infra"]


def test_each_applied_rule_is_recorded_as_standupless(client: TestClient, team: str, repositories: Any) -> None:
    """The rule row names the rule and the change it made follows it, both by the system."""
    rule = _rule("Crashes", text="crash", priority="urgent")
    _rules(repositories, rule)
    sign_in(client, OWNER)

    filed = create_issue(client, WORKSPACE, title="Crash")
    rows = [row for row in _history(repositories, filed["id"]) if row["actor_kind"] == "system"]

    [named] = [row for row in rows if row.get("field") == "triage_rule"]
    assert named["to_value"] == {"id": rule.rule_id, "name": "Crashes"}
    assert named["actor_id"] == "system" and named["source"] == "system"
    [priority] = [row for row in rows if row.get("field") == "priority"]
    assert priority["from_value"] == "none" and priority["to_value"] == "urgent"


def test_disabled_and_broken_rules_are_skipped(client: TestClient, team: str, repositories: Any) -> None:
    """A switched-off rule and one whose label was deleted pass the issue on to the next rule."""
    _rules(
        repositories,
        _rule("Off", enabled=False, priority="low"),
        _rule("Broken", add_label_ids=["01JB0000000000000000GONE00"]),
        _rule("Working", priority="high"),
    )
    sign_in(client, OWNER)

    filed = create_issue(client, WORKSPACE, title="Anything")

    assert filed["priority"] == "high"
    assert _applied(repositories, filed["id"]) == ["Working"]


def test_rules_leave_issues_outside_triage_alone(
    client: TestClient, team: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """An issue filed straight into a status never runs the rules."""
    _rules(repositories, _rule("Everything", priority="urgent"))
    sign_in(client, OWNER)

    filed = create_issue(client, WORKSPACE, title="Anything", status_id=statuses["backlog"].status_id)

    assert filed["in_triage"] is False
    assert filed["priority"] == "none"


def test_an_issue_sent_back_to_triage_runs_the_rules(
    client: TestClient, team: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Moving an issue into triage by status runs the rules as filing it there does."""
    sign_in(client, OWNER)
    filed = create_issue(client, WORKSPACE, title="Anything", status_id=statuses["backlog"].status_id)
    _rules(repositories, _rule("Everything", priority="urgent"))

    response = client.patch(f"{BASE}/{filed['id']}", json={"status_id": "triage"})

    assert response.status_code == 200, response.text
    assert response.json()["in_triage"] is True
    assert response.json()["priority"] == "urgent"
    assert _applied(repositories, filed["id"]) == ["Everything"]


def test_an_issue_moved_into_a_team_in_triage_runs_its_rules(client: TestClient, team: str, repositories: Any) -> None:
    """A waiting issue moved by hand to another team runs that team's rules there."""
    _rules(repositories)
    sign_in(client, OWNER)
    filed = create_issue(client, WORKSPACE, title="Anything")
    _rules(repositories, _rule("Arrivals", priority="low"), team_id=OTHER_TEAM)

    response = client.post(f"{BASE}/{filed['id']}/move", json={"team_id": OTHER_TEAM})

    assert response.status_code == 200, response.text
    assert response.json()["team_id"] == OTHER_TEAM
    assert response.json()["priority"] == "low"
    assert _applied(repositories, filed["id"]) == ["Arrivals"]
