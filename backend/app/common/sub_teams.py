"""Sub-teams: a team under one parent team, inheriting its workflow statuses and labels.

Held in `common` because the team routes, the MCP tools and the workflow rules all
need the same answers, and the integrations image may not import another domain's
code.

Teams nest one level, as a start: a parent sits at the top and a team with
sub-teams takes no parent, which also rules out any cycle. Privacy stays per team,
so a parent's views roll up only the sub-teams the caller may read.
"""

from __future__ import annotations

from typing import Callable

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.teams import Team
from app.common.issue_rules import require_team_reader, unprocessable, visible_team_ids

OWN_PARENT = "A team cannot be its own parent team."

NO_SUCH_PARENT = "No such team: {team_id}"

PARENT_IS_SUB_TEAM = "{name} is a sub-team, and sub-teams nest one level. Choose a top-level team."

HAS_SUB_TEAMS = "{name} has sub-teams, so it cannot sit under another team. Move its sub-teams first."


def sub_team_ids(repositories: Repositories, workspace_id: str, team_id: str) -> list[str]:
    """Every live team directly under `team_id`, oldest first."""
    return [team.team_id for team in repositories.teams.list_sub_teams(workspace_id, team_id)]


def family(repositories: Repositories, workspace_id: str, team_id: str) -> list[str]:
    """`team_id` and every sub-team under it: the teams that see a change to its own statuses and labels."""
    return [team_id, *sub_team_ids(repositories, workspace_id, team_id)]


def check_parent(
    repositories: Repositories,
    workspace_id: str,
    team: Team | None,
    parent_team_id: str,
    *,
    can_see: Callable[[str], bool] | None = None,
) -> Team:
    """The team `parent_team_id` names, once it may take `team` as a sub-team, or a 422.

    `team` is `None` for a team being created. A parent the caller cannot read
    answers as missing, so the refusal does not reveal a private team.
    """
    if team is not None and parent_team_id == team.team_id:
        raise unprocessable(OWN_PARENT)
    parent = repositories.teams.get(workspace_id, parent_team_id)
    if parent is None or (can_see is not None and not can_see(parent_team_id)):
        raise unprocessable(NO_SUCH_PARENT.format(team_id=parent_team_id))
    if parent.parent_team_id:
        raise unprocessable(PARENT_IS_SUB_TEAM.format(name=parent.name))
    if team is not None and sub_team_ids(repositories, workspace_id, team.team_id):
        raise unprocessable(HAS_SUB_TEAMS.format(name=team.name))
    return parent


def listed_teams(
    repositories: Repositories, context: AuthzContext, team_id: str | None, *, include_sub_teams: bool = False
) -> list[str]:
    """The teams an issue list reads: every visible team, or the one named and, rolled up, its visible sub-teams.

    Naming a team the caller cannot read is a 404 as before. A sub-team the caller
    cannot see is left out of the roll-up rather than refusing it, as Linear does.
    """
    if team_id is None:
        return visible_team_ids(repositories, context)
    require_team_reader(repositories, context, team_id)
    if not include_sub_teams:
        return [team_id]
    subs = [sub for sub in sub_team_ids(repositories, context.workspace_id, team_id) if context.can_see_team(sub)]
    return [team_id, *subs]
