"""Presence over the WebSocket: who else has an issue or a document open.

The sender is a fake at the API Gateway management API, so the presence rows,
the visibility checks and the entity reads run against the mocked tables.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.common.db.dynamo.documents import Document, DocumentBody
from app.common.db.dynamo.planning import Project, project_key
from app.common.db.dynamo.realtime_presence import PRESENCE_TTL_SECONDS
from app.domains.integrations.realtime import presence, websocket
from tests.domains.helpers import add_team_member
from tests.domains.integrations.conftest import (
    ADMIN,
    GUEST,
    MEMBER,
    OTHER_TEAM,
    OWNER,
    TEAM,
    WORKSPACE,
    seed_issue,
)
from tests.domains.integrations.test_realtime import FakeSender, connected, verifier, ws_event

ISSUE = "01JB0000000000000000000IS1"

HIDDEN_ISSUE = "01JB0000000000000000000IS2"

DOCUMENT = "01JB000000000000000000DOC1"

PROJECT = "01JB000000000000000000PJT1"


@pytest.fixture
def issues(repositories: Any, workspace: str) -> None:
    """One issue in the team everyone sees and one in the team the guest is outside of."""
    seed_issue(repositories, workspace, TEAM, ISSUE, "ABC", 1)
    seed_issue(repositories, workspace, OTHER_TEAM, HIDDEN_ISSUE, "XYZ", 1)


def send(
    repositories: Any,
    sender: FakeSender,
    connection_id: str,
    route: str = "presence",
    *,
    kind: str = "issue",
    entity_id: str = ISSUE,
    editing: bool = False,
    now: float | None = None,
) -> dict[str, Any]:
    """Send one presence message on a connection, answering the integration response."""
    body = json.dumps({"action": route, "kind": kind, "id": entity_id, "editing": editing})
    event = ws_event(route, connection_id, body=body)
    if now is None:
        return websocket.handle_event(repositories, event, verifier, lambda: sender)
    handler = presence.presence if route == "presence" else presence.leave
    return handler(repositories, event, connection_id, sender_factory=lambda: sender, now=now)


def viewers(response: dict[str, Any]) -> list[dict[str, Any]]:
    """The viewers an answer lists."""
    return json.loads(response["body"])["viewers"]


def test_the_first_viewer_sees_no_one_and_tells_no_one(repositories: Any, issues: None) -> None:
    """Alone on an issue, the answer lists nobody, and the viewer is never shown to themselves."""
    connected(repositories, ("c-1", MEMBER))
    sender = FakeSender()

    response = send(repositories, sender, "c-1")

    assert response["statusCode"] == 200
    assert json.loads(response["body"]) == {
        "type": "presence",
        "workspace_id": WORKSPACE,
        "kind": "issue",
        "id": ISSUE,
        "viewers": [],
    }
    assert sender.sent == []


def test_a_second_viewer_is_told_of_the_first_and_the_first_is_pushed(repositories: Any, issues: None) -> None:
    """Opening an issue someone has open answers them, and pushes the newcomer to them."""
    connected(repositories, ("c-1", MEMBER), ("c-2", ADMIN))
    sender = FakeSender()
    send(repositories, sender, "c-1")

    response = send(repositories, sender, "c-2")

    assert viewers(response) == [{"user_id": MEMBER, "editing": False}]
    [pushed] = sender.to("c-1")
    assert pushed["viewers"] == [{"user_id": ADMIN, "editing": False}]
    assert sender.to("c-2") == []


def test_a_heartbeat_with_no_change_pushes_nothing(repositories: Any, issues: None) -> None:
    """A heartbeat refreshes the row and answers, without a push to anyone."""
    connected(repositories, ("c-1", MEMBER), ("c-2", ADMIN))
    sender = FakeSender()
    send(repositories, sender, "c-1")
    send(repositories, sender, "c-2")
    sender.sent.clear()

    send(repositories, sender, "c-2")

    assert sender.sent == []


def test_starting_to_edit_is_pushed_with_a_flag(repositories: Any, issues: None) -> None:
    """A change of the editing flag is a change worth a push."""
    connected(repositories, ("c-1", MEMBER), ("c-2", ADMIN))
    sender = FakeSender()
    send(repositories, sender, "c-1")
    send(repositories, sender, "c-2")
    sender.sent.clear()

    send(repositories, sender, "c-2", editing=True)

    assert sender.to("c-1")[-1]["viewers"] == [{"user_id": ADMIN, "editing": True}]


def test_two_tabs_of_one_member_are_listed_once(repositories: Any, issues: None) -> None:
    """A member with two tabs open is one viewer, editing when either tab is."""
    connected(repositories, ("c-1", MEMBER), ("c-2", ADMIN), ("c-3", ADMIN))
    sender = FakeSender()
    send(repositories, sender, "c-2")
    send(repositories, sender, "c-3", editing=True)

    response = send(repositories, sender, "c-1")

    assert viewers(response) == [{"user_id": ADMIN, "editing": True}]


def test_a_member_who_cannot_read_the_issue_is_refused(repositories: Any, issues: None) -> None:
    """A guest naming an issue outside their teams learns nothing and leaves no row."""
    connected(repositories, ("c-guest", GUEST))
    sender = FakeSender()

    response = send(repositories, sender, "c-guest", entity_id=HIDDEN_ISSUE)

    assert response == {"statusCode": 404}
    assert repositories.realtime_presence.list_for_entity(WORKSPACE, "issue", HIDDEN_ISSUE) == []


def test_an_unknown_entity_and_a_bad_message_are_refused(repositories: Any, issues: None) -> None:
    """An id that names nothing is 404, and a kind outside issue and document is 400."""
    connected(repositories, ("c-1", MEMBER))
    sender = FakeSender()

    assert send(repositories, sender, "c-1", entity_id="01JB00000000000000000NONE")["statusCode"] == 404
    assert send(repositories, sender, "c-1", kind="cycle")["statusCode"] == 400
    assert send(repositories, sender, "c-1", entity_id="x" * 65)["statusCode"] == 400


def test_a_forgotten_connection_is_told_to_reconnect(repositories: Any, issues: None) -> None:
    """A message on a socket with no row answers the pong a stale heartbeat gets."""
    response = send(repositories, FakeSender(), "c-9")

    assert json.loads(response["body"]) == {"action": "pong", "connected": False}


def test_a_private_team_viewer_is_hidden_from_and_never_pushed_to_outsiders(repositories: Any, issues: None) -> None:
    """Someone who lost the team keeps a row but is neither listed nor told anything."""
    connected(repositories, ("c-member", MEMBER), ("c-admin", ADMIN))
    sender = FakeSender()
    send(repositories, sender, "c-member", entity_id=HIDDEN_ISSUE)
    repositories.memberships.set_team_private(WORKSPACE, OTHER_TEAM, True)
    add_team_member(repositories, WORKSPACE, OTHER_TEAM, ADMIN, "member")
    sender.sent.clear()

    response = send(repositories, sender, "c-admin", entity_id=HIDDEN_ISSUE)

    assert viewers(response) == []
    assert sender.to("c-member") == []


def test_leaving_tells_the_others(repositories: Any, issues: None) -> None:
    """Closing the page removes the row and pushes the shorter list."""
    connected(repositories, ("c-1", MEMBER), ("c-2", ADMIN))
    sender = FakeSender()
    send(repositories, sender, "c-1")
    send(repositories, sender, "c-2")
    sender.sent.clear()

    assert send(repositories, sender, "c-2", "presence_leave")["statusCode"] == 200

    assert sender.to("c-1") == [
        {"type": "presence", "workspace_id": WORKSPACE, "kind": "issue", "id": ISSUE, "viewers": []}
    ]
    assert [row.connection_id for row in repositories.realtime_presence.list_for_entity(WORKSPACE, "issue", ISSUE)] == [
        "c-1"
    ]


def test_a_disconnect_clears_every_open_entity(repositories: Any, issues: None) -> None:
    """A closed socket leaves every entity it had open, and their viewers hear of it."""
    connected(repositories, ("c-1", MEMBER), ("c-2", ADMIN))
    sender = FakeSender()
    send(repositories, sender, "c-1")
    send(repositories, sender, "c-2")
    send(repositories, sender, "c-2", entity_id=HIDDEN_ISSUE)
    sender.sent.clear()

    websocket.handle_event(repositories, ws_event("$disconnect", "c-2"), verifier, lambda: sender)

    assert repositories.realtime_presence.list_for_connection("c-2") == []
    assert sender.to("c-1")[-1]["viewers"] == []


def test_a_row_past_its_ttl_is_not_listed(repositories: Any, issues: None) -> None:
    """A viewer whose heartbeats stopped drops out about a minute later."""
    connected(repositories, ("c-1", MEMBER), ("c-2", ADMIN))
    sender = FakeSender()
    send(repositories, sender, "c-1", now=1_000_000)

    later = send(repositories, sender, "c-2", now=1_000_000 + PRESENCE_TTL_SECONDS + 1)

    assert viewers(later) == []


def test_a_gone_viewer_loses_its_row(repositories: Any, issues: None) -> None:
    """A push API Gateway answers 410 for deletes that viewer's row."""
    connected(repositories, ("c-1", MEMBER), ("c-2", ADMIN))
    send(repositories, FakeSender(), "c-1")

    send(repositories, FakeSender(gone={"c-1"}), "c-2")

    assert [row.connection_id for row in repositories.realtime_presence.list_for_entity(WORKSPACE, "issue", ISSUE)] == [
        "c-2"
    ]


def test_messages_past_the_limit_are_dropped(repositories: Any, issues: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """A connection over its presence limit is answered 429 and writes nothing."""
    connected(repositories, ("c-1", MEMBER))
    monkeypatch.setattr(presence, "_allowed", lambda connection_id: False)

    assert send(repositories, FakeSender(), "c-1") == {"statusCode": 429}
    assert repositories.realtime_presence.list_for_entity(WORKSPACE, "issue", ISSUE) == []


def _document(repositories: Any, parent_kind: str, parent_id: str) -> None:
    """One document under a parent, written straight into the planning table."""
    repositories.documents.create(
        Document(
            workspace_id=WORKSPACE,
            document_id=DOCUMENT,
            parent_kind=parent_kind,
            parent_id=parent_id,
            title="Plan",
            author_id=OWNER,
            updated_by=OWNER,
        ),
        DocumentBody(workspace_id=WORKSPACE, document_id=DOCUMENT, parent_kind=parent_kind, parent_id=parent_id),
    )


def test_a_project_document_follows_the_project_teams(repositories: Any, workspace: str) -> None:
    """A document under a project is open to anyone who sees one of its teams, and no one else."""
    repositories.planning.create_project(
        Project(
            workspace_id=WORKSPACE,
            planning_key=project_key(PROJECT),
            project_id=PROJECT,
            team_ids=[OTHER_TEAM],
            name="Launch",
            status="in_progress",
            created_by=OWNER,
        )
    )
    _document(repositories, "project", PROJECT)
    connected(repositories, ("c-member", MEMBER), ("c-guest", GUEST))
    sender = FakeSender()

    assert send(repositories, sender, "c-member", kind="document", entity_id=DOCUMENT)["statusCode"] == 200
    assert send(repositories, sender, "c-guest", kind="document", entity_id=DOCUMENT) == {"statusCode": 404}


def test_a_team_document_is_its_team(repositories: Any, workspace: str) -> None:
    """A document under a team is open to that team's readers, the guest who belongs to it included."""
    _document(repositories, "team", TEAM)
    connected(repositories, ("c-member", MEMBER), ("c-guest", GUEST))
    sender = FakeSender()
    send(repositories, sender, "c-member", kind="document", entity_id=DOCUMENT, editing=True)

    response = send(repositories, sender, "c-guest", kind="document", entity_id=DOCUMENT)

    assert viewers(response) == [{"user_id": MEMBER, "editing": True}]
