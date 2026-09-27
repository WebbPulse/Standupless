"""Label list and create, shared by the label routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a label an agent creates must be the same row a team admin's is.
"""

from __future__ import annotations

from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.teams import LabelCreate
from app.common.db.dynamo.team_config import Label, label_key, new_config_id


def ordered_labels(repositories: Repositories, workspace_id: str, team_id: str) -> list[Label]:
    """Every label of one team, in case-insensitive name order."""
    rows = repositories.team_config.list_labels(workspace_id, team_id)
    return sorted(rows, key=lambda row: row.name.lower())


def create_label(repositories: Repositories, workspace_id: str, team_id: str, payload: LabelCreate) -> Label:
    """Add a label to one team.

    The caller has already been held to team admin, by the route's dependency or
    by the tool, because the label set is a team setting every issue draws on.
    """
    label_id = new_config_id()
    return repositories.team_config.create_label(
        Label(
            workspace_id=workspace_id,
            config_key=label_key(team_id, label_id),
            team_id=team_id,
            label_id=label_id,
            name=payload.name,
            color=payload.color,
        )
    )
