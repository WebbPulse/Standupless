"""The planning rollup consumer: keeps each cycle's, project's and milestone's counts current.

The `issues` table streams `NEW_AND_OLD_IMAGES` into this route. A record matters
only when it moved an issue between cycles or projects, or moved it between
status categories while attached to one, so most records are read and dropped.

A cycle's counts move through an atomic `ADD` rather than a recount, because there
is no index from a cycle back to every team's issues and its history snapshots
read the move itself. `ADD` is not idempotent, so each such record claims its own
`eventID` in the `idempotency` table first: a record redelivered after a partial
batch failure finds its claim taken and does nothing, which is what keeps a retry
from double counting.

A project's counts, and its milestones', are recounted instead. A project spans
teams and an issue can change team, status, project, milestone or archived state
from any writer, so an incremental count drifts the first time one move is missed.
The recount reads each team's slice of the sparse project index and overlays the
record's own new image, because the index is eventually consistent and may not
yet show the change that triggered it. Every non-archived issue whose `project_id`
is the project counts, whatever team holds it. Writing the same numbers twice is
harmless, so this path needs no claim, and any drift heals on the next record.

A cycle's counters also carry estimate points and unestimated issue counts beside
the issue counts, and the carry-over a cycle close recorded. After every move of a cycle's counters the
consumer writes the day's snapshot of them, which is the cycle's scope history:
the burn-up chart reads the last snapshot of each day rather than a scheduled job
sampling every cycle at midnight.

Nothing here writes to the `issues` table. The counters live on the planning row
and the issue's own attributes are the consumer's input, never its output, which is
what keeps this off the second write path the design forbids.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Mapping

from fastapi import APIRouter
from webbpulse.events import deserialize_image, record_id, register_stream_consumer

from app.common.api.dependencies.repositories import Repositories
from app.common.composition.consumers import CONSUMERS
from app.common.db.dynamo.planning import (
    CATEGORY_BUCKETS,
    COUNT_BUCKETS,
    POINT_PREFIX,
    UNESTIMATED_PREFIX,
    cycle_key,
    milestone_key,
    parse_cycle_key,
    project_key,
)
from app.common.estimates import estimate_points, is_unestimated
from app.domains.planning.cycle_schedule import is_cycle_schedule, sweep

_log = logging.getLogger(__name__)

_GRANT = CONSUMERS["planning-rollup-consumer"]
"""The tables this consumer's function is granted, which every record is handled within."""

IDEMPOTENCY_SCOPE = "planning-rollup"
"""What a claim in the shared `idempotency` table is namespaced under."""

CLAIM_TTL_SECONDS = 24 * 60 * 60
"""How long a consumed record's claim is remembered.

Comfortably longer than a stream's own 24 hour retention would let a record be
redelivered for, so a claim never expires while the record it guards can still
arrive again.
"""


CARRY_MARKER = "cycle_carried_from"
"""The issue attribute a cycle close stamps with the cycle it carried the issue out of."""


def _text(image: Mapping[str, Any], name: str) -> str:
    """One attribute of a stream image as a string, empty when it is absent or null."""
    value = image.get(name)
    return str(value).strip() if value is not None else ""


def _bucket(repositories: Repositories, workspace_id: str, team_id: str, status_id: str) -> str | None:
    """Which count bucket one status of one team folds into, or `None`.

    Read through the team's own statuses because a category is a team setting
    rather than something the issue row carries, and an unknown status counts into
    nothing rather than into a default bucket that would then be wrong.
    """
    if not status_id:
        return None
    row = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if row is None:
        return None
    return CATEGORY_BUCKETS.get(row.category)


PROJECT_FIELDS: tuple[str, ...] = (
    "team_id",
    "status_id",
    "project_id",
    "project_milestone_id",
    "archived_at",
    "estimate",
)
"""The issue attributes a project's or milestone's counts depend on."""


def _removed(record: Mapping[str, Any]) -> bool:
    """Whether one stream record deleted its issue."""
    return str(record.get("eventName", "")).upper() == "REMOVE"


def projects_to_recount(record: Mapping[str, Any]) -> set[str]:
    """Which projects one record made stale, empty when it changed nothing they count.

    A create or delete touches the project its issue sits in. A modify touches the
    project on either side when any attribute the counts read moved, so a move
    between projects recounts both and a team move that kept the project recounts it.
    """
    new_image = {} if _removed(record) else deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    projects = {_text(image, "project_id") for image in (new_image, old_image)} - {""}
    if not projects:
        return set()
    if new_image and old_image and all(_text(new_image, name) == _text(old_image, name) for name in PROJECT_FIELDS):
        return set()
    return projects


def _counted_issue(image: Mapping[str, Any]) -> dict[str, str]:
    """The attributes a project recount reads off one issue, as strings."""
    return {name: _text(image, name) for name in PROJECT_FIELDS}


def project_issues(
    repositories: Repositories,
    workspace_id: str,
    project_id: str,
    record: Mapping[str, Any],
) -> dict[str, dict[str, str]]:
    """Every non-archived issue of one project across the workspace's teams, by issue id.

    Every live team is read rather than only the project's own, because an issue
    keeps its project when its team leaves the project and still counts there.
    The record's own issue is taken from its new image rather than from the index,
    which may still hold the row from before this change.
    """
    found: dict[str, dict[str, str]] = {}
    for team in repositories.teams.list_for_workspace(workspace_id):
        for issue in repositories.issues.iter_for_project(workspace_id, team.team_id, project_id):
            found[issue.issue_id] = {
                "team_id": issue.team_id,
                "status_id": issue.status_id,
                "project_id": issue.project_id or "",
                "project_milestone_id": issue.project_milestone_id or "",
                "archived_at": issue.archived_at.isoformat() if issue.archived_at is not None else "",
                "estimate": (issue.estimate or "").strip(),
            }

    new_image = {} if _removed(record) else deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    issue_id = _text(new_image, "issue_id") or _text(old_image, "issue_id")
    if issue_id:
        found.pop(issue_id, None)
        if new_image and _text(new_image, "project_id") == project_id:
            found[issue_id] = _counted_issue(new_image)

    return {key: issue for key, issue in found.items() if not issue["archived_at"]}


def recount_project(
    repositories: Repositories,
    workspace_id: str,
    project_id: str,
    record: Mapping[str, Any],
) -> int:
    """Write one project's and each of its milestones' counts from its issues, returning rows written.

    Nothing is written when the project is gone, and a row whose stored counts
    already match is left alone. A milestone that no issue names any more is
    written back to zero, so a move out of its last issue leaves it right. Beside
    the category buckets each row keeps a count per status id, so a progress bar
    can split In Review from In Progress. Points
    sum each issue's estimate, and an unestimated issue adds one point when its
    team counts unestimated issues.
    """
    project = repositories.planning.get_project(workspace_id, project_id)
    if project is None:
        return 0
    issues = project_issues(repositories, workspace_id, project_id, record)

    milestones = repositories.planning.list_milestones(workspace_id, project_id)
    stored: dict[str, dict[str, int]] = {
        project_key(project_id): {**project.counts.as_map(), **project.points.as_map(POINT_PREFIX)}
    }
    stored_statuses: dict[str, dict[str, int]] = {project_key(project_id): dict(project.status_counts)}
    categories: dict[str, dict[str, str]] = {}
    counting: dict[str, bool] = {}
    project_counts = _zeroed_counts()
    project_statuses: dict[str, int] = {}
    milestone_counts: dict[str, dict[str, int]] = {}
    milestone_statuses: dict[str, dict[str, int]] = {}
    for milestone in milestones:
        milestone_counts[milestone.milestone_id] = _zeroed_counts()
        milestone_statuses[milestone.milestone_id] = {}
        stored[milestone_key(project_id, milestone.milestone_id)] = {
            **milestone.counts.as_map(),
            **milestone.points.as_map(POINT_PREFIX),
        }
        stored_statuses[milestone_key(project_id, milestone.milestone_id)] = dict(milestone.status_counts)
    for issue in issues.values():
        team_id = issue["team_id"]
        if team_id not in categories:
            categories[team_id] = {
                row.status_id: row.category for row in repositories.team_config.list_statuses(workspace_id, team_id)
            }
            team = repositories.teams.get(workspace_id, team_id)
            counting[team_id] = bool(
                team is not None and team.estimate_count_unestimated and team.estimate_scale != "off"
            )
        bucket = CATEGORY_BUCKETS.get(categories[team_id].get(issue["status_id"], ""))
        if bucket is None:
            continue
        estimate = issue.get("estimate", "")
        points = 1 if is_unestimated(estimate) and counting[team_id] else estimate_points(estimate)
        point_bucket = f"{POINT_PREFIX}{bucket}"
        targets = [(project_counts, project_statuses)]
        milestone = milestone_counts.get(issue["project_milestone_id"])
        if milestone is not None:
            targets.append((milestone, milestone_statuses[issue["project_milestone_id"]]))
        for counts, statuses in targets:
            counts[bucket] += 1
            counts[point_bucket] += points
            statuses[issue["status_id"]] = statuses.get(issue["status_id"], 0) + 1

    wanted = {project_key(project_id): (project_counts, project_statuses)}
    for milestone_id, counts in milestone_counts.items():
        wanted[milestone_key(project_id, milestone_id)] = (counts, milestone_statuses[milestone_id])
    written = 0
    for planning_key, (counts, statuses) in wanted.items():
        if stored.get(planning_key) == counts and stored_statuses.get(planning_key) == statuses:
            continue
        if repositories.planning.set_counts(workspace_id, planning_key, counts, statuses):
            written += 1
    return written


def _zeroed_counts() -> dict[str, int]:
    """Every issue and point bucket of a project or milestone, each at zero."""
    return {name: 0 for bucket in COUNT_BUCKETS for name in (bucket, f"{POINT_PREFIX}{bucket}")}


def deltas_for(
    repositories: Repositories,
    workspace_id: str,
    record: Mapping[str, Any],
) -> dict[str, dict[str, int]]:
    """Every cycle counter move one record implies, keyed by planning sort key.

    Projects and milestones are recounted by `recount_project` instead. Built by
    subtracting the old image's contribution from the new one's, so an issue that
    changed neither attachment nor category produces an empty result and one that
    moved between cycles decrements the cycle it left in the same pass that
    increments the one it joined.
    """
    new_image = {} if _removed(record) else deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")

    moves: dict[str, dict[str, int]] = {}

    for image, sign in ((old_image, -1), (new_image, 1)):
        team_id = _text(image, "team_id")
        if not team_id:
            continue
        bucket = _bucket(repositories, workspace_id, team_id, _text(image, "status_id"))
        if bucket is None:
            continue
        cycle_id = _text(image, "cycle_id")
        if not cycle_id:
            continue
        points = estimate_points(image.get("estimate"))
        counts = moves.setdefault(cycle_key(team_id, cycle_id), {})
        counts[bucket] = counts.get(bucket, 0) + sign
        if points:
            point_bucket = f"{POINT_PREFIX}{bucket}"
            counts[point_bucket] = counts.get(point_bucket, 0) + sign * points
        if is_unestimated(image.get("estimate")):
            unestimated_bucket = f"{UNESTIMATED_PREFIX}{bucket}"
            counts[unestimated_bucket] = counts.get(unestimated_bucket, 0) + sign

    for key, delta in carry_deltas(old_image, new_image).items():
        counts = moves.setdefault(key, {})
        for name, value in delta.items():
            counts[name] = counts.get(name, 0) + value

    return {key: {bucket: delta for bucket, delta in counts.items() if delta} for key, counts in moves.items()}


def carry_deltas(old_image: Mapping[str, Any], new_image: Mapping[str, Any]) -> dict[str, dict[str, int]]:
    """The carry-over counters one move implies, empty unless a cycle close made it.

    A close moves an issue from the cycle that ended into the next one and stamps
    the issue with the cycle it left, so a move whose marker names the cycle in the
    old image is a carry-over and any other move is a planner's own.
    """
    old_cycle = _text(old_image, "cycle_id")
    new_cycle = _text(new_image, "cycle_id")
    team_id = _text(new_image, "team_id")
    if not old_cycle or not new_cycle or old_cycle == new_cycle or not team_id:
        return {}
    if _text(old_image, "team_id") != team_id or _text(new_image, CARRY_MARKER) != old_cycle:
        return {}
    points = estimate_points(new_image.get("estimate"))
    left: dict[str, int] = {"carried_out": 1, "carried_out_points": points}
    joined: dict[str, int] = {"carried_in": 1, "carried_in_points": points}
    if is_unestimated(new_image.get("estimate")):
        left["carried_out_unestimated"] = 1
        joined["carried_in_unestimated"] = 1
    return {cycle_key(team_id, old_cycle): left, cycle_key(team_id, new_cycle): joined}


def carried_issue_ids(old_image: Mapping[str, Any], new_image: Mapping[str, Any]) -> list[tuple[str, str, str]]:
    """The cycle id sets one carry-over adds the issue to, as `(planning_key, attribute, issue_id)`.

    Empty unless the move is a carry-over by the same rule `carry_deltas` applies,
    so the stored ids and the counters always describe the same moves.
    """
    issue_id = _text(new_image, "issue_id")
    if not issue_id:
        return []
    moved = carry_deltas(old_image, new_image)
    if not moved:
        return []
    team_id = _text(new_image, "team_id")
    return [
        (cycle_key(team_id, _text(old_image, "cycle_id")), "carried_out_issue_ids", issue_id),
        (cycle_key(team_id, _text(new_image, "cycle_id")), "carried_in_issue_ids", issue_id),
    ]


def record_day(record: Mapping[str, Any]) -> str:
    """The UTC day one stream record's change happened on, today when it carries none."""
    section = record.get("dynamodb")
    raw = section.get("ApproximateCreationDateTime") if isinstance(section, Mapping) else None
    try:
        moment = float(raw) if raw is not None else None
    except (TypeError, ValueError):
        moment = None
    if moment is None or moment <= 0:
        return datetime.now(timezone.utc).date().isoformat()
    return datetime.fromtimestamp(moment, tz=timezone.utc).date().isoformat()


def opening_counts(after: Mapping[str, Any], deltas: Mapping[str, int]) -> dict[str, int]:
    """The count, point and unestimated buckets a cycle held before one move, from the row after it."""
    prefixes = ("", POINT_PREFIX, UNESTIMATED_PREFIX)
    keys = [f"{prefix}{bucket}" for prefix in prefixes for bucket in COUNT_BUCKETS]
    return {key: int(after.get(key, 0) or 0) - int(deltas.get(key, 0)) for key in keys}


def snapshot_cycle(
    repositories: Repositories,
    workspace_id: str,
    planning_key: str,
    deltas: Mapping[str, int],
    after: Mapping[str, Any],
    day: str,
) -> bool:
    """Record one cycle's counters after a move as its snapshot for the day.

    Never raises: the counters have already moved, so a failed snapshot is logged
    and dropped rather than retried, since a retry would find the claim released
    and move the counters a second time.
    """
    parsed = parse_cycle_key(planning_key)
    if parsed is None:
        return False
    team_id, cycle_id = parsed
    counters = after.get("counts")
    if not isinstance(counters, Mapping):
        return False
    try:
        return repositories.planning.write_cycle_snapshot(
            workspace_id,
            team_id,
            cycle_id,
            day,
            rev=int(after.get("rollup_rev", 0) or 0),
            counts={key: int(value or 0) for key, value in counters.items()},
            opening=opening_counts(counters, deltas),
        )
    except Exception:
        _log.exception(
            "Writing a cycle snapshot failed; the day keeps its earlier value.",
            extra={"event": "planning.rollup.snapshot_failed", "workspace_id": workspace_id},
        )
        return False


def workspace_of(record: Mapping[str, Any]) -> str:
    """The workspace a record belongs to, from whichever image carries it.

    A REMOVE record has no `NewImage`, so the old one is read as the fallback rather
    than the record being skipped: a deleted issue still has to leave its cycle's
    counts.
    """
    for image in ("NewImage", "OldImage"):
        workspace_id = _text(deserialize_image(record, image), "workspace_id")
        if workspace_id:
            return workspace_id
    return ""


def handle_record(repositories: Repositories, record: Mapping[str, Any]) -> None:
    """Move every counter one stream record made stale, once.

    Raising puts this record alone into `batchItemFailures`, so a transient failure
    retries the record rather than the whole batch. The claim is released when no
    counter moved, so a record whose work was skipped does not hold a key that a
    genuine redelivery would then find taken. The issue ids of a carry-over are
    added before the claim, since a string set `ADD` is safe to repeat. The
    automatic cycles trigger runs the sweep and nothing else. Projects are
    recounted before the cycle moves, and need no claim because a recount is
    idempotent.
    """
    repositories = _GRANT.narrow(repositories)
    if is_cycle_schedule(record):
        sweep(repositories)
        return

    workspace_id = workspace_of(record)
    if not workspace_id:
        return

    recounted = 0
    for project_id in sorted(projects_to_recount(record)):
        recounted += recount_project(repositories, workspace_id, project_id, record)
    if recounted:
        _log.info(
            "Recounted project counts.",
            extra={"event": "planning.rollup.projects", "workspace_id": workspace_id, "rows": recounted},
        )

    moves = deltas_for(repositories, workspace_id, record)
    if not moves:
        return

    removed = str(record.get("eventName", "")).upper() == "REMOVE"
    if not removed:
        for planning_key, attribute, issue_id in carried_issue_ids(
            deserialize_image(record, "OldImage"), deserialize_image(record, "NewImage")
        ):
            repositories.planning.record_carried_issue(workspace_id, planning_key, attribute, issue_id)

    event_id = record_id(record)
    if not event_id:
        return
    if not repositories.idempotency.claim(
        workspace_id,
        IDEMPOTENCY_SCOPE,
        event_id,
        ttl_seconds=CLAIM_TTL_SECONDS,
    ):
        return

    moved_cycles: list[tuple[str, Mapping[str, Any]]] = []
    try:
        moved = 0
        for planning_key in sorted(moves):
            if parse_cycle_key(planning_key) is not None:
                after = repositories.planning.move_cycle_counts(workspace_id, planning_key, moves[planning_key])
                if after is not None:
                    moved += 1
                    moved_cycles.append((planning_key, after))
            elif repositories.planning.move_counts(workspace_id, planning_key, moves[planning_key]):
                moved += 1
    except Exception:
        repositories.idempotency.release(workspace_id, IDEMPOTENCY_SCOPE, event_id)
        raise

    day = record_day(record)
    for planning_key, after in moved_cycles:
        snapshot_cycle(repositories, workspace_id, planning_key, moves[planning_key], after, day)

    _log.info(
        "Moved planning rollup counts.",
        extra={"event": "planning.rollup", "workspace_id": workspace_id, "rows": moved},
    )


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """The consumer's router, mounted at the root with no API prefix.

    Unprefixed because the Lambda Web Adapter posts the invocation to its own
    pass-through path, which is not under `/api`. The bundle is closed over rather
    than taken as a FastAPI dependency, because the route is registered by the
    shared package and its signature is not this domain's to extend; passing one in
    is what lets a test drive the consumer against moto's tables.
    """
    bundle = repositories if repositories is not None else _GRANT.bundle()
    router = APIRouter()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against this domain's bundle."""
        handle_record(bundle, record)

    register_stream_consumer(router, consume, log_event="planning.rollup.batch")
    return router
