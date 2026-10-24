"""The form template MCP tools: form_fields on the template tools, and form_answers on create_issue.

An agent saves a form the way the settings page does and files an issue from
it by name, and create_issue holds the answers it is given to the form.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER
from tests.domains.integrations.conftest import TEAM
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

SCOPES = ("teams:read", "teams:write", "issues:read", "issues:write")

FIELDS = [
    {"key": "summary", "label": "Summary", "required": True},
    {
        "key": "area",
        "label": "Area",
        "type": "select",
        "options": [{"value": "Billing", "priority": "high"}, {"value": "Other"}],
    },
]


def _save(client: TestClient, secret: str) -> dict[str, Any]:
    """Save a form on the team through the tool and answer it."""
    arguments = {"team_id": TEAM, "name": "Request", "title": "Request", "form_fields": FIELDS}
    return answer(tool(client, secret, "create_template", arguments))


def test_a_form_is_saved_and_cleared(client: TestClient, workspace: str, repositories: Any) -> None:
    """form_fields saves the questions, and a null on update turns the form off."""
    secret = mint_for(repositories, MEMBER, SCOPES)

    saved = _save(client, secret)
    arguments = {"team_id": TEAM, "template": "Request", "form_fields": None}
    cleared = answer(tool(client, secret, "update_template", arguments))

    assert [field["key"] for field in saved["form_fields"]] == ["summary", "area"]
    assert cleared["form_fields"] == []


def test_create_issue_holds_and_renders_form_answers(client: TestClient, workspace: str, repositories: Any) -> None:
    """The answers land in the body and map priority, and a missing required answer is refused."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    _save(client, secret)

    created = answer(
        tool(
            client,
            secret,
            "create_issue",
            {"team_id": TEAM, "template_id": "request", "form_answers": {"summary": "Refund", "area": "Billing"}},
        )
    )
    missing = refusal(tool(client, secret, "create_issue", {"team_id": TEAM, "template_id": "request"}))
    unknown = refusal(
        tool(
            client,
            secret,
            "create_issue",
            {"team_id": TEAM, "template_id": "request", "form_answers": {"summary": "x", "bogus": "y"}},
        )
    )

    assert created["body"] == "**Summary**\n\nRefund\n\n**Area**\n\nBilling"
    assert created["priority"] == "high"
    assert "Summary is required" in missing
    assert "No such form field: bogus" in unknown
