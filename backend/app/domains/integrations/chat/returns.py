"""Where a chat App install sends the browser back to once it finishes.

The settings page the install started from, a team's or the workspace's, with the
outcome in one query parameter the page turns into a toast.
"""

from __future__ import annotations

from typing import Any, Mapping
from urllib.parse import urlencode

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.domains.integrations.outbound.payloads import Links


def return_url(repositories: Repositories, claims: Mapping[str, Any], param: str, outcome: str) -> str:
    """The settings page an install started from, carrying `param=outcome`."""
    query = urlencode({param: outcome})
    workspace_id = str(claims.get("workspace_id", ""))
    workspace = repositories.workspaces.get(workspace_id) if workspace_id else None
    if workspace is None:
        return f"{settings.frontend_base_url}/workspaces?{query}"
    links = Links(repositories, workspace_id)
    team_id = str(claims.get("team_id", ""))
    if team_id and links.team_prefix(team_id):
        return f"{links.team_settings(team_id)}?{query}"
    return f"{settings.frontend_base_url}/w/{workspace.slug}/settings?{query}"
