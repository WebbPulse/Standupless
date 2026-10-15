"""Isolation arguments for the agent profile tools.

Profiles belong to the person behind the key rather than to any workspace, so
these tools take no foreign id and answer from the caller's own profiles.
"""

from __future__ import annotations

from typing import Any

ANSWERS_AT_HOME: frozenset[str] = frozenset(
    {
        "save_agent_profile",
        "get_agent_profile",
        "list_agent_profiles",
        "list_agent_profile_versions",
        "delete_agent_profile",
    }
)


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """No foreign rows: a profile lives outside every workspace."""
    return {}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming one of the caller's own profiles, one set per tool."""
    return {
        "save_agent_profile": {
            "name": "isolation",
            "files": [{"root": "home", "path": ".claude/CLAUDE.md", "content": "hello"}],
        },
        "get_agent_profile": {"name": "isolation"},
        "list_agent_profiles": {},
        "list_agent_profile_versions": {"name": "isolation"},
        "delete_agent_profile": {"name": "isolation"},
    }
