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

The same chain purges a whole workspace and a whole account once their grace
period runs out. A workspace purge runs every team stage over each of the
workspace's teams, then a whole-workspace step per stage, and ends in the
workspaces stage, which deletes the workspace row last. An account purge runs the
views stage for the person's own views and inbox, then the workspaces stage, which
deletes the users row. An hourly schedule drops a sweep message on the workspaces
queue, and the sweep is what starts both.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, replace
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

WORKSPACE_STAGE = "workspaces"
"""The last stage of a workspace or account purge, run by the workspaces domain.

It is also where the hourly sweep lands, because the workspaces domain is the one
that can read the schedules on both the workspaces and the users table.
"""

ALL_STAGES: tuple[str, ...] = (*STAGES, WORKSPACE_STAGE)

TEAM = "team"

WORKSPACE = "workspace"

ACCOUNT = "account"

SWEEP = "sweep"

KINDS: tuple[str, ...] = (TEAM, WORKSPACE, ACCOUNT, SWEEP)

CHAINS: dict[str, tuple[str, ...]] = {
    TEAM: STAGES,
    WORKSPACE: ALL_STAGES,
    ACCOUNT: ("views", WORKSPACE_STAGE),
    SWEEP: (WORKSPACE_STAGE,),
}
"""The stages each kind of purge runs through, in order.

A whole workspace runs every team stage over each of its teams and then the
workspaces stage for what is left. An account only owns personal views, inbox rows
and its own row, so it runs the two stages that hold those.
"""

REST = "~"
"""The team cursor a workspace purge moves to once every team is done.

Sorts after every team id, so "the next team after this one" finds none and the
stage moves on to its whole-workspace step.
"""

BUDGET_SECONDS = 20.0
"""How long one message may work before it hands the rest to a fresh message.

Under the consumer's 29 second timeout with room for the last page and the send,
so a large team is purged across several invocations rather than timing out
part way through one and repeating it.
"""


@dataclass(frozen=True)
class PurgeJob:
    """One stage's share of one purge, as a queue message carries it.

    For a team purge `team_id` is the team and `cursor` resumes within it. For a
    workspace purge `team_id` is the team the stage is working through, empty
    before the first and `REST` after the last, and `cursor` resumes within that
    team or within the whole-workspace step. An account purge names `user_id`.
    """

    workspace_id: str
    team_id: str
    stage: str
    cursor: int = 0
    kind: str = TEAM
    user_id: str = ""


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

SweepStep = Callable[["Repositories", Deadline], None]
"""The hourly sweep: start the purges whose grace period has run out."""


@dataclass(frozen=True)
class StageSteps:
    """Everything one stage does, by kind of purge.

    `team` runs once per team, for a team purge and for each team of a workspace
    purge. `workspace` runs once after the teams, for what the workspace holds
    outside any team. `account` runs for an account purge. A stage that has no
    share of a kind leaves it `None` and hands the job straight on.
    """

    team: StageStep | None = None
    workspace: StageStep | None = None
    account: StageStep | None = None
    sweep: SweepStep | None = None


def queue_url(stage: str) -> str:
    """The queue one stage is drained from, or empty when it is not configured."""
    return str(getattr(settings, f"TEAM_PURGE_{stage.upper()}_QUEUE_URL", "") or "")


def _payload(job: PurgeJob) -> dict[str, Any]:
    """The message body for one job, in the team purge's original shape when it is one."""
    payload: dict[str, Any] = {
        "workspace_id": job.workspace_id,
        "team_id": job.team_id,
        "stage": job.stage,
        "cursor": job.cursor,
    }
    if job.kind != TEAM:
        payload["kind"] = job.kind
        payload["user_id"] = job.user_id
    return payload


def send(job: PurgeJob) -> bool:
    """Put one job on its stage's queue, reporting whether it was sent."""
    url = queue_url(job.stage)
    if not url:
        _log.info(
            "The purge chain stops at an unconfigured stage.",
            extra={"event": "team_purge.stage_unconfigured", "stage": job.stage, "kind": job.kind},
        )
        return False
    enqueue(
        url,
        EventEnvelope(
            name=EVENT_NAME,
            payload=_payload(job),
            scope=job.workspace_id or job.user_id or job.kind,
        ),
    )
    return True


_send = send


def start(workspace_id: str, team_id: str) -> bool:
    """Hand a tombstoned team to the first stage, reporting whether the chain started."""
    return send(PurgeJob(workspace_id=workspace_id, team_id=team_id, stage=STAGES[0]))


def start_workspace(workspace_id: str) -> bool:
    """Hand a purging workspace to the first stage, reporting whether the chain started."""
    return send(PurgeJob(workspace_id=workspace_id, team_id="", stage=CHAINS[WORKSPACE][0], kind=WORKSPACE))


def start_account(user_id: str) -> bool:
    """Hand a purging account to the first stage, reporting whether the chain started."""
    return send(PurgeJob(workspace_id="", team_id="", stage=CHAINS[ACCOUNT][0], kind=ACCOUNT, user_id=user_id))


def next_stage(stage: str, kind: str = TEAM) -> str | None:
    """The stage after `stage` in this kind's chain, or `None` after the last."""
    chain = CHAINS[kind]
    position = chain.index(stage)
    return chain[position + 1] if position + 1 < len(chain) else None


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
    kind = str(payload.get("kind") or TEAM)
    workspace_id = str(payload.get("workspace_id") or "")
    team_id = str(payload.get("team_id") or "")
    user_id = str(payload.get("user_id") or "")
    stage = str(payload.get("stage") or "")
    try:
        cursor = int(payload.get("cursor") or 0)
    except (TypeError, ValueError):
        return None
    if kind not in KINDS or stage not in CHAINS[kind]:
        return None
    if kind == TEAM and (not workspace_id or not team_id):
        return None
    if kind == WORKSPACE and not workspace_id:
        return None
    if kind == ACCOUNT and not user_id:
        return None
    return PurgeJob(workspace_id=workspace_id, team_id=team_id, stage=stage, cursor=cursor, kind=kind, user_id=user_id)


def _authorised(repositories: "Repositories", job: PurgeJob) -> bool:
    """Whether the mark this kind of purge answers to is on its row.

    A team purge answers to the team's tombstone, a workspace purge to the
    workspace's `purging_at`, and an account purge to the user's. The mark is the
    only authority for deleting anything, so a stray message never purges live data.
    """
    if job.kind == TEAM:
        return repositories.teams.is_deleting(job.workspace_id, job.team_id)
    if job.kind == WORKSPACE:
        workspace = repositories.workspaces.get(job.workspace_id)
        return workspace is not None and workspace.is_purging
    if job.kind == ACCOUNT:
        user = repositories.users.get(job.user_id)
        return user is not None and user.is_purging
    return True


def _hand_on(job: PurgeJob) -> None:
    """Send the job to the next stage of its chain, or log the chain's end."""
    following = next_stage(job.stage, job.kind)
    if following is not None:
        team_id = job.team_id if job.kind == TEAM else ""
        send(PurgeJob(job.workspace_id, team_id, following, 0, job.kind, job.user_id))
    _log.info(
        "A purge stage finished.",
        extra={"event": "team_purge.stage_done", "stage": job.stage, "kind": job.kind},
    )


def _run_workspace(repositories: "Repositories", job: PurgeJob, steps: StageSteps, deadline: Deadline) -> None:
    """Run one stage over every team of a workspace, then its whole-workspace step.

    Resumes from the team the job names, and within it from the cursor, so a
    workspace with many teams is worked through across as many messages as it takes.
    """
    team_id, cursor = job.team_id, job.cursor
    if team_id != REST and steps.team is not None:
        pending = [
            candidate for candidate in repositories.teams.list_team_ids(job.workspace_id) if candidate >= team_id
        ]
        for current in pending:
            resume = steps.team(repositories, replace(job, team_id=current, cursor=cursor), deadline)
            if resume is not None:
                send(replace(job, team_id=current, cursor=resume))
                return
            cursor = 0
            if deadline.expired():
                later = [candidate for candidate in pending if candidate > current]
                send(replace(job, team_id=later[0] if later else REST, cursor=0))
                return
        team_id, cursor = REST, 0
    if steps.workspace is not None:
        resume = steps.workspace(repositories, replace(job, team_id=REST, cursor=cursor), deadline)
        if resume is not None:
            send(replace(job, team_id=REST, cursor=resume))
            return
    _hand_on(job)


def handle_record(
    repositories: "Repositories",
    record: Mapping[str, Any],
    stage: str,
    step: StageStep | None = None,
    *,
    steps: StageSteps | None = None,
) -> None:
    """Run one stage for the purge in `record`, then resume it or hand it on.

    A job for another stage, or one whose purge mark is not on its row, is dropped:
    the mark is the only authority for deleting anything, so a stray message can
    never purge live data.
    """
    bound = steps if steps is not None else StageSteps(team=step)
    job = parse(record)
    if job is None or job.stage != stage:
        _log.warning("Dropped a malformed purge record.", extra={"event": "team_purge.unparseable"})
        return
    deadline = Deadline(BUDGET_SECONDS)
    if job.kind == SWEEP:
        if bound.sweep is not None:
            bound.sweep(repositories, deadline)
        return
    if not _authorised(repositories, job):
        _log.info(
            "Dropped a purge whose mark is not on its row.",
            extra={"event": "team_purge.not_deleting", "kind": job.kind},
        )
        return

    if job.kind == WORKSPACE:
        _run_workspace(repositories, job, bound, deadline)
        return

    work = bound.team if job.kind == TEAM else bound.account
    cursor = work(repositories, job, deadline) if work is not None else None
    if cursor is not None:
        send(replace(job, cursor=cursor))
        return
    _hand_on(job)


def build_router(
    domain_name: str,
    stage: str,
    step: StageStep | None,
    repositories: "Repositories | None" = None,
    *,
    workspace_step: StageStep | None = None,
    account_step: StageStep | None = None,
    sweep: SweepStep | None = None,
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
    steps = StageSteps(team=step, workspace=workspace_step, account=account_step, sweep=sweep)

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against this domain's bundle."""
        handle_record(bundle, record, stage, steps=steps)

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
