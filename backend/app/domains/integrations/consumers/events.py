"""The `github-events` consumer: turns a GitHub delivery into links and transitions.

This is where every decision that needs a database read happens, off the request
path, because the receiver has to answer GitHub inside its timeout and a fan-out
across teams and issues does not fit there.

The ordering guarantee is weak by design. SQS is not ordered, so a merge can be
handled before the open that preceded it, and a redrive from the dead letter queue
replays a delivery long after the pull request moved on. Two guards make a late
delivery a no-op instead of a regression. The link row is written only when the
pull request's own `updated_at` is not older than the one the row holds, with a
merge terminal, and a delivery that loses that check moves no issue and queues no
write-back. A transition that does run is still guarded on the issue's own
`updated_at`, so a person's change after the event is kept.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Iterable, Mapping, Sequence

from fastapi import APIRouter
from webbpulse.events import register_stream_consumer

from app.common.api.dependencies.repositories import Repositories, build_bundle
from app.common.change_source import GITHUB
from app.common.core.config import settings
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import IssueLink, link_key, source_millis
from app.common.issue_move import find_issue_by_number
from app.domains.integrations import linking, pr_labels
from app.domains.integrations.service import effective_transitions

_log = logging.getLogger(__name__)

WRITEBACK_EVENTS = frozenset({"pull_request"})

NAMED_REPOSITORY_EVENTS = frozenset({"pull_request", "push", "issues", "issue_comment", "repository"})
"""Deliveries whose `repository` object refreshes the stored display names and visibility.

A `repository` delivery with the `publicized` action is how a repository turning
public reaches a two way sync, which drops to one way."""

TRUSTED_ASSOCIATIONS = frozenset({"OWNER", "MEMBER", "COLLABORATOR"})
"""The `author_association` values GitHub gives people with a standing in the repository.

Anyone else, which on a public repository includes the author of any fork pull
request, is acted on only when they linked a GitHub account to a workspace member."""


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


def _pull_request_time(pull_request: Mapping[str, Any], event_at: datetime) -> datetime:
    """The pull request's own `updated_at`, which orders deliveries about it.

    Falls back to when the receiver accepted the delivery, which a redrive keeps,
    so a payload without the field still orders behind a newer one.
    """
    raw = pull_request.get("updated_at")
    if isinstance(raw, str) and raw:
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            pass
    return event_at


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


def _prefixes(repositories: Repositories, workspace_id: str, team_id: str | None) -> dict[str, list[str]]:
    """The key prefixes of each team a repository may name, current prefix first.

    A repository pinned to one team searches that team's prefixes alone, which is
    what stops `ABC-1` in a pinned repository moving an issue of a different team
    that happens to share the number. Retired prefixes follow the current one, so a
    branch or commit written before a key change still links.
    """
    teams = repositories.teams.list_for_workspace(workspace_id)
    if team_id:
        teams = [team for team in teams if team.team_id == team_id]
    if not teams:
        return {}
    aliases = repositories.teams.aliases_by_team(workspace_id)
    return {team.team_id: [team.key_prefix, *aliases.get(team.team_id, [])] for team in teams if team.key_prefix}


def _pull_request_author(
    repositories: Repositories, workspace_id: str, pull_request: Mapping[str, Any]
) -> tuple[bool, str | None]:
    """Whether a pull request's author may link issues, and the workspace member they linked as.

    Trusted means a linked workspace member, or an author GitHub reports as the
    repository's owner, an organization member or a collaborator.
    """
    from app.domains.integrations.issue_sync import _user_for_github

    user = pull_request.get("user")
    github_id = str(user.get("id", "") or "") if isinstance(user, Mapping) else ""
    member = _user_for_github(repositories, workspace_id, github_id)
    association = str(pull_request.get("author_association", "") or "").upper()
    return member is not None or association in TRUSTED_ASSOCIATIONS, member


def _reachable_teams(
    repositories: Repositories,
    workspace_id: str,
    member: str | None,
) -> set[str]:
    """The teams an unpinned repository's pull request may reach for its author.

    An open team is reachable by any trusted author. A private team is reachable
    only when the author is a linked member who can see it, which also holds a
    linked guest to the teams they belong to.
    """
    from app.common.team_privacy import person_can_see_team

    private = set(repositories.memberships.list_private_team_ids(workspace_id))
    reachable: set[str] = set()
    for team in repositories.teams.list_for_workspace(workspace_id):
        if member is not None and person_can_see_team(repositories, workspace_id, team.team_id, member):
            reachable.add(team.team_id)
        elif team.team_id not in private:
            reachable.add(team.team_id)
    return reachable


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

    repository = body.get("repository")
    if event in NAMED_REPOSITORY_EVENTS and isinstance(repository, Mapping):
        from app.domains.integrations.installs import refresh_repository_names, refresh_repository_visibility

        refresh_repository_names(repositories, workspace_id, repository)
        refresh_repository_visibility(repositories, workspace_id, repository)
    if event == "repository":
        return

    if event == "pull_request":
        _handle_pull_request(repositories, workspace_id, body, _event_time(record, payload))
    elif event == "push":
        _handle_push(repositories, workspace_id, body, _event_time(record, payload))
    elif event == "issues":
        from app.domains.integrations.issue_sync import handle_issue_event

        handle_issue_event(repositories, workspace_id, body)
    elif event == "issue_comment":
        from app.domains.integrations.issue_sync import handle_comment_event

        handle_comment_event(repositories, workspace_id, body)
    elif event == "deployment_status":
        from app.domains.integrations.deployments import handle_deployment_status

        handle_deployment_status(repositories, workspace_id, body)


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
    """Link a pull request to the issues it names and move them if a rule says so.

    An issue whose link refuses the write as stale is left alone, and a delivery
    any link refused queues no write-back and no label sync, because every link of
    one pull request shares its `updated_at` and the comment, check run and labels
    would describe a state that has since moved on.

    A pull request from an untrusted author, such as a fork pull request from an
    outsider, links nothing and posts nothing. A repository pinned to no team
    reaches only the teams its author may reach, so naming a private team's key
    does nothing for someone outside that team.
    """
    pull_request = body.get("pull_request")
    repository = body.get("repository")
    if not isinstance(pull_request, Mapping) or not isinstance(repository, Mapping):
        return

    trusted, member = _pull_request_author(repositories, workspace_id, pull_request)
    if not trusted:
        _log.info(
            "Ignored a pull request from an untrusted author.",
            extra={"event": "integrations.pr_untrusted_author"},
        )
        return

    repository_id = str(repository.get("id", ""))
    stored_repository = repositories.github.get_repository(workspace_id, repository_id)
    pinned_team = stored_repository.team_id if stored_repository else None
    prefixes = _prefixes(repositories, workspace_id, pinned_team)
    reachable = None if pinned_team else _reachable_teams(repositories, workspace_id, member)
    if reachable is not None:
        prefixes = {team_id: rows for team_id, rows in prefixes.items() if team_id in reachable}
    if not prefixes:
        return

    head = pull_request.get("head")
    branch = str(head.get("ref", "")) if isinstance(head, Mapping) else ""
    base = pull_request.get("base")
    base_branch = str(base.get("ref", "")) if isinstance(base, Mapping) else ""
    title = str(pull_request.get("title", ""))
    pr_body = str(pull_request.get("body") or "")

    action = str(body.get("action", ""))
    merged = bool(pull_request.get("merged"))
    draft = bool(pull_request.get("draft"))
    state = linking.pr_state(state=str(pull_request.get("state", "")), merged=merged, draft=draft)
    trigger = linking.trigger_for(action, merged=merged, draft=draft)

    commit_messages: list[str] = []
    if trigger == "pr_merged" and _has_merge_rules(repositories, workspace_id, prefixes):
        commit_messages = _merged_commit_messages(body, pull_request, repository_id)
    found = linking.extract(prefixes, branch=branch, title=title, body=pr_body, commit_messages=commit_messages)
    node_id = str(pull_request.get("node_id", "")) or f"{repository_id}#{pull_request.get('number', '')}"
    pr_updated_ms = source_millis(_pull_request_time(pull_request, event_at))
    if not found:
        pr_labels.after_delivery(repositories, workspace_id, body, node_id, pr_updated_ms, [])
        return

    user = pull_request.get("user")
    author = str(user.get("login", "")) if isinstance(user, Mapping) else ""

    issues = _resolve_issues(repositories, workspace_id, found)
    if reachable is not None:
        issues = {key: issue for key, issue in issues.items() if issue.team_id in reachable}
    if not issues:
        pr_labels.after_delivery(repositories, workspace_id, body, node_id, pr_updated_ms, [])
        return

    stale = False
    for key, issue in issues.items():
        match = next(row for row in found if row.key == key)
        link_id = f"{node_id}#{issue.issue_id}"
        previous = repositories.github.get_link(workspace_id, link_id)
        issue_trigger = trigger
        if previous is None and issue_trigger is None:
            issue_trigger = linking.trigger_for_new_link(
                action,
                state=str(pull_request.get("state", "")),
                merged=merged,
                draft=draft,
            )
        written = repositories.github.put_link(
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
                pr_updated_ms=pr_updated_ms,
                repository_id=repository_id,
                applied_labels=previous.applied_labels if previous is not None else [],
                linked_at=previous.linked_at if previous is not None else utc_now(),
                updated_at=utc_now(),
            )
        )
        if not written:
            _log.info(
                "Skipped a pull request delivery older than the stored link.",
                extra={"event": "integrations.link_stale"},
            )
            stale = True
            continue

        if issue_trigger is not None:
            applied = _apply_transition(
                repositories,
                workspace_id,
                issue,
                issue_trigger,
                closes=match.magic_word is not None,
                base_branch=base_branch,
                event_at=event_at,
            )
            if applied is not None:
                repositories.github.update_link(workspace_id, link_id, applied_status_id=applied)

    if stale:
        return
    link_ids = [f"{node_id}#{issue.issue_id}" for issue in issues.values()]
    _enqueue_writeback(workspace_id, repository, pull_request, sorted(issues), link_ids)
    pr_labels.after_delivery(repositories, workspace_id, body, node_id, pr_updated_ms, link_ids)


def _has_merge_rules(repositories: Repositories, workspace_id: str, prefixes: Mapping[str, Any]) -> bool:
    """Whether any team a merge could touch has stored `pr_merged` rules.

    Only a stored rule moves an issue on a merge without a magic word, and a key
    found in a commit message never carries one, so a team on the defaults has no
    use for the commit list and GitHub is not asked for it.
    """
    return any(
        row.trigger == "pr_merged"
        for team_id in prefixes
        for row in repositories.team_config.list_transitions(workspace_id, team_id)
    )


def _merged_commit_messages(
    body: Mapping[str, Any],
    pull_request: Mapping[str, Any],
    repository_id: str,
) -> list[str]:
    """The commit messages of a merged pull request, read from GitHub since the payload lacks them.

    A promotion pull request names no key in its branch, title or body; the keys
    of the work it ships are in its commits. A missing App or a repository GitHub
    no longer shows is logged and read as no commits, so the rest of the delivery
    still applies. A rate limit or an outage raises, so the record is retried.
    """
    from webbpulse.integrations.github import GitHubForbidden, GitHubNotConfigured, GitHubNotFound

    installation = body.get("installation")
    installation_id = str(installation.get("id", "")) if isinstance(installation, Mapping) else ""
    number = pull_request.get("number")
    if not installation_id or not repository_id or not number:
        return []
    base = pull_request.get("base")
    head = pull_request.get("head")
    try:
        return fetch_commit_messages(
            installation_id,
            repository_id,
            str(number),
            base_sha=str(base.get("sha", "")) if isinstance(base, Mapping) else "",
            head_sha=str(head.get("sha", "")) if isinstance(head, Mapping) else "",
        )
    except (GitHubNotConfigured, GitHubNotFound, GitHubForbidden, ValueError):
        _log.warning(
            "Could not read a merged pull request's commits.",
            extra={"event": "integrations.pr_commits_unavailable"},
        )
        return []


def fetch_commit_messages(
    installation_id: str,
    repository_id: str,
    number: str,
    *,
    base_sha: str,
    head_sha: str,
) -> list[str]:
    """Every commit message on one pull request, read with a fresh installation token."""
    from app.domains.integrations import github_issues

    token = github_issues.installation_token(installation_id)
    return github_issues.pull_request_commit_messages(
        token, repository_id, number, base_sha=base_sha, head_sha=head_sha
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
    and never a transition. Each commit that names a key is its own row, so the
    feed can name and link the sha.
    """
    repository = body.get("repository")
    if not isinstance(repository, Mapping):
        return
    repository_id = str(repository.get("id", ""))
    stored_repository = repositories.github.get_repository(workspace_id, repository_id)
    prefixes = _prefixes(repositories, workspace_id, stored_repository.team_id if stored_repository else None)
    if not prefixes:
        return

    full_name = str(repository.get("full_name", ""))
    commits = [entry for entry in (body.get("commits") or []) if isinstance(entry, Mapping)]
    for commit in commits:
        found = linking.extract(prefixes, commit_messages=[str(commit.get("message", ""))])
        if not found:
            continue
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
                    to_value=_commit_reference(full_name, commit),
                )
            )


def _commit_reference(full_name: str, commit: Mapping[str, Any]) -> dict[str, str]:
    """What an activity row keeps about one commit: where it landed and how to open it.

    One row per commit rather than one per push, so the feed can name the short sha
    and link it, and the first line of the message is kept so a reader sees what
    the commit said without leaving the issue.
    """
    message = str(commit.get("message", "")).strip().splitlines()
    return {
        "repository": full_name,
        "sha": str(commit.get("id", "")),
        "url": str(commit.get("url", "")),
        "message": (message[0] if message else "")[:200],
    }


def _resolve_issues(repositories: Repositories, workspace_id: str, found: Sequence[linking.FoundKey]) -> dict[str, Any]:
    """The issues the found keys name, keyed by the key, skipping ones that are gone.

    A key names a team and a number, and the number is unique within the team,
    so this is one index read each rather than a scan. A key written before its
    issue moved to another team resolves to the issue where it now lives. A key
    whose issue was deleted resolves to nothing and is simply not linked.
    """
    resolved: dict[str, Any] = {}
    for row in found:
        issue = find_issue_by_number(repositories, workspace_id, row.team_id, row.number)
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
    base_branch: str = "",
) -> str | None:
    """Move one issue if a rule says to and nobody has moved it since.

    A merge without a magic word still moves the issue when a rule maps `pr_merged`
    to a status; the magic word is what makes a merge close an issue in a team
    whose rules say nothing, which is the design section 4 default. The rule is the
    one for the branch the pull request targets, so a `Fixes` merge into `staging`
    lands in that branch's status rather than closing the issue. Opening, readying
    and merging only ever move an issue forward, so a promotion naming issues already
    on staging leaves them there.
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

    rule = linking.select_rule(rules, trigger, base_branch)
    if rule is None or (rule.is_default and trigger == "pr_merged" and not closes):
        return None
    target = rule.status_id

    if not target or target == issue.status_id:
        return None
    if trigger in linking.FORWARD_ONLY_TRIGGERS:
        by_id = {status.status_id: status for status in statuses}
        if not linking.moves_forward(by_id.get(issue.status_id), by_id.get(target)):
            _log.info(
                "Skipped a transition that would move the issue back.",
                extra={"event": "integrations.transition_backward_skipped"},
            )
            return None

    previous = issue.status_id
    moved = issue.model_copy(
        update={"status_id": target, "updated_at": utc_now(), "updated_by": None, "updated_source": GITHUB}
    )
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
                "repository_id": str(repository.get("id", "")),
                "repository_full_name": str(repository.get("full_name", "")),
                "repository_private": repository.get("private") is not False,
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
