"""Per-area isolation arguments for the MCP tools, merged by `test_mcp_tools`.

Each area module exports `arguments(foreign, home_issue)`, a map from tool name to
arguments naming the other workspace's rows, and `seed(repositories, workspace_id, team_id)`, extra foreign
rows by id, and `ANSWERS_AT_HOME`, the tools that
take no foreign id and so answer from the key's own workspace instead of refusing.
"""

from __future__ import annotations

from typing import Any, Callable

from tests.domains.integrations.mcp_isolation import issues, planning, teams, transitions, views, workspace

AREAS = (issues, planning, teams, transitions, views, workspace)

AREA_ARGUMENTS: tuple[Callable[[dict[str, str], str], dict[str, dict[str, Any]]], ...] = tuple(
    area.arguments for area in AREAS
)

AREA_SEEDS: tuple[Callable[[Any, str, str], dict[str, str]], ...] = tuple(area.seed for area in AREAS)

ANSWERS_AT_HOME: frozenset[str] = frozenset(name for area in AREAS for name in area.ANSWERS_AT_HOME)
