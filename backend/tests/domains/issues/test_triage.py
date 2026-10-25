"""A team's triage inbox, through the issue routes.

These pin who lands in triage, which with triage on is every new issue that
names no status, that a waiting issue stays off the list and the board until it
is worked, and that accept, decline, duplicate and snooze each move it out the
way the inbox promises.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.team_config import default_triage_settings
from app.common.db.dynamo.team_templates import IssueTemplate, template_key
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_team_member, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, WORKSPACE, create_issue

BASE = f"/api/workspaces/{WORKSPACE}/issues"

TRIAGE = f"{BASE}/triage"


def _enable(repositories: Any, team_id: str = TEAM) -> None:
    """Turn the team's triage inbox on straight in the table."""
    repositories.team_config.put_triage_settings(
        default_triage_settings(WORKSPACE, team_id).model_copy(update={"enabled": True})
    )


@pytest.fixture
def triage(repositories: Any, workspace: str) -> str:
    """`TEAM` with triage on and the owner as its one explicit member."""
    _enable(repositories)
    add_team_member(repositories, workspace, TEAM, OWNER, "admin")
    return TEAM


def _waiting(client: TestClient, **params: Any) -> "list[str]":
    """The ids the team's triage inbox answers, in order."""
    response = client.get(TRIAGE, params={"team_id": TEAM, **params})
    assert response.status_code == 200, response.text
    return [row["id"] for row in response.json()["issues"]]


def _listed(client: TestClient, **params: Any) -> "set[str]":
    """The ids the ordinary issue list answers."""
    response = client.get(BASE, params={"team_id": TEAM, **params})
    assert response.status_code == 200, response.text
    return {row["id"] for row in response.json()["issues"]}


def _triage_rows(repositories: Any, issue_id: str) -> "list[tuple[str, Any]]":
    """The triage history rows of one issue, as (field, to_value)."""
    rows = repositories.activity.list_for_issue(WORKSPACE, issue_id, limit=50).items
    return [
        (str(row["field"]), row.get("to_value"))
        for row in rows
        if row.get("kind") == "field_changed" and str(row.get("field", "")).startswith("triage")
    ]


def test_nothing_lands_in_triage_while_it_is_off(client: TestClient, workspace: str) -> None:
    """Triage is off by default, so every issue goes straight to the team."""
    sign_in(client, GUEST)
    issue = create_issue(client, workspace)

    assert issue["in_triage"] is False


def test_guests_and_people_outside_the_team_land_in_triage(client: TestClient, triage: str) -> None:
    """A guest and a workspace member outside the team both file into the inbox."""
    sign_in(client, GUEST)
    from_guest = create_issue(client, WORKSPACE, title="From a guest")
    sign_in(client, MEMBER)
    from_member = create_issue(client, WORKSPACE, title="From outside")

    assert from_guest["in_triage"] is True
    assert from_member["in_triage"] is True
    sign_in(client, OWNER)
    assert _waiting(client) == [from_member["id"], from_guest["id"]]


def test_a_team_members_issue_with_no_status_lands_in_triage(client: TestClient, triage: str) -> None:
    """An explicit member's new issue waits in the inbox when it names no status."""
    sign_in(client, OWNER)
    filed = create_issue(client, WORKSPACE, title="Filed")
    asked = create_issue(client, WORKSPACE, title="Asked", triage=True)

    assert filed["in_triage"] is True
    assert asked["in_triage"] is True
    assert set(_waiting(client)) == {filed["id"], asked["id"]}


def test_a_named_status_skips_triage_for_a_member(client: TestClient, triage: str, statuses: "dict[str, Any]") -> None:
    """A member who names a real status files straight into it."""
    sign_in(client, OWNER)
    direct = create_issue(client, WORKSPACE, status_id=statuses["started"].status_id)

    assert direct["in_triage"] is False
    assert direct["status_id"] == statuses["started"].status_id


def test_a_named_status_does_not_let_a_guest_skip_triage(
    client: TestClient, triage: str, statuses: "dict[str, Any]"
) -> None:
    """A guest's issue waits in the inbox whatever status it names."""
    sign_in(client, GUEST)
    filed = create_issue(client, WORKSPACE, status_id=statuses["started"].status_id)

    assert filed["in_triage"] is True


def test_a_members_sub_issue_skips_triage(client: TestClient, triage: str, statuses: "dict[str, Any]") -> None:
    """A sub-issue from a member keeps filing straight in, and may still ask for triage."""
    sign_in(client, OWNER)
    parent = create_issue(client, WORKSPACE, status_id=statuses["started"].status_id)
    child = create_issue(client, WORKSPACE, title="Child", parent_id=parent["id"])
    asked = create_issue(client, WORKSPACE, title="Asked", parent_id=parent["id"], triage=True)

    assert child["in_triage"] is False
    assert asked["in_triage"] is True


def _template(repositories: Any, template_id: str, name: str, status_id: "str | None" = None) -> None:
    """Store one team template straight in the table."""
    repositories.team_config.create_template(
        IssueTemplate(
            workspace_id=WORKSPACE,
            config_key=template_key(TEAM, template_id),
            template_id=template_id,
            team_id=TEAM,
            name=name,
            title=name,
            status_id=status_id,
        )
    )


def test_a_template_without_a_status_lands_in_triage(
    client: TestClient, triage: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A template that sets no status leaves a member's issue in triage, and one that sets a status files into it."""
    _template(repositories, "01JB000000000000000000BARE", "Bare")
    _template(repositories, "01JB00000000000000000PLACE", "Placed", statuses["started"].status_id)
    sign_in(client, OWNER)

    from_bare = create_issue(client, WORKSPACE, title="", template_id="01JB000000000000000000BARE")
    from_placed = create_issue(client, WORKSPACE, title="", template_id="01JB00000000000000000PLACE")

    assert from_bare["in_triage"] is True
    assert from_placed["in_triage"] is False
    assert from_placed["status_id"] == statuses["started"].status_id


def test_a_waiting_issue_is_off_the_list_and_the_board(
    client: TestClient, triage: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """The list leaves it out unless asked, and no status column holds it."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)
    kept = create_issue(client, WORKSPACE, status_id=statuses["backlog"].status_id)

    assert _listed(client) == {kept["id"]}
    assert _listed(client, include_triage="true") == {kept["id"], waiting["id"]}
    assert _listed(client, triage_only="true") == {waiting["id"]}
    column = repositories.issues.list_for_status(WORKSPACE, TEAM, waiting["status_id"])
    assert waiting["id"] not in {str(item["issue_id"]) for item in column.items}


def test_accept_moves_it_to_the_first_unstarted_status(
    client: TestClient, triage: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Accepting with no status picks the team's first unstarted one and records the outcome."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    response = client.post(f"{BASE}/{waiting['id']}/triage/accept")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["in_triage"] is False
    assert body["status_id"] == statuses["unstarted"].status_id
    assert _waiting(client) == []
    assert waiting["id"] in _listed(client)
    assert ("triage", "accepted") in _triage_rows(repositories, waiting["id"])
    column = repositories.issues.list_for_status(WORKSPACE, TEAM, body["status_id"])
    assert waiting["id"] in {str(item["issue_id"]) for item in column.items}


def test_accept_takes_a_named_status(client: TestClient, triage: str, statuses: "dict[str, Any]") -> None:
    """A named status wins over the default."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    response = client.post(f"{BASE}/{waiting['id']}/triage/accept", json={"status_id": statuses["started"].status_id})

    assert response.json()["status_id"] == statuses["started"].status_id


def _comments(repositories: Any, issue_id: str) -> "list[Any]":
    """The comments stored on one issue, oldest first."""
    return list(repositories.comments.iter_for_issue(WORKSPACE, issue_id))


def test_accept_posts_its_comment_as_the_person_accepting(
    client: TestClient, triage: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A comment on the accept lands in the thread by the acting user, and the history still shows the accept."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    response = client.post(
        f"{BASE}/{waiting['id']}/triage/accept",
        json={"status_id": statuses["started"].status_id, "comment": "Taking this one this cycle"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["status_id"] == statuses["started"].status_id
    comments = _comments(repositories, waiting["id"])
    assert [(comment.author_id, comment.body) for comment in comments] == [(OWNER, "Taking this one this cycle")]
    assert ("triage", "accepted") in _triage_rows(repositories, waiting["id"])
    subscribers = {row.user_id for row in repositories.subscriptions.list_for_issue(WORKSPACE, waiting["id"])}
    assert OWNER in subscribers


def test_accept_with_a_blank_comment_posts_nothing(client: TestClient, triage: str, repositories: Any) -> None:
    """Whitespace is no comment, so the accept goes through with an empty thread."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    response = client.post(f"{BASE}/{waiting['id']}/triage/accept", json={"comment": "   "})

    assert response.status_code == 200, response.text
    assert _comments(repositories, waiting["id"]) == []


def test_accept_refuses_an_oversized_comment_and_leaves_the_issue_waiting(
    client: TestClient, triage: str, repositories: Any
) -> None:
    """The comment is held to the comment cap before anything is written."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    response = client.post(f"{BASE}/{waiting['id']}/triage/accept", json={"comment": "x" * (ISSUE_BODY_MAX_BYTES + 1)})

    assert response.status_code == 422
    assert _waiting(client) == [waiting["id"]]
    assert _comments(repositories, waiting["id"]) == []


def test_decline_cancels_and_keeps_the_reason(
    client: TestClient, triage: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Declining moves it to the cancelled status with the reason in its history."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    response = client.post(f"{BASE}/{waiting['id']}/triage/decline", json={"reason": "Out of scope"})

    assert response.status_code == 200, response.text
    assert response.json()["status_id"] == statuses["cancelled"].status_id
    rows = _triage_rows(repositories, waiting["id"])
    assert ("triage", "declined") in rows
    assert ("triage_reason", "Out of scope") in rows


def test_duplicate_links_and_closes_it(
    client: TestClient, triage: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Marking as duplicate links the two and closes the waiting one."""
    sign_in(client, OWNER)
    original = create_issue(client, WORKSPACE, title="Original", status_id=statuses["backlog"].status_id)
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE, title="Again")
    sign_in(client, OWNER)

    response = client.post(f"{BASE}/{waiting['id']}/triage/duplicate", json={"duplicate_of_id": original["id"]})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["in_triage"] is False
    assert body["status_id"] == statuses["cancelled"].status_id
    links = client.get(f"{BASE}/{waiting['id']}/links").json()
    assert any(row["target_issue_id"] == original["id"] for row in links["links"])
    assert ("triage", "duplicate") in _triage_rows(repositories, waiting["id"])


def test_duplicate_refuses_itself_and_an_unknown_target(client: TestClient, triage: str) -> None:
    """A bad target leaves the issue waiting."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    itself = client.post(f"{BASE}/{waiting['id']}/triage/duplicate", json={"duplicate_of_id": waiting["id"]})
    unknown = client.post(f"{BASE}/{waiting['id']}/triage/duplicate", json={"duplicate_of_id": "01JB0000000000000NOPE"})

    assert itself.status_code == 422
    assert unknown.status_code == 404
    assert _waiting(client) == [waiting["id"]]


def test_snooze_hides_it_until_its_time(client: TestClient, triage: str, repositories: Any) -> None:
    """A snoozed issue leaves the inbox and the count, and returns once its time passes."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)
    until = (utc_now() + timedelta(days=1)).isoformat()

    response = client.post(f"{BASE}/{waiting['id']}/triage/snooze", json={"until": until})

    assert response.status_code == 200, response.text
    assert response.json()["snoozed_until"] is not None
    assert _waiting(client) == []
    assert _waiting(client, snoozed="true") == [waiting["id"]]
    summary = client.get(f"{TRIAGE}/summary").json()
    assert summary == {"teams": [{"team_id": TEAM, "count": 0}]}

    stored = repositories.issues.get(WORKSPACE, waiting["id"])
    repositories.issues.replace(stored.model_copy(update={"snoozed_until": utc_now() - timedelta(minutes=1)}))
    assert _waiting(client) == [waiting["id"]]


def test_snooze_holds_its_bounds_and_null_unsnoozes(client: TestClient, triage: str) -> None:
    """Past and far-off moments are refused, and null brings the issue back."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)
    url = f"{BASE}/{waiting['id']}/triage/snooze"

    assert client.post(url, json={"until": (utc_now() - timedelta(hours=1)).isoformat()}).status_code == 422
    assert client.post(url, json={"until": (utc_now() + timedelta(days=91)).isoformat()}).status_code == 422
    client.post(url, json={"until": (utc_now() + timedelta(hours=2)).isoformat()})
    back = client.post(url, json={"until": None})

    assert back.json()["snoozed_until"] is None
    assert _waiting(client) == [waiting["id"]]


def _snoozed(client: TestClient, repositories: Any) -> str:
    """A member's waiting issue snoozed for a day by the owner, with the admin on the team."""
    add_team_member(repositories, WORKSPACE, TEAM, ADMIN, "member")
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)
    until = (utc_now() + timedelta(days=1)).isoformat()
    response = client.post(f"{BASE}/{waiting['id']}/triage/snooze", json={"until": until})
    assert response.status_code == 200, response.text
    return str(waiting["id"])


def _comment(client: TestClient, issue_id: str, body: str = "Any news?") -> "dict[str, Any]":
    """Post one comment on an issue as the signed in user."""
    response = client.post(f"{BASE}/{issue_id}/comments", json={"body": body})
    assert response.status_code == 201, response.text
    return dict(response.json())


def test_snooze_keeps_who_snoozed_it(client: TestClient, triage: str, repositories: Any) -> None:
    """The snoozer is kept with the snooze and cleared with it."""
    issue_id = _snoozed(client, repositories)

    assert repositories.issues.get(WORKSPACE, issue_id).snoozed_by == OWNER
    client.post(f"{BASE}/{issue_id}/triage/snooze", json={"until": None})
    assert repositories.issues.get(WORKSPACE, issue_id).snoozed_by is None


def test_someone_elses_comment_wakes_a_snoozed_issue(client: TestClient, triage: str, repositories: Any) -> None:
    """Another member's comment brings the issue back at once, with no history and no new `updated_at`."""
    issue_id = _snoozed(client, repositories)
    before = repositories.issues.get(WORKSPACE, issue_id)
    history = len(repositories.activity.list_for_issue(WORKSPACE, issue_id, limit=50).items)

    sign_in(client, ADMIN)
    _comment(client, issue_id)

    after = repositories.issues.get(WORKSPACE, issue_id)
    assert after.snoozed_until is None
    assert after.snoozed_by is None
    assert after.in_triage is True
    assert after.updated_at == before.updated_at
    assert len(repositories.activity.list_for_issue(WORKSPACE, issue_id, limit=50).items) == history
    sign_in(client, OWNER)
    assert _waiting(client) == [issue_id]
    assert _waiting(client, snoozed="true") == []


def test_the_snoozers_own_comment_keeps_it_snoozed(client: TestClient, triage: str, repositories: Any) -> None:
    """A comment from the person who snoozed the issue is not new activity from someone else."""
    issue_id = _snoozed(client, repositories)

    _comment(client, issue_id)

    assert repositories.issues.get(WORKSPACE, issue_id).snoozed_until is not None
    assert _waiting(client) == []
    assert _waiting(client, snoozed="true") == [issue_id]


def test_editing_a_comment_does_not_wake_it(client: TestClient, triage: str, repositories: Any) -> None:
    """Only a new comment wakes the issue, not an edit to one written before the snooze."""
    add_team_member(repositories, WORKSPACE, TEAM, ADMIN, "member")
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, ADMIN)
    written = _comment(client, waiting["id"])
    sign_in(client, OWNER)
    until = (utc_now() + timedelta(days=1)).isoformat()
    client.post(f"{BASE}/{waiting['id']}/triage/snooze", json={"until": until})

    sign_in(client, ADMIN)
    edited = client.patch(
        f"/api/workspaces/{WORKSPACE}/comments/{written['comment_id']}",
        json={"issue_id": waiting["id"], "body": "Edited"},
    )

    assert edited.status_code == 200, edited.text
    assert repositories.issues.get(WORKSPACE, waiting["id"]).snoozed_until is not None


def test_a_comment_on_an_issue_not_snoozed_changes_nothing(client: TestClient, triage: str, repositories: Any) -> None:
    """A waiting issue with no snooze is left exactly as it was."""
    add_team_member(repositories, WORKSPACE, TEAM, ADMIN, "member")
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    before = repositories.issues.get(WORKSPACE, waiting["id"])

    sign_in(client, ADMIN)
    _comment(client, waiting["id"])

    after = repositories.issues.get(WORKSPACE, waiting["id"])
    assert after.snoozed_until is None
    assert after.read_revision() == before.read_revision()


def test_a_comment_on_an_issue_out_of_triage_changes_nothing(
    client: TestClient, triage: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A stray snooze stamp on an issue outside triage is not touched by a comment."""
    add_team_member(repositories, WORKSPACE, TEAM, ADMIN, "member")
    sign_in(client, OWNER)
    direct = create_issue(client, WORKSPACE, status_id=statuses["started"].status_id)
    stored = repositories.issues.get(WORKSPACE, direct["id"])
    until = utc_now() + timedelta(days=1)
    stamped = repositories.issues.replace(stored.model_copy(update={"snoozed_until": until, "snoozed_by": OWNER}))

    sign_in(client, ADMIN)
    _comment(client, direct["id"])

    after = repositories.issues.get(WORKSPACE, direct["id"])
    assert after.in_triage is False
    assert after.snoozed_until is not None
    assert after.read_revision() == stamped.read_revision()


def test_a_status_change_accepts_it(client: TestClient, triage: str, statuses: "dict[str, Any]") -> None:
    """Moving a waiting issue by an ordinary edit takes it out of triage too."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    response = client.patch(f"{BASE}/{waiting['id']}", json={"status_id": statuses["started"].status_id})

    assert response.json()["in_triage"] is False
    assert _waiting(client) == []


def test_guests_cannot_work_triage(client: TestClient, triage: str, statuses: "dict[str, Any]") -> None:
    """A guest who filed an issue cannot accept it, by the action or by a status change."""
    sign_in(client, GUEST)
    waiting = create_issue(client, WORKSPACE)

    assert client.post(f"{BASE}/{waiting['id']}/triage/accept").status_code == 403
    moved = client.patch(f"{BASE}/{waiting['id']}", json={"status_id": statuses["started"].status_id})
    assert moved.json()["in_triage"] is True


def test_an_issue_not_in_triage_is_refused(client: TestClient, triage: str, statuses: "dict[str, Any]") -> None:
    """The actions only work issues still waiting."""
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE, status_id=statuses["backlog"].status_id)

    assert client.post(f"{BASE}/{issue['id']}/triage/accept").status_code == 422


def test_the_summary_counts_only_teams_with_triage_on(client: TestClient, triage: str, repositories: Any) -> None:
    """A team without triage is left out, and each count is that team's waiting issues."""
    sign_in(client, MEMBER)
    create_issue(client, WORKSPACE)
    create_issue(client, WORKSPACE)
    create_issue(client, WORKSPACE, team_id=OTHER_TEAM)

    summary = client.get(f"{TRIAGE}/summary").json()

    assert summary == {"teams": [{"team_id": TEAM, "count": 2}]}


def test_a_guest_cannot_read_another_teams_inbox(client: TestClient, triage: str, repositories: Any) -> None:
    """The inbox is as hidden as its team, and so is its count."""
    _enable(repositories, OTHER_TEAM)
    sign_in(client, GUEST)

    assert client.get(TRIAGE, params={"team_id": OTHER_TEAM}).status_code == 404
    assert [row["team_id"] for row in client.get(f"{TRIAGE}/summary").json()["teams"]] == [TEAM]


def test_archiving_and_restoring_keeps_it_in_triage(client: TestClient, triage: str) -> None:
    """A restored waiting issue returns to the inbox, not the board."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, ADMIN)
    client.post(f"{BASE}/{waiting['id']}/archive")
    assert _waiting(client) == []

    client.post(f"{BASE}/{waiting['id']}/unarchive")

    assert _waiting(client) == [waiting["id"]]
