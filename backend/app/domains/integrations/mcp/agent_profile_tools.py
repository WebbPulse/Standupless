"""The MCP tools over the caller's private agent profiles.

A profile is keyed by the person behind the credential and never by the workspace
it is bound to, so the same profile answers from any workspace's token and no
other member, admin or workspace key can reach it. A workspace key acts for no
person and is refused.

Restoring is the agent's own job: `get_agent_profile` answers each file with its
root and a path relative to it, and the agent writes them with its own file tools,
asking before it overwrites anything that differs.
"""

from __future__ import annotations

from typing import Any

from webbpulse.audit import AuditActor

from app.common import agent_profiles
from app.common.db.dynamo.api_keys import is_service_subject
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, object_schema, string
from app.domains.integrations.mcp.transport import ToolError

PERSON_ONLY = "Agent profiles belong to a person; a workspace key keeps none"


def _person(call: ToolCall) -> str:
    """The caller's user id, refusing a credential that acts for no person."""
    user_id = call.context.user_id
    if not user_id or is_service_subject(user_id):
        raise ToolError(PERSON_ONLY)
    return user_id


def _actor(call: ToolCall) -> AuditActor:
    """The caller as their own trail records them."""
    context = call.context
    return AuditActor(
        id=context.user_id, kind=context.actor.value, source=context.source or "mcp", ip=context.ip, amr=context.amr
    )


def _guarded(handler: Any) -> Any:
    """Run one handler, turning the store's refusals into tool errors carrying their message."""

    def run(call: ToolCall) -> Any:
        """Call the handler for the caller's own profiles."""
        try:
            return handler(call, _person(call))
        except agent_profiles.AgentProfileError as exc:
            raise ToolError(exc.message) from exc

    run.__doc__ = handler.__doc__
    return run


def _save(call: ToolCall, user_id: str) -> Any:
    """Store the files as the profile's next version, refusing credentials and unsafe paths."""
    saved = agent_profiles.save_profile(
        call.repositories,
        user_id,
        call.require("name"),
        call.require("files"),
        call.optional("note"),
        _actor(call),
    )
    return saved.model_dump(mode="json")


def _get(call: ToolCall, user_id: str) -> Any:
    """One version's files, the latest unless a version is named."""
    snapshot = agent_profiles.read_profile(
        call.repositories, user_id, call.require("name"), call.optional("version"), _actor(call)
    )
    return snapshot.model_dump(mode="json")


def _list(call: ToolCall, user_id: str) -> Any:
    """Every profile the caller keeps."""
    return agent_profiles.list_profiles(call.repositories, user_id).model_dump(mode="json")


def _versions(call: ToolCall, user_id: str) -> Any:
    """A profile's kept versions, newest first."""
    return agent_profiles.list_versions(call.repositories, user_id, call.require("name")).model_dump(mode="json")


def _delete(call: ToolCall, user_id: str) -> Any:
    """Remove a profile and every kept version of it."""
    name = call.require("name")
    removed = agent_profiles.delete_profile(call.repositories, user_id, name, _actor(call))
    return {"deleted": str(name).strip(), "versions_removed": removed}


FILE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "root": {
            "type": "string",
            "enum": list(agent_profiles.ROOTS),
            "description": "home for files under the home directory such as .claude/CLAUDE.md, project for "
            "untracked files in the project checkout, memory for Claude Code's memory folder of the project",
        },
        "path": string("The path relative to the root, with forward slashes, such as .claude/CLAUDE.md or MEMORY.md"),
        "content": string("The file's full text"),
    },
    "required": ["root", "path", "content"],
    "additionalProperties": False,
}

NAME = string("The profile name: letters, digits, dots, hyphens or underscores, such as work-laptop")

AGENT_PROFILE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="save_agent_profile",
        description="Save local agent guidance as a new version of one of your private agent profiles, so another "
        "machine can restore it: ~/.claude/CLAUDE.md as root home, a project's untracked CLAUDE.md as root project, "
        "and Claude Code's memory folder (MEMORY.md and each memory file) as root memory, optionally skills and "
        "settings.json under home. Only you can read your profiles, whatever workspace this credential is bound "
        f"to. Saving files identical to the latest version adds no version; the last {agent_profiles.VERSIONS_KEPT} "
        "versions are kept. Refused, naming the file and line, when any line looks like a credential.",
        scopes=("settings:write",),
        schema=object_schema(
            {
                "name": NAME,
                "files": {
                    "type": "array",
                    "items": FILE_SCHEMA,
                    "minItems": 1,
                    "maxItems": agent_profiles.MAX_FILES,
                    "description": "Every file of the profile; files left out are not in the new version",
                },
                "note": string("What changed in this version, shown in the version list"),
            },
            ("name", "files"),
        ),
        handler=_guarded(_save),
        idempotent=True,
    ),
    Tool(
        name="get_agent_profile",
        description="Read one version of your private agent profile to restore it on this machine, the latest "
        "unless a version is named. Each file comes with its root and a path relative to it, and roots explains "
        "where each root is on this machine. Write the files with your own file tools, and ask before overwriting "
        "a file whose content differs.",
        scopes=("settings:read",),
        schema=object_schema(
            {
                "name": NAME,
                "version": {
                    "type": ["integer", "string"],
                    "description": "A version number from list_agent_profile_versions, or latest",
                },
            },
            ("name",),
        ),
        handler=_guarded(_get),
    ),
    Tool(
        name="list_agent_profiles",
        description="Your private agent profiles, with each one's latest version, file count and size.",
        scopes=("settings:read",),
        schema=object_schema({}),
        handler=_guarded(_list),
    ),
    Tool(
        name="list_agent_profile_versions",
        description="The kept versions of one of your agent profiles, newest first, with each version's note, "
        "file count, size, digest and the client it was saved through, for picking one to roll back to.",
        scopes=("settings:read",),
        schema=object_schema({"name": NAME}, ("name",)),
        handler=_guarded(_versions),
    ),
    Tool(
        name="delete_agent_profile",
        description="Delete one of your agent profiles and every kept version of it. This cannot be undone.",
        scopes=("settings:write",),
        schema=object_schema({"name": NAME}, ("name",)),
        handler=_guarded(_delete),
        destructive=True,
    ),
)
