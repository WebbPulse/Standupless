"""Import a GitHub repository's Issues into one team through the installed GitHub App.

A GitHub import is an `ImportJob` of kind `github`, so it shares the CSV and
Linear importers' job object, queue, page retries, stale job detection, cancel
and inbox notice. Each queue message reads one page of the repository's issues,
oldest first, with every comment of each, and writes them into the chosen team.
`after` holds the next page number and `cursor` counts the pages, so the queue's
duplicate guard works unchanged. Pull requests share GitHub's issue list and are
skipped.

The App's installation token is minted for each page and never stored. The
repository must be one the workspace's installation covers, checked when the
import starts and again on every page, so an uninstall or a removed repository
fails the job rather than reading on.

Every row gets an id derived from the workspace and the GitHub id, with the
GitHub creation time as its time part, so a page that runs twice, and a later
import of the same repository, updates the rows already written instead of
writing them again. Each issue's `external_ref` carries `owner/repo#number` and
its GitHub URL. An issue the two way sync already mirrors is left to the sync.

People are matched to members through the GitHub account they linked, then by
email, then by a display name equal to their login. A comment by anyone else is
written under the `github:<login>` placeholder the sync uses, and no account or
invite is ever created.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Callable, Mapping, Optional

import httpx
from webbpulse.dynamodb import ConditionFailed, new_ulid
from webbpulse.integrations.github import (
    GitHubError,
    GitHubForbidden,
    GitHubNotConfigured,
    GitHubNotFound,
    GitHubUnauthorized,
)

from app.common import issue_import
from app.common.api.dependencies.authz import AuthzContext
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.linear_import import StepResult, TeamContext, _cap, _ensure_label, _team_context, linear_row_id
from app.domains.integrations import github_issues
from app.domains.integrations.issue_sync import BACKLINK_MARKER, github_author

_log = logging.getLogger(__name__)

PRESET = "github_api"

KIND = "github"

PAGE_SIZE = 50
"""How many issues one page reads, each with its comments, so a page ends well inside its invocation."""

CLOSED_CATEGORIES = {
    "not_planned": ("cancelled", "completed"),
    "duplicate": ("cancelled", "completed"),
}
"""The status categories a closed issue prefers by its close reason; any other reason prefers completed."""


class RepositoryNotAvailable(Exception):
    """The repository is not one the workspace's installed GitHub App covers, or the App is suspended."""


def _http_client() -> httpx.Client:
    """A client for one page's GitHub calls, closed when the page ends."""
    return httpx.Client(timeout=github_issues.TIMEOUT_SECONDS, follow_redirects=False)


http_factory: Callable[[], httpx.Client] = _http_client
"""How a page's HTTP client is built, swapped for an in-process transport in the tests."""


def importable_repositories(repositories: Any, workspace_id: str) -> list[Any]:
    """The repositories the workspace's installation covers, or none when there is no live installation."""
    installation = repositories.github.get_installation(workspace_id)
    if installation is None or installation.suspended_at is not None:
        return []
    return [
        row
        for row in repositories.github.list_repositories(workspace_id)
        if row.installation_id == installation.installation_id
    ]


def covered_repository(repositories: Any, workspace_id: str, repository_id: str) -> Any:
    """One repository the live installation covers, raising `RepositoryNotAvailable` otherwise."""
    installation = repositories.github.get_installation(workspace_id)
    if installation is None or installation.suspended_at is not None:
        raise RepositoryNotAvailable("The GitHub App is not installed or is suspended")
    row = repositories.github.get_repository(workspace_id, repository_id)
    if row is None or row.installation_id != installation.installation_id:
        raise RepositoryNotAvailable("The GitHub App cannot see that repository")
    return row


def start_github_import(repositories: Any, context: AuthzContext, team_id: str, repository_id: str) -> Any:
    """Queue an import of one repository's Issues into one team, or run it inline where no queue exists.

    Refuses like the other imports do, and with `RepositoryNotAvailable` when the
    installation does not cover the repository.
    """
    from app.common.issue_rules import require_team_member

    issue_import.bucket()
    queue_url = settings.ISSUE_IMPORT_QUEUE_URL.strip()
    if not queue_url and settings.is_production:
        raise issue_import.ImportUnavailable("GitHub imports are not configured for this environment")
    require_team_member(repositories, context, team_id)
    repository = covered_repository(repositories, context.workspace_id, repository_id)
    now = utc_now()
    if any(job.is_active(now) for job in issue_import.list_jobs(context.workspace_id, limit=3)):
        raise issue_import.ImportInProgress("An import into this workspace is already running")
    job = issue_import.save_job(
        issue_import.ImportJob(
            import_id=new_ulid(),
            workspace_id=context.workspace_id,
            team_id=team_id,
            kind=KIND,
            preset=PRESET,
            mapping={},
            github_repository_id=repository.repository_id,
            file_name=repository.full_name,
            requested_by=context.user_id,
            requester_role=context.role,
            source=context.source,
            created_at=now,
        )
    )
    if queue_url:
        issue_import.enqueue_page(job.workspace_id, job.import_id, 0)
        return job
    return issue_import.run_inline(repositories, job.workspace_id, job.import_id) or job


def github_row_id(workspace_id: str, kind: str, github_id: Any, created_at: Any) -> str:
    """The id one GitHub issue or comment always becomes in one workspace, so a re-run finds what it wrote."""
    return linear_row_id(workspace_id, f"github_{kind}", str(github_id), created_at)


def _instant(value: Any) -> Optional[datetime]:
    """A GitHub timestamp as an aware datetime, or `None`."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def read_page(token: str, repository_id: str, page: int, client: httpx.Client) -> list[Mapping[str, Any]]:
    """One page of a repository's issues and pull requests, oldest first, open and closed."""
    path = (
        f"{github_issues.repository_path(repository_id)}/issues"
        f"?state=all&sort=created&direction=asc&per_page={PAGE_SIZE}&page={page}"
    )
    body = github_issues._request("GET", path, token=token, client=client)
    if not isinstance(body, list):
        raise GitHubError("the issue list call answered no list")
    return [entry for entry in body if isinstance(entry, Mapping)]


def _github_user(value: Any) -> tuple[str, str, str]:
    """A GitHub user object's account id, login and email, each possibly empty."""
    if not isinstance(value, Mapping):
        return "", "", ""
    account = str(value.get("id") or "")
    login = str(value.get("login") or "").strip()
    email = str(value.get("email") or "").strip().lower()
    return account, login, email


def member_for(
    repositories: Any, workspace_id: str, context: TeamContext, user: Any, linked: dict[str, Optional[str]]
) -> Optional[str]:
    """The member a GitHub user is: by linked account, then email, then a display name equal to the login."""
    account, login, email = _github_user(user)
    if account:
        if account not in linked:
            link = repositories.oauth_links.get(f"github#{account}")
            member = None
            if link is not None and repositories.memberships.get(workspace_id, link.user_id):
                member = link.user_id
            linked[account] = member
        if linked[account] is not None:
            return linked[account]
    if email and email in context.lookup.by_email:
        return context.lookup.by_email[email]
    if login:
        return context.lookup.by_name.get(login.lower())
    return None


def _status(context: TeamContext, node: Mapping[str, Any]) -> Any:
    """The team status an issue lands in: the default when open, a closed category by its reason when closed."""
    lookup = context.lookup
    if str(node.get("state") or "open") != "closed":
        return lookup.default_status
    reason = str(node.get("state_reason") or "")
    for category in CLOSED_CATEGORIES.get(reason, ("completed", "cancelled")):
        if category in lookup.status_by_category:
            return lookup.status_by_category[category]
    return lookup.default_status


def _label_ids(
    repositories: Any, job: Any, context: TeamContext, node: Mapping[str, Any], result: StepResult
) -> list[str]:
    """The team labels a GitHub issue's labels map to, created where missing."""
    ids: list[str] = []
    for label in node.get("labels") or []:
        if isinstance(label, str):
            label = {"name": label}
        if not isinstance(label, Mapping):
            continue
        color = str(label.get("color") or "").strip()
        entry = {"name": label.get("name"), "color": f"#{color}" if color else None}
        label_id = _ensure_label(repositories, job.workspace_id, context, entry, result)
        if label_id is not None:
            ids.append(label_id)
    return list(dict.fromkeys(ids))


def _assignee(
    repositories: Any,
    job: Any,
    context: TeamContext,
    node: Mapping[str, Any],
    ref: str,
    linked: dict[str, Optional[str]],
    result: StepResult,
) -> Optional[str]:
    """The first GitHub assignee who is a member able to hold the issue, or `None` with a warning."""
    from app.common.issue_import import _assignable

    people = [entry for entry in node.get("assignees") or [] if isinstance(entry, Mapping)]
    if not people and isinstance(node.get("assignee"), Mapping):
        people = [node["assignee"]]
    if not people:
        return None
    for person in people:
        member = member_for(repositories, job.workspace_id, context, person, linked)
        if member is not None and _assignable(repositories, context.lookup, job.workspace_id, member):
            return member
    result.warn("assignee", f"{ref}: no assignee is a member who can see this team, left unassigned")
    return None


def _write_issue(
    repositories: Any,
    job: Any,
    repository: Any,
    context: TeamContext,
    node: Mapping[str, Any],
    linked: dict[str, Optional[str]],
    result: StepResult,
) -> Optional[str]:
    """Write or update one GitHub issue in the team, answering its id, or `None` when it was left out."""
    from app.common.db.dynamo.activity import build_activity
    from app.common.db.dynamo.issues import Issue, issue_key
    from app.common.sla import apply_sla

    number = int(node.get("number") or 0)
    ref = f"{repository.full_name}#{number}"
    title = str(node.get("title") or "").strip()[:500]
    if not number or not node.get("id") or not title:
        result.warn("title", f"{ref}: no number or title, left out")
        return None
    mirrored = repositories.github.issue_sync_for_github(job.workspace_id, repository.repository_id, number)
    if mirrored is not None and repositories.issues.get(job.workspace_id, mirrored.issue_id) is not None:
        result.add("already_synced")
        return None
    issue_id = github_row_id(job.workspace_id, "issue", node["id"], node.get("created_at"))
    body, cut = _cap(str(node.get("body") or "").strip() or None)
    if cut:
        result.warn("description", f"{ref}: the description was cut to fit")
    url = str(node.get("html_url") or "").strip()
    fields: dict[str, Any] = {
        "title": title,
        "body": body,
        "status_id": _status(context, node).status_id,
        "assignee_id": _assignee(repositories, job, context, node, ref, linked, result),
        "label_ids": _label_ids(repositories, job, context, node, result),
        "external_ref": f"{ref} {url}".strip()[:500],
        "import_batch_id": job.import_id,
    }
    now = utc_now()
    existing = repositories.issues.get(job.workspace_id, issue_id)
    if existing is not None:
        if existing.team_id != job.team_id:
            result.warn("team", f"{ref}: imported before into another team, left there")
            return issue_id
        updated = existing.model_copy(
            update={**fields, "updated_at": now, "updated_by": job.requested_by, "updated_source": job.source}
        )
        repositories.issues.replace(updated, keep_import_batch=True)
        result.add("issues_updated")
        return issue_id
    creator = member_for(repositories, job.workspace_id, context, node.get("user"), linked) or job.requested_by
    issue_number = repositories.counters.allocate_issue_number(job.workspace_id, job.team_id)
    created_at = _instant(node.get("created_at"))
    issue = Issue(
        workspace_id=job.workspace_id,
        issue_id=issue_id,
        team_id=job.team_id,
        key=issue_key(context.lookup.team.key_prefix, issue_number),
        number=issue_number,
        priority="none",
        created_by=creator,
        created_at=min(created_at, now) if created_at is not None else now,
        updated_at=now,
        updated_by=job.requested_by,
        updated_source=job.source,
        **fields,
    )
    apply_sla(repositories, None, issue)
    try:
        created = repositories.issues.create(issue)
    except ConditionFailed:
        return issue_id
    repositories.activity.record(
        build_activity(job.workspace_id, job.team_id, issue_id, creator, "created", source=job.source)
    )
    if created.assignee_id:
        repositories.subscriptions.subscribe(job.workspace_id, issue_id, job.team_id, created.assignee_id, "assignee")
    result.add("issues_created")
    return issue_id


def _write_comment(
    repositories: Any,
    job: Any,
    context: TeamContext,
    issue_id: str,
    node: Mapping[str, Any],
    linked: dict[str, Optional[str]],
    result: StepResult,
) -> None:
    """Write or update one GitHub comment with its author and time, skipping the App's own backlink."""
    from app.common.db.dynamo.comments import build_comment

    text = str(node.get("body") or "").strip()
    if not text or BACKLINK_MARKER in text or not node.get("id"):
        return
    body, _ = _cap(text)
    if not body:
        return
    _, login, _ = _github_user(node.get("user"))
    member = member_for(repositories, job.workspace_id, context, node.get("user"), linked)
    author = member or github_author(login or "ghost")
    comment_id = github_row_id(job.workspace_id, "comment", node["id"], node.get("created_at"))
    draft = build_comment(job.workspace_id, issue_id, context.team_id, author, body, source=job.source)
    comment = draft.model_copy(
        update={
            "comment_id": comment_id,
            "created_at": _instant(node.get("created_at")) or utc_now(),
            "import_batch_id": job.import_id,
        }
    )
    existing = repositories.comments.get(job.workspace_id, issue_id, comment_id)
    if existing is None:
        try:
            repositories.comments.create(comment)
        except ConditionFailed:
            return
    elif existing.body != body or existing.author_id != comment.author_id:
        repositories.comments.replace_imported(comment)
    result.add("comments")


def run_step(repositories: Any, job: Any) -> StepResult:
    """Read one page of the repository's issues with their comments and write them into the team."""
    repository = covered_repository(repositories, job.workspace_id, job.github_repository_id)
    page = int(job.after or 1)
    token = github_issues.installation_token(repository.installation_id)
    context = _team_context(repositories, job.workspace_id, job.team_id)
    linked: dict[str, Optional[str]] = {}
    result = StepResult()
    with http_factory() as client:
        entries = read_page(token, repository.repository_id, page, client)
        for node in entries:
            if node.get("pull_request") is not None:
                result.add("pull_requests_skipped")
                continue
            issue_id = _write_issue(repositories, job, repository, context, node, linked, result)
            if issue_id is None or not int(node.get("comments") or 0):
                continue
            comments = github_issues.list_comments(token, repository.repository_id, int(node["number"]), client=client)
            for comment in sorted(comments, key=lambda item: str(item.get("created_at") or "")):
                _write_comment(repositories, job, context, issue_id, comment, linked, result)
    result.next_after = str(page + 1) if len(entries) >= PAGE_SIZE else None
    return result


def run_github_page(repositories: Any, job: Any) -> Any:
    """Run the page the job is at and move it on, completing it after the last page.

    The job is read again before its progress is saved, so a cancel that landed
    while the page ran is kept. A repository the App no longer covers, or a token
    GitHub refuses, fails the job at once, since no retry can fix it.
    """
    try:
        result = run_step(repositories, job)
    except (RepositoryNotAvailable, GitHubNotConfigured, GitHubNotFound, GitHubForbidden, GitHubUnauthorized) as exc:
        _log.warning(
            "A GitHub import cannot read its repository.",
            extra={"event": "issue.import.github_refused", "import_id": job.import_id, "error": type(exc).__name__},
        )
        return issue_import.fail(repositories, job, exc)
    current = issue_import.load_job(job.workspace_id, job.import_id)
    if current is not None and current.status not in ("queued", "running"):
        return current
    counts = dict(job.counts)
    for name, amount in result.counts.items():
        counts[name] = counts.get(name, 0) + amount
    done = result.next_after is None
    problems = [*job.problems, *result.problems]
    updated = issue_import.save_job(
        job.model_copy(
            update={
                "cursor": job.cursor + 1,
                "page_attempts": 0,
                "phase_index": 1 if done else 0,
                "after": result.next_after,
                "counts": counts,
                "created_count": counts.get("issues_created", 0),
                "updated_count": counts.get("issues_updated", 0),
                "skipped_count": counts.get("already_synced", 0),
                "labels_created": counts.get("labels", 0),
                "problems": problems[: issue_import.MAX_PROBLEMS],
                "problems_truncated": job.problems_truncated or len(problems) > issue_import.MAX_PROBLEMS,
                "status": "completed" if done else "running",
                "finished_at": utc_now() if done else None,
            }
        )
    )
    if done:
        issue_import.notify(repositories, updated)
    return updated


issue_import.PAGE_RUNNERS[KIND] = run_github_page
