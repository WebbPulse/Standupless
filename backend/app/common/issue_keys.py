"""An issue's key as readers see it: the team's current prefix and the stored number.

Rows keep the key they were created with. A team key change retires the old
prefix into an alias row rather than rewriting every issue, so each response
boundary swaps the stored prefix for the team's current one here. The lookup is
one team read per team, cached in process for a short while, so a hot path pays
for it once per warm function rather than once per issue.
"""

from __future__ import annotations

import re
import time
from typing import Any, Iterable, Mapping, TypeVar

from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.teams import TeamRepository

CACHE_SECONDS = 60.0

_cache: dict[tuple[str, str], tuple[float, str | None]] = {}

IssueT = TypeVar("IssueT", bound=Issue)

REFERENCE = re.compile(r"\b([A-Z][A-Z0-9]{1,5})-(\d+)\b")
"""An issue key written in free text, such as a standup note."""


def clear() -> None:
    """Drop every cached prefix."""
    _cache.clear()


def forget(workspace_id: str, team_id: str) -> None:
    """Drop one team's cached prefix, after its key changed in this process."""
    _cache.pop((workspace_id, team_id), None)


def current_prefix(teams: TeamRepository, workspace_id: str, team_id: str) -> str | None:
    """The team's current key prefix, or `None` when the team is gone."""
    if not workspace_id or not team_id:
        return None
    now = time.monotonic()
    cached = _cache.get((workspace_id, team_id))
    if cached is not None and now - cached[0] < CACHE_SECONDS:
        return cached[1]
    team = teams.get(workspace_id, team_id)
    prefix = team.key_prefix if team is not None and team.key_prefix else None
    _cache[(workspace_id, team_id)] = (now, prefix)
    return prefix


def display_key(teams: TeamRepository, workspace_id: str, team_id: str, stored_key: str) -> str:
    """`stored_key` under the team's current prefix, or unchanged when that is unknown."""
    head, separator, number = stored_key.rpartition("-")
    if not separator or not head or not number.isdigit():
        return stored_key
    prefix = current_prefix(teams, workspace_id, team_id)
    if not prefix or prefix == head:
        return stored_key
    return f"{prefix}-{number}"


def current(teams: TeamRepository, issue: IssueT) -> IssueT:
    """A copy of `issue` carrying its current key, or the issue itself when unchanged."""
    key = display_key(teams, issue.workspace_id, issue.team_id, issue.key)
    return issue if key == issue.key else issue.model_copy(update={"key": key})


def current_all(teams: TeamRepository, issues: Iterable[IssueT]) -> list[IssueT]:
    """Every issue carrying its current key, in the order given."""
    return [current(teams, issue) for issue in issues]


def retired_prefixes(teams: TeamRepository, workspace_id: str) -> dict[str, str]:
    """Each retired prefix of the workspace mapped to the current prefix of the live team it resolves to."""
    aliases = teams.aliases_by_team(workspace_id)
    if not aliases:
        return {}
    live = {team.team_id: team.key_prefix for team in teams.list_for_workspace(workspace_id) if team.key_prefix}
    held = set(live.values())
    return {
        old: live[team_id] for team_id, olds in aliases.items() if team_id in live for old in olds if old not in held
    }


def current_references(text: str, renames: Mapping[str, str]) -> str:
    """`text` with every issue key under a retired prefix rewritten to the team's current prefix."""
    if not renames or not text:
        return text

    def swap(match: re.Match[str]) -> str:
        prefix = renames.get(match.group(1))
        return f"{prefix}-{match.group(2)}" if prefix else match.group(0)

    return REFERENCE.sub(swap, text)


def is_issue_reference(value: Any) -> bool:
    """Whether an activity value names an issue by id and key, as relation and sub-issue rows do."""
    return isinstance(value, dict) and isinstance(value.get("id"), str) and isinstance(value.get("key"), str)


def current_reference_value(value: Any, renames: Mapping[str, str]) -> Any:
    """An activity value with the key of each issue it names under the team's current prefix.

    Relation and sub-issue rows store the key the far issue had when the row was
    written, so a team key change would leave them printing a retired prefix. Only
    the stored key is swapped; the id, which the reader links by, is kept.
    """
    if not renames:
        return value
    if isinstance(value, list):
        return [current_reference_value(item, renames) for item in value]
    if not is_issue_reference(value):
        return value
    head, separator, number = value["key"].rpartition("-")
    prefix = renames.get(head) if separator and number.isdigit() else None
    return {**value, "key": f"{prefix}-{number}"} if prefix else value
