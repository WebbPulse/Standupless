"""Turning one GitLab merge request event into links and transitions.

A GitLab merge request is linked exactly as a GitHub pull request is: the same
key search over the source branch, the title and the description, the same link
rows, ordered on the merge request's own `updated_at`, and the same per team
transition rules, picked by the branch the merge request targets. Nothing is
written back to GitLab, because a connection's token only reads.

Only the connection's own group or project is acted on, and a connection that
was removed since the delivery was queued acts on nothing. GitLab reports no
standing for a merge request's author the way GitHub's `author_association`
does, so a merge request from a fork links nothing, and a merge request reaches
only the workspace's open teams, never a private one.

GitLab has no separate review request trigger that maps onto a status. A merge
request leaving draft is `pr_ready_for_review`, as a GitHub pull request leaving
draft is.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from typing import Any, Mapping

from app.common.api.dependencies.repositories import Repositories
from app.common.change_source import SYSTEM
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import IssueLink, link_key, source_millis
from app.common.db.dynamo.gitlab import GitlabConnection
from app.domains.integrations import linking
from app.domains.integrations.pr_summary import refresh_for_pr

_log = logging.getLogger(__name__)

EVENT = "gitlab.merge_request"
"""The queued event name a GitLab merge request delivery travels under."""

PROVIDER = "gitlab"


def node_id(instance_url: str, project_id: str, iid: int) -> str:
    """The id one merge request's link rows are keyed under.

    Keyed by the instance, the target project and the merge request's number in
    it, rather than by connection, so a project two connections cover still has
    one row per issue and a replayed delivery reaches the same row.
    """
    instance = hashlib.sha256(instance_url.encode()).hexdigest()[:12]
    return f"gitlab_{instance}_{project_id}_{iid}"


def in_scope(connection: GitlabConnection, project: Mapping[str, Any]) -> bool:
    """Whether a merge request's project is the connection's project or sits under its group."""
    project_id = str(project.get("id", "") or "")
    if connection.scope_kind == "project":
        return bool(project_id) and project_id == connection.scope_id
    path = str(project.get("path_with_namespace", "") or "").lower()
    return bool(path) and path.startswith(f"{connection.scope_path.lower()}/")


def trigger_for(action: str, *, draft: bool, changes: Mapping[str, Any]) -> str | None:
    """Which transition trigger a GitLab merge request action fires, or `None`.

    `open` and `reopen` start the work unless the merge request is a draft,
    `merge` and `close` split the way a closed GitHub pull request does, and an
    `update` that turned a draft ready is the ready for review trigger.
    """
    if action in ("open", "reopen"):
        return None if draft else "pr_opened"
    if action == "merge":
        return "pr_merged"
    if action == "close":
        return "pr_closed"
    if action == "update":
        change = changes.get("draft") or changes.get("work_in_progress")
        if isinstance(change, Mapping) and change.get("previous") is True and change.get("current") is False:
            return "pr_ready_for_review"
    return None


def link_state(state: str, *, draft: bool) -> str:
    """How a GitLab merge request state is recorded on the link row."""
    if state == "merged":
        return "merged"
    if state in ("closed", "locked"):
        return "closed"
    return "draft" if draft else "open"


def _updated_at(attributes: Mapping[str, Any], event_at: datetime) -> datetime:
    """The merge request's own `updated_at`, in either form GitLab writes it, else when the delivery arrived."""
    raw = str(attributes.get("updated_at", "") or "").strip()
    if raw:
        text = raw.replace(" UTC", "+00:00").replace("Z", "+00:00")
        if " " in text and "T" not in text:
            text = text.replace(" ", "T", 1)
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            parsed = None
        if parsed is not None:
            return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=event_at.tzinfo)
    return event_at


def handle(repositories: Repositories, payload: Mapping[str, Any], event_at: datetime) -> bool:
    """Link one GitLab merge request to the issues it names and move them if a rule says so.

    Answers whether anything was written. A delivery for a removed connection,
    a project outside the connection, or a merge request from a fork does nothing.
    """
    from app.domains.integrations.consumers.events import (
        _apply_transition,
        _prefixes,
        _reachable_teams,
        _resolve_issues,
    )

    workspace_id = str(payload.get("workspace_id", "") or "")
    connection_id = str(payload.get("connection_id", "") or "")
    body = payload.get("body")
    if not workspace_id or not connection_id or not isinstance(body, Mapping):
        return False
    connection = repositories.github.gitlab.get(workspace_id, connection_id)
    if connection is None:
        _log.info(
            "Dropped a GitLab delivery for a connection that was removed.",
            extra={"event": "integrations.gitlab.unknown_connection"},
        )
        return False

    attributes = body.get("object_attributes")
    project = body.get("project")
    if body.get("object_kind") != "merge_request" or not isinstance(attributes, Mapping):
        return False
    if not isinstance(project, Mapping) or not in_scope(connection, project):
        _log.info(
            "Dropped a GitLab delivery for a project outside its connection.",
            extra={"event": "integrations.gitlab.out_of_scope"},
        )
        return False
    project_id = str(project.get("id", "") or "")
    source_project = str(attributes.get("source_project_id", "") or project_id)
    target_project = str(attributes.get("target_project_id", "") or project_id)
    if source_project != target_project:
        _log.info(
            "Ignored a GitLab merge request from a fork.",
            extra={"event": "integrations.gitlab.fork_ignored"},
        )
        return False

    reachable = _reachable_teams(repositories, workspace_id, None)
    prefixes = {
        team_id: rows for team_id, rows in _prefixes(repositories, workspace_id).items() if team_id in reachable
    }
    if not prefixes:
        return False

    iid = int(attributes.get("iid", 0) or 0)
    if iid <= 0:
        return False
    branch = str(attributes.get("source_branch", "") or "")
    base_branch = str(attributes.get("target_branch", "") or "")
    title = str(attributes.get("title", "") or "")
    description = str(attributes.get("description") or "")
    action = str(attributes.get("action", "") or "")
    state_raw = str(attributes.get("state", "") or "")
    draft = bool(attributes.get("draft") or attributes.get("work_in_progress"))
    changes = body.get("changes")
    changes = changes if isinstance(changes, Mapping) else {}
    state = link_state(state_raw, draft=draft)
    trigger = trigger_for(action, draft=draft, changes=changes)

    node = node_id(connection.instance_url, project_id, iid)
    pr_updated_ms = source_millis(_updated_at(attributes, event_at))
    found = linking.extract(prefixes, branch=branch, title=title, body=description)
    issues = _resolve_issues(repositories, workspace_id, found)
    issues = {key: issue for key, issue in issues.items() if issue.team_id in reachable}

    user = body.get("user")
    actor = str(user.get("username", "") or "") if isinstance(user, Mapping) else ""
    named: list[str] = []
    for key, issue in issues.items():
        match = next(row for row in found if row.key == key)
        link_id = f"{node}#{issue.issue_id}"
        previous = repositories.github.get_link(workspace_id, link_id)
        moves = match.moves_status
        issue_trigger = trigger if moves else None
        newly_moving = previous is None or not previous.moves_status
        if moves and newly_moving and issue_trigger is None and action == "update":
            issue_trigger = linking.trigger_for_new_link(
                "edited", state="open" if state_raw == "opened" else state_raw, merged=state == "merged", draft=draft
            )
        author = previous.author_login if previous is not None and previous.author_login else ""
        if not author and action == "open":
            author = actor
        written = repositories.github.put_link(
            IssueLink(
                workspace_id=workspace_id,
                github_key=link_key(link_id),
                ws_issue=f"{workspace_id}#{issue.issue_id}",
                link_id=link_id,
                issue_id=issue.issue_id,
                issue_key=key,
                repository_full_name=str(project.get("path_with_namespace", "") or ""),
                pr_number=iid,
                pr_title=title,
                pr_url=str(attributes.get("url", "") or ""),
                pr_state=state,
                author_login=author,
                magic_word=match.magic_word,
                moves_status=moves,
                holds_on_merge=match.holds_on_merge,
                applied_status_id=previous.applied_status_id if previous is not None else None,
                pr_updated_ms=pr_updated_ms,
                provider=PROVIDER,
                head_ref=branch,
                base_ref=base_branch,
                linked_at=previous.linked_at if previous is not None else utc_now(),
                updated_at=utc_now(),
            )
        )
        if not written:
            _log.info(
                "Skipped a GitLab delivery older than the stored link.",
                extra={"event": "integrations.gitlab.link_stale"},
            )
            continue
        named.append(link_id)
        if issue_trigger is None:
            continue
        applied = _apply_transition(
            repositories,
            workspace_id,
            issue,
            issue_trigger,
            closes=match.magic_word is not None,
            holds=bool(match.holds_on_merge),
            base_branch=base_branch,
            event_at=event_at,
            actor_kind=SYSTEM,
            source=SYSTEM,
        )
        if applied is not None:
            repositories.github.update_link(workspace_id, link_id, applied_status_id=applied)

    wanted = {f"{node}#{issue.issue_id}" for issue in issues.values()}
    for link in repositories.github.list_links_for_pr(workspace_id, node):
        if link.link_id not in wanted and not link.detached:
            repositories.github.detach_link(workspace_id, link.link_id, pr_updated_ms)
    refresh_for_pr(repositories, workspace_id, node)
    return bool(named)
