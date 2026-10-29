"""Status update draft routes: one unposted update per member per project and per initiative.

The properties held here are that a draft is its author's alone, that saving
again replaces the target's draft and keeps when it was first saved, that a
draft is held to what posting the update would need, that the listing drops
drafts on targets that are hidden or gone, and that posting an update clears
the draft it came from but never one saved after it.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from webbpulse.dynamodb import table_name

from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import (
    Initiative,
    Project,
    initiative_key,
    initiative_update_key,
    project_key,
    project_update_key,
)
from app.common.db.dynamo.views import UpdateDraft, update_draft_key
from app.domains.views.consumers.notify import clear_update_draft, handle_record
from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM
from tests.domains.views.test_notify_consumer import _image, _record, inbox_of

PLANNING_ARN = (
    f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('planning', settings.dynamodb_table_prefix)}/stream/x"
)

PROJECT_ID = "01JB000000000000000000PRJD"

AWAY_PROJECT_ID = "01JB000000000000000000PRJA"

INITIATIVE_ID = "01JB000000000000000000INID"

UPDATE_ID = "01JB00000000000000000UPDD1"


@pytest.fixture
def targets(repositories: Any, workspace: str) -> None:
    """A project on the team the guest is on, one on the team they are outside, and an initiative."""
    for project_id, team_id, name in ((PROJECT_ID, TEAM, "Launch"), (AWAY_PROJECT_ID, OTHER_TEAM, "Away")):
        repositories.planning.create_project(
            Project(
                workspace_id=workspace,
                planning_key=project_key(project_id),
                project_id=project_id,
                team_ids=[team_id],
                name=name,
                created_by=OWNER,
            )
        )
    repositories.planning.create_initiative(
        Initiative(
            workspace_id=workspace,
            planning_key=initiative_key(INITIATIVE_ID),
            initiative_id=INITIATIVE_ID,
            name="Grow",
            owner_id=OWNER,
            created_by=OWNER,
        )
    )


def path(workspace: str, kind: str | None = None, target_id: str | None = None) -> str:
    """The update drafts listing, or one project's or initiative's draft route."""
    base = f"/api/workspaces/{workspace}/drafts/updates"
    return base if kind is None else f"{base}/{kind}/{target_id}"


def save(client: TestClient, workspace: str, kind: str, target_id: str, body: str, health: str | None = None) -> Any:
    """Save a status update draft through the route."""
    return client.put(path(workspace, kind, target_id), json={"body": body, "health": health})


def listed(client: TestClient, workspace: str) -> "list[dict[str, Any]]":
    """The caller's update drafts listing, failing loudly on a refusal."""
    response = client.get(path(workspace))
    assert response.status_code == 200, response.text
    return response.json()["drafts"]


def test_a_project_draft_is_saved_read_and_replaced(client: TestClient, workspace: str, targets: None) -> None:
    """Saving twice keeps one draft holding the latest body and health and the first save's time."""
    sign_in(client, MEMBER)

    first = save(client, workspace, "projects", PROJECT_ID, "Half a", "at_risk")
    second = save(client, workspace, "projects", PROJECT_ID, "Half a thought", "off_track")
    read = client.get(path(workspace, "projects", PROJECT_ID))

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert read.status_code == 200, read.text
    body = read.json()
    assert body["target_kind"] == "project"
    assert body["project_id"] == PROJECT_ID
    assert body["initiative_id"] is None
    assert body["target_name"] == "Launch"
    assert (body["body"], body["health"]) == ("Half a thought", "off_track")
    assert body["created_at"] == first.json()["created_at"]
    assert [row["body"] for row in listed(client, workspace)] == ["Half a thought"]


def test_an_initiative_draft_sits_apart_from_a_projects(client: TestClient, workspace: str, targets: None) -> None:
    """An initiative's draft is its own, may leave health unpicked, and discards apart from a project's."""
    sign_in(client, MEMBER)
    save(client, workspace, "projects", PROJECT_ID, "Project draft")

    saved = save(client, workspace, "initiatives", INITIATIVE_ID, "Initiative draft")
    gone = client.delete(path(workspace, "initiatives", INITIATIVE_ID))

    assert saved.status_code == 200, saved.text
    assert (saved.json()["initiative_id"], saved.json()["health"]) == (INITIATIVE_ID, None)
    assert gone.status_code == 204
    assert client.get(path(workspace, "initiatives", INITIATIVE_ID)).status_code == 404
    assert [row["body"] for row in listed(client, workspace)] == ["Project draft"]


def test_drafts_are_the_callers_own(client: TestClient, workspace: str, targets: None) -> None:
    """Another member reads no draft, lists none and cannot clear the first one's."""
    sign_in(client, MEMBER)
    save(client, workspace, "projects", PROJECT_ID, "Mine")
    save(client, workspace, "initiatives", INITIATIVE_ID, "Mine too")

    sign_in(client, OWNER)
    missing = client.get(path(workspace, "projects", PROJECT_ID))
    client.delete(path(workspace, "projects", PROJECT_ID))
    client.delete(path(workspace, "initiatives", INITIATIVE_ID))

    assert missing.status_code == 404
    assert listed(client, workspace) == []
    sign_in(client, MEMBER)
    assert sorted(row["body"] for row in listed(client, workspace)) == ["Mine", "Mine too"]


def test_a_blank_draft_or_unknown_health_is_refused(client: TestClient, workspace: str, targets: None) -> None:
    """A blank body is a discard, and a health no update takes is refused."""
    sign_in(client, MEMBER)

    blank = save(client, workspace, "projects", PROJECT_ID, "   ")
    health = save(client, workspace, "projects", PROJECT_ID, "Fine", "great")

    assert (blank.status_code, health.status_code) == (422, 422)


def test_a_guest_cannot_draft_where_they_cannot_post(client: TestClient, workspace: str, targets: None) -> None:
    """A guest is refused a project on a team they are outside, and every initiative."""
    sign_in(client, GUEST)

    hidden = save(client, workspace, "projects", AWAY_PROJECT_ID, "Sneaky")
    initiative = save(client, workspace, "initiatives", INITIATIVE_ID, "Sneaky")
    own = save(client, workspace, "projects", PROJECT_ID, "On my team")

    assert hidden.status_code == 404
    assert initiative.status_code == 403
    assert own.status_code == 200, own.text


def test_a_draft_on_a_hidden_or_gone_target_drops_out(
    client: TestClient, workspace: str, targets: None, repositories: Any
) -> None:
    """A draft on a target that went private stays stored, and one on a deleted target is deleted."""
    now = utc_now()
    for kind, target_id in (("project", AWAY_PROJECT_ID), ("project", "01JB000000000000000000GONE")):
        repositories.views.put_update_draft(
            UpdateDraft(
                workspace_id=workspace,
                view_key=update_draft_key(GUEST, kind, target_id),
                user_id=GUEST,
                target_kind="project",
                target_id=target_id,
                body="Stale",
                created_at=now,
                updated_at=now,
            )
        )
    sign_in(client, GUEST)

    assert listed(client, workspace) == []
    assert repositories.views.get_update_draft(workspace, GUEST, "project", AWAY_PROJECT_ID) is not None
    assert repositories.views.get_update_draft(workspace, GUEST, "project", "01JB000000000000000000GONE") is None


def test_deleting_twice_is_not_an_error(client: TestClient, workspace: str, targets: None) -> None:
    """Discarding is idempotent, so a composer clearing twice is harmless."""
    sign_in(client, MEMBER)
    save(client, workspace, "projects", PROJECT_ID, "Gone soon")

    first = client.delete(path(workspace, "projects", PROJECT_ID))
    second = client.delete(path(workspace, "projects", PROJECT_ID))

    assert (first.status_code, second.status_code) == (204, 204)


def _posted(workspace: str, kind: str, author: str, posted_at: str, **fields: Any) -> "dict[str, Any]":
    """A planning stream record for a project or initiative update just posted."""
    if kind == "project_update":
        target = {"project_id": PROJECT_ID, "planning_key": project_update_key(PROJECT_ID, UPDATE_ID)}
    else:
        target = {"initiative_id": INITIATIVE_ID, "planning_key": initiative_update_key(INITIATIVE_ID, UPDATE_ID)}
    return _record(
        PLANNING_ARN,
        "INSERT",
        new=_image(
            workspace_id=workspace,
            kind=kind,
            update_id=UPDATE_ID,
            author_id=author,
            health="on_track",
            body="Posted",
            created_at=posted_at,
            **target,
            **fields,
        ),
    )


def test_posting_a_project_update_clears_the_draft_it_came_from(
    client: TestClient, workspace: str, targets: None, repositories: Any
) -> None:
    """The update's record clears its author's draft on that project, and notifies nobody of the draft."""
    sign_in(client, MEMBER)
    save(client, workspace, "projects", PROJECT_ID, "About to post")
    sign_in(client, OWNER)
    save(client, workspace, "projects", PROJECT_ID, "Owner draft")

    handle_record(
        repositories,
        _posted(workspace, "project_update", MEMBER, (utc_now() + timedelta(seconds=5)).isoformat()),
    )

    assert repositories.views.get_update_draft(workspace, MEMBER, "project", PROJECT_ID) is None
    assert repositories.views.get_update_draft(workspace, OWNER, "project", PROJECT_ID) is not None
    assert inbox_of(repositories, workspace, OWNER) == []


def test_posting_an_initiative_update_clears_the_draft_it_came_from(
    client: TestClient, workspace: str, targets: None, repositories: Any
) -> None:
    """An initiative update's record clears its author's draft on that initiative."""
    sign_in(client, MEMBER)
    save(client, workspace, "initiatives", INITIATIVE_ID, "About to post")

    handle_record(
        repositories,
        _posted(workspace, "initiative_update", MEMBER, (utc_now() + timedelta(seconds=5)).isoformat()),
    )

    assert repositories.views.get_update_draft(workspace, MEMBER, "initiative", INITIATIVE_ID) is None


def test_a_draft_saved_after_the_post_survives(
    client: TestClient, workspace: str, targets: None, repositories: Any
) -> None:
    """Starting the next update before the post's record lands loses nothing."""
    sign_in(client, MEMBER)
    save(client, workspace, "projects", PROJECT_ID, "The next update")

    cleared = clear_update_draft(
        repositories,
        _posted(workspace, "project_update", MEMBER, (utc_now() - timedelta(minutes=1)).isoformat()),
    )

    assert cleared is False
    assert repositories.views.get_update_draft(workspace, MEMBER, "project", PROJECT_ID) is not None


def test_a_bulk_import_clears_nothing(client: TestClient, workspace: str, targets: None, repositories: Any) -> None:
    """Imported updates are history, not posts, so they never touch a draft."""
    sign_in(client, MEMBER)
    save(client, workspace, "projects", PROJECT_ID, "Keep me")

    cleared = clear_update_draft(
        repositories,
        _posted(
            workspace,
            "project_update",
            MEMBER,
            (utc_now() + timedelta(seconds=5)).isoformat(),
            import_batch_id="01JB00000000000000000BATCH",
        ),
    )

    assert cleared is False
    assert repositories.views.get_update_draft(workspace, MEMBER, "project", PROJECT_ID) is not None


def test_the_account_purge_removes_a_members_update_drafts(workspace: str, repositories: Any) -> None:
    """Every update draft of the person goes, and nobody else's."""
    for user_id, target_id in ((MEMBER, PROJECT_ID), (MEMBER, INITIATIVE_ID), (OWNER, PROJECT_ID)):
        kind = "initiative" if target_id == INITIATIVE_ID else "project"
        repositories.views.put_update_draft(
            UpdateDraft(
                workspace_id=workspace,
                view_key=update_draft_key(user_id, kind, target_id),
                user_id=user_id,
                target_kind=kind,
                target_id=target_id,
                body="Draft",
            )
        )

    removed = repositories.views.delete_update_drafts_for_user(workspace, MEMBER)

    assert removed == 2
    assert repositories.views.list_update_drafts(workspace, MEMBER) == []
    assert [row.target_id for row in repositories.views.list_update_drafts(workspace, OWNER)] == [PROJECT_ID]
