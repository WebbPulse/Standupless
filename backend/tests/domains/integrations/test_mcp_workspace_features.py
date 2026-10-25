"""MCP honours the areas an admin turned off, as REST does.

A write tool in an area that is off answers an error result naming
FEATURE_DISABLED, its read tools still answer, `get_workspace` reports the flags
so an agent knows which tools apply, and `update_workspace` turns areas on and
off for an admin.
"""

from __future__ import annotations

import json
from typing import Any

from app.common.db.dynamo.api_keys import API_KEY_SCOPES
from tests.domains.helpers import ADMIN, MEMBER
from tests.domains.integrations.conftest import WORKSPACE
from tests.domains.integrations.test_mcp import mint, tool


def _text(response: Any) -> tuple[bool, str]:
    """Whether the tool call was an error result, and its text."""
    body = response.json()
    assert "error" not in body, body
    return body["result"]["isError"], body["result"]["content"][0]["text"]


def test_get_workspace_reports_every_feature_on_by_default(client: Any, workspace: str, repositories: Any) -> None:
    """An agent reads which areas apply from the workspace itself."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)

    is_error, text = _text(tool(client, secret, "get_workspace"))

    assert is_error is False
    assert json.loads(text)["features"] == {
        "initiatives": True,
        "customers": True,
        "releases": True,
        "documents": True,
        "pulse": True,
    }


def test_a_write_tool_in_a_turned_off_area_is_refused(client: Any, workspace: str, repositories: Any) -> None:
    """create_customer is refused with the code while list_customers still answers, and both work once back on."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)
    repositories.workspaces.set_features(WORKSPACE, {"customers": False})

    is_error, text = _text(tool(client, secret, "create_customer", {"name": "Acme"}))
    assert is_error is True
    assert "FEATURE_DISABLED" in text
    assert "Customers is turned off" in text
    assert _text(tool(client, secret, "list_customers"))[0] is False

    repositories.workspaces.set_features(WORKSPACE, {"customers": True})
    assert _text(tool(client, secret, "create_customer", {"name": "Acme"}))[0] is False


def test_each_area_refuses_its_write_tools(client: Any, workspace: str, repositories: Any) -> None:
    """One write tool per area is refused while that area alone is off."""
    secret = mint(repositories, ADMIN, API_KEY_SCOPES)
    calls = {
        "initiatives": ("create_initiative", {"name": "Grow"}),
        "documents": ("delete_document", {"document_id": "01JB0000000000000000000DOC"}),
        "pulse": ("mark_pulse_read", {}),
        "releases": ("create_release", {"team_id": "ABC", "name": "1.0"}),
    }
    for feature, (name, arguments) in calls.items():
        repositories.workspaces.set_features(WORKSPACE, {feature: False})
        is_error, text = _text(tool(client, secret, name, arguments))
        assert is_error is True, name
        assert "FEATURE_DISABLED" in text, (name, text)
    repositories.workspaces.set_features(WORKSPACE, {})


def test_update_workspace_turns_features_off_and_on(client: Any, workspace: str, repositories: Any) -> None:
    """An admin's call merges into the stored flags and answers them."""
    secret = mint(repositories, ADMIN, API_KEY_SCOPES)

    is_error, text = _text(tool(client, secret, "update_workspace", {"features": {"releases": False}}))

    assert is_error is False, text
    assert json.loads(text)["features"]["releases"] is False
    assert repositories.workspaces.get(WORKSPACE).features == {"releases": False}
