"""Form templates: an issue template whose questions an issue filed from it answers.

Saving a form holds its fields to their types and each option's label to the
team's labels. Filing from one holds the answers strictly, renders them into the
body ahead of any description, maps a chosen option onto labels and priority,
and sends the issue to the team's triage.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import OWNER, add_member, add_team_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000TEM1"

TEAM_ADMIN = "01JB00000000000000000TADMN"

WRITER = "01JB00000000000000000WRITR"

BASE = f"/api/workspaces/{WORKSPACE}"

TEMPLATES = f"{BASE}/teams/{TEAM}/templates"


def _client(repositories: Any, domain: str) -> Iterator[TestClient]:
    """A client for one domain's application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS[domain])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def teams(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, where templates are kept."""
    yield from _client(repositories, "teams")


@pytest.fixture
def issues(repositories: Any) -> Iterator[TestClient]:
    """A client for the issues application, where forms are filed."""
    yield from _client(repositories, "issues")


@pytest.fixture
def workspace(repositories: Any) -> str:
    """One team with an admin and a writer on a plan that offers triage."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    for user in (TEAM_ADMIN, WRITER):
        add_member(repositories, WORKSPACE, user, "member")
    make_team(repositories, WORKSPACE, TEAM, "ENG")
    add_team_member(repositories, WORKSPACE, TEAM, TEAM_ADMIN, "admin")
    add_team_member(repositories, WORKSPACE, TEAM, WRITER, "member")
    return WORKSPACE


def _label(teams: TestClient, name: str) -> str:
    """Create one label on the team as its admin and answer its id."""
    sign_in(teams, TEAM_ADMIN)
    response = teams.post(f"{BASE}/teams/{TEAM}/labels", json={"name": name, "color": "#5e6ad2"})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _triage_on(teams: TestClient) -> None:
    """Switch the team's triage inbox on as its admin."""
    sign_in(teams, TEAM_ADMIN)
    response = teams.patch(f"{BASE}/teams/{TEAM}/triage-settings", json={"enabled": True})
    assert response.status_code == 200, response.text


def _form(teams: TestClient, **extra: Any) -> dict[str, Any]:
    """Save a bug report form on the team as the writer and answer it."""
    body: dict[str, Any] = {
        "name": "Bug report",
        "title": "Bug: ",
        "form_fields": [
            {"label": "What happened?", "type": "long_text", "required": True},
            {"key": "browser", "label": "Browser", "type": "short_text"},
            {
                "key": "severity",
                "label": "Severity",
                "type": "select",
                "required": True,
                "options": [{"value": "Blocker", "priority": "urgent"}, {"value": "Minor", "priority": "low"}],
            },
            {"key": "repro", "label": "Can you reproduce it?", "type": "checkbox"},
        ],
    }
    body.update(extra)
    sign_in(teams, WRITER)
    response = teams.post(TEMPLATES, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_a_form_is_saved_with_keys_and_listed_with_its_fields(teams: TestClient, workspace: str) -> None:
    """A field without a key is given one, and the list carries every field."""
    saved = _form(teams)

    listed = teams.get(TEMPLATES).json()["templates"]

    assert [field["key"] for field in saved["form_fields"]] == ["f1", "browser", "severity", "repro"]
    assert saved["form_fields"][2]["options"][0] == {"value": "Blocker", "label_id": None, "priority": "urgent"}
    assert listed[0]["form_fields"] == saved["form_fields"]


def test_a_form_field_is_held_to_its_type(teams: TestClient, workspace: str) -> None:
    """A select needs distinct options, other types take none, keys are distinct and labels must exist."""
    sign_in(teams, WRITER)
    cases = [
        [{"label": "Pick", "type": "select"}],
        [{"label": "Pick", "type": "select", "options": [{"value": "A"}, {"value": "a"}]}],
        [{"label": "Text", "options": [{"value": "A"}]}],
        [{"key": "x", "label": "One"}, {"key": "x", "label": "Two"}],
        [{"label": "Pick", "type": "select", "options": [{"value": "A", "label_id": "01JB0000000000000000NOLABL"}]}],
    ]

    statuses = [teams.post(TEMPLATES, json={"name": "Bad", "form_fields": fields}).status_code for fields in cases]
    document = teams.post(
        TEMPLATES, json={"kind": "document", "name": "Doc", "form_fields": [{"label": "Question"}]}
    ).status_code

    assert statuses == [422] * len(cases)
    assert document == 422


def test_a_form_is_turned_off_by_clearing_its_fields(teams: TestClient, workspace: str) -> None:
    """A null form_fields clears the form and keeps the rest of the template."""
    saved = _form(teams)

    response = teams.patch(f"{TEMPLATES}/{saved['id']}", json={"form_fields": None})

    assert response.status_code == 200, response.text
    assert response.json()["form_fields"] == []
    assert response.json()["title"] == "Bug: "


def test_filing_a_form_renders_answers_maps_options_and_lands_in_triage(
    teams: TestClient, issues: TestClient, workspace: str
) -> None:
    """The answers lead the body, the chosen option sets labels and priority, and the issue waits in triage."""
    blocker = _label(teams, "Blocker")
    _triage_on(teams)
    saved = _form(teams)
    sign_in(teams, WRITER)
    fields = saved["form_fields"]
    fields[2]["options"][0]["label_id"] = blocker
    assert teams.patch(f"{TEMPLATES}/{saved['id']}", json={"form_fields": fields}).status_code == 200

    sign_in(issues, WRITER)
    response = issues.post(
        f"{BASE}/issues",
        json={
            "team_id": TEAM,
            "template_id": saved["id"],
            "title": "Bug: login loops",
            "body": "Seen twice today.",
            "form_answers": {"f1": "The login page reloads.", "severity": "blocker", "repro": True},
        },
    )

    assert response.status_code == 201, response.text
    issue = response.json()
    assert issue["body"] == (
        "**What happened?**\n\nThe login page reloads.\n\n**Browser**\n\n_No answer_\n\n"
        "**Severity**\n\nBlocker\n\n**Can you reproduce it?**\n\nYes\n\nSeen twice today."
    )
    assert issue["label_ids"] == [blocker]
    assert issue["priority"] == "urgent"
    assert issue["in_triage"] is True


def test_a_form_refuses_answers_it_cannot_take(teams: TestClient, issues: TestClient, workspace: str) -> None:
    """A missing required answer, an unknown key, a wrong type or option, and answers to a plain template."""
    saved = _form(teams)
    plain = teams.post(TEMPLATES, json={"name": "Plain", "title": "Plain"}).json()
    sign_in(issues, WRITER)
    good = {"f1": "Broken", "severity": "Minor"}
    cases = [
        ({"severity": "Minor"}, "What happened? is required"),
        ({**good, "nope": "x"}, "No such form field: nope"),
        ({**good, "severity": "Huge"}, "Huge is not an option of Severity"),
        ({**good, "repro": "yes"}, "Can you reproduce it? takes true or false"),
        ({**good, "browser": "one\ntwo"}, "Browser takes one line"),
    ]

    texts = []
    for answers, _ in cases:
        response = issues.post(
            f"{BASE}/issues", json={"team_id": TEAM, "template_id": saved["id"], "form_answers": answers}
        )
        assert response.status_code == 422, response.text
        texts.append(response.text)
    unanswered = issues.post(f"{BASE}/issues", json={"team_id": TEAM, "template_id": saved["id"]})
    wrong = issues.post(f"{BASE}/issues", json={"team_id": TEAM, "template_id": plain["id"], "form_answers": {}})
    bare = issues.post(f"{BASE}/issues", json={"team_id": TEAM, "title": "Bare", "form_answers": {}})

    for text, (_, expected) in zip(texts, cases):
        assert expected in text
    assert unanswered.status_code == 422
    assert wrong.status_code == 422
    assert "is not a form template" in wrong.text
    assert bare.status_code == 422


def test_a_form_files_normally_while_triage_is_off(teams: TestClient, issues: TestClient, workspace: str) -> None:
    """With the team's triage off the issue starts in the team's first status."""
    saved = _form(teams)
    sign_in(issues, WRITER)

    response = issues.post(
        f"{BASE}/issues",
        json={"team_id": TEAM, "template_id": saved["id"], "form_answers": {"f1": "Broken", "severity": "Minor"}},
    )

    assert response.status_code == 201, response.text
    assert response.json()["in_triage"] is False
    assert response.json()["priority"] == "low"
