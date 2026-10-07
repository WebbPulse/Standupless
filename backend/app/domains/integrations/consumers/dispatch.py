"""The `webhook-dispatch` consumer: write-back to GitHub, issue and label sync, and outbound webhooks.

The GitHub job kinds and the webhook kind share one queue because they share a
failure mode. Both are calls to somebody else's HTTP endpoint, both are slow, and
both must not be able to fail a transaction that has already been committed, so
both are queued rather than called from a request or from the events consumer.

A GitHub job that fails raises, the event source mapping redelivers it, and the
dead-letter queue is what catches an API that has been broken for a day. A webhook
attempt never raises for a receiver's failure: it records the attempt in the
delivery log and queues the next one itself with a backoff delay, because a
customer's broken receiver is expected rather than an incident.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Mapping, Sequence
from urllib.parse import quote

from fastapi import APIRouter
from webbpulse.events import register_stream_consumer

from app.common.api.dependencies.repositories import Repositories, build_bundle
from app.common.core.config import settings
from app.common.db.dynamo.github import IssueLink
from app.domains.integrations import github_issues
from app.domains.integrations.outbound.delivery import ATTEMPT_JOB, run_attempt

_log = logging.getLogger(__name__)

CHECK_NAME = "Standupless"

_MARKDOWN_SPECIAL = re.compile(r"([\\`*_{}\[\]()#+\-.!|<>~@:])")
"""Characters that would let an issue title open a link, a mention or markup."""

LEGACY_DELIVER_JOB = "webhook.deliver"
"""The job kind the first webhook release queued, which named an event rather than a delivery."""


def _job(record: Mapping[str, Any]) -> Mapping[str, Any]:
    """The job payload inside one SQS record."""
    raw = record.get("body")
    if not isinstance(raw, str):
        return {}
    try:
        envelope = json.loads(raw)
    except ValueError:
        _log.warning("A dispatch record would not parse.", extra={"event": "integrations.dispatch.unparseable"})
        return {}
    payload = envelope.get("payload") if isinstance(envelope, Mapping) else None
    return payload if isinstance(payload, Mapping) else {}


def _escape_markdown(text: str) -> str:
    """One title as inert Markdown on a single line.

    Line breaks fold to spaces so a title cannot end its list item, and every
    character GitHub reads as markup, a mention or a reference is backslash escaped.
    """
    return _MARKDOWN_SPECIAL.sub(r"\\\1", " ".join(text.split()))


def _issue_url(slug: str, key: str) -> str:
    """The issue page for one key, on the web app this environment serves."""
    return f"{settings.frontend_base_url}/w/{quote(slug, safe='')}/issues/{quote(key, safe='')}"


def _linked_issues_body(
    repositories: Repositories,
    workspace_id: str,
    keys: Sequence[str],
    links: Sequence[IssueLink],
) -> str:
    """The comment and check run summary: one list item per linked issue.

    Each key links to its issue page with the issue's title beside it. A key whose
    issue is gone still links, without a title, and a workspace that is gone leaves
    the keys as plain code spans rather than links to nowhere. A read that raises
    is left to raise, so the queue retries the job before anything is posted.
    """
    workspace = repositories.workspaces.get(workspace_id)
    slug = workspace.slug if workspace is not None else ""
    issue_ids = {link.issue_key: link.issue_id for link in links if link.issue_key and link.issue_id}
    issues = repositories.issues.get_many(workspace_id, list(issue_ids.values()))

    lines = ["Linked issues:", ""]
    for key in sorted(keys):
        label = f"[{key}]({_issue_url(slug, key)})" if slug else f"`{key}`"
        issue = issues.get(issue_ids.get(key, ""))
        title = _escape_markdown(issue.title) if issue is not None else ""
        lines.append(f"- {label} {title}" if title else f"- {label}")
    return "\n".join(lines)


def handle_record(repositories: Repositories, record: Mapping[str, Any]) -> None:
    """Run one dispatch job."""
    job = _job(record)
    kind = str(job.get("kind", ""))
    if kind == "github.writeback":
        _write_back(repositories, job)
    elif kind == ATTEMPT_JOB:
        run_attempt(repositories, job)
    elif kind == LEGACY_DELIVER_JOB:
        _log.info(
            "Dropped a webhook job queued in the retired shape.",
            extra={"event": "integrations.dispatch.legacy_webhook_dropped"},
        )
    elif kind == "github.pr_labels":
        from app.domains.integrations.pr_labels import push_pr_labels

        push_pr_labels(repositories, job)
    elif kind in ("github.issue_sync", "github.comment_sync", "github.issue_backlink"):
        from app.domains.integrations import issue_sync

        if kind == issue_sync.ISSUE_SYNC_JOB:
            issue_sync.push_issue(repositories, job)
        elif kind == issue_sync.BACKLINK_JOB:
            issue_sync.push_backlink(repositories, job)
        else:
            issue_sync.push_comment(repositories, job)


def _write_back(repositories: Repositories, job: Mapping[str, Any]) -> None:
    """Comment the linked issues on the pull request and set the check run.

    Skipped entirely when the link already carries this state, which is what keeps
    a redelivery from posting a second identical comment. The check run is set by
    `head_sha`, so GitHub itself replaces rather than duplicates it. The repository
    is addressed by id, so a rename between the delivery and the job changes
    nothing; a job queued before jobs carried the id is dropped, and the pull
    request's next delivery queues it again.
    """
    workspace_id = str(job.get("workspace_id", ""))
    keys = [str(key) for key in (job.get("keys") or [])]
    link_ids = [str(link_id) for link_id in (job.get("link_ids") or [])]
    if not workspace_id or not keys:
        return

    installation = repositories.github.get_installation(workspace_id)
    if installation is None:
        return

    links = [repositories.github.get_link(workspace_id, link_id) for link_id in link_ids]
    present = [link for link in links if link is not None]
    if present and len(present) == len(link_ids) and all(link.comment_id and link.check_run_id for link in present):
        _log.info(
            "Skipped a write-back that is already current.",
            extra={"event": "integrations.writeback.skipped"},
        )
        return

    repository_id = str(job.get("repository_id", ""))
    pr_number = int(job.get("pr_number", 0) or 0)
    if not repository_id or not pr_number:
        _log.info(
            "Dropped a write-back with no repository id.",
            extra={"event": "integrations.writeback.unaddressed"},
        )
        return

    existing = next((link for link in present if link.comment_id), None)
    body = _linked_issues_body(repositories, workspace_id, keys, present)
    head_sha = str(job.get("head_sha", ""))

    comment_id = existing.comment_id if existing is not None else None
    check_run_id = next((link.check_run_id for link in present if link.check_run_id), None)
    token = github_issues.installation_token(str(installation.installation_id))
    if comment_id:
        github_issues.update_comment(token, repository_id, comment_id, body)
    else:
        comment_id = str(github_issues.create_comment(token, repository_id, pr_number, body)["id"])

    if head_sha:
        check_run = github_issues.create_check_run(
            token,
            repository_id,
            name=CHECK_NAME,
            head_sha=head_sha,
            conclusion="success",
            title=f"{len(keys)} linked issue{'s' if len(keys) != 1 else ''}",
            summary=body,
        )
        check_run_id = str(check_run["id"])

    for link_id in link_ids:
        repositories.github.update_link(
            workspace_id,
            link_id,
            comment_id=comment_id,
            check_run_id=check_run_id,
        )


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """The dispatch consumer's router, mounted at the root with no API prefix."""
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

    register_stream_consumer(router, consume, log_event="integrations.dispatch.batch")
    return router
