"""The MCP tool registry: every tool, in the order `tools/list` answers them.

The tools themselves live in `issue_tools`, `team_tools` and `planning_tools`, one
module per area, on the shared record in `toolkit`. Each one reads and writes
through the same `app.common` paths the HTTP routes run, and each needs the same
read or write scope its route does, so MCP is not a second authorization system.

There is no delete tool and no workspace administration tool. An agent that can
create and update but never destroy is a different risk from one that can do both,
and the difference is worth more than the convenience of a `delete_issue`.
"""

from __future__ import annotations

import json
from typing import Any

from app.domains.integrations.mcp.issue_tools import ISSUE_TOOLS
from app.domains.integrations.mcp.planning_tools import PLANNING_TOOLS
from app.domains.integrations.mcp.team_tools import TEAM_TOOLS
from app.domains.integrations.mcp.toolkit import Tool, ToolCall

TOOLS: tuple[Tool, ...] = (*ISSUE_TOOLS, *TEAM_TOOLS, *PLANNING_TOOLS)

TOOLS_BY_NAME: dict[str, Tool] = {tool.name: tool for tool in TOOLS}

__all__ = ["TOOLS", "TOOLS_BY_NAME", "Tool", "ToolCall", "render"]


def render(value: Any) -> str:
    """One tool's answer as the text content MCP carries.

    JSON rather than prose, because every consumer is a language model reading a
    structure it will chain further calls from, and indentation costs tokens for
    nothing a model needs.
    """
    return json.dumps(value, default=str, sort_keys=True)
