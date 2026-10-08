"""The MCP tool that reads the workspace audit log.

It checks the capability the audit log route requires and runs the same
`app.common.audit.list_page` the route runs, so plan gating, filters and cursors
are identical on both surfaces. A plan without the audit log is refused with a
message naming the plan to upgrade to, rather than an empty page an agent could
mistake for a quiet workspace.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from app.common import audit
from app.common.api.dependencies.authz import Capability, check_capability
from app.domains.integrations.mcp.toolkit import (
    MAX_RESULTS,
    NOT_VISIBLE,
    Tool,
    ToolCall,
    enum,
    object_schema,
    page_properties,
    string,
)
from app.domains.integrations.mcp.transport import ToolError

UNAVAILABLE = "The audit log is part of the Business plan; upgrade the workspace to read it"


def _actor(call: ToolCall, value: Any) -> Optional[str]:
    """The actor filter as an id, from `me`, an id or a member's email address.

    A bare id is taken as given, so events by a member who has since left, or by
    `system` or `stripe`, can still be filtered on.
    """
    if value is None:
        return None
    reference = str(value).strip()
    if not reference:
        return None
    if reference == "me":
        return call.context.user_id
    if "@" not in reference:
        return reference
    user = call.repositories.users.get_by_email(reference.lower())
    if user is None or call.repositories.memberships.get(call.context.workspace_id, user.id) is None:
        raise ToolError(NOT_VISIBLE)
    return user.id


def _moment(call: ToolCall, name: str) -> Optional[datetime]:
    """An ISO 8601 date or date and time argument, or None when absent."""
    value = call.optional(name)
    if value is None or str(value).strip() == "":
        return None
    try:
        return datetime.fromisoformat(str(value).strip())
    except ValueError as exc:
        raise ToolError(f"{name} must be an ISO 8601 date or date and time, such as 2026-10-01") from exc


def _list_audit_events(call: ToolCall) -> Any:
    """One page of the audit log, newest first, filtered by actor, event type and date."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    raw_limit = call.optional("limit")
    try:
        size = int(raw_limit) if raw_limit is not None else 20
    except (TypeError, ValueError):
        size = 20
    page = audit.list_page(
        call.repositories,
        call.context.workspace_id,
        actor_id=_actor(call, call.optional("actor")),
        event=call.optional("event"),
        since=_moment(call, "since"),
        until=_moment(call, "until"),
        limit=max(1, min(size, MAX_RESULTS)),
        cursor=call.optional("cursor"),
    )
    if not page.available:
        raise ToolError(UNAVAILABLE)
    return page.model_dump(mode="json", exclude={"event_types", "available"})


AUDIT_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_audit_events",
        description="The workspace audit log, newest first: member joins, removals and role changes, invites, "
        "authentication policy, API keys, connected apps, exports, settings, plan and team changes, each with "
        "actor, client, IP and before and after values. Filter by actor, event and a date range. Needs "
        "workspace owner or admin and the Business plan.",
        scopes=("settings:read", "admin"),
        schema=object_schema(
            {
                "actor": string("Only events by this actor: 'me', a member's email address, or a user id"),
                "event": enum(audit.EVENT_TYPES, "Only events of this type"),
                "since": string("Only events at or after this ISO 8601 date or date and time"),
                "until": string("Only events before this ISO 8601 date or date and time"),
                **page_properties(),
            }
        ),
        handler=_list_audit_events,
    ),
)
