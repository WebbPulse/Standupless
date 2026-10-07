"""The argument check every MCP tool call passes: strict names and issue keys.

An unknown argument is refused with the declared one it most likely meant, a
missing one is named, every problem in a call comes back in one answer, and any
tool that takes an issue id takes the issue's key as well.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.domains.integrations.mcp.arguments import check_arguments, suggestion
from app.domains.integrations.mcp.tools import TOOLS, TOOLS_BY_NAME
from app.domains.integrations.mcp.transport import ToolError
from tests.domains.helpers import MEMBER
from tests.domains.integrations.conftest import TEAM, WORKSPACE, seed_issue
from tests.domains.integrations.test_mcp import call, tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

WRITE = ("issues:write", "issues:read", "comments:write")


@pytest.mark.parametrize(
    ("tool_name", "wrong", "meant"),
    [
        ("create_issue", "description", "body"),
        ("create_issue", "status", "status_id"),
        ("create_issue_relation", "relation_type", "type"),
        ("create_issue_relation", "related_issue_key", "target_issue_key"),
        ("update_issue", "assignee", "assignee_id"),
        ("update_issue", "titel", "title"),
    ],
)
def test_an_unknown_argument_suggests_the_declared_one(tool_name: str, wrong: str, meant: str) -> None:
    """The suggestion is the argument an agent most likely meant, and only a declared one."""
    assert suggestion(wrong, TOOLS_BY_NAME[tool_name].schema["properties"]) == meant


def test_an_unrelated_argument_suggests_nothing() -> None:
    """A name nothing resembles is refused without a misleading guess."""
    assert suggestion("frobnicate", TOOLS_BY_NAME["create_issue"].schema["properties"]) is None


def test_create_issue_refuses_an_unknown_argument_and_writes_nothing(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """`description` used to be dropped silently, leaving an empty body; now nothing is created."""
    secret = mint_for(repositories, MEMBER, WRITE)

    text = refusal(tool(client, secret, "create_issue", {"team_id": TEAM, "title": "Hi", "description": "Lost"}))

    assert "unknown argument description (did you mean body?)" in text
    assert repositories.issues.list_for_team(WORKSPACE, TEAM, limit=50).items == []


def test_every_problem_is_reported_in_one_answer(client: TestClient, repositories: Any, issue: Issue) -> None:
    """The three calls SUP-49 needed become one refusal naming every fix."""
    secret = mint_for(repositories, MEMBER, WRITE)

    text = refusal(
        tool(
            client,
            secret,
            "create_issue_relation",
            {"issue": "ABC-1", "related_issue_key": "ABC-2", "relation_type": "blocks"},
        )
    )

    assert "unknown argument related_issue_key (did you mean target_issue_key?)" in text
    assert "unknown argument relation_type (did you mean type?)" in text
    assert "name either issue_id or issue_key" in text
    assert "name either target_issue_id or target_issue_key" in text
    assert "missing required argument type" in text


def test_create_issue_relation_takes_issue_keys(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Both ends of a relation can be named by key alone."""
    seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS7", "ABC", 2)
    secret = mint_for(repositories, MEMBER, WRITE)

    created = answer(
        tool(
            client,
            secret,
            "create_issue_relation",
            {"issue_key": "ABC-1", "type": "blocks", "target_issue_key": "ABC-2"},
        )
    )

    assert created["issue_id"] == issue.issue_id
    assert created["target_issue_key"] == "ABC-2"


def test_update_issue_and_add_comment_take_issue_key(client: TestClient, repositories: Any, issue: Issue) -> None:
    """The tools that act on one issue accept its key as get_issue does."""
    secret = mint_for(repositories, MEMBER, WRITE)

    updated = answer(tool(client, secret, "update_issue", {"issue_key": "ABC-1", "title": "Renamed"}))
    comment = answer(tool(client, secret, "add_comment", {"issue_key": "ABC-1", "body": "Noted"}))

    assert updated["title"] == "Renamed"
    assert comment["issue_id"] == issue.issue_id


def test_naming_neither_names_both(client: TestClient, repositories: Any, issue: Issue) -> None:
    """With no issue named, the refusal says either argument would do."""
    secret = mint_for(repositories, MEMBER, WRITE)

    text = refusal(tool(client, secret, "add_comment", {"body": "Noted"}))

    assert "name either issue_id or issue_key" in text


def test_naming_both_is_refused(client: TestClient, repositories: Any, issue: Issue) -> None:
    """An id and a key together could disagree, so the call names one."""
    secret = mint_for(repositories, MEMBER, WRITE)

    text = refusal(tool(client, secret, "get_issue", {"issue_id": issue.issue_id, "issue_key": "ABC-1"}))

    assert "name either issue_id or issue_key, not both" in text


def test_every_tool_on_one_issue_takes_its_key() -> None:
    """Any tool whose schema takes an issue id takes the key beside it, in the advertised schema too."""
    for row in TOOLS:
        properties = row.schema["properties"]
        advertised = row.descriptor()["inputSchema"]
        for name, alternative in (("issue_id", "issue_key"), ("target_issue_id", "target_issue_key")):
            if name in properties:
                assert alternative in advertised["properties"], row.name
                assert name not in advertised.get("required", ()), row.name
        assert advertised["additionalProperties"] is False, row.name


def test_the_check_folds_a_key_into_the_id() -> None:
    """A handler reads only the canonical name, whichever spelling the caller used."""
    schema = TOOLS_BY_NAME["archive_issue"].schema

    assert check_arguments("archive_issue", schema, {"issue_key": "ABC-1"}) == {"issue_id": "ABC-1"}
    with pytest.raises(ToolError, match="It takes: issue_id, issue_key"):
        check_arguments("archive_issue", schema, {})


def test_tools_list_advertises_the_key_alternative(client: TestClient, repositories: Any, workspace: str) -> None:
    """The wire schema of update_issue offers issue_key and does not demand issue_id."""
    secret = mint_for(repositories, MEMBER, WRITE)

    body = call(client, secret, "tools/list").json()
    schema = next(row for row in body["result"]["tools"] if row["name"] == "update_issue")["inputSchema"]

    assert "issue_key" in schema["properties"]
    assert "issue_id" not in schema.get("required", ())
