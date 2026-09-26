"""The `webhook-dispatch` consumer: write-back to GitHub and outbound webhooks.

Two job kinds share one queue because they share a failure mode. Both are calls to
somebody else's HTTP endpoint, both are slow, and both must not be able to fail a
transaction that has already been committed, so both are queued rather than called
from a request or from the events consumer.

Nothing here is retried in process beyond the dispatcher's own policy. A job that
fails raises, the event source mapping redelivers it, and the dead-letter queue is
what catches an endpoint that has been broken for a day.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Mapping, Sequence
from urllib.parse import quote

from fastapi import APIRouter
from webbpulse.events import register_stream_consumer
from webbpulse.events.webhooks import RetryPolicy, UrllibWebhookSender, WebhookDispatcher

from app.common.api.dependencies.repositories import Repositories, build_bundle
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import IssueLink
from app.domains.integrations import github_api
from app.domains.integrations.service import signing_key

_log = logging.getLogger(__name__)

CHECK_NAME = "Standupless"

_MARKDOWN_SPECIAL = re.compile(r"([\\`*_{}\[\]()#+\-.!|<>~@:])")
"""Characters that would let an issue title open a link, a mention or markup."""

_POLICY = RetryPolicy(attempts=1)
"""One attempt per delivery, because the queue is what retries.

Retrying in process would hold a Lambda open through somebody else's outage and
still lose the job if the function timed out; raising hands the retry to the event
source mapping, which is durable.
"""


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
    issue cannot be read still links, without a title, and a workspace that cannot
    be read leaves the keys as plain code spans rather than links to nowhere.
    """
    workspace = repositories.workspaces.get(workspace_id)
    slug = workspace.slug if workspace is not None else ""
    issue_ids = {link.issue_key: link.issue_id for link in links if link.issue_key and link.issue_id}
    try:
        issues = repositories.issues.get_many(workspace_id, list(issue_ids.values()))
    except Exception:
        _log.warning(
            "Issue titles could not be read for a write-back.",
            extra={"event": "integrations.writeback.titles_unavailable"},
        )
        issues = {}

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
    elif kind == "webhook.deliver":
        _deliver(repositories, job)


def _write_back(repositories: Repositories, job: Mapping[str, Any]) -> None:
    """Comment the linked issues on the pull request and set the check run.

    Skipped entirely when the link already carries this state, which is what keeps
    a redelivery from posting a second identical comment. The check run is set by
    `head_sha`, so GitHub itself replaces rather than duplicates it.
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

    full_name = str(job.get("repository_full_name", ""))
    pr_number = int(job.get("pr_number", 0) or 0)
    if not full_name or not pr_number:
        return

    existing = next((link for link in present if link.comment_id), None)
    token = github_api.installation_token(str(installation.installation_id))
    body = _linked_issues_body(repositories, workspace_id, keys, present)

    comment_id = existing.comment_id if existing is not None else None
    if comment_id:
        github_api.update_comment(token, full_name, comment_id, body)
    else:
        comment_id = github_api.create_comment(token, full_name, pr_number, body) or None

    check_run_id = next((link.check_run_id for link in present if link.check_run_id), None)
    head_sha = str(job.get("head_sha", ""))
    if head_sha:
        check_run_id = (
            github_api.create_check_run(
                token,
                full_name,
                head_sha,
                conclusion="success",
                title=f"{len(keys)} linked issue{'s' if len(keys) != 1 else ''}",
                summary=body,
            )
            or check_run_id
        )

    for link_id in link_ids:
        repositories.github.update_link(
            workspace_id,
            link_id,
            comment_id=comment_id,
            check_run_id=check_run_id,
        )


def _deliver(repositories: Repositories, job: Mapping[str, Any]) -> None:
    """Sign and post one product event to every endpoint subscribed to it.

    Each endpoint is signed with its own derived key, so a receiver cannot verify a
    payload that was meant for a different endpoint even inside the same workspace.
    """
    workspace_id = str(job.get("workspace_id", ""))
    event = str(job.get("event", ""))
    payload = job.get("payload")
    if not workspace_id or not event or not isinstance(payload, Mapping):
        return

    endpoints = [
        endpoint
        for endpoint in repositories.github.list_endpoints(workspace_id)
        if endpoint.active and event in endpoint.events
    ]
    if not endpoints:
        return

    dispatcher = WebhookDispatcher(UrllibWebhookSender(), secret=b"", policy=_POLICY)
    body = {"event": event, "workspace_id": workspace_id, "data": dict(payload)}

    failures = 0
    for endpoint in endpoints:
        delivery = dispatcher.send(
            endpoint.url,
            body,
            event=event,
            secret=signing_key(endpoint.webhook_id, endpoint.secret_salt),
        )
        last = delivery.last_response
        repositories.github.update_endpoint(
            workspace_id,
            endpoint.webhook_id,
            last_status=last.status_code if last is not None else 0,
            last_delivery_at=utc_now().isoformat(),
        )
        if not delivery.delivered:
            failures += 1

    if failures:
        raise RuntimeError(f"{failures} webhook endpoints did not accept the delivery.")


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
