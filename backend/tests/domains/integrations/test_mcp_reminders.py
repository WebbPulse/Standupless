"""The reminder MCP tools on projects, initiatives and documents, beside the issue ones.

Each tool runs the inbox route's own `app.common` path, so what is asserted here
is the naming the tools add: a project or initiative named by its name, and a
subject out of sight answering as not visible.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.documents import Document, DocumentBody
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import Initiative, initiative_key
from tests.domains.helpers import GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal, seed_planning

INBOX = ("notifications:read", "notifications:write")

INITIATIVE = "01JB000000000000000000MIN1"

DOCUMENT = "01JB000000000000000000MDC1"


def _later(minutes: int = 30) -> str:
    """A moment comfortably past the one minute floor, as the tools take it."""
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


@pytest.fixture
def subjects(repositories: Any, workspace: str) -> dict[str, str]:
    """A project on `TEAM` and one on `OTHER_TEAM`, an initiative, and a document on the first project."""
    home = seed_planning(repositories, workspace, TEAM, "Home")
    away = seed_planning(repositories, workspace, OTHER_TEAM, "Away")
    repositories.planning.create_initiative(
        Initiative(
            workspace_id=workspace,
            planning_key=initiative_key(INITIATIVE),
            initiative_id=INITIATIVE,
            name="Grow",
            created_by=OWNER,
        )
    )
    parent = home["project_id"]
    repositories.documents.create(
        Document(
            workspace_id=workspace,
            document_id=DOCUMENT,
            parent_kind="project",
            parent_id=parent,
            title="Launch plan",
            author_id=OWNER,
            updated_by=OWNER,
        ),
        DocumentBody(workspace_id=workspace, document_id=DOCUMENT, parent_kind="project", parent_id=parent),
    )
    return {"project": parent, "hidden_project": away["project_id"], "initiative": INITIATIVE, "document": DOCUMENT}


def test_reminders_are_set_listed_and_cancelled_on_each_kind(
    client: TestClient, repositories: Any, subjects: dict[str, str]
) -> None:
    """A project and initiative named by name and a document by id each take one reminder."""
    secret = mint_for(repositories, MEMBER, INBOX)

    project = answer(
        tool(
            client,
            secret,
            "set_reminder",
            {"entity_type": "project", "entity_id": "Home project", "remind_at": _later(10)},
        )
    )
    initiative = answer(
        tool(
            client, secret, "set_reminder", {"entity_type": "initiative", "entity_id": "Grow", "remind_at": _later(20)}
        )
    )
    document = answer(
        tool(
            client, secret, "set_reminder", {"entity_type": "document", "entity_id": DOCUMENT, "remind_at": _later(30)}
        )
    )
    listed = answer(tool(client, secret, "list_reminders", {}))["reminders"]
    cancelled = answer(tool(client, secret, "cancel_reminder", {"entity_type": "initiative", "entity_id": INITIATIVE}))
    after = answer(tool(client, secret, "list_reminders", {"entity_type": "initiative"}))["reminders"]

    assert (project["entity_id"], project["title"]) == (subjects["project"], "Home project")
    assert (initiative["entity_id"], initiative["title"]) == (INITIATIVE, "Grow")
    assert document["title"] == "Launch plan"
    assert [row["entity_type"] for row in listed] == ["project", "initiative", "document"]
    assert cancelled == {"cancelled": True, "entity_type": "initiative", "entity_id": INITIATIVE}
    assert after == []


def test_the_generic_tools_take_an_issue_too(client: TestClient, repositories: Any, issue: Issue) -> None:
    """An issue named by its key is set through `set_reminder` and reads back through the issue tool."""
    secret = mint_for(repositories, MEMBER, INBOX)

    answer(
        tool(client, secret, "set_reminder", {"entity_type": "issue", "entity_id": issue.key, "remind_at": _later()})
    )
    issue_tool = answer(tool(client, secret, "list_issue_reminders", {}))["reminders"]

    assert [row["issue_id"] for row in issue_tool] == [issue.issue_id]


def test_a_subject_out_of_sight_answers_as_not_visible(
    client: TestClient, repositories: Any, subjects: dict[str, str]
) -> None:
    """A guest cannot remind themselves about a project outside their team, nor an initiative."""
    secret = mint_for(repositories, GUEST, INBOX)

    hidden = refusal(
        tool(
            client,
            secret,
            "set_reminder",
            {"entity_type": "project", "entity_id": subjects["hidden_project"], "remind_at": _later()},
        )
    )
    initiative = refusal(
        tool(
            client,
            secret,
            "set_reminder",
            {"entity_type": "initiative", "entity_id": INITIATIVE, "remind_at": _later()},
        )
    )

    assert hidden
    assert initiative


def test_an_unknown_kind_is_refused(client: TestClient, repositories: Any, subjects: dict[str, str]) -> None:
    """Only the four kinds of subject take reminders."""
    secret = mint_for(repositories, MEMBER, INBOX)

    text = refusal(tool(client, secret, "cancel_reminder", {"entity_type": "cycle", "entity_id": subjects["project"]}))

    assert "entity_type" in text
