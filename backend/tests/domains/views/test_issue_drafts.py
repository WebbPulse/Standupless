"""New issue draft routes: many unfiled issues per member per workspace.

The properties held here are that a draft keeps every create dialog field, that
saving again under an id replaces it and keeps when it was first saved, that a
draft is its author's alone, that an empty draft and a hidden team are refused,
that a member holds at most the cap, and that the purges take the drafts of a
team and of a person.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.views import ISSUE_DRAFTS_MAX, IssueDraft, issue_draft_key
from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM

DRAFT = "01JBDRAFT00000000000000001"


def drafts_path(workspace: str, draft_id: str | None = None) -> str:
    """The new issue drafts listing, or one draft's route."""
    base = f"/api/workspaces/{workspace}/drafts/new-issues"
    return base if draft_id is None else f"{base}/{draft_id}"


def listed(client: TestClient, workspace: str) -> "list[dict[str, Any]]":
    """The caller's new issue drafts, failing loudly on a refusal."""
    response = client.get(drafts_path(workspace))
    assert response.status_code == 200, response.text
    return response.json()["drafts"]


def full_draft() -> dict[str, Any]:
    """A draft holding every field the create dialog has."""
    return {
        "team_id": TEAM,
        "title": "Fix the login",
        "body": "Steps to reproduce",
        "template_id": "01JBTEMPLATE00000000000001",
        "template_title": "Bug: ",
        "template_body": "## Steps",
        "answers": {"severity": "high", "regression": True},
        "status_id": "01JBSTATUS0000000000000001",
        "priority": "high",
        "assignee_id": MEMBER,
        "label_ids": ["01JBLABEL00000000000000001", "01JBLABEL00000000000000001", "01JBLABEL00000000000000002"],
        "estimate": "M",
        "project_id": "01JBPROJECT000000000000001",
        "project_milestone_id": "01JBMILESTONE0000000000001",
        "cycle_id": "01JBCYCLE00000000000000001",
        "start_date": "2026-10-20",
        "due_date": "2026-11-01",
        "parent_id": "01JBISSUE00000000000000001",
        "parent_key": "ABC-1",
        "parent_title": "The parent",
        "sub_issues": ["First step", "  ", "Second step"],
    }


def seed_draft(repositories: Any, workspace: str, user_id: str, draft_id: str, team_id: str, **fields: Any) -> None:
    """Store a draft row directly."""
    now = fields.pop("updated_at", utc_now())
    repositories.views.put_issue_draft(
        IssueDraft(
            workspace_id=workspace,
            view_key=issue_draft_key(user_id, draft_id),
            user_id=user_id,
            draft_id=draft_id,
            team_id=team_id,
            title=fields.pop("title", "Draft"),
            created_at=now,
            updated_at=now,
            **fields,
        )
    )


def test_a_draft_keeps_every_field(client: TestClient, workspace: str) -> None:
    """Every field saved reads back, with repeated labels and blank sub-issues dropped."""
    sign_in(client, MEMBER)

    saved = client.put(drafts_path(workspace, DRAFT), json=full_draft())
    read = client.get(drafts_path(workspace, DRAFT))

    assert saved.status_code == 200, saved.text
    assert read.status_code == 200, read.text
    body = read.json()
    expected = full_draft()
    expected["label_ids"] = ["01JBLABEL00000000000000001", "01JBLABEL00000000000000002"]
    expected["sub_issues"] = ["First step", "Second step"]
    for field, value in expected.items():
        assert body[field] == value, field
    assert body["draft_id"] == DRAFT


def test_saving_again_replaces_the_draft_and_keeps_its_creation(client: TestClient, workspace: str) -> None:
    """A second save under one id is one draft holding the latest fields."""
    sign_in(client, MEMBER)

    first = client.put(drafts_path(workspace, DRAFT), json={"team_id": TEAM, "title": "Half a"})
    second = client.put(drafts_path(workspace, DRAFT), json={"team_id": TEAM, "title": "Half a thought"})

    assert second.status_code == 200, second.text
    assert second.json()["created_at"] == first.json()["created_at"]
    assert [row["title"] for row in listed(client, workspace)] == ["Half a thought"]


def test_posting_creates_a_draft_under_a_fresh_id(client: TestClient, workspace: str) -> None:
    """The create route names the draft itself."""
    sign_in(client, MEMBER)

    first = client.post(drafts_path(workspace), json={"team_id": TEAM, "title": "One"})
    second = client.post(drafts_path(workspace), json={"team_id": TEAM, "body": "Two"})

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["draft_id"] != second.json()["draft_id"]
    assert len(listed(client, workspace)) == 2


def test_the_listing_is_newest_saved_first(client: TestClient, workspace: str, repositories: Any) -> None:
    """Drafts list by when they were last saved, the newest first, with the cap."""
    now = utc_now()
    seed_draft(repositories, workspace, MEMBER, "OLD", TEAM, title="Old", updated_at=now - timedelta(days=2))
    seed_draft(repositories, workspace, MEMBER, "NEW", TEAM, title="New", updated_at=now)
    seed_draft(repositories, workspace, MEMBER, "MID", TEAM, title="Mid", updated_at=now - timedelta(days=1))
    sign_in(client, MEMBER)

    response = client.get(drafts_path(workspace))

    assert response.status_code == 200, response.text
    assert [row["title"] for row in response.json()["drafts"]] == ["New", "Mid", "Old"]
    assert response.json()["limit"] == ISSUE_DRAFTS_MAX


def test_drafts_are_the_callers_own(client: TestClient, workspace: str) -> None:
    """Another member reads no draft, lists none, cannot clear it, and saving its id makes their own."""
    sign_in(client, MEMBER)
    client.put(drafts_path(workspace, DRAFT), json={"team_id": TEAM, "title": "Mine"})

    sign_in(client, OWNER)
    missing = client.get(drafts_path(workspace, DRAFT))
    client.delete(drafts_path(workspace, DRAFT))
    client.put(drafts_path(workspace, DRAFT), json={"team_id": TEAM, "title": "Theirs"})

    assert missing.status_code == 404
    assert [row["title"] for row in listed(client, workspace)] == ["Theirs"]
    sign_in(client, MEMBER)
    assert [row["title"] for row in listed(client, workspace)] == ["Mine"]


def test_an_empty_draft_is_refused(client: TestClient, workspace: str) -> None:
    """A draft with nothing typed is a discard, which is the delete route's job."""
    sign_in(client, MEMBER)

    response = client.put(drafts_path(workspace, DRAFT), json={"team_id": TEAM, "title": "  ", "body": ""})

    assert response.status_code == 422


def test_a_bad_draft_id_is_refused(client: TestClient, workspace: str) -> None:
    """A draft id carries only letters, digits, hyphens and underscores."""
    sign_in(client, MEMBER)

    response = client.put(drafts_path(workspace, "bad.id"), json={"team_id": TEAM, "title": "x"})

    assert response.status_code == 422


def test_a_guest_cannot_draft_outside_their_team(client: TestClient, workspace: str, repositories: Any) -> None:
    """A team the guest is outside answers exactly as one that does not exist, and its drafts drop out."""
    seed_draft(repositories, workspace, GUEST, "HIDDEN", OTHER_TEAM, title="Hidden")
    sign_in(client, GUEST)

    saved = client.put(drafts_path(workspace, DRAFT), json={"team_id": OTHER_TEAM, "title": "Sneaky"})
    read = client.get(drafts_path(workspace, "HIDDEN"))

    assert saved.status_code == 404
    assert read.status_code == 404
    assert listed(client, workspace) == []


def test_the_cap_refuses_a_new_draft_but_not_an_edit(client: TestClient, workspace: str, repositories: Any) -> None:
    """At the cap a new draft answers 409 with a message, while an existing one still saves."""
    for index in range(ISSUE_DRAFTS_MAX):
        seed_draft(repositories, workspace, MEMBER, f"D{index:04d}", TEAM)
    sign_in(client, MEMBER)

    refused = client.post(drafts_path(workspace), json={"team_id": TEAM, "title": "One more"})
    edited = client.put(drafts_path(workspace, "D0000"), json={"team_id": TEAM, "title": "Edited"})

    assert refused.status_code == 409
    assert "Delete a draft" in refused.text
    assert edited.status_code == 200, edited.text


def test_deleting_twice_is_not_an_error(client: TestClient, workspace: str) -> None:
    """Discarding a draft that is gone is a no-op."""
    sign_in(client, MEMBER)
    client.put(drafts_path(workspace, DRAFT), json={"team_id": TEAM, "title": "Gone soon"})

    first = client.delete(drafts_path(workspace, DRAFT))
    second = client.delete(drafts_path(workspace, DRAFT))

    assert (first.status_code, second.status_code) == (204, 204)
    assert client.get(drafts_path(workspace, DRAFT)).status_code == 404


def test_the_comment_draft_listing_is_unaffected(client: TestClient, workspace: str) -> None:
    """New issue drafts never appear among comment drafts."""
    sign_in(client, MEMBER)
    client.put(drafts_path(workspace, DRAFT), json={"team_id": TEAM, "title": "New issue"})

    response = client.get(f"/api/workspaces/{workspace}/drafts")

    assert response.status_code == 200, response.text
    assert response.json()["drafts"] == []


def test_the_purges_remove_a_teams_and_a_members_drafts(workspace: str, repositories: Any) -> None:
    """A team purge takes every draft filed to it, an account purge every draft of the person."""
    seed_draft(repositories, workspace, MEMBER, "M1", TEAM)
    seed_draft(repositories, workspace, MEMBER, "M2", OTHER_TEAM)
    seed_draft(repositories, workspace, OWNER, "O1", TEAM)
    seed_draft(repositories, workspace, OWNER, "O2", OTHER_TEAM)

    by_team = repositories.views.delete_issue_drafts_for_team(workspace, TEAM)
    by_member = repositories.views.delete_issue_drafts_for_user(workspace, MEMBER)

    assert (by_team, by_member) == (2, 1)
    assert [row.draft_id for row in repositories.views.list_issue_drafts(workspace, OWNER)] == ["O2"]
