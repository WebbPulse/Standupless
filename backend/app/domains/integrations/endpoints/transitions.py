"""Per-team rules for what a pull request event does to an issue's status.

A team with no stored rules behaves as design section 4 says, and the read
returns those defaults marked `is_default` rather than an empty list, so the
frontend can show what will actually happen without restating the defaults itself.
Writing any rule replaces the defaults entirely, which is what makes "disable the
merge transition" expressible. A rule may name a target branch pattern, and the
PUT swaps the whole set at once, which is how a preset such as "merged into
staging is On Staging, merged into main is Done" is applied.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.domains.integrations.schemas.integrations import (
    TransitionCreate,
    TransitionRead,
    TransitionSet,
    TransitionUpdate,
)
from app.domains.integrations.service import (
    conflict,
    effective_transitions,
    new_transition,
    not_found,
    replace_team_transitions,
    transition_read,
    unprocessable,
)

router = APIRouter()


def _require_team(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the team exists in this workspace, or 404."""
    if repositories.teams.get(context.workspace_id, team_id) is None:
        raise not_found()


def _check_status(repositories: Repositories, context: AuthzContext, team_id: str, status_id: str | None) -> None:
    """Hold that a named status belongs to this team.

    A rule pointing at a status of another team would move an issue into a
    status its board cannot render, so it is refused on write rather than skipped
    at transition time where nobody would see the mistake.
    """
    if status_id is None:
        return
    if repositories.team_config.get_status(context.workspace_id, team_id, status_id) is None:
        raise unprocessable("The status does not belong to this team.")


@router.get("/{workspace_id}/teams/{team_id}/github-transitions", response_model=list[TransitionRead])
def list_transitions(
    team_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> list[TransitionRead]:
    """What this team actually does on each pull request event."""
    _require_team(repositories, context, team_id)
    stored = repositories.team_config.list_transitions(context.workspace_id, team_id)
    statuses = repositories.team_config.list_statuses(context.workspace_id, team_id)
    return effective_transitions(team_id, stored, statuses)


@router.post(
    "/{workspace_id}/teams/{team_id}/github-transitions",
    response_model=TransitionRead,
    status_code=status.HTTP_201_CREATED,
)
def create_transition(
    team_id: Annotated[str, Path(min_length=1)],
    payload: TransitionCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TransitionRead:
    """Add the rule for one trigger and branch pattern, which must not already have one."""
    _require_team(repositories, context, team_id)
    _check_status(repositories, context, team_id, payload.status_id)

    stored = repositories.team_config.list_transitions(context.workspace_id, team_id)
    pattern = payload.branch_pattern or ""
    if any(row.trigger == payload.trigger and row.branch_pattern == pattern for row in stored):
        raise conflict("That trigger already has a rule for that branch pattern.")
    row = new_transition(context.workspace_id, team_id, payload)
    return transition_read(repositories.team_config.create_transition(row))


@router.put(
    "/{workspace_id}/teams/{team_id}/github-transitions",
    response_model=list[TransitionRead],
)
def replace_transitions(
    team_id: Annotated[str, Path(min_length=1)],
    payload: TransitionSet,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> list[TransitionRead]:
    """Replace the team's whole rule set, an empty list restoring the defaults."""
    _require_team(repositories, context, team_id)
    return replace_team_transitions(repositories, context.workspace_id, team_id, payload.rules)


@router.patch(
    "/{workspace_id}/teams/{team_id}/github-transitions/{transition_id}",
    response_model=TransitionRead,
)
def update_transition(
    team_id: Annotated[str, Path(min_length=1)],
    transition_id: str,
    payload: TransitionUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TransitionRead:
    """Repoint one rule at another status or at none, or change its branch pattern."""
    _require_team(repositories, context, team_id)
    _check_status(repositories, context, team_id, payload.status_id)
    current = repositories.team_config.get_transition(context.workspace_id, team_id, transition_id)
    if current is None:
        raise not_found()
    attributes: dict[str, str] = {}
    if "status_id" in payload.model_fields_set:
        attributes["status_id"] = payload.status_id or ""
    if "branch_pattern" in payload.model_fields_set:
        pattern = payload.branch_pattern or ""
        stored = repositories.team_config.list_transitions(context.workspace_id, team_id)
        if any(
            row.transition_id != transition_id and row.trigger == current.trigger and row.branch_pattern == pattern
            for row in stored
        ):
            raise conflict("That trigger already has a rule for that branch pattern.")
        attributes["branch_pattern"] = pattern
    if not attributes:
        return transition_read(current)
    updated = repositories.team_config.update_transition(
        context.workspace_id,
        team_id,
        transition_id,
        **attributes,
    )
    if updated is None:
        raise not_found()
    return transition_read(updated)


@router.delete(
    "/{workspace_id}/teams/{team_id}/github-transitions/{transition_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_transition(
    team_id: Annotated[str, Path(min_length=1)],
    transition_id: str,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Remove one rule. Removing the last one restores the defaults."""
    _require_team(repositories, context, team_id)
    if not repositories.team_config.delete_transition(context.workspace_id, team_id, transition_id):
        raise not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
