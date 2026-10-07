"""Isolation arguments for the release MCP tools.

Every release tool names its team first, and a team of another workspace is not
visible to the key, so each call refuses before any release is read.
"""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.releases import Release, new_release_id, release_key
from tests.domains.helpers import OWNER

ANSWERS_AT_HOME: frozenset[str] = frozenset()


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """One release on the other workspace's team."""
    release_id = new_release_id()
    repositories.releases.create(
        Release(
            workspace_id=workspace_id,
            planning_key=release_key(team_id, release_id),
            release_id=release_id,
            team_id=team_id,
            name="Classified release",
            source="manual",
            stages=[],
            created_by=OWNER,
        )
    )
    return {"release_id": release_id}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's team and release, one set per tool."""
    team = foreign["team_id"]
    release = {"team_id": team, "release_id": foreign["release_id"]}
    return {
        "list_releases": {"team_id": team},
        "get_release": release,
        "create_release": {"team_id": team, "name": "Should not land", "issues": [home_issue]},
        "advance_release": {**release, "stage": "Production"},
        "update_release": {**release, "name": "Should not land"},
        "add_issues_to_release": {**release, "issues": [home_issue]},
        "remove_issue_from_release": {**release, "issue": home_issue},
        "delete_release": release,
        "get_release_pipeline": {"team_id": team},
        "set_release_pipeline": {"team_id": team, "stages": [{"name": "Should not land"}]},
    }
