"""Comment drafts on document threads and on project and initiative update reply threads.

The properties held here are that each parent kind keeps one draft per member
per thread, held to what posting there would need, that a parent in another
workspace is never reached, that the listing filters by parent and names each
draft's kind, and that posting a comment on a document or a reply on an update
clears the draft it came from.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import (
    Initiative,
    InitiativeUpdateRow,
    ProjectUpdateRow,
    initiative_key,
    initiative_update_key,
    project_update_key,
)
from app.common.db.dynamo.update_threads import INITIATIVE_THREADS, update_comment_key
from app.domains.views.consumers.notify import clear_update_reply_draft, handle_record
from tests.domains.helpers import GUEST, MEMBER, OUTSIDER, OWNER, make_workspace, sign_in
from tests.domains.views.test_notify_consumer import COMMENTS_ARN, _image, _record, put_comment
from tests.domains.views.test_notify_document_comments import DOCUMENT, OTHER_PROJECT, PROJECT, seed_document
from tests.domains.views.test_update_drafts import PLANNING_ARN

ROOT = "01C000000000000000000001"

REPLY = "01C000000000000000000002"

INITIATIVE = "01JB000000000000000000INI7"

PROJECT_UPDATE = "01JB00000000000000000UPDP1"

INITIATIVE_UPDATE = "01JB00000000000000000UPDI1"

FOREIGN_WORKSPACE = "01JB0000000000000000000WS2"


def document_path(workspace: str, document_id: str = DOCUMENT) -> str:
    """One document thread's draft route."""
    return f"/api/workspaces/{workspace}/drafts/documents/{document_id}"


def reply_path(workspace: str, kind: str, target_id: str, update_id: str) -> str:
    """One update reply thread's draft route, under `projects` or `initiatives`."""
    return f"/api/workspaces/{workspace}/drafts/update-replies/{kind}/{target_id}/{update_id}"


def listed(client: TestClient, workspace: str, **params: str) -> "list[dict[str, Any]]":
    """The caller's drafts listing, failing loudly on a refusal."""
    response = client.get(f"/api/workspaces/{workspace}/drafts", params=params)
    assert response.status_code == 200, response.text
    return response.json()["drafts"]


def seed_project_update(repositories: Any, workspace: str, project_id: str = PROJECT) -> None:
    """One update on an already seeded project."""
    repositories.planning.create_project_update(
        ProjectUpdateRow(
            workspace_id=workspace,
            planning_key=project_update_key(project_id, PROJECT_UPDATE),
            update_id=PROJECT_UPDATE,
            project_id=project_id,
            body="Shipping on schedule",
            health="on_track",
            author_id=OWNER,
        )
    )


def seed_initiative_update(repositories: Any, workspace: str) -> None:
    """One initiative with one update on it."""
    repositories.planning.create_initiative(
        Initiative(
            workspace_id=workspace,
            planning_key=initiative_key(INITIATIVE),
            initiative_id=INITIATIVE,
            name="Grow",
            owner_id=OWNER,
            created_by=OWNER,
        )
    )
    repositories.planning.create_initiative_update(
        InitiativeUpdateRow(
            workspace_id=workspace,
            planning_key=initiative_update_key(INITIATIVE, INITIATIVE_UPDATE),
            update_id=INITIATIVE_UPDATE,
            initiative_id=INITIATIVE,
            body="On track",
            health="on_track",
            author_id=OWNER,
        )
    )


def test_a_document_draft_is_saved_read_and_replaced(client: TestClient, workspace: str, repositories: Any) -> None:
    """A document thread keeps one draft naming the document, and the listing filters to it."""
    seed_document(repositories, workspace)
    sign_in(client, MEMBER)

    first = client.put(document_path(workspace), json={"body": "Half a"})
    second = client.put(document_path(workspace), json={"body": "Half a thought"})
    read = client.get(document_path(workspace))

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    body = read.json()
    assert body["parent_kind"] == "document"
    assert body["document_id"] == DOCUMENT
    assert body["document_title"] == "Launch plan"
    assert body["issue_id"] is None
    assert body["body"] == "Half a thought"
    assert body["created_at"] == first.json()["created_at"]
    assert [row["body"] for row in listed(client, workspace, document_id=DOCUMENT)] == ["Half a thought"]
    assert [row["parent_kind"] for row in listed(client, workspace)] == ["document"]


def test_a_document_reply_draft_needs_a_root_comment_on_the_document(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A reply draft answers a root comment of the document, never a missing one or a reply."""
    seed_document(repositories, workspace)
    put_comment(repositories, workspace, DOCUMENT, ROOT, author_id=OWNER, body="Root")
    put_comment(repositories, workspace, DOCUMENT, REPLY, author_id=OWNER, body="Reply", parent_comment_id=ROOT)
    sign_in(client, MEMBER)

    reply = client.put(document_path(workspace), json={"body": "On the reply"}, params={"parent_comment_id": ROOT})
    missing = client.put(
        document_path(workspace), json={"body": "Hi"}, params={"parent_comment_id": "01C0000000000000000000NOPE"}
    )
    nested = client.put(document_path(workspace), json={"body": "Hi"}, params={"parent_comment_id": REPLY})
    deleted = client.delete(document_path(workspace), params={"parent_comment_id": ROOT})

    assert reply.status_code == 200, reply.text
    assert reply.json()["parent_comment_id"] == ROOT
    assert (missing.status_code, nested.status_code) == (404, 409)
    assert deleted.status_code == 204
    assert listed(client, workspace) == []


def test_a_guest_cannot_draft_on_a_document_they_cannot_reach(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A document under a project outside the guest's team is out of reach for a draft too."""
    seed_document(repositories, workspace, parent_id=OTHER_PROJECT)
    sign_in(client, GUEST)

    refused = client.put(document_path(workspace), json={"body": "Sneaky"})

    assert refused.status_code in (403, 404)
    assert repositories.views.get_draft(workspace, GUEST, DOCUMENT) is None


def test_a_document_in_another_workspace_is_never_reached(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Neither naming a foreign document from home nor calling the foreign workspace saves a draft."""
    make_workspace(repositories, FOREIGN_WORKSPACE, "globex", OUTSIDER)
    seed_document(repositories, FOREIGN_WORKSPACE)
    sign_in(client, MEMBER)

    from_home = client.put(document_path(workspace), json={"body": "Sneaky"})
    abroad = client.put(document_path(FOREIGN_WORKSPACE), json={"body": "Sneaky"})
    listed_abroad = client.get(f"/api/workspaces/{FOREIGN_WORKSPACE}/drafts", params={"document_id": DOCUMENT})

    assert from_home.status_code == 404
    assert abroad.status_code in (403, 404)
    assert listed_abroad.status_code in (403, 404)
    assert repositories.views.get_draft(workspace, MEMBER, DOCUMENT) is None
    assert repositories.views.get_draft(FOREIGN_WORKSPACE, MEMBER, DOCUMENT) is None


def test_project_and_initiative_update_reply_drafts(client: TestClient, workspace: str, repositories: Any) -> None:
    """Each update thread keeps its own draft naming the update and its project or initiative."""
    seed_document(repositories, workspace)
    seed_project_update(repositories, workspace)
    seed_initiative_update(repositories, workspace)
    sign_in(client, MEMBER)

    on_project = client.put(
        reply_path(workspace, "projects", PROJECT, PROJECT_UPDATE), json={"body": "Nice work on the project"}
    )
    on_initiative = client.put(
        reply_path(workspace, "initiatives", INITIATIVE, INITIATIVE_UPDATE), json={"body": "Nice work overall"}
    )
    read = client.get(reply_path(workspace, "projects", PROJECT, PROJECT_UPDATE))

    assert on_project.status_code == 200, on_project.text
    assert on_initiative.status_code == 200, on_initiative.text
    assert (read.json()["parent_kind"], read.json()["update_id"], read.json()["project_id"]) == (
        "project_update",
        PROJECT_UPDATE,
        PROJECT,
    )
    assert on_initiative.json()["initiative_id"] == INITIATIVE
    assert [row["body"] for row in listed(client, workspace, update_id=INITIATIVE_UPDATE)] == ["Nice work overall"]
    assert {row["parent_kind"] for row in listed(client, workspace)} == {"project_update", "initiative_update"}

    deleted = client.delete(reply_path(workspace, "initiatives", INITIATIVE, INITIATIVE_UPDATE))

    assert deleted.status_code == 204
    assert [row["update_id"] for row in listed(client, workspace)] == [PROJECT_UPDATE]


def test_a_guest_cannot_draft_on_an_update_they_cannot_reach(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """An update on a project outside the guest's team, or one that does not exist, keeps no draft."""
    seed_document(repositories, workspace, parent_id=OTHER_PROJECT)
    seed_project_update(repositories, workspace, project_id=OTHER_PROJECT)
    sign_in(client, GUEST)

    hidden = client.put(reply_path(workspace, "projects", OTHER_PROJECT, PROJECT_UPDATE), json={"body": "Sneaky"})
    sign_in(client, MEMBER)
    missing = client.put(
        reply_path(workspace, "projects", OTHER_PROJECT, "01JB00000000000000000UPDXX"), json={"body": "Hi"}
    )

    assert hidden.status_code in (403, 404)
    assert missing.status_code == 404
    assert repositories.views.get_draft(workspace, GUEST, PROJECT_UPDATE) is None


def test_an_update_in_another_workspace_is_never_reached(client: TestClient, workspace: str, repositories: Any) -> None:
    """A project update seeded in a foreign workspace cannot be drafted on from home."""
    make_workspace(repositories, FOREIGN_WORKSPACE, "globex", OUTSIDER)
    seed_document(repositories, FOREIGN_WORKSPACE)
    seed_project_update(repositories, FOREIGN_WORKSPACE)
    sign_in(client, MEMBER)

    from_home = client.put(reply_path(workspace, "projects", PROJECT, PROJECT_UPDATE), json={"body": "Sneaky"})

    assert from_home.status_code == 404
    assert repositories.views.get_draft(workspace, MEMBER, PROJECT_UPDATE) is None


def test_naming_several_parents_in_the_listing_is_refused(client: TestClient, workspace: str) -> None:
    """The listing filters by at most one parent."""
    sign_in(client, MEMBER)

    refused = client.get(
        f"/api/workspaces/{workspace}/drafts", params={"document_id": DOCUMENT, "update_id": PROJECT_UPDATE}
    )

    assert refused.status_code == 422


def test_posting_a_document_comment_clears_its_draft(client: TestClient, workspace: str, repositories: Any) -> None:
    """The document comment's record clears its author's draft on that document."""
    seed_document(repositories, workspace)
    sign_in(client, MEMBER)
    client.put(document_path(workspace), json={"body": "About to post"})

    handle_record(
        repositories,
        _record(
            COMMENTS_ARN,
            "INSERT",
            new=_image(
                workspace_id=workspace,
                issue_id=DOCUMENT,
                document_id=DOCUMENT,
                team_id="",
                comment_id="01C000000000000000000009",
                author_id=MEMBER,
                body="Posted",
                created_at=(utc_now() + timedelta(seconds=5)).isoformat(),
            ),
        ),
    )

    assert repositories.views.get_draft(workspace, MEMBER, DOCUMENT) is None


def _reply_record(workspace: str, author: str, posted_at: str, *, initiative: bool = False) -> "dict[str, Any]":
    """A planning stream record for a reply just posted on the project or initiative update."""
    if initiative:
        image: "dict[str, Any]" = {
            "planning_key": update_comment_key(
                INITIATIVE, INITIATIVE_UPDATE, "01JB00000000000000000RPLY9", INITIATIVE_THREADS
            ),
            "kind": "initiative_update_comment",
            "initiative_id": INITIATIVE,
            "update_id": INITIATIVE_UPDATE,
        }
    else:
        image = {
            "planning_key": update_comment_key(PROJECT, PROJECT_UPDATE, "01JB00000000000000000RPLY9"),
            "kind": "project_update_comment",
            "project_id": PROJECT,
            "update_id": PROJECT_UPDATE,
        }
    image.update(
        workspace_id=workspace,
        comment_id="01JB00000000000000000RPLY9",
        author_id=author,
        body="Nice work",
        created_at=posted_at,
    )
    return _record(PLANNING_ARN, "INSERT", new=_image(**image))


def test_posting_an_update_reply_clears_its_draft(client: TestClient, workspace: str, repositories: Any) -> None:
    """A reply on a project or initiative update clears its author's draft there and no one else's."""
    seed_document(repositories, workspace)
    seed_project_update(repositories, workspace)
    seed_initiative_update(repositories, workspace)
    sign_in(client, MEMBER)
    client.put(reply_path(workspace, "projects", PROJECT, PROJECT_UPDATE), json={"body": "About to reply"})
    client.put(reply_path(workspace, "initiatives", INITIATIVE, INITIATIVE_UPDATE), json={"body": "About to reply"})
    sign_in(client, OWNER)
    client.put(reply_path(workspace, "projects", PROJECT, PROJECT_UPDATE), json={"body": "Mine"})
    later = (utc_now() + timedelta(seconds=5)).isoformat()

    handle_record(repositories, _reply_record(workspace, MEMBER, later))
    handle_record(repositories, _reply_record(workspace, MEMBER, later, initiative=True))

    assert repositories.views.get_draft(workspace, MEMBER, PROJECT_UPDATE) is None
    assert repositories.views.get_draft(workspace, MEMBER, INITIATIVE_UPDATE) is None
    assert repositories.views.get_draft(workspace, OWNER, PROJECT_UPDATE) is not None


def test_an_update_reply_draft_saved_after_the_reply_survives(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Starting the next reply before the posted one's record lands loses nothing."""
    seed_document(repositories, workspace)
    seed_project_update(repositories, workspace)
    sign_in(client, MEMBER)
    client.put(reply_path(workspace, "projects", PROJECT, PROJECT_UPDATE), json={"body": "The next reply"})

    cleared = clear_update_reply_draft(
        repositories, _reply_record(workspace, MEMBER, (utc_now() - timedelta(minutes=1)).isoformat())
    )

    assert cleared is False
    assert repositories.views.get_draft(workspace, MEMBER, PROJECT_UPDATE) is not None
