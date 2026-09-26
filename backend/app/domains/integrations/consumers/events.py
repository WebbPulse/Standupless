"""The `github-events` consumer: turns a GitHub delivery into links and transitions.

This is where every decision that needs a database read happens, off the request
path, because the receiver has to answer GitHub inside its timeout and a fan-out
across teams and issues does not fit there.

The ordering guarantee is weak by design. SQS is not ordered, so a merge can be
handled before the open that preceded it. That is why a transition is guarded on
the issue's own `updated_at` rather than on the order the queue happened to
deliver: the guard makes a late delivery a no-op instead of a regression.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Iterable, Mapping, Sequence

from fastapi import APIRouter
from webbpulse.events import register_stream_consumer

from app.common.api.dependencies.repositories import Repositories, build_bundle
from app.common.core.config import settings
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import IssueLink, link_key
from app.domains.integrations import linking
from app.domains.integrations.service import effective_transitions

_log = logging.getLogger(__name__)

WRITEBACK_EVENTS = frozenset({"pull_request"})


def _body(record: Mapping[str, Any]) -> Mapping[str, Any]:
    """The envelope payload inside one SQS record.

    A record whose body will not parse is dropped rather than raised on, because a
    malformed message would otherwise be retried until the queue gives up on it and
    every delivery behind it waits.
    """
    raw = record.get("body")
    if not isinstance(raw, str):
        return {}
    try:
        envelope = json.loads(raw)
    except ValueError:
        _log.warning("A github-events record would not parse.", extra={"event": "integrations.events.unparseable"})
        return {}
    payload = envelope.get("payload") if isinstance(envelope, Mapping) else None
    return payload if isinstance(payload, Mapping) else {}


def _event_time(record: Mapping[str, Any], payload: Mapping[str, Any]) -> datetime:
    """When the delivery was raised, for the manual-change guard.

    The envelope's own `occurred_at` is preferred over the SQS timestamp because it
    is when the receiver accepted the delivery, which is as close as this gets to
    when the pull request actually changed.
    """
    raw = record.get("body")
    if isinstance(raw, str):
        try:
            envelope = json.loads(raw)
            occurred = envelope.get("occurred_at") if isinstance(envelope, Mapping) else None
            if isinstance(occurred, str):
                return datetime.fromisoformat(occurred.replace("Z", "+00:00"))
        except ValueError:
            pass
    return utc_now()


def _resolve_workspace(repositories: Repositories, installation_id: str) -> str:
    """Which workspace an installation belongs to, or empty when none does.

    The one cross-workspace read in the product, and it is why the `github` table
    carries `installation_id-index`: a delivery names an installation and nothing
    else, so the tenant has to be looked up before any workspace-scoped read.
    """
    if not installation_id:
        return ""
    installation = repositories.github.installation_by_id(installation_id)
    return installation.workspace_id if installation is not None else ""


def _prefixes(repositories: Repositories, workspace_id: str, team_id: str | None) -> dict[str, str]:
    """The key prefix of each team a repository may name.

    A repository pinned to one team searches that prefix alone, which is what
    stops `ABC-1` in a pinned repository moving an issue of a different team
    that happens to share the number.
    """
    teams = repositories.teams.list_for_workspace(workspace_id)
    if team_id:
        teams = [team for team in teams if team.team_id == team_id]
    return {team.team_id: team.key_prefix for team in teams if team.key_prefix}


def handle_record(repositories: Repositories, record: Mapping[str, Any]) -> None:
    """Handle one queued GitHub delivery."""
    payload = _body(record)
    event = str(payload.get("event", ""))
    body = payload.get("body")
    if not event or not isinstance(body, Mapping):
        return

    installation = body.get("installation")
    installation_id = str(installation.get("id", "")) if isinstance(installation, Mapping) else ""

    if event == "installation":
        _handle_installation(repositories, body, installation_id)
        return
    if event == "installation_repositories":
        _handle_installation_repositories(repositories, body, installation_id)
        return

    workspace_id = _resolve_workspace(repositories, installation_id)
    if not workspace_id:
        _log.info(
            "Dropped a delivery for an installation no workspace owns.",
            extra={"event": "integrations.events.unknown_installation"},
        )
        return

    if event == "pull_request":
        _handle_pull_request(repositories, workspace_id, body, _event_time(record, payload))
    elif event == "push":
        _handle_push(repositories, workspace_id, body, _event_time(record, payload))


def _handle_installation(repositories: Repositories, body: Mapping[str, Any], installation_id: str) -> None:
    """Keep the install row current, and drop it when the App is uninstalled.

    `created` is usually a no-op: the delivery tends to beat the browser back to the
    callback, and an installation only has a workspace once the callback binds it.
    """
    from app.domains.integrations.installs import refresh_installation, remove_installation, set_suspended

    action = str(body.get("action", ""))
    workspace_id = _resolve_workspace(repositories, installation_id)
    if not workspace_id:
        return
    if action == "deleted":
        remove_installation(repositories, workspace_id)
        _log.info("Removed an uninstalled GitHub App.", extra={"event": "integrations.uninstalled"})
        return
    if action == "suspend":
        set_suspended(repositories, workspace_id, utc_now())
        _log.info("Marked a GitHub installation suspended.", extra={"event": "integrations.suspended"})
        return
    if action in ("created", "new_permissions_accepted", "unsuspend"):
        refresh_installation(repositories, installation_id)


def _handle_installation_repositories(
    repositories: Repositories,
    body: Mapping[str, Any],
    installation_id: str,
) -> None:
    """Apply an added or removed repository delta."""
    from app.domains.integrations.installs import apply_repository_changes, set_repository_selection

    workspace_id = _resolve_workspace(repositories, installation_id)
    if not workspace_id:
        return
    set_repository_selection(repositories, workspace_id, str(body.get("repository_selection", "")))
    added = body.get("repositories_added")
    removed = body.get("repositories_removed")
    apply_repository_changes(
        repositories,
        workspace_id,
        installation_id,
        added=[entry for entry in (added or []) if isinstance(entry, Mapping)],
        removed=[entry for entry in (removed or []) if isinstance(entry, Mapping)],
    )


def _handle_pull_request(
    repositories: Repositories,
    workspace_id: str,
    body: Mapping[str, Any],
    event_at: datetime,
) -> None:
    """Link a pull request to the issues it names and move them if a rule says so."""
    pull_request = body.get("pull_request")
    repository = body.get("repository")
    if not isinstance(pull_request, Mapping) or not isinstance(repository, Mapping):
        return

    repository_id = str(repository.get("id", ""))
    stored_repository = repositories.github.get_repository(workspace_id, repository_id)
    prefixes = _prefixes(repositories, workspace_id, stored_repository.team_id if stored_repository else None)
    if not prefixes:
        return

    head = pull_request.get("head")
    branch = str(head.get("ref", "")) if isinstance(head, Mapping) else ""
    title = str(pull_request.get("title", ""))
    pr_body = str(pull_request.get("body") or "")
    found = linking.extract(prefixes, branch=branch, title=title, body=pr_body)
    if not found:
        return

    action = str(body.get("action", ""))
    merged = bool(pull_request.get("merged"))
    draft = bool(pull_request.get("draft"))
    state = linking.pr_state(state=str(pull_request.get("state", "")), merged=merged, draft=draft)
    trigger = linking.trigger_for(action, merged=merged, draft=draft)

    user = pull_request.get("user")
    author = str(user.get("login", "")) if isinstance(user, Mapping) else ""
    node_id = str(pull_request.get("node_id", "")) or f"{repository_id}#{pull_request.get('number', '')}"

    issues = _resolve_issues(repositories, workspace_id, found)
    if not issues:
        return

    for key, issue in issues.items():
        match = next(row for row in found if row.key == key)
        link_id = f"{node_id}#{issue.issue_id}"
        previous = repositories.github.get_link(workspace_id, link_id)
        repositories.github.put_link(
            IssueLink(
                workspace_id=workspace_id,
                github_key=link_key(link_id),
                ws_issue=f"{workspace_id}#{issue.issue_id}",
                link_id=link_id,
                issue_id=issue.issue_id,
                issue_key=key,
                repository_full_name=str(repository.get("full_name", "")),
                pr_number=int(pull_request.get("number", 0) or 0),
                pr_title=title,
                pr_url=str(pull_request.get("html_url", "")),
                pr_state=state,
                author_login=author,
                magic_word=match.magic_word,
                applied_status_id=previous.applied_status_id if previous is not None else None,
                comment_id=previous.comment_id if previous is not None else None,
                check_run_id=previous.check_run_id if previous is not None else None,
                linked_at=previous.linked_at if previous is not None else utc_now(),
                updated_at=utc_now(),
            )
        )

        if trigger is not None:
            applied = _apply_transition(
                repositories,
                workspace_id,
                issue,
                trigger,
                closes=match.magic_word is not None,
                event_at=event_at,
            )
            if applied is not None:
                repositories.github.update_link(workspace_id, link_id, applied_status_id=applied)

    _enqueue_writeback(
        workspace_id,
        repository,
        pull_request,
        sorted(issues),
        [f"{node_id}#{issue.issue_id}" for issue in issues.values()],
    )


def _handle_push(
    repositories: Repositories,
    workspace_id: str,
    body: Mapping[str, Any],
    event_at: datetime,
) -> None:
    """Record activity for issues a push's commit messages name.

    A push moves nothing. Commit messages are the least reliable of the four
    sources, since a rebase rewrites them wholesale, so they contribute a mention
    and never a transition.
    """
    repository = body.get("repository")
    if not isinstance(repository, Mapping):
        return
    repository_id = str(repository.get("id", ""))
    stored_repository = repositories.github.get_repository(workspace_id, repository_id)
    prefixes = _prefixes(repositories, workspace_id, stored_repository.team_id if stored_repository else None)
    if not prefixes:
        return

    commits = body.get("commits")
    messages = [str(entry.get("message", "")) for entry in (commits or []) if isinstance(entry, Mapping)]
    if not messages:
        return

    found = linking.extract(prefixes, commit_messages=messages)
    issues = _resolve_issues(repositories, workspace_id, found)
    for issue in issues.values():
        repositories.activity.record(
            build_activity(
                workspace_id,
                issue.team_id,
                issue.issue_id,
                "github",
                "field_changed",
                actor_kind="github",
                field="github_commit",
                to_value=str(repository.get("full_name", "")),
            )
        )


def _resolve_issues(repositories: Repositories, workspace_id: str, found: Sequence[linking.FoundKey]) -> dict[str, Any]:
    """The issues the found keys name, keyed by the key, skipping ones that are gone.

    A key names a team and a number, and the number is unique within the team,
    so this is one index read each rather than a scan. A key whose issue was deleted
    resolves to nothing and is simply not linked.
    """
    resolved: dict[str, Any] = {}
    for row in found:
        issue = repositories.issues.get_by_number(workspace_id, row.team_id, row.number)
        if issue is not None:
            resolved[row.key] = issue
    return resolved


def _apply_transition(
    repositories: Repositories,
    workspace_id: str,
    issue: Any,
    trigger: str,
    *,
    closes: bool,
    event_at: datetime,
) -> str | None:
    """Move one issue if a rule says to and nobody has moved it since.

    A merge without a magic word still moves the issue when a rule maps `pr_merged`
    to a status; the magic word is what makes a merge close an issue in a team
    whose rules say nothing, which is the design section 4 default.
    """
    if not linking.may_apply(getattr(issue, "updated_at", None), event_at):
        _log.info(
            "Skipped a transition because the issue moved after the event.",
            extra={"event": "integrations.transition_skipped"},
        )
        return None

    stored = repositories.team_config.list_transitions(workspace_id, issue.team_id)
    statuses = repositories.team_config.list_statuses(workspace_id, issue.team_id)
    rules = effective_transitions(issue.team_id, stored, statuses)

    target: str | None = None
    for rule in rules:
        if rule.trigger != trigger:
            continue
        if rule.is_default and trigger == "pr_merged" and not closes:
            return None
        target = rule.status_id
        break

    if not target or target == issue.status_id:
        return None

    previous = issue.status_id
    moved = issue.model_copy(update={"status_id": target, "updated_at": utc_now()})
    repositories.issues.replace(moved)
    repositories.activity.record(
        build_activity(
            workspace_id,
            issue.team_id,
            issue.issue_id,
            "github",
            "field_changed",
            actor_kind="github",
            field="status_id",
            from_value=previous,
            to_value=target,
        )
    )
    return target


def _enqueue_writeback(
    workspace_id: str,
    repository: Mapping[str, Any],
    pull_request: Mapping[str, Any],
    keys: Iterable[str],
    link_ids: Iterable[str],
) -> None:
    """Queue the comment and check run for the dispatch consumer.

    Enqueued rather than called here so that a GitHub outage retries the write-back
    alone, without replaying the linking and the transitions that already
    succeeded.
    """
    from webbpulse.events import EventEnvelope, enqueue

    enqueue(
        settings.WEBHOOK_DISPATCH_QUEUE_URL,
        EventEnvelope(
            name="github.writeback",
            payload={
                "kind": "github.writeback",
                "workspace_id": workspace_id,
                "repository_full_name": str(repository.get("full_name", "")),
                "pr_number": int(pull_request.get("number", 0) or 0),
                "pr_node_id": str(pull_request.get("node_id", "")),
                "head_sha": str((pull_request.get("head") or {}).get("sha", "")),
                "keys": list(keys),
                "link_ids": list(link_ids),
            },
            scope=workspace_id,
        ),
    )


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """The github-events consumer's router, mounted at the root with no API prefix."""
    from app.common.composition.domains import DOMAINS

    bundle = (
        repositories
        if repositories is not None
        else build_bundle(DOMAINS["integrations"].all_repositories, name="integrations")
    )
    router = APIRouter()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against this domain's bundle."""
        handle_record(bundle, record)

    register_stream_consumer(router, consume, log_event="integrations.events.batch")
    return router
