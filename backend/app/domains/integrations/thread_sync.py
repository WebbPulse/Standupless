"""Comment threads synced to a GitHub pull request or issue, like Linear's synced threads.

A person marks one root comment's thread as synced to a pull request linked to
the issue, or to the GitHub issue a one way sync imported it from. From then on
the App posts the thread to that conversation: an opening comment that quotes the
root, then every new reply naming its author, with edits carried by editing the
App's copy. A comment written on that pull request or issue while the thread is
synced lands in the thread as a reply, preferring the thread whose text it
quotes when several are synced to the same place. Unsyncing forgets the pairing
and leaves every comment where it is on both sides.

The thread rides on the issue sync's machinery rather than beside it: the same
`github.comment_sync` job posts both, the same `issue_comment` deliveries feed
both, and the same three echo guards hold. A delivery from the App's own bot is
dropped, each pairing records which side wrote the comment first so only that
side's edits cross, and an inbound reply's row is claimed before the reply is
written, so the job its stream record queues finds it already paired. A GitHub
issue a two way sync mirrors is refused as a target, because every comment on
it already crosses.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any, Mapping, Sequence

from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.change_source import GITHUB
from app.common.comment_anchors import quoted_passage
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.comments import Comment, GithubThread, build_comment, new_comment_id
from app.common.db.dynamo.github import ThreadComment, ThreadTarget, thread_comment_key, thread_target_key
from app.common.db.dynamo.issues import Issue
from app.common.issue_keys import current
from app.common.issue_rules import load_visible_issue, require_team_member
from app.common.thread_resolution import reopen_on_reply
from app.common.triage_wake import wake_on_activity
from app.domains.integrations import github_issues
from app.domains.integrations.issue_sync import (
    GITHUB_AUTHOR_PREFIX,
    PENDING_STALE,
    _comment_author,
    _escape,
    _parse_time,
    _positive_id,
    _Token,
    _user_for_github,
    is_backlink,
    issue_url,
    outbound_comment_body,
    own_delivery,
)
from app.domains.integrations.service import conflict, not_found, unprocessable

_log = logging.getLogger(__name__)

THREAD_MARKER_PREFIX = "<!-- standupless:thread:"

_THREAD_MARKER = re.compile(r"<!-- standupless:thread:([0-9A-Za-z]+) -->")

_COMMENT_ANCHOR = re.compile(r"issuecomment-(\d+)")

PULL_REQUEST = "pull_request"

GITHUB_ISSUE = "issue"

TRUSTED_ASSOCIATIONS = frozenset({"OWNER", "MEMBER", "COLLABORATOR"})
"""Who may write into a synced thread from GitHub without a linked account.

The same standing pull request links ask for, so a stranger commenting on a
public repository's pull request cannot write into a team's issue.
"""


def thread_marker(root_comment_id: str) -> str:
    """The hidden first line of the App's opening comment for one thread."""
    return f"{THREAD_MARKER_PREFIX}{root_comment_id} -->"


def is_thread_opener(text: str) -> bool:
    """Whether a GitHub comment is the App's opening comment of a synced thread."""
    return text.lstrip().startswith(THREAD_MARKER_PREFIX)


def target_ref(full_name: str, number: int) -> str:
    """How a target is named to a person or an agent, `owner/repo#12`."""
    return f"{full_name}#{number}"


def thread_targets(repositories: Repositories, issue: Issue) -> list[dict[str, Any]]:
    """Where one issue's threads may be synced: its linked pull requests and its one way GitHub issue.

    A pull request linked through several keys is listed once, and a detached link
    is left out because the pull request no longer names the issue. A GitHub issue
    a two way sync mirrors is left out, because its comments already cross.
    """
    workspace_id = issue.workspace_id
    repositories_by_id = {row.repository_id: row for row in repositories.github.list_repositories(workspace_id)}
    seen: set[tuple[str, int]] = set()
    targets: list[dict[str, Any]] = []
    page = repositories.github.list_links_for_issue(workspace_id, issue.issue_id, limit=100)
    for item in page.items:
        repository_id = str(item.get("repository_id") or "")
        number = int(item.get("pr_number") or 0)
        if item.get("detached") or not repository_id or not number or (repository_id, number) in seen:
            continue
        seen.add((repository_id, number))
        repository = repositories_by_id.get(repository_id)
        full_name = str(item.get("repository_full_name") or (repository.full_name if repository else ""))
        targets.append(
            {
                "kind": PULL_REQUEST,
                "repository_id": repository_id,
                "full_name": full_name,
                "number": number,
                "title": str(item.get("pr_title") or ""),
                "url": str(item.get("pr_url") or ""),
                "private": repository.private if repository is not None else False,
                "ref": target_ref(full_name, number),
            }
        )
    sync = repositories.github.get_issue_sync(workspace_id, issue.issue_id)
    if sync is not None and sync.state == "linked" and sync.number and (sync.repository_id, sync.number) not in seen:
        config = repositories.github.team_sync_for_repository(workspace_id, sync.repository_id)
        if config is not None and config.enabled and not config.writes_back:
            repository = repositories_by_id.get(sync.repository_id)
            targets.append(
                {
                    "kind": GITHUB_ISSUE,
                    "repository_id": sync.repository_id,
                    "full_name": sync.full_name,
                    "number": sync.number,
                    "title": issue.title,
                    "url": sync.html_url,
                    "private": repository.private if repository is not None else False,
                    "ref": target_ref(sync.full_name, sync.number),
                }
            )
    return targets


def _two_way_target(repositories: Repositories, issue: Issue, repository_id: str, number: int) -> bool:
    """Whether a pull request or issue is the GitHub issue a two way sync already mirrors."""
    sync = repositories.github.get_issue_sync(issue.workspace_id, issue.issue_id)
    if sync is None or (sync.repository_id, sync.number) != (repository_id, number):
        return False
    config = repositories.github.team_sync_for_repository(issue.workspace_id, repository_id)
    return config is not None and config.writes_back


def pick_target(targets: Sequence[Mapping[str, Any]], reference: str | None) -> Mapping[str, Any]:
    """The one target a reference names, or the only target when none is named, or a 422 that lists them.

    A reference is `owner/repo#12`, a pull request or issue URL, or a bare number
    when only one repository is in play.
    """
    if not targets:
        raise conflict("This issue has no linked pull request or GitHub issue to sync a thread to")
    if not reference:
        if len(targets) == 1:
            return targets[0]
        raise unprocessable(f"Name github_target, one of: {', '.join(str(row['ref']) for row in targets)}")
    wanted = reference.strip().lower().rstrip("/")
    for row in targets:
        names = {str(row["ref"]).lower(), str(row["url"]).lower().rstrip("/"), f"#{row['number']}", str(row["number"])}
        if wanted in names:
            return row
    raise unprocessable(f"Unknown github_target, use one of: {', '.join(str(row['ref']) for row in targets)}")


def _root_comment(repositories: Repositories, context: AuthzContext, issue: Issue, comment_id: str) -> Comment:
    """A root comment of a visible issue, or a 404, or a 409 for a reply."""
    comment = repositories.comments.get(context.workspace_id, issue.issue_id, comment_id)
    if comment is None:
        raise not_found()
    if comment.parent_comment_id:
        raise conflict("Only a thread's first comment can be synced")
    return comment


def sync_thread(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: str,
    comment_id: str,
    *,
    repository_id: str | None = None,
    number: int | None = None,
    reference: str | None = None,
) -> Comment:
    """Sync one root comment's thread to a linked pull request or GitHub issue, answering the stored comment.

    The target is named by repository and number, or by a reference `pick_target`
    reads. Syncing a thread that is already synced to the same place changes
    nothing, and syncing it somewhere else unsyncs it from the first place. The
    pointer is written before the mark on the comment, so the stream record of the
    mark queues a post that finds its thread.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)
    comment = _root_comment(repositories, context, issue, comment_id)
    installation = repositories.github.get_installation(context.workspace_id)
    if installation is None or installation.suspended_at is not None:
        raise conflict("The GitHub App is not installed or is suspended")

    if repository_id and number and _two_way_target(repositories, issue, repository_id, number):
        raise conflict("That GitHub issue already syncs every comment both ways")
    targets = thread_targets(repositories, issue)
    if repository_id and number:
        matches = [row for row in targets if (row["repository_id"], row["number"]) == (repository_id, number)]
        if not matches:
            raise unprocessable("That pull request or issue is not linked to this issue")
        target = matches[0]
    else:
        target = pick_target(targets, reference)

    existing = comment.github_thread
    if existing is not None:
        if (existing.repository_id, existing.number) == (target["repository_id"], target["number"]):
            return comment
        _forget(repositories, issue, comment.comment_id, existing)

    thread = GithubThread(
        kind=str(target["kind"]),
        repository_id=str(target["repository_id"]),
        full_name=str(target["full_name"]),
        number=int(target["number"]),
        target_url=str(target["url"]),
        private=bool(target["private"]),
        synced_by=context.user_id,
    )
    repositories.github.put_thread_target(
        ThreadTarget(
            workspace_id=issue.workspace_id,
            github_key=thread_target_key(thread.repository_id, thread.number, comment.comment_id),
            issue_id=issue.issue_id,
            team_id=issue.team_id,
            root_comment_id=comment.comment_id,
            repository_id=thread.repository_id,
            number=thread.number,
            synced_at=thread.synced_at,
        )
    )
    updated = repositories.comments.set_github_thread(context.workspace_id, issue.issue_id, comment.comment_id, thread)
    if updated is None:
        repositories.github.delete_thread(
            issue.workspace_id, issue.issue_id, comment.comment_id, thread.repository_id, thread.number
        )
        raise not_found()
    _log.info("Synced a comment thread to GitHub.", extra={"event": "integrations.thread.synced"})
    return updated


def unsync_thread(repositories: Repositories, context: AuthzContext, issue_id: str, comment_id: str) -> Comment:
    """Stop mirroring one thread, leaving every comment where it is, answering the stored comment.

    The mark goes first, so a job racing the unsync finds the thread unsynced and
    posts nothing, and then the pairing rows go. Unsyncing a thread that is not
    synced changes nothing.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)
    comment = _root_comment(repositories, context, issue, comment_id)
    thread = comment.github_thread
    if thread is None:
        return comment
    updated = repositories.comments.set_github_thread(context.workspace_id, issue.issue_id, comment.comment_id, None)
    _forget(repositories, issue, comment.comment_id, thread)
    _log.info("Unsynced a comment thread from GitHub.", extra={"event": "integrations.thread.unsynced"})
    return updated or comment.model_copy(update={"github_thread": None})


def _forget(repositories: Repositories, issue: Issue, root_comment_id: str, thread: GithubThread) -> None:
    """Drop one thread's pointer and pairing rows."""
    repositories.github.delete_thread(
        issue.workspace_id, issue.issue_id, root_comment_id, thread.repository_id, thread.number
    )


def _quote(text: str) -> str:
    """Markdown text as a blockquote."""
    lines = text.strip().splitlines() or [""]
    return "\n".join(f"> {line}" if line else ">" for line in lines)


def opener_body(repositories: Repositories, issue: Issue, root: Comment) -> str:
    """The App's opening comment for a thread, quoting its root and linking the issue.

    Carries `thread_marker` on its first line, which is how a retry finds a post
    that landed before its row was saved, and how the events consumer knows the
    delivery of it is the App's own. A root pinned to a passage of the description
    quotes that passage ahead of its own text.
    """
    user = repositories.users.get(root.author_id)
    name = _escape((user.display_name or "") if user is not None else "") or "Someone"
    key = current(repositories.teams, issue).key
    workspace = repositories.workspaces.get(issue.workspace_id)
    where = f"[{key}]({issue_url(workspace.slug, key)})" if workspace is not None and workspace.slug else key
    return (
        f"{thread_marker(root.comment_id)}\n"
        f"**{name}** started a thread in Standupless on {where}:\n\n"
        f"{quoted_passage(root.anchor)}"
        f"{_quote(root.body)}\n\n"
        "Replies here are added to the thread in Standupless."
    )


def _posted_opener(comments: Sequence[Mapping[str, Any]], root_comment_id: str) -> Mapping[str, Any] | None:
    """An opening comment the App already posted for one thread, found by its marker."""
    marker = thread_marker(root_comment_id)
    for comment in comments:
        if str(comment.get("body") or "").lstrip().startswith(marker) and _positive_id(comment.get("id")):
            return comment
    return None


def push_thread_comment(repositories: Repositories, comment: Comment) -> None:
    """Post or update the GitHub copy of one comment in a synced thread.

    The root's first post is the opening comment and its edits re-render it. A
    reply is posted only when it was written after the thread was synced, so
    syncing an old thread does not replay its history. A comment GitHub wrote, or
    one already paired from GitHub, is never posted back.
    """
    if comment.author_id.startswith(GITHUB_AUTHOR_PREFIX) or comment.source == GITHUB:
        return
    workspace_id = comment.workspace_id
    if comment.parent_comment_id:
        root = repositories.comments.get(workspace_id, comment.issue_id, comment.parent_comment_id)
    else:
        root = comment
    if root is None or root.github_thread is None:
        return
    thread = root.github_thread
    if comment is not root and comment.created_at < thread.synced_at:
        return
    if (
        repositories.github.get_thread_target(workspace_id, thread.repository_id, thread.number, root.comment_id)
        is None
    ):
        return
    issue = repositories.issues.get(workspace_id, comment.issue_id)
    installation = repositories.github.get_installation(workspace_id)
    if issue is None or installation is None or installation.suspended_at is not None:
        return
    token = _Token(str(installation.installation_id))

    def render() -> str:
        """The GitHub text of this comment, as the opener or as a reply."""
        if comment is root:
            return opener_body(repositories, issue, root)
        return outbound_comment_body(repositories, comment.author_id, comment.body)

    existing = repositories.github.get_thread_comment(workspace_id, comment.issue_id, comment.comment_id)
    if existing is not None and (existing.repository_id, existing.number) != (thread.repository_id, thread.number):
        repositories.github.delete_thread_comment(existing)
        existing = None
    if existing is None:
        pending = ThreadComment(
            workspace_id=workspace_id,
            github_key=thread_comment_key(comment.issue_id, comment.comment_id),
            issue_id=comment.issue_id,
            comment_id=comment.comment_id,
            root_comment_id=root.comment_id,
            repository_id=thread.repository_id,
            number=thread.number,
            origin="standupless",
            state="pending",
            body=comment.body,
        )
        if not repositories.github.claim_thread_comment(pending, stale_before=utc_now() - PENDING_STALE):
            return
        body = render()
        found = None
        if comment is root:
            found = _posted_opener(
                github_issues.list_comments(token(), thread.repository_id, thread.number), root.comment_id
            )
        if found is not None:
            response = found
            if str(found.get("body") or "") != body:
                response = github_issues.update_comment(token(), thread.repository_id, str(found.get("id")), body)
        else:
            response = github_issues.create_comment(token(), thread.repository_id, thread.number, body)
        repositories.github.save_thread_comment(
            pending.model_copy(
                update={
                    "github_comment_id": str(response.get("id", "")),
                    "html_url": str(response.get("html_url") or ""),
                    "state": "linked",
                }
            )
        )
        _log.info("Posted a thread comment to GitHub.", extra={"event": "integrations.thread.posted"})
        return

    if existing.origin != "standupless" or existing.state != "linked" or existing.body == comment.body:
        return
    try:
        github_issues.update_comment(token(), thread.repository_id, existing.github_comment_id, render())
    except github_issues.GitHubNotFound:
        repositories.github.delete_thread_comment(existing)
        return
    repositories.github.save_thread_comment(existing.model_copy(update={"body": comment.body}))
    _log.info("Updated a thread comment on GitHub.", extra={"event": "integrations.thread.updated"})


def note_own_comment(repositories: Repositories, workspace_id: str, body: Mapping[str, Any]) -> None:
    """Record where the App's opening comment of a thread landed, from GitHub's delivery of it.

    The dispatch job that posts the comment may not write comments, while the
    events consumer may, so the link a synced thread shows is set here. The write
    is conditioned on the thread still naming this pull request or issue.
    """
    comment = body.get("comment")
    github_issue = body.get("issue")
    repository = body.get("repository")
    if str(body.get("action", "")) != "created" or not isinstance(comment, Mapping):
        return
    if not isinstance(github_issue, Mapping) or not isinstance(repository, Mapping):
        return
    match = _THREAD_MARKER.match(str(comment.get("body") or "").lstrip())
    url = str(comment.get("html_url") or "")
    if match is None or not url:
        return
    repository_id = str(repository.get("id", ""))
    number = int(github_issue.get("number") or 0)
    target = repositories.github.get_thread_target(workspace_id, repository_id, number, match.group(1))
    if target is None:
        return
    repositories.comments.set_github_thread_url(
        workspace_id, target.issue_id, target.root_comment_id, repository_id, number, url
    )


def _live_threads(
    repositories: Repositories, workspace_id: str, repository_id: str, number: int
) -> list[tuple[ThreadTarget, Comment]]:
    """Every thread still synced to one pull request or issue, with its root, the most recently synced first."""
    live: list[tuple[ThreadTarget, Comment]] = []
    for target in repositories.github.thread_targets(workspace_id, repository_id, number):
        root = repositories.comments.get(workspace_id, target.issue_id, target.root_comment_id)
        thread = root.github_thread if root is not None else None
        if root is not None and thread is not None and (thread.repository_id, thread.number) == (repository_id, number):
            live.append((target, root))
    return live


def _quoted_lines(text: str) -> set[str]:
    """The non-empty lines a Markdown comment quotes, with their quote marks stripped."""
    quoted: set[str] = set()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith(">"):
            continue
        content = stripped.lstrip("> ").strip()
        if content:
            quoted.add(content)
    return quoted


def _choose_thread(
    repositories: Repositories, threads: list[tuple[ThreadTarget, Comment]], text: str
) -> tuple[ThreadTarget, Comment]:
    """The thread a GitHub comment answers: the one whose comment it links or quotes most, else the newest."""
    if len(threads) == 1:
        return threads[0]
    anchors = set(_COMMENT_ANCHOR.findall(text))
    quoted = _quoted_lines(text)
    best = threads[0]
    best_score = 0
    for target, root in threads:
        rows = repositories.github.list_thread_comments(target.workspace_id, target.issue_id, root.comment_id)
        if anchors & {row.github_comment_id for row in rows}:
            return target, root
        lines = {line.strip() for line in root.body.splitlines()}
        for row in rows:
            lines.update(line.strip() for line in row.body.splitlines())
        score = len(quoted & lines)
        if score > best_score:
            best, best_score = (target, root), score
    return best


def handle_inbound(repositories: Repositories, workspace_id: str, body: Mapping[str, Any]) -> bool:
    """Carry one `issue_comment` delivery into a synced thread, answering whether a thread took it.

    A new comment on a pull request or issue with a synced thread becomes a reply
    in that thread. An edit or delete of a comment paired from GitHub follows it
    while the thread is still synced there. A delivery no thread takes is left for
    the issue sync.
    """
    github_issue = body.get("issue")
    repository = body.get("repository")
    comment = body.get("comment")
    if not isinstance(github_issue, Mapping) or not isinstance(repository, Mapping) or not isinstance(comment, Mapping):
        return False
    text = str(comment.get("body") or "")
    if is_backlink(text) or is_thread_opener(text) or own_delivery(body):
        return False
    repository_id = str(repository.get("id", ""))
    number = int(github_issue.get("number") or 0)
    action = str(body.get("action", ""))
    github_comment_id = str(comment.get("id", ""))
    edited_ms = _millis(comment.get("updated_at"))

    existing = repositories.github.thread_comment_for_github(workspace_id, github_comment_id)
    if action != "created":
        if existing is None:
            return False
        _follow(repositories, existing, action, text, edited_ms)
        return True
    if existing is not None:
        return True

    if not _trusted(repositories, workspace_id, comment):
        return False
    threads = _live_threads(repositories, workspace_id, repository_id, number)
    written = _parse_time(comment.get("created_at"))
    if written is not None:
        threads = [(target, root) for target, root in threads if _after_sync(root, written)]
    if not threads:
        return False
    target, root = _choose_thread(repositories, threads, text)
    issue = repositories.issues.get(workspace_id, target.issue_id)
    if issue is None:
        return True
    comment_id = new_comment_id()
    row = ThreadComment(
        workspace_id=workspace_id,
        github_key=thread_comment_key(target.issue_id, comment_id),
        issue_id=target.issue_id,
        comment_id=comment_id,
        root_comment_id=root.comment_id,
        repository_id=repository_id,
        number=number,
        github_comment_id=github_comment_id,
        html_url=str(comment.get("html_url") or ""),
        origin="github",
        body=text,
        github_updated_ms=edited_ms,
    )
    if not repositories.github.claim_thread_comment(row):
        return True
    reply = build_comment(
        workspace_id,
        target.issue_id,
        issue.team_id,
        _comment_author(repositories, workspace_id, comment.get("user")),
        text,
        parent_comment_id=root.comment_id,
        source=GITHUB,
    )
    try:
        repositories.comments.create(reply.model_copy(update={"comment_id": comment_id}))
    except ConditionFailed:
        return True
    reopen_on_reply(repositories, root, reply.author_id, actor_kind="github", source=GITHUB)
    wake_on_activity(repositories, issue, reply.author_id)
    _log.info("Added a GitHub comment to a synced thread.", extra={"event": "integrations.thread.received"})
    return True


def _trusted(repositories: Repositories, workspace_id: str, comment: Mapping[str, Any]) -> bool:
    """Whether a GitHub comment's author has standing in the repository or linked a member account."""
    if str(comment.get("author_association", "") or "").upper() in TRUSTED_ASSOCIATIONS:
        return True
    user = comment.get("user")
    github_id = str(user.get("id", "") or "") if isinstance(user, Mapping) else ""
    return bool(github_id) and _user_for_github(repositories, workspace_id, github_id) is not None


def _after_sync(root: Comment, written: datetime) -> bool:
    """Whether a GitHub comment was written once its thread was synced, to the second."""
    thread = root.github_thread
    return thread is not None and written.replace(microsecond=0) >= thread.synced_at.replace(microsecond=0)


def _millis(value: Any) -> int:
    """A GitHub timestamp in epoch milliseconds, or 0."""
    parsed = _parse_time(value)
    return int(parsed.timestamp() * 1000) if parsed is not None else 0


def _follow(repositories: Repositories, row: ThreadComment, action: str, text: str, edited_ms: int) -> None:
    """Apply a GitHub edit or delete to the reply it paired with, while its thread is still synced there."""
    if row.origin != "github" or row.state != "linked":
        return
    root = repositories.comments.get(row.workspace_id, row.issue_id, row.root_comment_id)
    thread = root.github_thread if root is not None else None
    if thread is None or (thread.repository_id, thread.number) != (row.repository_id, row.number):
        return
    if action == "deleted":
        repositories.comments.delete(row.workspace_id, row.issue_id, row.comment_id)
        repositories.github.delete_thread_comment(row)
        return
    if action != "edited" or (edited_ms and row.github_updated_ms and edited_ms < row.github_updated_ms):
        return
    repositories.github.save_thread_comment(row.model_copy(update={"body": text, "github_updated_ms": edited_ms}))
    current_comment = repositories.comments.get(row.workspace_id, row.issue_id, row.comment_id)
    if current_comment is None or current_comment.body == text:
        return
    try:
        repositories.comments.edit(row.workspace_id, row.issue_id, row.comment_id, text, [])
    except ConditionFailed:
        return


def thread_read(comment: Comment) -> dict[str, Any]:
    """One comment's thread sync state as the routes and tools answer it."""
    return {
        "comment_id": comment.comment_id,
        "issue_id": comment.issue_id,
        "github_thread": comment.github_thread.model_dump(mode="json") if comment.github_thread else None,
    }
