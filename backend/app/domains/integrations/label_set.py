"""The workspace label set: the workspace's labels pushed to every repository the installation can see.

A workspace admin turns it on in the workspace's GitHub settings. From then on
every repository of the installation carries each workspace label under its
GitHub name, colour and description, written by the same per-label code a team's
label sync uses. A repository a team syncs labels with is left to that team's
reconcile, which already carries the inherited workspace labels, and a public
repository is left out unless the admin includes public repositories, because
the push publishes the label names there.

The push runs as `github.label_set_push` jobs on the dispatch queue, one page of
repositories at a time in repository id order. Each page runs inside a GitHub
call budget, so a large installation never spends the share of the hour live
sync needs, and the job queues the next page itself, held back until the rate
limit resets when GitHub or the budget says to stop. A workspace label created,
renamed, recoloured or deleted queues a push from the start; a repository added
to the installation queues a push of just that repository. Only a repository
label Standupless created is deleted when its workspace label goes, and turning
the set off deletes nothing.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.github import WORKSPACE_LABEL_SYNC_TEAM, LabelSetSetting
from app.common.db.dynamo.team_config import Label
from app.domains.integrations import github_budget, github_issues
from app.domains.integrations.issue_sync import _enqueue, _Token
from app.domains.integrations.label_sync import SyncTarget, syncs_labels, write_labels

_log = logging.getLogger(__name__)

LABEL_SET_JOB = "github.label_set_push"
"""The dispatch job that pushes the workspace label set to one page of repositories."""

PAGE_SIZE = 10
"""The most repositories one job writes before it hands the rest to the next page."""

PAGE_SECONDS = 20.0
"""How long one page may spend on GitHub calls, inside the dispatch consumer's timeout."""

NEXT_PAGE_DELAY = 5
"""Seconds the next page waits when this one stopped for time or size rather than rate."""

RATE_DELAY_MIN = 60
"""The shortest wait before a page that GitHub or the budget stopped for rate runs again."""

RATE_DELAY_MAX = 900
"""The longest wait SQS allows on one message, which a later page simply waits again after."""


def enabled(repositories: Repositories, workspace_id: str) -> bool:
    """Whether the workspace pushes its label set to every repository."""
    return _setting(repositories, workspace_id) is not None


def _setting(repositories: Repositories, workspace_id: str) -> LabelSetSetting | None:
    """The workspace's label set setting, when it is on."""
    setting = repositories.github.get_label_set(workspace_id)
    return setting if setting is not None and setting.enabled else None


def enqueue_push(
    workspace_id: str,
    *,
    after: str = "",
    repository_ids: Iterable[str] | None = None,
    delay_seconds: int = 0,
) -> None:
    """Queue one page of the push, starting after the repository id `after`, limited to `repository_ids` when named."""
    payload: dict[str, Any] = {"kind": LABEL_SET_JOB, "workspace_id": workspace_id, "after": after}
    if repository_ids is not None:
        payload["repository_ids"] = sorted(str(repository_id) for repository_id in repository_ids)
    _enqueue(LABEL_SET_JOB, payload, workspace_id, delay_seconds=delay_seconds)


def queue_push(workspace_id: str, repository_ids: Iterable[str] | None = None) -> bool:
    """Queue a push from the first repository, answering whether the queue took it.

    A queue that refuses the job fails nothing: the next workspace label change
    queues the push again, and that one brings every repository up to date.
    """
    from botocore.exceptions import BotoCoreError, ClientError

    try:
        enqueue_push(workspace_id, repository_ids=repository_ids)
    except (BotoCoreError, ClientError):
        _log.warning(
            "Could not queue a workspace label set push.", extra={"event": "integrations.label_set.queue_failed"}
        )
        return False
    return True


def queue_on_change(repositories: Repositories, workspace_id: str) -> bool:
    """Queue a push of every repository after a workspace label changed, when the set is on."""
    if not workspace_id or not enabled(repositories, workspace_id):
        return False
    return queue_push(workspace_id)


def queue_added(repositories: Repositories, workspace_id: str, repository_ids: Iterable[str]) -> bool:
    """Queue a push of the repositories just added to the installation, when the set is on."""
    wanted = [str(repository_id) for repository_id in repository_ids if repository_id]
    if not wanted or not workspace_id or not enabled(repositories, workspace_id):
        return False
    return queue_push(workspace_id, wanted)


def push_page(repositories: Repositories, job: Mapping[str, Any]) -> None:
    """Write the workspace label set to one page of repositories, then queue the next page."""
    workspace_id = str(job.get("workspace_id", ""))
    setting = _setting(repositories, workspace_id) if workspace_id else None
    if setting is None:
        return
    installation = repositories.github.get_installation(workspace_id)
    if installation is None or installation.suspended_at is not None:
        return
    after = str(job.get("after", ""))
    named = job.get("repository_ids")
    wanted = {str(repository_id) for repository_id in named} if isinstance(named, list) else None
    pending = sorted(
        (
            row.repository_id
            for row in repositories.github.list_repositories(workspace_id)
            if _after(row.repository_id, after)
            and (wanted is None or row.repository_id in wanted)
            and (row.private or setting.include_public)
        ),
        key=_order,
    )
    if not pending:
        return
    labels = repositories.team_config.list_workspace_labels(workspace_id)
    token = _Token(str(installation.installation_id))
    cursor = after
    delay: int | None = None
    with github_budget.capped(PAGE_SECONDS):
        for repository_id in pending[:PAGE_SIZE]:
            try:
                _push_one(repositories, SyncTarget(workspace_id, repository_id), token, labels)
            except github_budget.BudgetSpent as error:
                delay = _until(error.budget.reset_at) if error.reason == github_budget.RATE else NEXT_PAGE_DELAY
                break
            except github_issues.GitHubRateLimited as error:
                delay = _clamp(error.retry_after)
                break
            except github_issues.GitHubUnavailable:
                delay = RATE_DELAY_MIN
                break
            except github_issues.GitHubError:
                _log.warning(
                    "GitHub refused the workspace label set for one repository.",
                    extra={"event": "integrations.label_set.repository_failed", "repository_id": repository_id},
                )
            cursor = repository_id
    if cursor == pending[-1]:
        return
    enqueue_push(
        workspace_id,
        after=cursor,
        repository_ids=wanted,
        delay_seconds=NEXT_PAGE_DELAY if delay is None else delay,
    )


def _push_one(repositories: Repositories, target: SyncTarget, token: _Token, labels: list[Label]) -> None:
    """Write the workspace labels to one repository, unless a team's label sync owns it.

    The rows considered are the set's own and any a team wrote for a workspace
    label, so a label a team once created keeps its `created` mark. Only the
    set's own rows are forgotten when their workspace label is gone.
    """
    if syncs_labels(repositories.github.team_sync_for_repository(target.workspace_id, target.repository_id)):
        return
    label_ids = {label.label_id for label in labels}
    rows = {
        row.label_id: row
        for row in repositories.github.list_label_syncs(target.workspace_id, target.repository_id)
        if row.team_id == WORKSPACE_LABEL_SYNC_TEAM or row.label_id in label_ids
    }
    write_labels(repositories, target, token, labels, rows, still_exists=lambda label_id: label_id in label_ids)


def _order(repository_id: str) -> tuple[int, str]:
    """A repository id's place in the push: numeric ids by value, anything else after them by text."""
    return (int(repository_id), "") if repository_id.isdigit() else (1 << 62, repository_id)


def _after(repository_id: str, cursor: str) -> bool:
    """Whether a repository comes after the cursor of the last page."""
    return not cursor or _order(repository_id) > _order(cursor)


def _clamp(seconds: float | None) -> int:
    """A wait in whole seconds, inside what SQS allows and no shorter than a rate stop deserves."""
    if seconds is None:
        return RATE_DELAY_MIN
    return max(RATE_DELAY_MIN, min(RATE_DELAY_MAX, int(seconds) + 1))


def _until(reset_at: datetime | None) -> int:
    """The wait until GitHub's rate limit resets, clamped to what one message may wait."""
    if reset_at is None:
        return RATE_DELAY_MIN
    return _clamp((reset_at - datetime.now(timezone.utc)).total_seconds())
