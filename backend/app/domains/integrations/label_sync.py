"""Label definition sync between a team and the GitHub repository it syncs with.

A team that links a repository with `sync_labels` on and writes back keeps the
repository's label set in step with its own: every label it can put on an issue
exists in the repository under its GitHub name, with its colour and description.
`reconcile` is the one outbound job. It is idempotent and reads both sides every
time, so any label change in the workspace queues it for every syncing team and
a run with nothing to do makes no write. Each label's `LabelSync` row remembers
the GitHub name it was last written under, which is how a rename is carried as a
rename rather than a delete and a create, and whether Standupless created the
repository label, because only a label it created is deleted from GitHub when
the team label goes. A label that was already in the repository is adopted by
name and left behind on a delete.

A rename made on GitHub arrives as a `label` delivery and is queued as a
`rename` job here, since the events consumer may not write team configuration.
It renames the matching team label, or overrides an inherited label's name in
the team, so every issue keeps carrying it. The issue sync snapshots are moved
to the new name with it, so the next issue push does not put the old name back.

A repository label renamed either way is renamed on every pull request that
carries it, so the names the pull request label mirror applied move with it,
and the App keeps owning them.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from fastapi import HTTPException

from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.teams import LabelUpdate, OverrideUpdate
from app.common.db.dynamo.github import WORKSPACE_LABEL_SYNC_TEAM, LabelSync, TeamSync, label_sync_key
from app.common.db.dynamo.team_config import TEAM_SCOPE, Label
from app.common.labels import github_label_names
from app.domains.integrations import github_issues
from app.domains.integrations.issue_sync import _enqueue, _Token, _writable, own_delivery

_log = logging.getLogger(__name__)

LABEL_SYNC_JOB = "github.label_sync"
"""The dispatch job that reconciles one team's labels with its repository."""

LABEL_RENAME_JOB = "github.label_rename"
"""The dispatch job that carries a GitHub label rename to the team label."""

_DEFINITION_FIELDS = ("name", "color", "description", "parent_id", "is_group", "hidden", "shown")


def syncs_labels(config: TeamSync | None) -> bool:
    """Whether a team sync carries label definitions to GitHub."""
    return config is not None and config.writes_back and config.sync_labels


def enqueue_label_sync(workspace_id: str, team_id: str) -> None:
    """Queue a reconcile of one team's labels with its repository."""
    _enqueue(LABEL_SYNC_JOB, {"kind": LABEL_SYNC_JOB, "workspace_id": workspace_id, "team_id": team_id}, workspace_id)


def queue_after_link(workspace_id: str, team_id: str) -> bool:
    """Queue the first reconcile for a team that just linked, answering whether it was queued.

    A queue that refuses the job does not fail the link: the next label change
    queues a reconcile again, and that one brings the repository up to date.
    """
    from botocore.exceptions import BotoCoreError, ClientError

    try:
        enqueue_label_sync(workspace_id, team_id)
    except (BotoCoreError, ClientError):
        _log.warning(
            "Could not queue a label sync for a new link.", extra={"event": "integrations.label_sync.queue_failed"}
        )
        return False
    return True


def definition_changed(old_image: Mapping[str, Any] | None, new_image: Mapping[str, Any] | None) -> bool:
    """Whether a label or label override row moved a field the repository's labels reflect."""
    if not old_image or not new_image:
        return bool(old_image or new_image)
    return any(old_image.get(field) != new_image.get(field) for field in _DEFINITION_FIELDS)


def queue_for_workspace(repositories: Repositories, workspace_id: str) -> int:
    """Queue a reconcile for every team of the workspace that syncs labels, returning how many."""
    queued = 0
    for config in repositories.github.list_team_syncs(workspace_id):
        if syncs_labels(config):
            enqueue_label_sync(workspace_id, config.team_id)
            queued += 1
    return queued


def _hex(color: str | None) -> str:
    """A colour as GitHub stores it: six lowercase hex digits."""
    return (color or "").lstrip("#").lower()


def _remote_by_name(entries: list[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    """The repository's labels keyed by lowered name, which is how GitHub tells them apart."""
    return {str(entry.get("name", "")).lower(): entry for entry in entries if entry.get("name")}


@dataclass(frozen=True)
class SyncTarget:
    """The repository one label set is written to, and the team it belongs to.

    `team_id` is `WORKSPACE_LABEL_SYNC_TEAM` for the workspace label set, which
    has no issue snapshots to move on a rename.
    """

    workspace_id: str
    repository_id: str
    team_id: str = WORKSPACE_LABEL_SYNC_TEAM


def reconcile(repositories: Repositories, job: Mapping[str, Any]) -> None:
    """Bring the repository's labels in line with the team's, one label at a time."""
    workspace_id = str(job.get("workspace_id", ""))
    team_id = str(job.get("team_id", ""))
    writable = _writable(repositories, workspace_id, team_id)
    if writable is None or not writable[0].sync_labels:
        return
    config, token = writable
    labels = repositories.team_config.list_labels(workspace_id, team_id)
    rows = {row.label_id: row for row in repositories.github.list_label_syncs(workspace_id, config.repository_id)}
    write_labels(
        repositories,
        SyncTarget(workspace_id, config.repository_id, team_id),
        token,
        labels,
        rows,
        still_exists=lambda label_id: repositories.team_config.get_label(workspace_id, team_id, label_id) is not None,
    )


def write_labels(
    repositories: Repositories,
    target: SyncTarget,
    token: _Token,
    labels: list[Label],
    rows: dict[str, LabelSync],
    *,
    still_exists: Callable[[str], bool],
) -> None:
    """Write `labels` to the target repository, then forget each row in `rows` no label claimed.

    A forgotten row's repository label is deleted only when Standupless created
    it and `still_exists` says its label is gone rather than hidden.
    """
    names = github_label_names(labels)
    remote = _remote_by_name(github_issues.list_labels(token(), target.repository_id))
    for label in labels:
        if label.is_group or label.hidden or label.label_id not in names:
            continue
        _sync_one(repositories, target, token, label, names[label.label_id], rows.pop(label.label_id, None), remote)
    for row in rows.values():
        if still_exists(row.label_id):
            continue
        if row.created:
            github_issues.delete_label(token(), target.repository_id, row.name)
        repositories.github.delete_label_sync(target.workspace_id, target.repository_id, row.label_id)
        _log.info("Removed a label's sync.", extra={"event": "integrations.label_sync.removed", "deleted": row.created})


def _sync_one(
    repositories: Repositories,
    target: SyncTarget,
    token: _Token,
    label: Label,
    name: str,
    row: LabelSync | None,
    remote: Mapping[str, Mapping[str, Any]],
) -> None:
    """Create, adopt, rename or recolour the repository label one label mirrors."""
    description = label.description or ""
    current = remote.get(row.name.lower()) if row is not None else None
    if current is None:
        current = remote.get(name.lower())
    created = row.created if row is not None else current is None
    try:
        if current is None:
            if not github_issues.create_label(
                token(), target.repository_id, name, label.color, description=description
            ):
                github_issues.update_label(
                    token(), target.repository_id, name, color=label.color, description=description
                )
                created = row.created if row is not None else False
        elif (
            str(current.get("name", "")) != name
            or _hex(str(current.get("color", ""))) != _hex(label.color)
            or (current.get("description") or "") != description
        ):
            github_issues.update_label(
                token(),
                target.repository_id,
                str(current.get("name", "")),
                new_name=name,
                color=label.color,
                description=description,
            )
    except github_issues.GitHubUnprocessable:
        _log.warning(
            "GitHub refused a label write, likely a name another repository label holds.",
            extra={"event": "integrations.label_sync.refused"},
        )
        return
    if row is not None and row.name != name:
        from app.domains.integrations.pr_labels import rename_applied

        if target.team_id:
            rename_in_snapshots(repositories, target.workspace_id, target.team_id, row.name, name)
        rename_applied(repositories, target.workspace_id, target.repository_id, row.name, name)
    updated = LabelSync(
        workspace_id=target.workspace_id,
        github_key=label_sync_key(target.repository_id, label.label_id),
        team_id=target.team_id,
        repository_id=target.repository_id,
        label_id=label.label_id,
        name=name,
        color=_hex(label.color),
        description=description,
        created=created,
    )
    if row is None or row.model_dump(exclude={"synced_at"}) != updated.model_dump(exclude={"synced_at"}):
        repositories.github.save_label_sync(updated)


def rename_in_snapshots(repositories: Repositories, workspace_id: str, team_id: str, old: str, new: str) -> int:
    """Move one label name in every synced issue's GitHub snapshot, returning how many moved.

    A lost race on one row is left to the next issue sync, which reads GitHub afresh.
    """
    from webbpulse.dynamodb import ConditionFailed

    moved = 0
    lowered = old.lower()
    for sync in repositories.github.list_issue_syncs(workspace_id, team_id):
        current = [str(name) for name in sync.github.get("labels") or []]
        if not any(name.lower() == lowered for name in current):
            continue
        renamed = sorted({new if name.lower() == lowered else name for name in current})
        try:
            repositories.github.save_issue_sync(
                sync.model_copy(update={"github": {**sync.github, "labels": renamed}}), expected_version=sync.version
            )
        except ConditionFailed:
            continue
        moved += 1
    return moved


def on_label_delivery(repositories: Repositories, workspace_id: str, body: Mapping[str, Any]) -> bool:
    """Queue the rename a `label` delivery carries, answering whether one was queued.

    Only an `edited` delivery that changed the name, from someone other than this
    App, for a repository a team syncs labels with, is carried.
    """
    if str(body.get("action", "")) != "edited" or own_delivery(body):
        return False
    changes = body.get("changes")
    renamed = changes.get("name") if isinstance(changes, Mapping) else None
    old = str(renamed.get("from", "")) if isinstance(renamed, Mapping) else ""
    label = body.get("label")
    new = str(label.get("name", "")) if isinstance(label, Mapping) else ""
    repository = body.get("repository")
    repository_id = str(repository.get("id", "")) if isinstance(repository, Mapping) else ""
    if not old or not new or old == new or not repository_id:
        return False
    config = repositories.github.team_sync_for_repository(workspace_id, repository_id)
    if config is None or not config.enabled or not config.sync_labels:
        return False
    _enqueue(
        LABEL_RENAME_JOB,
        {
            "kind": LABEL_RENAME_JOB,
            "workspace_id": workspace_id,
            "repository_id": repository_id,
            "old": old,
            "new": new,
        },
        workspace_id,
    )
    return True


def _matching_label(
    repositories: Repositories, config: TeamSync, old: str
) -> tuple[Label, dict[str, str], LabelSync | None] | None:
    """The team label the repository label `old` mirrors, the team's GitHub names, and its sync row."""
    labels = repositories.team_config.list_labels(config.workspace_id, config.team_id)
    names = github_label_names(labels)
    by_id = {label.label_id: label for label in labels}
    lowered = old.lower()
    for row in repositories.github.list_label_syncs(config.workspace_id, config.repository_id):
        if row.name.lower() == lowered and row.label_id in by_id:
            return by_id[row.label_id], names, row
    for label_id, name in names.items():
        if name.lower() == lowered:
            return by_id[label_id], names, None
    return None


def _team_name(repositories: Repositories, config: TeamSync, label: Label, new: str) -> str | None:
    """The name the team label takes for the GitHub name `new`, or `None` when it cannot carry it.

    A grouped label's GitHub name is `Group/Child`, so only a rename that keeps the
    group's prefix renames the child; any other new name has no place to go.
    """
    if not label.parent_id:
        return new
    group = repositories.team_config.get_label(config.workspace_id, config.team_id, label.parent_id)
    prefix = f"{group.name}/" if group is not None else ""
    if prefix and new.lower().startswith(prefix.lower()):
        return new[len(prefix) :] or None
    return None


def apply_rename(repositories: Repositories, job: Mapping[str, Any]) -> None:
    """Rename the team label a renamed repository label mirrors, keeping it on every issue."""
    from app.common import team_workflow

    workspace_id = str(job.get("workspace_id", ""))
    repository_id = str(job.get("repository_id", ""))
    old = str(job.get("old", ""))
    new = str(job.get("new", ""))
    config = repositories.github.team_sync_for_repository(workspace_id, repository_id)
    if config is None or not config.enabled or not config.sync_labels or not old or not new:
        return
    found = _matching_label(repositories, config, old)
    if found is None:
        return
    label, _, row = found
    team_name = _team_name(repositories, config, label, new)
    if team_name is None:
        _log.info("Skipped a label rename out of its group.", extra={"event": "integrations.label_sync.skipped"})
        return
    try:
        if team_name != label.name:
            if label.scope == TEAM_SCOPE:
                team_workflow.update_label(
                    repositories, workspace_id, config.team_id, label.label_id, LabelUpdate(name=team_name)
                )
            else:
                team_workflow.set_label_override(
                    repositories, workspace_id, config.team_id, label.label_id, OverrideUpdate(name=team_name)
                )
    except HTTPException:
        _log.warning(
            "Refused a GitHub label rename the team could not take.",
            extra={"event": "integrations.label_sync.rename_refused"},
        )
        return
    if row is not None:
        repositories.github.save_label_sync(row.model_copy(update={"name": new}))
    rename_in_snapshots(repositories, workspace_id, config.team_id, old, new)
    from app.domains.integrations.pr_labels import rename_applied

    rename_applied(repositories, workspace_id, repository_id, old, new)
    _log.info("Carried a GitHub label rename.", extra={"event": "integrations.label_sync.renamed"})
