"""The MCP tool registry: every tool, in the order `tools/list` answers them.

The tools live one module per area on the shared record in `toolkit`. Each one
reads and writes through the same `app.common` paths the HTTP routes run, checks
the same role, and needs the same scope its route does, so MCP is not a second
authorization system and never exceeds the signed-in user's role.

Destructive tools carry `destructiveHint`. The one irreversible tool is
`delete_team`, held to a workspace owner or admin as its route is. Nothing here
deletes a workspace, touches billing, mints API keys or OAuth clients, or manages
the GitHub App.
"""

from __future__ import annotations

import json
from typing import Any

from app.domains.integrations.mcp.audit_tools import AUDIT_TOOLS
from app.domains.integrations.mcp.channel_tools import CHANNEL_TOOLS
from app.domains.integrations.mcp.document_tools import DOCUMENT_TOOLS
from app.domains.integrations.mcp.export_tools import EXPORT_TOOLS
from app.domains.integrations.mcp.initiative_tools import INITIATIVE_TOOLS
from app.domains.integrations.mcp.issue_tools import ISSUE_TOOLS
from app.domains.integrations.mcp.planning_tools import PLANNING_TOOLS
from app.domains.integrations.mcp.release_tools import RELEASE_TOOLS
from app.domains.integrations.mcp.review_tools import REVIEW_TOOLS
from app.domains.integrations.mcp.standup_tools import STANDUP_TOOLS
from app.domains.integrations.mcp.sync_tools import SYNC_TOOLS
from app.domains.integrations.mcp.team_tools import TEAM_TOOLS
from app.domains.integrations.mcp.toolkit import Tool, ToolCall
from app.domains.integrations.mcp.transition_tools import TRANSITION_TOOLS
from app.domains.integrations.mcp.triage_tools import TRIAGE_TOOLS
from app.domains.integrations.mcp.view_tools import VIEW_TOOLS
from app.domains.integrations.mcp.workflow_tools import WORKFLOW_TOOLS
from app.domains.integrations.mcp.workspace_tools import WORKSPACE_TOOLS

TOOLS: tuple[Tool, ...] = (
    *ISSUE_TOOLS,
    *REVIEW_TOOLS,
    *TEAM_TOOLS,
    *WORKFLOW_TOOLS,
    *TRANSITION_TOOLS,
    *SYNC_TOOLS,
    *CHANNEL_TOOLS,
    *STANDUP_TOOLS,
    *PLANNING_TOOLS,
    *INITIATIVE_TOOLS,
    *DOCUMENT_TOOLS,
    *RELEASE_TOOLS,
    *VIEW_TOOLS,
    *WORKSPACE_TOOLS,
    *EXPORT_TOOLS,
    *AUDIT_TOOLS,
    *TRIAGE_TOOLS,
)

TOOLS_BY_NAME: dict[str, Tool] = {tool.name: tool for tool in TOOLS}

__all__ = ["TOOLS", "TOOLS_BY_NAME", "Tool", "ToolCall", "render"]


def render(value: Any) -> str:
    """One tool's answer as the text content MCP carries.

    JSON rather than prose, because every consumer is a language model reading a
    structure it will chain further calls from, and indentation costs tokens for
    nothing a model needs.
    """
    return json.dumps(value, default=str, sort_keys=True)
