"""The team purge chain: each domain deletes its own rows for a deleted team.

Deleting a team tombstones its row and purges what the teams domain owns in the
request. Everything else (issues, comments, cycles, views, GitHub links) belongs
to domains the teams function has no grant on, so the delete route hands the
team to a chain of queues instead, one per domain, each drained by a consumer
running with that domain's own grants.

The order is fixed. Discussion and integrations find their rows through the
team's issues, so both run before the issues stage deletes them, and the teams
stage runs last because the tombstoned row is what every other stage checks
before it deletes anything.

Each stage works inside a time budget. When rows remain it puts itself back on
its own queue with a cursor, and when it is done it hands the team to the next
stage. A stage that raises is redelivered by the event source mapping and lands
in the queue's dead-letter queue after its retries, and every step is a delete
that is a no-op the second time, so a replayed message only repeats finished
work. An empty queue URL stops the chain at that stage.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Mapping

from webbpulse.events import EventEnvelope, enqueue, register_stream_consumer

from app.common.core.config import settings

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import APIRouter, FastAPI

    from app.common.api.dependencies.repositories import Repositories
    from app.common.composition.wiring import Domain

_log = logging.getLogger(__name__)

EVENT_NAME = "team.purge"

STAGES: tuple[str, ...] = ("discussion", "integrations", "views", "planning", "issues", "teams")

BUDGET_SECONDS = 20.0
"""How long one message may work before it hands the rest to a fresh message.

Under the consumer's 29 second timeout with room for the last page and the send,
so a large team is purged across several invocations rather than timing out
part way through one and repeating it.
"""


@dataclass(frozen=True)
class PurgeJob:
    """One stage's share of one team's purge, as a queue message carries it."""

    workspace_id: str
    team_id: str
    stage: str
    cursor: int = 0


class Deadline:
    """The point after which a stage stops starting new pages."""

    def __init__(self, seconds: float) -> None:
        """Start the clock now."""
        self._ends_at = time.monotonic() + seconds

    def expired(self) -> bool:
        """Whether the budget is spent."""
        return time.monotonic() >= self._ends_at


StageStep = Callable[["Repositories", PurgeJob, Deadline], "int | None"]
"""One stage's work: `None` when the stage is finished, else the cursor to resume from."""


def queue_url(stage: str) -> str:
    """The queue one stage is drained from, or empty when it is not configured."""
    return str(getattr(settings, f"TEAM_PURGE_{stage.upper()}_QUEUE_URL", "") or "")


def _send(job: PurgeJob) -> bool:
    """Put one job on its stage's queue, reporting whether it was sent."""
    url = queue_url(job.stage)
    if not url:
        _log.info(
            "The team purge chain stops at an unconfigured stage.",
            extra={"event": "team_purge.stage_unconfigured", "stage": job.stage},
        )
        return False
    enqueue(
        url,
        EventEnvelope(
            name=EVENT_NAME,
            payload={
                "workspace_id": job.workspace_id,
                "team_id": job.team_id,
                "stage": job.stage,
                "cursor": job.cursor,
            },
            scope=job.workspace_id,
        ),
    )
    return True


def start(workspace_id: str, team_id: str) -> bool:
    """Hand a tombstoned team to the first stage, reporting whether the chain started."""
    return _send(PurgeJob(workspace_id=workspace_id, team_id=team_id, stage=STAGES[0]))


def next_stage(stage: str) -> str | None:
    """The stage after `stage`, or `None` after the last."""
    position = STAGES.index(stage)
    return STAGES[position + 1] if position + 1 < len(STAGES) else None


def parse(record: Mapping[str, Any]) -> PurgeJob | None:
    """The job inside one SQS record, or `None` when it is not a well formed purge job."""
    raw = record.get("body")
    if not isinstance(raw, str):
        return None
    try:
        envelope = json.loads(raw)
    except ValueError:
        return None
    payload = envelope.get("payload") if isinstance(envelope, Mapping) else None
    if not isinstance(payload, Mapping):
        return None
    workspace_id = str(payload.get("workspace_id") or "")
    team_id = str(payload.get("team_id") or "")
    stage = str(payload.get("stage") or "")
    try:
        cursor = int(payload.get("cursor") or 0)
    except (TypeError, ValueError):
        return None
    if not workspace_id or not team_id or stage not in STAGES:
        return None
    return PurgeJob(workspace_id=workspace_id, team_id=team_id, stage=stage, cursor=cursor)


def handle_record(repositories: "Repositories", record: Mapping[str, Any], stage: str, step: StageStep) -> None:
    """Run one stage for the team in `record`, then resume it or hand it on.

    A job for another stage, or for a team that is not tombstoned, is dropped:
    the tombstone is the only authority for deleting a team's rows, so a stray
    message can never purge a live team.
    """
    job = parse(record)
    if job is None or job.stage != stage:
        _log.warning("Dropped a malformed team purge record.", extra={"event": "team_purge.unparseable"})
        return
    if not repositories.teams.is_deleting(job.workspace_id, job.team_id):
        _log.info("Dropped a purge for a team that is not deleting.", extra={"event": "team_purge.not_deleting"})
        return

    cursor = step(repositories, job, Deadline(BUDGET_SECONDS))
    if cursor is not None:
        _send(PurgeJob(job.workspace_id, job.team_id, stage, cursor))
        return
    following = next_stage(stage)
    if following is not None:
        _send(PurgeJob(job.workspace_id, job.team_id, following))
    _log.info("A team purge stage finished.", extra={"event": "team_purge.stage_done", "stage": stage})


def build_router(
    domain_name: str, stage: str, step: StageStep, repositories: "Repositories | None" = None
) -> "APIRouter":
    """One stage's consumer router, bound to its domain's repository bundle."""
    from fastapi import APIRouter

    from app.common.api.dependencies.repositories import build_bundle
    from app.common.composition.domains import DOMAINS

    bundle = (
        repositories
        if repositories is not None
        else build_bundle(
            DOMAINS[domain_name].all_repositories,
            name=domain_name,
            read_only=DOMAINS[domain_name].read_repositories,
        )
    )
    router = APIRouter()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against this domain's bundle."""
        handle_record(bundle, record, stage, step)

    register_stream_consumer(router, consume, log_event=f"{domain_name}.purge.batch")
    return router


def consumer_domain(domain_name: str, load_router: Callable[[], "APIRouter"]) -> "Domain":
    """The descriptor a stage's function runs: its domain's bundle and one route.

    Not a registry entry, like the other consumers: it carries the same
    repositories as the domain because it runs in the same image with the same
    IAM grant, and serves nothing but its queue route and the root probes.
    """
    from app.common.composition.domains import DOMAINS
    from app.common.composition.wiring import Domain

    served = DOMAINS[domain_name]
    return Domain(
        name=f"{domain_name}-purge-consumer",
        title=f"Standupless {domain_name} purge consumer",
        load_routers=lambda: [],
        load_unprefixed_routers=lambda _settings: [load_router()],
        repositories=served.repositories,
        read_repositories=served.read_repositories,
    )


def build_app(domain: "Domain") -> "FastAPI":
    """A stage function's application: the consumer route and the root probes."""
    from app.common.composition.wiring import build_domain_app

    return build_domain_app(domain, title=domain.title)


def serve(domain: "Domain") -> None:
    """Configure logging and tracing process-wide, then serve one stage's application."""
    from webbpulse.lambda_entry import run_uvicorn

    from app.common.composition.wiring import configure_logging, configure_tracing

    configure_logging(service=domain.service_name)
    configure_tracing(domain)
    run_uvicorn(build_app(domain))
