"""Carry the labels of linked issues onto the pull requests that name them.

A pull request linked to issues carries the union of their label names, and keeps
carrying it as labels move on either side. The events consumer queues a job when
a linked pull request is opened, edited, synchronised, reopened or marked ready,
and the stream consumer queues one for every open pull request linked to an issue
whose labels changed. The job runs on the dispatch queue like every other GitHub
write, so an outage retries the job alone.

The App only ever removes what it added. The names it applied are recorded on the
pull request's links as `applied_labels`, and a removal is limited to a recorded
name that no linked issue still carries, so a label a person put on the pull
request stays whatever the issues say. A missing repository label is created with
the Standupless label's color first, because GitHub refuses to apply a name the
repository does not have.

An issue a later delivery no longer names is marked `detached` on its link, which
is how editing a key out of the description removes the labels that issue alone
contributed. Closed and merged pull requests are left alone, judged both from the
newest link and from GitHub's own answer before any write.

Loops are cut in two places. The job's own writes raise `labeled` and `unlabeled`
deliveries, and those actions queue nothing; a delivery the App's bot sent queues
nothing either, the same sender check issue sync uses. And the job writes only
the `github` table, which the stream consumer does not read, so applying labels
never raises the issue write that would queue another job.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping, Sequence

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.github import IssueLink
from app.domains.integrations import github_issues

_log = logging.getLogger(__name__)

PR_LABELS_JOB = "github.pr_labels"

DELIVERY_ACTIONS = frozenset({"opened", "edited", "synchronize", "reopened", "ready_for_review"})
"""The pull request actions that queue a label sync. `labeled` and `unlabeled` are absent on purpose."""

FINISHED_STATES = frozenset({"closed", "merged"})


def pr_node_id(link_id: str) -> str:
    """The pull request part of a link id, which is `<pr_node_id>#<issue_id>`."""
    return link_id.rsplit("#", 1)[0]


def enqueue_pr_labels(workspace_id: str, node_id: str) -> None:
    """Queue a label sync for one pull request, when this environment has a dispatch queue."""
    from webbpulse.events import EventEnvelope, enqueue

    if not settings.WEBHOOK_DISPATCH_QUEUE_URL or not workspace_id or not node_id:
        return
    enqueue(
        settings.WEBHOOK_DISPATCH_QUEUE_URL,
        EventEnvelope(
            name=PR_LABELS_JOB,
            payload={"kind": PR_LABELS_JOB, "workspace_id": workspace_id, "pr_node_id": node_id},
            scope=workspace_id,
        ),
    )


def after_delivery(
    repositories: Repositories,
    workspace_id: str,
    body: Mapping[str, Any],
    node_id: str,
    pr_updated_ms: int,
    named_link_ids: Sequence[str],
) -> None:
    """Detach the links a pull request delivery no longer names, then queue the label sync.

    Called only for a delivery no link refused as stale, so the detach carries a
    stamp no older than any link it touches.
    """
    from app.domains.integrations.issue_sync import own_delivery

    if str(body.get("action", "")) not in DELIVERY_ACTIONS:
        return
    links = repositories.github.list_links_for_pr(workspace_id, node_id)
    if not links:
        return
    named = set(named_link_ids)
    for link in links:
        if link.link_id not in named and not link.detached:
            repositories.github.detach_link(workspace_id, link.link_id, pr_updated_ms)
    if own_delivery(body):
        return
    enqueue_pr_labels(workspace_id, node_id)


def after_issue_labels(repositories: Repositories, workspace_id: str, issue_id: str, team_id: str) -> int:
    """Queue a label sync for every open pull request linked to one issue, answering how many."""
    if not settings.WEBHOOK_DISPATCH_QUEUE_URL or not workspace_id or not issue_id:
        return 0
    team = repositories.teams.get(workspace_id, team_id) if team_id else None
    if team is None or not team.sync_pr_labels:
        return 0
    page = repositories.github.list_links_for_issue(workspace_id, issue_id, limit=100)
    queued: set[str] = set()
    for item in page.items:
        link = IssueLink.model_validate(dict(item))
        if link.detached or link.pr_state in FINISHED_STATES:
            continue
        node_id = pr_node_id(link.link_id)
        if node_id not in queued:
            queued.add(node_id)
            enqueue_pr_labels(workspace_id, node_id)
    return len(queued)


def _repository_id(repositories: Repositories, workspace_id: str, links: Sequence[IssueLink]) -> str:
    """The numeric repository id of a pull request, read by name for links written before they carried it."""
    stored = next((link.repository_id for link in links if link.repository_id), "")
    if stored:
        return stored
    full_name = next((link.repository_full_name for link in links if link.repository_full_name), "").lower()
    for row in repositories.github.list_repositories(workspace_id):
        if row.full_name.lower() == full_name:
            return row.repository_id
    return ""


def _wanted(
    repositories: Repositories, workspace_id: str, links: Sequence[IssueLink]
) -> tuple[dict[str, tuple[str, str]], bool]:
    """The labels the pull request should carry, keyed by lowered name, and whether any team syncs them.

    Every link counts towards whether a team has the sync on, so a pull request
    whose last issue was detached still sheds the labels that issue brought.
    Only the links still named contribute labels.
    """
    issues = repositories.issues.get_many(workspace_id, sorted({link.issue_id for link in links}))
    enabled: dict[str, bool] = {}
    for issue in issues.values():
        if issue.team_id not in enabled:
            team = repositories.teams.get(workspace_id, issue.team_id)
            enabled[issue.team_id] = team is not None and team.sync_pr_labels
    named = {link.issue_id for link in links if not link.detached}
    wanted: dict[str, tuple[str, str]] = {}
    palettes: dict[str, dict[str, Any]] = {}
    for issue_id in sorted(named):
        issue = issues.get(issue_id)
        if issue is None or not enabled.get(issue.team_id) or not issue.label_ids:
            continue
        if issue.team_id not in palettes:
            labels = repositories.team_config.list_labels(workspace_id, issue.team_id)
            palettes[issue.team_id] = {label.label_id: label for label in labels}
        for label_id in issue.label_ids:
            label = palettes[issue.team_id].get(label_id)
            if label is not None and label.name.lower() not in wanted:
                wanted[label.name.lower()] = (label.name, label.color)
    return wanted, any(enabled.values())


def push_pr_labels(repositories: Repositories, job: Mapping[str, Any]) -> None:
    """Bring one pull request's labels in line with its linked issues.

    Adds every wanted name the pull request lacks, creating the repository label
    first, and removes every name the App applied that no linked issue still
    carries. The applied set written back is what the App added and still owns.
    """
    workspace_id = str(job.get("workspace_id", ""))
    node_id = str(job.get("pr_node_id", ""))
    links = repositories.github.list_links_for_pr(workspace_id, node_id)
    if not links:
        return
    newest = max(links, key=lambda link: link.pr_updated_ms)
    if newest.pr_state in FINISHED_STATES or not newest.pr_number:
        return
    installation = repositories.github.get_installation(workspace_id)
    if installation is None or installation.suspended_at is not None:
        return
    repository_id = _repository_id(repositories, workspace_id, links)
    if not repository_id:
        _log.info("Dropped a label sync with no repository id.", extra={"event": "integrations.pr_labels.unaddressed"})
        return

    wanted, syncing = _wanted(repositories, workspace_id, links)
    if not syncing:
        return
    applied = {name.lower(): name for link in links for name in link.applied_labels}

    token = github_issues.installation_token(str(installation.installation_id))
    record = github_issues.get_issue(token, repository_id, newest.pr_number)
    if record.get("state") != "open":
        return
    carried = {
        str(entry.get("name", "")).lower(): str(entry.get("name", ""))
        for entry in record.get("labels") or []
        if isinstance(entry, Mapping) and entry.get("name")
    }

    added = [wanted[key] for key in sorted(wanted) if key not in carried]
    removed = [carried[key] for key in sorted(applied) if key not in wanted and key in carried]
    for name, color in added:
        github_issues.create_label(token, repository_id, name, color)
    github_issues.add_labels(token, repository_id, newest.pr_number, [name for name, _ in added])
    for name in removed:
        github_issues.remove_label(token, repository_id, newest.pr_number, name)

    owned = sorted(wanted[key][0] for key in wanted if key not in carried or (key in applied and key in carried))
    if added or removed:
        _log.info(
            "Synced issue labels to a pull request.",
            extra={"event": "integrations.pr_labels.synced", "added": len(added), "removed": len(removed)},
        )
    for link in links:
        if sorted(link.applied_labels) != owned:
            repositories.github.update_link(workspace_id, link.link_id, applied_labels=owned)
