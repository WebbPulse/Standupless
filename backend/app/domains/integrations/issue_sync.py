"""Two way issue sync between one team and one GitHub repository.

A team that links a repository imports every issue opened there afterwards, and
from then on each side's title, description, open or closed state, assignee,
labels and comments are carried to the other. The events consumer runs the
inbound half from `issues` and `issue_comment` deliveries, and the dispatch
consumer runs the outbound half from jobs the stream consumer queues on issue and
comment writes, so a GitHub outage retries on the queue without touching the
write that caused it.

Echo suppression has three layers, because each covers a case the others miss.
A delivery whose sender is this App's own bot is dropped outright, which catches
every write the outbound half makes. Each side's values as of the last sync are
kept on the `IssueSync` row, so a change is only a change when it differs from
that snapshot, which catches a stream record raised by an inbound write. And the
snapshot write is conditioned on the row's version, so two consumers racing on
one issue cannot both believe they won.

When both sides changed the same field since the last sync, the later write wins
by timestamp and the issue's activity records the conflict and which side was
kept, so a person can see why their edit did not stick.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Any, Callable, Mapping, Sequence

from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.comments import build_comment, new_comment_id
from app.common.db.dynamo.github import (
    CommentSync,
    IssueSync,
    TeamSync,
    comment_sync_key,
    issue_sync_key,
)
from app.common.db.dynamo.issues import Issue, issue_key, new_issue_id
from app.domains.integrations import github_issues

_log = logging.getLogger(__name__)

GITHUB_ACTOR = "github"
"""The actor id of a write the sync makes on GitHub's behalf with no linked person."""

GITHUB_AUTHOR_PREFIX = "github:"
"""The author id prefix of a comment written on GitHub by someone with no linked account."""

CONFLICT_FIELD = "github_sync_conflict"

PENDING_STALE = timedelta(minutes=2)
"""How old a `pending` claim must be before another job may take it over."""

ISSUE_SYNC_JOB = "github.issue_sync"

COMMENT_SYNC_JOB = "github.comment_sync"

SYNCED_ISSUE_FIELDS = ("title", "body", "status_id", "assignee_id", "label_ids")
"""The issue fields whose change is carried to GitHub."""

_SKIP = object()

_MARKDOWN_SPECIAL = re.compile(r"([\\`*_{}\[\]()#+\-.!|<>~@:])")


def own_delivery(body: Mapping[str, Any]) -> bool:
    """Whether a delivery was caused by this App's own write, and so must not sync back."""
    sender = body.get("sender")
    login = str(sender.get("login", "")) if isinstance(sender, Mapping) else ""
    slug = settings.GITHUB_APP_SLUG
    return bool(slug) and login.lower() == f"{slug}[bot]".lower()


def github_author(login: str) -> str:
    """The author id a comment by an unlinked GitHub account is stored under."""
    return f"{GITHUB_AUTHOR_PREFIX}{login}"


def _parse_time(value: Any) -> datetime | None:
    """A GitHub or stored timestamp as a datetime, or `None` when it is absent."""
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def github_snapshot(issue: Mapping[str, Any]) -> dict[str, Any]:
    """The synced fields of a GitHub issue record, as the snapshot stores them."""
    assignees = [entry for entry in (issue.get("assignees") or []) if isinstance(entry, Mapping)]
    labels = [entry for entry in (issue.get("labels") or []) if isinstance(entry, Mapping)]
    return {
        "title": str(issue.get("title") or ""),
        "body": str(issue.get("body") or ""),
        "state": str(issue.get("state") or "open"),
        "state_reason": str(issue.get("state_reason") or ""),
        "assignees": [str(entry.get("id", "")) for entry in assignees if entry.get("id") is not None],
        "labels": sorted(str(entry.get("name", "")) for entry in labels if entry.get("name")),
        "updated_at": str(issue.get("updated_at") or ""),
    }


def standupless_snapshot(issue: Issue) -> dict[str, Any]:
    """The synced fields of an issue, as the snapshot stores them."""
    return {
        "title": issue.title,
        "body": issue.body or "",
        "status_id": issue.status_id,
        "assignee_id": issue.assignee_id or "",
        "label_ids": sorted(issue.label_ids),
        "updated_at": issue.updated_at.isoformat(),
    }


def _first_status(statuses: Sequence[Any], *categories: str) -> Any | None:
    """The lowest positioned status of the first category that has one."""
    for category in categories:
        candidates = [status for status in statuses if status.category == category]
        if candidates:
            return sorted(candidates, key=lambda row: (row.position, row.status_id))[0]
    return None


def _category(statuses: Sequence[Any], status_id: str) -> str:
    """The category of one status, or empty when it is not the team's."""
    return next((status.category for status in statuses if status.status_id == status_id), "")


def status_for_github(statuses: Sequence[Any], current_status_id: str, state: str, reason: str) -> str | None:
    """Which status a GitHub state moves an issue to, or `None` to leave it.

    Closed as not planned lands in the first cancelled status and any other close
    in the first completed one. Reopening moves an issue that was done back to the
    first unstarted status, and leaves an issue that was never closed alone,
    because GitHub's `open` says nothing about which open status it is in.
    """
    current = _category(statuses, current_status_id)
    if state == "closed":
        preferred = ("cancelled", "completed") if reason == "not_planned" else ("completed", "cancelled")
        target = _first_status(statuses, *preferred)
        if target is None or target.category == current:
            return None
        return target.status_id
    if current not in ("completed", "cancelled"):
        return None
    target = _first_status(statuses, "unstarted", "backlog", "started")
    return target.status_id if target is not None else None


def github_state_for(statuses: Sequence[Any], status_id: str) -> tuple[str, str]:
    """The GitHub state and reason one status maps to."""
    category = _category(statuses, status_id)
    if category == "completed":
        return "closed", "completed"
    if category == "cancelled":
        return "closed", "not_planned"
    return "open", ""


def _status_for_new_issue(statuses: Sequence[Any], state: str, reason: str) -> Any | None:
    """The status an imported issue starts in."""
    if state == "closed":
        preferred = ("cancelled", "completed") if reason == "not_planned" else ("completed", "cancelled")
        closed = _first_status(statuses, *preferred)
        if closed is not None:
            return closed
    opened = _first_status(statuses, "unstarted", "backlog", "started")
    if opened is not None:
        return opened
    return sorted(statuses, key=lambda row: (row.position, row.status_id))[0] if statuses else None


def _user_for_github(repositories: Repositories, workspace_id: str, github_user_id: str) -> str | None:
    """The workspace member who linked this GitHub account, or `None`."""
    if not github_user_id:
        return None
    link = repositories.oauth_links.get(f"github#{github_user_id}")
    if link is None:
        return None
    if repositories.memberships.get(workspace_id, link.user_id) is None:
        return None
    return link.user_id


def _github_for_user(repositories: Repositories, user_id: str) -> str | None:
    """The GitHub account id a person linked, or `None`."""
    for link in repositories.oauth_links.list_for_user(user_id):
        if link.provider == "github" and link.subject:
            return str(link.subject)
    return None


def _desired_assignee(repositories: Repositories, workspace_id: str, github_ids: Sequence[str]) -> Any:
    """The assignee a GitHub assignee list maps to.

    `None` when GitHub has nobody assigned, the first mappable person otherwise,
    and `_SKIP` when every assignee is someone with no linked account, so an issue
    is not unassigned just because the GitHub side cannot be named here.
    """
    if not github_ids:
        return None
    for github_id in github_ids:
        user_id = _user_for_github(repositories, workspace_id, github_id)
        if user_id is not None:
            return user_id
    return _SKIP


def _label_ids(labels: Sequence[Any], names: Sequence[str]) -> list[str]:
    """The team label ids whose names appear in a GitHub label list, matched case insensitively."""
    wanted = {name.lower() for name in names}
    return sorted(label.label_id for label in labels if label.name.lower() in wanted)


def _record(repositories: Repositories, issue: Issue, field: str, before: Any, after: Any, actor_id: str) -> None:
    """One activity row for a change the sync made."""
    repositories.activity.record(
        build_activity(
            issue.workspace_id,
            issue.team_id,
            issue.issue_id,
            actor_id,
            "field_changed",
            actor_kind="github",
            field=field,
            from_value=before,
            to_value=after,
        )
    )


def import_issue(
    repositories: Repositories,
    workspace_id: str,
    config: TeamSync,
    github_issue: Mapping[str, Any],
) -> Issue | None:
    """Create the issue a newly opened GitHub issue mirrors, once.

    The sync row and its GitHub pointer are claimed before the issue exists, so
    the stream record the create raises already finds the issue synced and writes
    nothing back, and a redelivery finds the pointer and stops. A redelivery after
    a crash between the claim and the create finishes the create under the same id.
    """
    number = int(github_issue.get("number") or 0)
    if not number:
        return None
    existing = repositories.github.issue_sync_for_github(workspace_id, config.repository_id, number)
    if existing is not None:
        present = repositories.issues.get(workspace_id, existing.issue_id)
        if present is not None:
            if not existing.standupless:
                repositories.github.save_issue_sync(
                    existing.model_copy(update={"standupless": standupless_snapshot(present)}),
                    expected_version=existing.version,
                )
            return None

    team = repositories.teams.get(workspace_id, config.team_id)
    statuses = repositories.team_config.list_statuses(workspace_id, config.team_id)
    if team is None or not statuses:
        return None

    snapshot = github_snapshot(github_issue)
    status = _status_for_new_issue(statuses, snapshot["state"], snapshot["state_reason"])
    if status is None:
        return None

    sync = existing
    if sync is None:
        issue_id = new_issue_id()
        sync = IssueSync(
            workspace_id=workspace_id,
            github_key=issue_sync_key(issue_id),
            issue_id=issue_id,
            team_id=config.team_id,
            repository_id=config.repository_id,
            full_name=config.full_name,
            number=number,
            node_id=str(github_issue.get("node_id") or ""),
            html_url=str(github_issue.get("html_url") or ""),
            origin="github",
            github=snapshot,
        )
        if not repositories.github.claim_issue_sync(sync):
            return None

    user = github_issue.get("user")
    author_id = str(user.get("id", "")) if isinstance(user, Mapping) else ""
    created_by = _user_for_github(repositories, workspace_id, author_id) or GITHUB_ACTOR
    assignee = _desired_assignee(repositories, workspace_id, snapshot["assignees"])
    labels = repositories.team_config.list_labels(workspace_id, config.team_id) if config.sync_labels else []

    allocated = repositories.counters.allocate_issue_number(workspace_id, config.team_id)
    issue = Issue(
        workspace_id=workspace_id,
        issue_id=sync.issue_id,
        team_id=config.team_id,
        key=issue_key(team.key_prefix, allocated),
        number=allocated,
        title=snapshot["title"] or f"{config.full_name}#{number}",
        body=snapshot["body"] or None,
        status_id=status.status_id,
        assignee_id=assignee if isinstance(assignee, str) else None,
        label_ids=_label_ids(labels, snapshot["labels"]),
        created_by=created_by,
    )
    repositories.issues.create(issue)
    repositories.activity.record(
        build_activity(workspace_id, config.team_id, issue.issue_id, created_by, "created", actor_kind="github")
    )
    repositories.github.save_issue_sync(
        sync.model_copy(update={"github": snapshot, "standupless": standupless_snapshot(issue)}),
        expected_version=sync.version,
    )
    _log.info("Imported a GitHub issue.", extra={"event": "integrations.sync.imported"})
    return issue


def apply_github_issue(
    repositories: Repositories,
    workspace_id: str,
    config: TeamSync,
    sync: IssueSync,
    github_issue: Mapping[str, Any],
) -> bool:
    """Carry a GitHub issue's changes onto the issue it mirrors.

    Returns whether Standupless kept a value in a conflict, which the caller turns
    into an outbound job so GitHub converges on the winner. A delivery older than
    the snapshot is dropped, because SQS does not keep order and applying it would
    roll a newer edit back.
    """
    issue = repositories.issues.get(workspace_id, sync.issue_id)
    if issue is None:
        repositories.github.delete_issue_sync(workspace_id, sync.issue_id)
        return False

    incoming = github_snapshot(github_issue)
    previous = sync.github
    incoming_at = _parse_time(incoming["updated_at"])
    previous_at = _parse_time(previous.get("updated_at"))
    if incoming_at is not None and previous_at is not None and incoming_at < previous_at:
        _log.info("Dropped a stale GitHub issue delivery.", extra={"event": "integrations.sync.stale"})
        return False

    statuses = repositories.team_config.list_statuses(workspace_id, issue.team_id)
    labels = repositories.team_config.list_labels(workspace_id, issue.team_id) if config.sync_labels else []
    baseline = sync.standupless

    candidates: list[tuple[str, bool, Any]] = [
        ("title", incoming["title"] != previous.get("title"), incoming["title"]),
        ("body", incoming["body"] != previous.get("body"), incoming["body"] or None),
    ]
    state_changed = (incoming["state"], incoming["state_reason"]) != (
        previous.get("state"),
        previous.get("state_reason", ""),
    )
    target = status_for_github(statuses, issue.status_id, incoming["state"], incoming["state_reason"])
    candidates.append(("status_id", state_changed, target if target is not None else _SKIP))
    candidates.append(
        (
            "assignee_id",
            incoming["assignees"] != previous.get("assignees"),
            _desired_assignee(repositories, workspace_id, incoming["assignees"]),
        )
    )
    if config.sync_labels:
        candidates.append(
            ("label_ids", incoming["labels"] != previous.get("labels"), _label_ids(labels, incoming["labels"]))
        )

    changes: dict[str, Any] = {}
    conflicts: list[tuple[str, str]] = []
    issue_values = standupless_snapshot(issue)
    for field, changed_on_github, desired in candidates:
        if not changed_on_github or desired is _SKIP:
            continue
        current = getattr(issue, field)
        if (current or None) == (desired or None):
            continue
        if field in baseline and issue_values[field] != baseline[field]:
            kept = "github" if incoming_at is None or incoming_at >= issue.updated_at else "standupless"
            conflicts.append((field, kept))
            if kept == "standupless":
                continue
        changes[field] = desired

    updated_baseline = dict(baseline)
    if changes:
        updated = issue.model_copy(update={**changes, "updated_at": utc_now(), "updated_by": None})
        repositories.issues.replace(updated)
        for field, value in changes.items():
            _record(repositories, issue, field, getattr(issue, field), value, GITHUB_ACTOR)
        after = standupless_snapshot(updated)
        for field in changes:
            updated_baseline[field] = after[field]
        updated_baseline["updated_at"] = after["updated_at"]

    for field, kept in conflicts:
        _record(repositories, issue, CONFLICT_FIELD, None, {"field": field, "kept": kept}, GITHUB_ACTOR)

    repositories.github.save_issue_sync(
        sync.model_copy(update={"github": incoming, "standupless": updated_baseline}),
        expected_version=sync.version,
    )
    return any(kept == "standupless" for _field, kept in conflicts)


def handle_issue_event(repositories: Repositories, workspace_id: str, body: Mapping[str, Any]) -> None:
    """Route one `issues` delivery to an import or an update."""
    github_issue = body.get("issue")
    repository = body.get("repository")
    if not isinstance(github_issue, Mapping) or not isinstance(repository, Mapping):
        return
    if github_issue.get("pull_request") is not None or own_delivery(body):
        return
    repository_id = str(repository.get("id", ""))
    config = repositories.github.team_sync_for_repository(workspace_id, repository_id)
    if config is None or not config.enabled:
        return

    action = str(body.get("action", ""))
    number = int(github_issue.get("number") or 0)
    sync = repositories.github.issue_sync_for_github(workspace_id, repository_id, number)
    if action == "deleted":
        if sync is not None:
            repositories.github.delete_issue_sync(workspace_id, sync.issue_id)
        return
    if sync is None or repositories.issues.get(workspace_id, sync.issue_id) is None:
        if action == "opened":
            import_issue(repositories, workspace_id, config, github_issue)
        return
    if sync.state != "linked":
        return
    if apply_github_issue(repositories, workspace_id, config, sync, github_issue) and config.writes_back:
        enqueue_issue_sync(workspace_id, sync.issue_id, created=False)


def handle_comment_event(repositories: Repositories, workspace_id: str, body: Mapping[str, Any]) -> None:
    """Carry one `issue_comment` delivery onto the synced issue's discussion.

    Only comments GitHub originated are created, edited or deleted here. A comment
    that started in Standupless is authored on GitHub by the App, so a change to
    that copy is somebody editing the mirror rather than the conversation.
    """
    github_issue = body.get("issue")
    repository = body.get("repository")
    comment = body.get("comment")
    if not isinstance(github_issue, Mapping) or not isinstance(repository, Mapping) or not isinstance(comment, Mapping):
        return
    if github_issue.get("pull_request") is not None or own_delivery(body):
        return
    repository_id = str(repository.get("id", ""))
    config = repositories.github.team_sync_for_repository(workspace_id, repository_id)
    if config is None or not config.enabled:
        return
    sync = repositories.github.issue_sync_for_github(workspace_id, repository_id, int(github_issue.get("number") or 0))
    if sync is None:
        return
    issue = repositories.issues.get(workspace_id, sync.issue_id)
    if issue is None:
        return

    action = str(body.get("action", ""))
    github_comment_id = str(comment.get("id", ""))
    text = str(comment.get("body") or "")
    existing = repositories.github.comment_sync_for_github(workspace_id, github_comment_id)

    if action == "created":
        if existing is not None:
            if (
                existing.origin == "github"
                and repositories.comments.get(workspace_id, issue.issue_id, existing.comment_id) is None
            ):
                _create_comment(repositories, issue, existing, comment)
            return
        comment_id = new_comment_id()
        row = CommentSync(
            workspace_id=workspace_id,
            github_key=comment_sync_key(issue.issue_id, comment_id),
            issue_id=issue.issue_id,
            comment_id=comment_id,
            github_comment_id=github_comment_id,
            origin="github",
            body=text,
        )
        if repositories.github.claim_comment_sync(row):
            _create_comment(repositories, issue, row, comment)
        return

    if existing is None or existing.origin != "github":
        return
    if action == "edited":
        if text == existing.body:
            return
        try:
            repositories.comments.edit(workspace_id, issue.issue_id, existing.comment_id, text, [])
        except ConditionFailed:
            return
        repositories.github.save_comment_sync(existing.model_copy(update={"body": text}))
    elif action == "deleted":
        repositories.comments.delete(workspace_id, issue.issue_id, existing.comment_id)
        repositories.github.delete_comment_sync(workspace_id, issue.issue_id, existing.comment_id)


def _comment_author(repositories: Repositories, workspace_id: str, user: Any) -> str:
    """Who a GitHub comment is stored as: the linked member, or the GitHub login."""
    if not isinstance(user, Mapping):
        return GITHUB_ACTOR
    linked = _user_for_github(repositories, workspace_id, str(user.get("id", "")))
    return linked or github_author(str(user.get("login", "")) or "unknown")


def _create_comment(repositories: Repositories, issue: Issue, row: CommentSync, comment: Mapping[str, Any]) -> None:
    """Write the comment a claimed sync row names."""
    created = build_comment(
        issue.workspace_id,
        issue.issue_id,
        issue.team_id,
        _comment_author(repositories, issue.workspace_id, comment.get("user")),
        str(comment.get("body") or ""),
    )
    try:
        repositories.comments.create(created.model_copy(update={"comment_id": row.comment_id}))
    except ConditionFailed:
        return


def enqueue_issue_sync(workspace_id: str, issue_id: str, *, created: bool) -> None:
    """Queue an outbound issue sync for the dispatch consumer."""
    _enqueue(
        ISSUE_SYNC_JOB,
        {"kind": ISSUE_SYNC_JOB, "workspace_id": workspace_id, "issue_id": issue_id, "created": created},
        workspace_id,
    )


def enqueue_comment_sync(workspace_id: str, issue_id: str, comment_id: str) -> None:
    """Queue an outbound comment sync for the dispatch consumer."""
    _enqueue(
        COMMENT_SYNC_JOB,
        {"kind": COMMENT_SYNC_JOB, "workspace_id": workspace_id, "issue_id": issue_id, "comment_id": comment_id},
        workspace_id,
    )


def _enqueue(name: str, payload: Mapping[str, Any], workspace_id: str) -> None:
    """Put one job on the dispatch queue, when this environment has one."""
    from webbpulse.events import EventEnvelope, enqueue

    if not settings.WEBHOOK_DISPATCH_QUEUE_URL:
        return
    enqueue(settings.WEBHOOK_DISPATCH_QUEUE_URL, EventEnvelope(name=name, payload=dict(payload), scope=workspace_id))


class _Token:
    """An installation token minted on first use, so a job that writes nothing mints nothing."""

    def __init__(self, installation_id: str) -> None:
        """Remember which installation to mint for."""
        self._installation_id = installation_id
        self._token: str | None = None

    def __call__(self) -> str:
        """The token, minted once per job."""
        if self._token is None:
            self._token = github_issues.installation_token(self._installation_id)
        return self._token


def _writable(repositories: Repositories, workspace_id: str, team_id: str) -> tuple[TeamSync, _Token] | None:
    """The team's sync configuration and a token source, when the team writes back."""
    config = repositories.github.get_team_sync(workspace_id, team_id)
    if config is None or not config.writes_back:
        return None
    installation = repositories.github.get_installation(workspace_id)
    if installation is None or installation.suspended_at is not None:
        return None
    return config, _Token(str(installation.installation_id))


def _assignee_logins(repositories: Repositories, user_id: str | None, token: Callable[[], str]) -> list[str] | None:
    """The GitHub assignee list for one assignee, or `None` when they cannot be named there."""
    if not user_id:
        return []
    github_id = _github_for_user(repositories, user_id)
    if github_id is None:
        return None
    login = github_issues.user_login(token(), github_id)
    return [login] if login else None


def _label_names(repositories: Repositories, issue: Issue) -> tuple[list[str], set[str]]:
    """The issue's label names and every team label name, lowered, for the merge with GitHub's labels."""
    labels = repositories.team_config.list_labels(issue.workspace_id, issue.team_id)
    names = {label.label_id: label.name for label in labels}
    return sorted(names[label_id] for label_id in issue.label_ids if label_id in names), {
        label.name.lower() for label in labels
    }


def outbound_changes(
    repositories: Repositories,
    config: TeamSync,
    issue: Issue,
    sync: IssueSync,
    token: Callable[[], str],
) -> dict[str, Any]:
    """The GitHub patch that carries this issue's changes since the last sync.

    A field is sent only when it moved from the Standupless snapshot and differs
    from what GitHub already holds, which is what turns the stream record of an
    inbound write into no call at all.
    """
    baseline = sync.standupless
    github = sync.github
    changes: dict[str, Any] = {}
    if issue.title != baseline.get("title") and issue.title != github.get("title"):
        changes["title"] = issue.title
    body = issue.body or ""
    if body != baseline.get("body") and body != github.get("body"):
        changes["body"] = body
    if issue.status_id != baseline.get("status_id"):
        statuses = repositories.team_config.list_statuses(issue.workspace_id, issue.team_id)
        state, reason = github_state_for(statuses, issue.status_id)
        if state != github.get("state"):
            changes["state"] = state
            changes["state_reason"] = reason if state == "closed" else "reopened"
        elif state == "closed" and reason != github.get("state_reason"):
            changes["state"] = state
            changes["state_reason"] = reason
    if (issue.assignee_id or "") != baseline.get("assignee_id"):
        logins = _assignee_logins(repositories, issue.assignee_id, token)
        if logins is not None and (logins or github.get("assignees")):
            changes["assignees"] = logins
    if config.sync_labels and sorted(issue.label_ids) != baseline.get("label_ids"):
        wanted, team_names = _label_names(repositories, issue)
        current = [str(name) for name in github.get("labels") or []]
        merged = sorted({*[name for name in current if name.lower() not in team_names], *wanted})
        if merged != sorted(current):
            changes["labels"] = merged
    return changes


def push_issue(repositories: Repositories, job: Mapping[str, Any]) -> None:
    """Carry one issue's changes to GitHub, creating the GitHub issue for a new one."""
    workspace_id = str(job.get("workspace_id", ""))
    issue = repositories.issues.get(workspace_id, str(job.get("issue_id", "")))
    if issue is None:
        return
    writable = _writable(repositories, workspace_id, issue.team_id)
    if writable is None:
        return
    config, token = writable

    sync = repositories.github.get_issue_sync(workspace_id, issue.issue_id)
    if sync is None:
        if bool(job.get("created")):
            _create_on_github(repositories, config, issue, token)
        return
    if sync.state != "linked" or not sync.number or sync.repository_id != config.repository_id:
        return
    if not sync.standupless:
        return

    changes = outbound_changes(repositories, config, issue, sync, token)
    if not changes:
        return
    response = github_issues.update_issue(token(), sync.full_name, sync.number, changes)
    repositories.github.save_issue_sync(
        sync.model_copy(update={"github": github_snapshot(response), "standupless": standupless_snapshot(issue)}),
        expected_version=sync.version,
    )
    _log.info("Synced an issue to GitHub.", extra={"event": "integrations.sync.pushed"})


def _create_on_github(repositories: Repositories, config: TeamSync, issue: Issue, token: Callable[[], str]) -> None:
    """Open the GitHub issue a new team issue mirrors, under a claim so it happens once."""
    pending = IssueSync(
        workspace_id=issue.workspace_id,
        github_key=issue_sync_key(issue.issue_id),
        issue_id=issue.issue_id,
        team_id=issue.team_id,
        repository_id=config.repository_id,
        full_name=config.full_name,
        origin="standupless",
        state="pending",
    )
    if not repositories.github.claim_issue_sync(pending, stale_before=utc_now() - PENDING_STALE):
        return
    current = repositories.github.get_issue_sync(issue.workspace_id, issue.issue_id) or pending

    labels = _label_names(repositories, issue)[0] if config.sync_labels else []
    assignees = _assignee_logins(repositories, issue.assignee_id, token) or []
    response = github_issues.create_issue(
        token(),
        config.full_name,
        title=issue.title,
        body=issue.body or "",
        labels=labels,
        assignees=assignees,
    )
    statuses = repositories.team_config.list_statuses(issue.workspace_id, issue.team_id)
    state, reason = github_state_for(statuses, issue.status_id)
    number = int(response.get("number") or 0)
    if state == "closed" and number:
        response = github_issues.update_issue(
            token(), config.full_name, number, {"state": state, "state_reason": reason}
        )
    repositories.github.save_issue_sync(
        current.model_copy(
            update={
                "number": number,
                "node_id": str(response.get("node_id") or ""),
                "html_url": str(response.get("html_url") or ""),
                "state": "linked",
                "github": github_snapshot(response),
                "standupless": standupless_snapshot(issue),
            }
        ),
        expected_version=current.version,
    )
    _log.info("Opened a GitHub issue for a new issue.", extra={"event": "integrations.sync.created"})


def _escape(text: str) -> str:
    """A display name as inert Markdown on one line."""
    return _MARKDOWN_SPECIAL.sub(r"\\\1", " ".join(text.split()))


def outbound_comment_body(repositories: Repositories, author_id: str, body: str) -> str:
    """A Standupless comment as posted by the App, naming who wrote it."""
    user = repositories.users.get(author_id)
    name = (user.display_name or "") if user is not None else ""
    return f"**{_escape(name) or 'Someone'}** commented in Standupless:\n\n{body}"


def push_comment(repositories: Repositories, job: Mapping[str, Any]) -> None:
    """Post or update the GitHub copy of one Standupless comment."""
    workspace_id = str(job.get("workspace_id", ""))
    issue_id = str(job.get("issue_id", ""))
    comment = repositories.comments.get(workspace_id, issue_id, str(job.get("comment_id", "")))
    if comment is None or comment.author_id.startswith(GITHUB_AUTHOR_PREFIX):
        return
    writable = _writable(repositories, workspace_id, comment.team_id)
    if writable is None:
        return
    config, token = writable
    sync = repositories.github.get_issue_sync(workspace_id, issue_id)
    if sync is None or sync.state != "linked" or not sync.number or sync.repository_id != config.repository_id:
        return

    existing = repositories.github.get_comment_sync(workspace_id, issue_id, comment.comment_id)
    if existing is None:
        pending = CommentSync(
            workspace_id=workspace_id,
            github_key=comment_sync_key(issue_id, comment.comment_id),
            issue_id=issue_id,
            comment_id=comment.comment_id,
            origin="standupless",
            state="pending",
            body=comment.body,
        )
        if not repositories.github.claim_comment_sync(pending, stale_before=utc_now() - PENDING_STALE):
            return
        response = github_issues.create_comment(
            token(),
            sync.full_name,
            sync.number,
            outbound_comment_body(repositories, comment.author_id, comment.body),
        )
        repositories.github.save_comment_sync(
            pending.model_copy(update={"github_comment_id": str(response.get("id", "")), "state": "linked"})
        )
        return

    if existing.origin != "standupless" or existing.state != "linked" or existing.body == comment.body:
        return
    github_issues.update_comment(
        token(),
        sync.full_name,
        existing.github_comment_id,
        outbound_comment_body(repositories, comment.author_id, comment.body),
    )
    repositories.github.save_comment_sync(existing.model_copy(update={"body": comment.body}))
