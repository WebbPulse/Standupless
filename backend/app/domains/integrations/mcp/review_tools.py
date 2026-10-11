"""The MCP tool for the caller's Reviews list.

`list_my_reviews` answers exactly what `GET /workspaces/{id}/reviews` does,
through the same service call and capability, under an `issues:read` credential
since the list shows pull requests and the issues they link.
"""

from __future__ import annotations

from typing import Any

from app.common.api.dependencies.authz import Capability, check_capability
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, object_schema
from app.domains.integrations.reviews import list_reviews


def _list_my_reviews(call: ToolCall) -> Any:
    """The pull requests waiting on the caller as a reviewer, grouped."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    return list_reviews(call.repositories, call.context).model_dump(mode="json")


REVIEW_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_my_reviews",
        description=(
            "Open pull requests waiting on the caller as a reviewer, grouped as needs_review, "
            "changes_requested and approved, each with its checks and the issues it links. "
            "Matched by the caller's linked GitHub account; github_linked is false when there is none."
        ),
        scopes=("issues:read",),
        schema=object_schema({}),
        handler=_list_my_reviews,
    ),
)
