"""The MCP tools for Pulse: the caller's feed of project and initiative updates, and what they follow.

Every tool runs the Pulse routes' own `app.common.pulse_reads` path, so the feed
holds exactly what the caller may read in the app, keyed by the credential's own
user, and no argument reaches another member's feed, read marker or follows.
Projects and initiatives are named by id or by an unambiguous name.
"""

from __future__ import annotations

from typing import Any

from app.common import pulse, pulse_reads
from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.planning import PulseFollowRead, PulseItemRead
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    enum,
    initiative_id_ref,
    limit,
    object_schema,
    page_properties,
    project_id_ref,
    string,
)

PROJECT_HELP = "The project: id or name"

INITIATIVE_HELP = "The initiative: id or name"


def _workspace_member(call: ToolCall) -> None:
    """Hold the capability every Pulse route declares."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)


def _item_json(item: PulseItemRead) -> dict[str, Any]:
    """One feed entry as the tools answer it."""
    return item.model_dump(mode="json")


def _follow_json(state: PulseFollowRead, **subject: str) -> dict[str, Any]:
    """A follow state with the subject it is about."""
    return {**subject, **state.model_dump(mode="json")}


def _list_pulse(call: ToolCall) -> Any:
    """One page of the caller's Pulse in the scope named."""
    _workspace_member(call)
    items, next_cursor = pulse_reads.list_pulse(
        call.repositories,
        call.context,
        scope=str(call.optional("scope") or "for_me"),
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
    )
    return {
        "items": [_item_json(item) for item in items],
        "next_cursor": next_cursor,
        "unread": pulse_reads.unread_count(call.repositories, call.context),
    }


def _mark_pulse_read(call: ToolCall) -> Any:
    """Mark the caller's whole Pulse read as of now."""
    _workspace_member(call)
    return {"read_at": pulse_reads.mark_read(call.repositories, call.context).isoformat()}


def _set_project_follow(call: ToolCall, following: bool) -> Any:
    """Follow or unfollow a project the caller may read."""
    _workspace_member(call)
    project_id = project_id_ref(call, call.require("project_id"))
    state = pulse_reads.set_project_follow(call.repositories, call.context, project_id, following)
    return _follow_json(state, project_id=project_id)


def _set_initiative_follow(call: ToolCall, following: bool) -> Any:
    """Follow or unfollow an initiative."""
    _workspace_member(call)
    initiative_id = initiative_id_ref(call, call.require("initiative_id"))
    state = pulse_reads.set_initiative_follow(call.repositories, call.context, initiative_id, following)
    return _follow_json(state, initiative_id=initiative_id)


def _follow_project(call: ToolCall) -> Any:
    """Follow a project in Pulse."""
    return _set_project_follow(call, True)


def _unfollow_project(call: ToolCall) -> Any:
    """Unfollow a project in Pulse."""
    return _set_project_follow(call, False)


def _follow_initiative(call: ToolCall) -> Any:
    """Follow an initiative in Pulse."""
    return _set_initiative_follow(call, True)


def _unfollow_initiative(call: ToolCall) -> Any:
    """Unfollow an initiative in Pulse."""
    return _set_initiative_follow(call, False)


PULSE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_pulse",
        description=(
            "One page of the caller's Pulse: project and initiative updates, health changes and completed "
            "milestones. Scope for_me (the default) holds what the caller leads, is a member of, owns or follows, "
            "newest first; recent holds everything they may read, newest first; popular ranks the project and "
            "initiative updates they may read from the last 14 days by replies plus reactions, newest first among "
            "equals. Each entry says whether it is unread, and the answer carries the unread count."
        ),
        scopes=("projects:read",),
        schema=object_schema(
            {"scope": enum(pulse.PULSE_SCOPES, "Which feed: for_me, popular or recent"), **page_properties()},
        ),
        handler=_list_pulse,
    ),
    Tool(
        name="mark_pulse_read",
        description="Mark everything in the caller's Pulse read as of now.",
        scopes=("projects:write",),
        schema=object_schema({}),
        handler=_mark_pulse_read,
    ),
    Tool(
        name="follow_project",
        description="Follow a project in the caller's Pulse, so its updates, health and milestones reach it.",
        scopes=("projects:write",),
        schema=object_schema({"project_id": string(PROJECT_HELP)}, required=("project_id",)),
        handler=_follow_project,
    ),
    Tool(
        name="unfollow_project",
        description="Unfollow a project in the caller's Pulse, even one they lead or are a member of.",
        scopes=("projects:write",),
        schema=object_schema({"project_id": string(PROJECT_HELP)}, required=("project_id",)),
        handler=_unfollow_project,
    ),
    Tool(
        name="follow_initiative",
        description="Follow an initiative in the caller's Pulse, and with it every project inside it.",
        scopes=("projects:write",),
        schema=object_schema({"initiative_id": string(INITIATIVE_HELP)}, required=("initiative_id",)),
        handler=_follow_initiative,
    ),
    Tool(
        name="unfollow_initiative",
        description="Unfollow an initiative in the caller's Pulse, even one they own.",
        scopes=("projects:write",),
        schema=object_schema({"initiative_id": string(INITIATIVE_HELP)}, required=("initiative_id",)),
        handler=_unfollow_initiative,
    ),
)
