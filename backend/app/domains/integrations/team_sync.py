"""Reading and saving one team's GitHub issue sync link.

Shared by the `github-sync` routes and the MCP tools, so the public repository
rule holds the same way however a link is written. A public repository syncs
GitHub to Standupless only, unless the team turns on `allow_public_two_way`,
which accepts that writing back publishes the team's issues on GitHub. Saving and
removing a link, and pinning a repository to a team, are recorded in the
workspace audit log here.
"""

from __future__ import annotations

from typing import Any

from webbpulse.dynamodb import ConditionFailed

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import TeamSync, team_sync_key
from app.domains.integrations.schemas.integrations import TeamSyncRead, TeamSyncWrite
from app.domains.integrations.service import conflict, unprocessable

PUBLIC_TWO_WAY = (
    "Two way sync is not available for a public repository, because it would publish this team's issues. "
    "Choose GitHub to Standupless instead, or allow two way sync on public repositories."
)

REPOSITORY_UNSEEN = "The GitHub App cannot see that repository."

REPOSITORY_TAKEN = "That repository already syncs with another team."


def team_sync_read(row: TeamSync, *, repository_private: bool = True) -> TeamSyncRead:
    """The public shape of one team's sync link, with its repository's visibility."""
    return TeamSyncRead.model_validate({**row.model_dump(), "repository_private": repository_private})


def repository_private(repositories: Repositories, workspace_id: str, repository_id: str) -> bool:
    """Whether the stored repository row says private, assuming private when the row is gone."""
    repository = repositories.github.get_repository(workspace_id, repository_id)
    return repository.private if repository is not None else True


def read_team_sync(repositories: Repositories, workspace_id: str, team_id: str) -> TeamSyncRead | None:
    """One team's sync link as the API answers it, or `None` when it has none."""
    row = repositories.github.get_team_sync(workspace_id, team_id)
    if row is None:
        return None
    return team_sync_read(row, repository_private=repository_private(repositories, workspace_id, row.repository_id))


def audit_fields(row: TeamSync) -> dict[str, Any]:
    """What the audit log keeps about a sync link: the repository, which way, and its switches."""
    return {
        "repository": row.full_name,
        "direction": row.direction,
        "enabled": row.enabled,
        "sync_labels": row.sync_labels,
        "allow_public_two_way": row.allow_public_two_way,
    }


def _record(
    repositories: Repositories,
    context: AuthzContext,
    event: str,
    team_id: str,
    *,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
) -> None:
    """Record one change to a team's sync link with the team as the target."""
    team = repositories.teams.get(context.workspace_id, team_id)
    audit.record(
        repositories,
        context,
        event,
        target_type="team",
        target_id=team_id,
        target_label=team.name if team is not None else "",
        before=before,
        after=after,
    )


def save_team_sync(
    repositories: Repositories, context: AuthzContext, team_id: str, payload: TeamSyncWrite
) -> TeamSyncRead:
    """Link a team to a repository the installation can see, or change the link.

    Raises a 422 for an unseen repository or for two way sync on a public one the
    team has not allowed, and a 409 when another team already syncs the
    repository. Saving an enabled link queues the backlink backfill.
    """
    workspace_id = context.workspace_id
    user_id = context.user_id
    repository = repositories.github.get_repository(workspace_id, payload.repository_id)
    if repository is None:
        raise unprocessable(REPOSITORY_UNSEEN)
    if not repository.private and payload.direction == "two_way" and not payload.allow_public_two_way:
        raise unprocessable(PUBLIC_TWO_WAY)
    now = utc_now()
    existing = repositories.github.get_team_sync(workspace_id, team_id)
    row = TeamSync(
        workspace_id=workspace_id,
        github_key=team_sync_key(team_id),
        team_id=team_id,
        repository_id=repository.repository_id,
        full_name=repository.full_name,
        direction=payload.direction,
        enabled=payload.enabled,
        sync_labels=payload.sync_labels,
        allow_public_two_way=payload.allow_public_two_way,
        public_demoted_at=(
            existing.public_demoted_at
            if existing is not None and existing.repository_id == repository.repository_id
            else None
        ),
        created_by=existing.created_by if existing is not None else user_id,
        created_at=existing.created_at if existing is not None else now,
        updated_at=now,
    )
    try:
        repositories.github.put_team_sync(row)
    except ConditionFailed:
        raise conflict(REPOSITORY_TAKEN) from None
    before = audit_fields(existing) if existing is not None else None
    after = audit_fields(row)
    changed = [name for name in after if before is None or before[name] != after[name]]
    if changed:
        _record(
            repositories,
            context,
            "github.sync_updated",
            team_id,
            before={name: before[name] for name in changed} if before is not None else None,
            after={name: after[name] for name in changed},
        )
    if row.enabled:
        from app.domains.integrations.issue_sync import backfill_backlinks

        backfill_backlinks(repositories, workspace_id, team_id)
    from app.domains.integrations.label_sync import queue_after_link, syncs_labels

    if syncs_labels(row):
        queue_after_link(workspace_id, team_id)
    return team_sync_read(row, repository_private=repository.private)


def remove_team_sync(repositories: Repositories, context: AuthzContext, team_id: str) -> bool:
    """Stop syncing a team and record it, or False when it had no link."""
    existing = repositories.github.get_team_sync(context.workspace_id, team_id)
    if not repositories.github.delete_team_sync(context.workspace_id, team_id):
        return False
    _record(
        repositories,
        context,
        "github.sync_removed",
        team_id,
        before=audit_fields(existing) if existing is not None else None,
    )
    return True


def _team_fields(repositories: Repositories, workspace_id: str, team_id: str | None) -> dict[str, Any]:
    """A pinned team as the audit log keeps it, by id and by name."""
    if team_id is None:
        return {"team_id": None, "team": None}
    team = repositories.teams.get(workspace_id, team_id)
    return {"team_id": team_id, "team": team.name if team is not None else None}


def record_pin(
    repositories: Repositories,
    context: AuthzContext,
    repository_id: str,
    full_name: str,
    before: str | None,
    after: str | None,
) -> None:
    """Record a repository being pinned to a team, moved to another, or unpinned, when it changed."""
    if before == after:
        return
    audit.record(
        repositories,
        context,
        "github.repository_unpinned" if after is None else "github.repository_pinned",
        target_type="repository",
        target_id=repository_id,
        target_label=full_name,
        before=_team_fields(repositories, context.workspace_id, before),
        after=_team_fields(repositories, context.workspace_id, after),
    )
