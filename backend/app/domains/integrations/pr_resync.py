"""Reading linked pull requests back from GitHub when their merge or close never arrived.

The receiver answers GitHub 202 before a delivery is handled, so a queued record
that is lost, as the rate limited batches before STUP-327 were, is never sent
again, and its links read open long after the pull request merged. This heals
them. A sweep lists a workspace's open links that have sat idle for a while and
queues one read back per pull request on the events queue. The read asks GitHub
for the pull request and, once it has merged or closed, folds it exactly as its
`closed` delivery would have been folded, so the stale row guard and the guard on
a person's later change both still hold.

The sweep runs off any later delivery for the same workspace, at most once per
`SWEEP_INTERVAL`, and `scripts/resync_open_pull_requests.py` runs it once over
every workspace. A pull request is read at most once per `RECHECK_INTERVAL`, a
sweep queues at most `SWEEP_LIMIT`, and an installation GitHub reported below the
share of its hour kept for live sync is not read again until its reset.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Iterable, Mapping

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import IssueLink
from app.domains.integrations import github_budget

_log = logging.getLogger(__name__)

RESYNC_EVENT = "standupless.resync_pull_request"
"""The events queue kind that reads one linked pull request back from GitHub.

GitHub never sends an event of this name, and the receiver queues only the events
it knows, so only this product's own sweep queues one."""

OPEN_STATES = frozenset({"open", "draft"})
"""Link states a missed merge or close leaves behind."""

SWEEP_INTERVAL = timedelta(minutes=15)
"""How often one workspace's open links are swept, at most."""

IDLE_AFTER = timedelta(minutes=10)
"""How long a link must sit unchanged before a sweep asks GitHub about it."""

MAX_IDLE = timedelta(days=30)
"""How long a link may sit unchanged and still be swept; older open pull requests are left alone."""

RECHECK_INTERVAL = timedelta(hours=1)
"""How often one pull request is read back, at most."""

SWEEP_LIMIT = 50
"""The most pull requests one sweep queues."""

READ_SECONDS = 10.0
"""The deadline of one read back."""

SWEEP_SCOPE = "github.pr-resync-sweep"

RECHECK_SCOPE = "github.pr-resync"

_swept: dict[str, int] = {}
"""The sweep window each workspace was last swept in by this process, to skip the claim."""

_low_until: dict[str, float] = {}
"""When each installation GitHub reported low on budget resets, in epoch seconds."""


@dataclass(frozen=True)
class Target:
    """One pull request to read back."""

    repository_id: str
    number: int
    node_id: str


def node_id_of(link: IssueLink) -> str:
    """The pull request node id a link row is keyed under."""
    return link.link_id.rsplit("#", 1)[0] if "#" in link.link_id else link.link_id


def plan(
    links: Iterable[IssueLink],
    now: datetime,
    *,
    idle_after: timedelta = IDLE_AFTER,
    max_idle: timedelta | None = MAX_IDLE,
) -> list[Target]:
    """The open pull requests among `links` idle long enough to read back, most recently active first."""
    latest: dict[tuple[str, int], tuple[datetime, str]] = {}
    for link in links:
        if link.detached or link.pr_state not in OPEN_STATES or not link.repository_id or link.pr_number <= 0:
            continue
        idle = now - link.updated_at
        if idle < idle_after or (max_idle is not None and idle > max_idle):
            continue
        key = (link.repository_id, link.pr_number)
        seen = latest.get(key)
        if seen is None or link.updated_at > seen[0]:
            latest[key] = (link.updated_at, node_id_of(link))
    ordered = sorted(latest.items(), key=lambda item: item[1][0], reverse=True)
    return [Target(repository_id=key[0], number=key[1], node_id=value[1]) for key, value in ordered]


def _window(now: datetime) -> int:
    """The sweep window `now` falls in."""
    return int(now.timestamp() // SWEEP_INTERVAL.total_seconds())


def maybe_sweep(repositories: Repositories, workspace_id: str, *, now: datetime | None = None) -> int:
    """Sweep the workspace's open links if nobody has in this window, answering how many were queued.

    Never raises: it runs alongside a delivery that must still apply.
    """
    if not workspace_id or not settings.GITHUB_EVENTS_QUEUE_URL:
        return 0
    moment = now or utc_now()
    window = _window(moment)
    if _swept.get(workspace_id) == window:
        return 0
    _swept[workspace_id] = window
    try:
        ttl = SWEEP_INTERVAL.total_seconds() * 2
        if not repositories.idempotency.claim(workspace_id, SWEEP_SCOPE, str(window), ttl_seconds=ttl):
            return 0
        return sweep(repositories, workspace_id, now=moment)
    except Exception:
        _log.warning(
            "Could not sweep a workspace's open pull request links.",
            extra={"event": "integrations.pr_resync.sweep_failed"},
        )
        return 0


def sweep(
    repositories: Repositories,
    workspace_id: str,
    *,
    now: datetime | None = None,
    idle_after: timedelta = IDLE_AFTER,
    max_idle: timedelta | None = MAX_IDLE,
    limit: int = SWEEP_LIMIT,
    queue_url: str | None = None,
    recheck: bool = True,
    dry_run: bool = False,
) -> int:
    """Queue a read back for each of the workspace's idle open pull requests, answering how many.

    With `recheck`, a pull request read back within `RECHECK_INTERVAL` is skipped.
    A dry run counts what would be queued and writes nothing.
    """
    installation = repositories.github.get_installation(workspace_id)
    if installation is None or installation.suspended_at is not None:
        return 0
    url = queue_url if queue_url is not None else settings.GITHUB_EVENTS_QUEUE_URL
    if not url and not dry_run:
        return 0
    moment = now or utc_now()
    targets = plan(repositories.github.iter_links(workspace_id), moment, idle_after=idle_after, max_idle=max_idle)
    queued = 0
    for target in targets:
        if queued >= limit:
            break
        if dry_run:
            queued += 1
            continue
        key = f"{target.repository_id}#{target.number}"
        if recheck and not repositories.idempotency.claim(
            workspace_id, RECHECK_SCOPE, key, ttl_seconds=RECHECK_INTERVAL.total_seconds()
        ):
            continue
        try:
            enqueue_resync(url, str(installation.installation_id), target)
        except Exception:
            _log.warning(
                "Could not queue a pull request read back.",
                extra={"event": "integrations.pr_resync.enqueue_failed"},
            )
            if recheck:
                repositories.idempotency.release(workspace_id, RECHECK_SCOPE, key)
            continue
        queued += 1
    if queued:
        _log.info(
            "Queued read backs of idle open pull requests.",
            extra={"event": "integrations.pr_resync.swept", "queued": queued, "dry_run": dry_run},
        )
    return queued


def enqueue_resync(queue_url: str, installation_id: str, target: Target) -> None:
    """Queue one pull request's read back on the events queue."""
    from webbpulse.events import EventEnvelope, enqueue

    enqueue(
        queue_url,
        EventEnvelope(
            name=RESYNC_EVENT,
            payload={
                "event": RESYNC_EVENT,
                "body": {
                    "installation": {"id": installation_id},
                    "repository": {"id": target.repository_id},
                    "number": target.number,
                    "node_id": target.node_id,
                },
            },
            scope=installation_id,
        ),
    )


def fetch_pull_request(installation_id: str, repository_id: str, number: int) -> Mapping[str, Any]:
    """One pull request as GitHub answers it now, read with a fresh installation token."""
    from app.domains.integrations import github_issues

    token = github_issues.installation_token(installation_id)
    return github_issues.get_pull_request(token, repository_id, number)


def _read(installation_id: str, repository_id: str, number: int) -> Mapping[str, Any] | None:
    """The pull request from GitHub, or `None` when it cannot be read now.

    Every failure, a rate limit included, is logged and answered `None` rather than
    raised: the next sweep asks again, which is the back off.
    """
    from webbpulse.integrations.github import GitHubError

    if time.time() < _low_until.get(installation_id, 0.0):
        return None
    try:
        with github_budget.capped(READ_SECONDS) as budget:
            pull_request = fetch_pull_request(installation_id, repository_id, number)
    except (github_budget.BudgetSpent, GitHubError, ValueError):
        _log.warning(
            "Could not read a pull request back from GitHub.",
            extra={"event": "integrations.pr_resync.unavailable"},
        )
        return None
    if budget.low() and budget.reset_at is not None:
        _low_until[installation_id] = budget.reset_at.timestamp()
    return pull_request


def _moment(pull_request: Mapping[str, Any]) -> datetime:
    """When the pull request merged or closed, for the guard on a person's later change."""
    for field in ("merged_at", "closed_at", "updated_at"):
        raw = pull_request.get(field)
        if isinstance(raw, str) and raw:
            try:
                return datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                continue
    return utc_now()


def handle_resync(repositories: Repositories, workspace_id: str, body: Mapping[str, Any]) -> bool:
    """Run one queued `RESYNC_EVENT`, answering whether it folded a missed merge or close.

    A pull request whose links no longer read open was healed by a delivery since
    the sweep and is not read. One GitHub still shows open is left as it is.
    """
    installation = body.get("installation")
    repository = body.get("repository")
    installation_id = str(installation.get("id", "") or "") if isinstance(installation, Mapping) else ""
    repository_id = str(repository.get("id", "") or "") if isinstance(repository, Mapping) else ""
    number = body.get("number")
    node_id = str(body.get("node_id", "") or "")
    if not installation_id or not repository_id or not node_id:
        return False
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        return False
    links = repositories.github.list_links_for_pr(workspace_id, node_id)
    stale = [link for link in links if not link.detached and link.pr_state in OPEN_STATES]
    if not stale:
        return False
    pull_request = _read(installation_id, repository_id, number)
    if pull_request is None or str(pull_request.get("state", "")) != "closed":
        return False
    if str(pull_request.get("node_id", "") or node_id) != node_id:
        return False

    base = pull_request.get("base")
    base_repository = base.get("repo") if isinstance(base, Mapping) else None
    named: dict[str, Any] = dict(base_repository) if isinstance(base_repository, Mapping) else {}
    named["id"] = int(repository_id) if repository_id.isdigit() else repository_id
    named.setdefault("full_name", stale[0].repository_full_name)
    delivery = {
        "action": "closed",
        "installation": {"id": int(installation_id) if installation_id.isdigit() else installation_id},
        "repository": named,
        "pull_request": dict(pull_request),
    }
    from app.domains.integrations.consumers.events import fold_pull_request

    fold_pull_request(repositories, workspace_id, delivery, _moment(pull_request))
    _log.info(
        "Folded a pull request merge or close its delivery never brought.",
        extra={"event": "integrations.pr_resync.healed", "merged": bool(pull_request.get("merged"))},
    )
    return True
