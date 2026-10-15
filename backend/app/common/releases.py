"""Releases: what shipped where, shared by the release routes, the MCP tools and the GitHub source.

Held in `common` because the teams image serves the routes, the integrations image
runs the MCP tools and the GitHub deployment source, and neither may import the
other's code. Every source records a release through `record_release`, so a
release a person adds by hand, one a CI job posts and one a GitHub deployment
reports are the same row with the same rules.

A release belongs to one team and carries only that team's issues, so who may see
it is exactly who may see the team. Any team member records and edits a release,
and only a team administrator changes the pipeline or deletes a release.
"""

from __future__ import annotations

import itertools
import re
from datetime import datetime, timedelta
from typing import Any, Iterable, Iterator, Mapping, Sequence

from boto3.dynamodb.conditions import Attr
from fastapi import HTTPException
from fastapi import status as http_status
from webbpulse.dynamodb import ConditionFailed, ReadOnlyTable, encode_start_key

from app.common import issue_keys
from app.common.api.dependencies.authz import ActorKind, AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import resume_key
from app.common.api.schemas.releases import (
    DEFAULT_LIMIT,
    ISSUES_MAX,
    MAX_LIMIT,
    NAME_MAX,
    IncludedReleaseRead,
    IssueReleaseListRead,
    IssueReleaseRead,
    ReleaseCreate,
    ReleaseDetailRead,
    ReleaseIssueRead,
    ReleasePipelineRead,
    ReleasePipelineUpdate,
    ReleaseRead,
    ReleaseStageAdvance,
    ReleaseUpdate,
)
from app.common.change_source import GITHUB, SYSTEM
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.releases import (
    PipelineStage,
    Release,
    ReleasePipeline,
    ReleaseStageReached,
    default_pipeline,
    fold_name,
    new_release_id,
    pipeline_key,
    release_key,
    release_prefix,
)
from app.common.issue_key_search import find_keys
from app.common.issue_move import find_issue_by_number
from app.common.issue_rules import load_visible_issue, status_categories
from app.common.planning_rules import (
    not_found,
    require_team_admin,
    require_team_member,
    require_team_reader,
    unprocessable,
)

SHORT_SHA = 7

GITHUB_DEPLOYMENT = "github_deployment"

CATEGORY_RANK: Mapping[str, int] = {
    "backlog": 0,
    "unstarted": 1,
    "started": 2,
    "completed": 3,
    "cancelled": 3,
}
"""How far along the workflow each status category is; the two finished ones tie."""

NAME_ATTEMPTS = 5
"""How many free names a new release tries before giving up on a run of lost races."""

FOLD_SWEEP_VERSION = 1
"""The version of the one-time sweep that records promotions' included releases; raising it sweeps again."""

FOLD_SWEEP_ROWS = 5000
"""How many of a team's newest releases the one-time sweep reads."""

FOLD_BEFORE = timedelta(minutes=3)
"""How long before a promotion reached its stage an included release may have reached it.

A deployment advances the earlier releases of its range before it records the
promotion, so they reach the stage first, seconds apart.
"""

FOLD_AFTER = timedelta(seconds=10)
"""How long after a promotion reached its stage an included release may have reached it."""

LIST_SCANS = 5
"""How many reads one listing page makes to fill itself past releases that promotions hide."""

_DATED_NAME = re.compile(r"^(?P<base>.*\d{4}-\d{2}-\d{2})-(?P<letter>[a-z])$")
"""A date-style name with a letter, as a `promote/<date>-<letter>` branch names a release."""


def name_taken(name: str) -> HTTPException:
    """The 409 a rename to a name another release of the team holds gets."""
    return HTTPException(
        status_code=http_status.HTTP_409_CONFLICT,
        detail={
            "error_code": "CONFLICT",
            "message": f"This team already has a release named {name}; pick another name",
        },
    )


def name_candidates(name: str) -> Iterator[str]:
    """The name itself, then the names a release falls back to when it is taken, in order.

    A date-style name moves on through the later letters, so `2026-10-10-a`
    becomes `2026-10-10-b`; any other name, or a dated one past `z`, gets `-2`,
    `-3` and so on, trimmed to fit the name limit.
    """
    yield name
    dated = _DATED_NAME.match(name)
    if dated is not None:
        for code in range(ord(dated["letter"]) + 1, ord("z") + 1):
            yield f"{dated['base']}-{chr(code)}"
    for number in itertools.count(2):
        suffix = f"-{number}"
        yield f"{name[: NAME_MAX - len(suffix)]}{suffix}"


def unique_name(name: str, taken: Mapping[str, str] | set[str]) -> str:
    """The first of the name's candidates no release of the team carries."""
    return next(candidate for candidate in name_candidates(name) if fold_name(candidate) not in taken)


def pipeline_for(repositories: Repositories, workspace_id: str, team_id: str) -> tuple[ReleasePipeline, bool]:
    """The team's pipeline and whether it configured one, the default standing in when not."""
    stored = repositories.releases.get_pipeline(workspace_id, team_id)
    if stored is not None and stored.stages:
        return stored, True
    return default_pipeline(workspace_id, team_id), False


def find_stage(pipeline: ReleasePipeline, reference: str | None) -> PipelineStage | None:
    """The stage an id or a name names, case insensitively, or the first stage for none."""
    if not reference:
        return pipeline.stages[0]
    folded = reference.strip().casefold()
    for stage in pipeline.stages:
        if stage.stage_id == reference.strip() or stage.name.casefold() == folded:
            return stage
    return None


def resolve_stage(pipeline: ReleasePipeline, reference: str | None) -> PipelineStage:
    """The stage a reference names, or a 422 listing the stages there are."""
    stage = find_stage(pipeline, reference)
    if stage is None:
        names = ", ".join(row.name for row in pipeline.stages)
        raise unprocessable(f"No such release stage: {reference}. This team's stages are: {names}")
    return stage


def stage_for_environment(pipeline: ReleasePipeline, environment: str) -> PipelineStage | None:
    """The stage a GitHub environment reaches in this pipeline, or `None` when none maps it."""
    folded = environment.strip().casefold()
    if not folded:
        return None
    for stage in pipeline.stages:
        if folded in {name.casefold() for name in stage.github_environments}:
            return stage
    return None


def auto_name(sha: str | None, release_id: str, now: datetime | None = None) -> str:
    """A release name from the date and the short sha, or the date and the id's tail without a sha."""
    day = (now or utc_now()).strftime("%Y.%m.%d")
    suffix = sha[:SHORT_SHA] if sha else release_id[-6:].lower()
    return f"{day}-{suffix}"


def team_prefixes(repositories: Repositories, workspace_id: str, team_id: str) -> dict[str, list[str]]:
    """One team's current key prefix then the ones it retired, for reading keys out of text."""
    team = repositories.teams.get(workspace_id, team_id)
    if team is None or not team.key_prefix:
        return {}
    aliases = repositories.teams.list_aliases(workspace_id, team_id)
    return {team_id: [team.key_prefix, *aliases]}


def issues_from_messages(
    repositories: Repositories, workspace_id: str, team_id: str, messages: Sequence[str]
) -> list[Issue]:
    """The team's issues whose keys appear in these commit messages, first named first."""
    prefixes = team_prefixes(repositories, workspace_id, team_id)
    if not prefixes or not messages:
        return []
    numbers: dict[int, None] = {}
    for message in messages:
        for found in find_keys(message, prefixes):
            numbers.setdefault(found.number, None)
    issues: dict[str, Issue] = {}
    for number in numbers:
        issue = find_issue_by_number(repositories, workspace_id, team_id, number)
        if issue is not None and issue.team_id == team_id:
            issues.setdefault(issue.issue_id, issue)
    return list(issues.values())


def resolve_issue_refs(
    repositories: Repositories, workspace_id: str, team_id: str, references: Iterable[str]
) -> tuple[list[Issue], list[str]]:
    """The team's issues these keys or ids name, and the references that named none of them.

    Lenient on purpose: a release records what shipped, so one bad key in a CI job's
    list is reported back rather than refusing the whole release.
    """
    prefixes = team_prefixes(repositories, workspace_id, team_id)
    found: dict[str, Issue] = {}
    skipped: list[str] = []
    for raw in references:
        reference = str(raw).strip()
        if not reference:
            continue
        issue: Issue | None = None
        if "-" in reference:
            keys = find_keys(reference, prefixes) if prefixes else []
            if keys:
                issue = find_issue_by_number(repositories, workspace_id, team_id, keys[0].number)
        else:
            issue = repositories.issues.get(workspace_id, reference)
        if issue is None or issue.team_id != team_id:
            skipped.append(reference)
            continue
        found.setdefault(issue.issue_id, issue)
    return list(found.values()), skipped


def _reached(
    stage: PipelineStage,
    *,
    source: str,
    environment: str | None,
    url: str | None,
    actor_id: str | None,
    at: datetime | None = None,
) -> ReleaseStageReached:
    """A stage-reached entry stamped now, or at the time given."""
    return ReleaseStageReached(
        stage_id=stage.stage_id,
        name=stage.name,
        reached_at=at or utc_now(),
        source=source,
        environment=environment,
        url=url,
        actor_id=actor_id,
    )


def reach_stage(
    repositories: Repositories,
    release: Release,
    stage: PipelineStage,
    *,
    source: str,
    environment: str | None = None,
    url: str | None = None,
    actor_id: str | None = None,
    at: datetime | None = None,
    automate: bool = True,
) -> Release:
    """The release with this stage reached, written only when it had not reached it yet.

    Newly reaching a stage runs its status automation over the release's issues
    unless `automate` is off, which is how a history backfill leaves issues alone.
    A backfill also passes `at`, when the stage was really reached.
    """
    if any(row.stage_id == stage.stage_id for row in release.stages):
        return release
    entry = _reached(stage, source=source, environment=environment, url=url, actor_id=actor_id, at=at)
    updated = release.model_copy(update={"stages": [*release.stages, entry], "updated_at": utc_now()})
    try:
        stored = repositories.releases.replace(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    if automate:
        apply_stage_automation(repositories, stored, stage, source=source)
    return stored


def add_issues(
    repositories: Repositories,
    release: Release,
    issues: Sequence[Issue],
    *,
    automate: bool = True,
    referenced: Sequence[str] = (),
) -> Release:
    """The release with these issues added, written only when any was new to it.

    Each new issue then gets the status automation of every stage the release
    already reached, unless `automate` is off or it is in `referenced`, the new
    issues no pull request of the release closes.
    """
    new_ids = [issue.issue_id for issue in issues if issue.issue_id not in release.issue_ids]
    if not new_ids:
        return release
    combined = list(dict.fromkeys([*release.issue_ids, *new_ids]))
    if len(combined) > ISSUES_MAX:
        raise unprocessable(f"A release carries at most {ISSUES_MAX} issues")
    references = list(dict.fromkeys([*release.referenced_issue_ids, *(i for i in referenced if i in new_ids)]))
    updated = release.model_copy(
        update={"issue_ids": combined, "referenced_issue_ids": references, "updated_at": utc_now()}
    )
    try:
        stored = repositories.releases.replace(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    repositories.releases.link_issues(stored, new_ids)
    if automate and stored.stages:
        pipeline, _ = pipeline_for(repositories, stored.workspace_id, stored.team_id)
        by_id = {stage.stage_id: stage for stage in pipeline.stages}
        for reached in stored.stages:
            stage = by_id.get(reached.stage_id)
            if stage is not None:
                apply_stage_automation(repositories, stored, stage, issue_ids=new_ids, source=reached.source)
    return stored


def _stage_rank(pipeline: ReleasePipeline) -> dict[str, int]:
    """Each stage id of the pipeline mapped to its position."""
    return {stage.stage_id: index for index, stage in enumerate(pipeline.stages)}


def _carries(parent: Release, child: Release, rank: Mapping[str, int]) -> bool:
    """Whether a promotion may include this release: another, not in one yet, from an earlier stage."""
    if child.release_id == parent.release_id or child.included_in is not None or parent.included_in is not None:
        return False
    if not parent.stages or not child.stages:
        return False
    parent_rank = rank.get(parent.stages[0].stage_id)
    child_rank = rank.get(child.stages[0].stage_id)
    return parent_rank is not None and child_rank is not None and child_rank < parent_rank


def include_releases(
    repositories: Repositories, parent: Release, candidates: Sequence[Release], pipeline: ReleasePipeline
) -> Release:
    """The promotion with the earlier releases it carried recorded as included in it.

    A release qualifies when it first landed on an earlier stage of the pipeline
    than the one the promotion was released to and is in no promotion yet. Each
    write holds only while the release is in none, so two writers never move a
    release between promotions. Status automation is untouched: the releases
    already advanced through `reach_stage`.
    """
    rank = _stage_rank(pipeline)
    added = [
        child.release_id
        for child in candidates
        if _carries(parent, child, rank)
        and repositories.releases.mark_included(
            parent.workspace_id, parent.team_id, child.release_id, parent.release_id
        )
    ]
    if not added:
        return parent
    included = list(dict.fromkeys([*parent.included_release_ids, *added]))
    repositories.releases.set_included(parent.workspace_id, parent.team_id, parent.release_id, included)
    return parent.model_copy(update={"included_release_ids": included})


def _entry(release: Release, stage_id: str) -> ReleaseStageReached | None:
    """The release's entry for one stage, when it reached it after landing on another."""
    return next((row for row in release.stages[1:] if row.stage_id == stage_id), None)


def infer_inclusions(rows: Sequence[Release], pipeline: ReleasePipeline) -> dict[str, str]:
    """Which of these releases a promotion among them carried, release id to promotion id.

    This is how releases recorded before promotions kept their included releases
    are matched: a promotion is a GitHub deployment of a merged pull request that
    landed on its first stage there, and it carried every release of the same
    repository that reached that stage, from an earlier one, in the same
    deployment. Same deployment means the same deployment link when both have one,
    and reaching the stage just before the promotion did. Each release goes to the
    promotion that reached the stage nearest in time.
    """
    rank = _stage_rank(pipeline)
    promotions = [row for row in rows if row.source == GITHUB_DEPLOYMENT and row.pr_number is not None and row.stages]
    found: dict[str, str] = {}
    for child in rows:
        if child.source != GITHUB_DEPLOYMENT or len(child.stages) < 2:
            continue
        best: tuple[timedelta, str] | None = None
        for parent in promotions:
            if parent.repository_id != child.repository_id or not _carries(parent, child, rank):
                continue
            landed = parent.stages[0]
            entry = _entry(child, landed.stage_id)
            if entry is None or entry.source != GITHUB_DEPLOYMENT:
                continue
            if entry.environment and landed.environment and entry.environment != landed.environment:
                continue
            if entry.url and landed.url and entry.url != landed.url:
                continue
            gap = landed.reached_at - entry.reached_at
            if gap < -FOLD_AFTER or gap > FOLD_BEFORE or child.created_at > landed.reached_at:
                continue
            distance = abs(gap)
            if best is None or distance < best[0]:
                best = (distance, parent.release_id)
        if best is not None:
            found[child.release_id] = best[1]
    return found


def included_in(rows: Sequence[Release], pipeline: ReleasePipeline) -> dict[str, str]:
    """Each of these releases a promotion carried, recorded or matched, release id to promotion id."""
    found = {row.release_id: row.included_in for row in rows if row.included_in}
    for child_id, parent_id in infer_inclusions(rows, pipeline).items():
        found.setdefault(child_id, parent_id)
    return found


def sweep_inclusions(repositories: Repositories, workspace_id: str, team_id: str, pipeline: ReleasePipeline) -> None:
    """Once per team, record the included releases of promotions recorded before they were kept.

    Runs on a listing read in the images that may write releases, and leaves a
    marker so it never runs again at this version. A function that may only read
    releases skips it; its listings still match promotions in memory.
    """
    if repositories.is_read_only("releases"):
        return
    if repositories.releases.fold_swept(workspace_id, team_id, FOLD_SWEEP_VERSION):
        return
    try:
        rows = repositories.releases.list_all_for_team(workspace_id, team_id, max_items=FOLD_SWEEP_ROWS)
        by_id = {row.release_id: row for row in rows}
        grouped: dict[str, list[Release]] = {}
        for child_id, parent_id in infer_inclusions(rows, pipeline).items():
            grouped.setdefault(parent_id, []).append(by_id[child_id])
        for parent_id, children in grouped.items():
            include_releases(repositories, by_id[parent_id], children, pipeline)
        repositories.releases.mark_fold_swept(workspace_id, team_id, FOLD_SWEEP_VERSION)
    except ReadOnlyTable:
        return


def moves_forward(current: Any | None, target: Any | None) -> bool:
    """Whether moving from `current` to `target` status goes further along the workflow.

    A later category is forward, and within one category a higher `position` is.
    Moving between the two finished categories is not forward, so nothing ever
    leaves canceled. An issue whose status the team no longer has may move.
    """
    if target is None:
        return False
    if current is None:
        return True
    current_rank = CATEGORY_RANK.get(current.category)
    target_rank = CATEGORY_RANK.get(target.category)
    if current_rank is None or target_rank is None:
        return False
    if target_rank != current_rank:
        return target_rank > current_rank
    if target.category != current.category:
        return False
    return (target.position, target.status_id) > (current.position, current.status_id)


def apply_stage_automation(
    repositories: Repositories,
    release: Release,
    stage: PipelineStage,
    *,
    issue_ids: Sequence[str] | None = None,
    source: str = "",
) -> list[str]:
    """Move the release's issues to the stage's status, forward only, returning the ids moved.

    An issue already past the status, in canceled, archived, moved to another
    team, or only referenced by the release is left alone. Each write is
    conditional on the status it read, so an issue someone moves meanwhile keeps
    their move. Every move is recorded in the
    issue's activity naming the release.
    """
    if not stage.status_id:
        return []
    rows_of_team = repositories.team_config.list_statuses(release.workspace_id, release.team_id)
    statuses = {row.status_id: row for row in rows_of_team}
    target = statuses.get(stage.status_id)
    if target is None:
        return []
    referenced = set(release.referenced_issue_ids)
    wanted = issue_ids if issue_ids is not None else release.issue_ids
    ids = [issue_id for issue_id in dict.fromkeys(wanted) if issue_id not in referenced]
    if not ids:
        return []
    actor = GITHUB if source == GITHUB_DEPLOYMENT else SYSTEM
    rows = repositories.issues.get_many(release.workspace_id, ids)
    moved: list[str] = []
    for issue_id in ids:
        issue = rows.get(issue_id)
        if issue is None or issue.team_id != release.team_id or issue.archived_at is not None:
            continue
        if issue.status_id == target.status_id or not moves_forward(statuses.get(issue.status_id), target):
            continue
        updated = issue.model_copy(
            update={"status_id": target.status_id, "updated_at": utc_now(), "updated_by": None, "updated_source": actor}
        )
        try:
            repositories.issues.replace(updated, condition=Attr("status_id").eq(issue.status_id))
        except ConditionFailed:
            continue
        repositories.activity.record(
            build_activity(
                release.workspace_id,
                issue.team_id,
                issue.issue_id,
                actor,
                "field_changed",
                actor_kind=actor,
                field="status_id",
                from_value=issue.status_id,
                to_value=target.status_id,
                release_id=release.release_id,
            )
        )
        moved.append(issue.issue_id)
    return moved


def record_release(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    *,
    stage: PipelineStage,
    source: str,
    issues: Sequence[Issue] = (),
    name: str | None = None,
    version: str | None = None,
    description: str | None = None,
    sha: str | None = None,
    previous_sha: str | None = None,
    repository_id: str | None = None,
    repository: str | None = None,
    url: str | None = None,
    environment: str | None = None,
    actor_id: str | None = None,
    pr_number: int | None = None,
    pr_url: str | None = None,
    at: datetime | None = None,
    automate: bool = True,
    referenced: Sequence[str] = (),
) -> tuple[Release, bool]:
    """Record a release reaching a stage, and whether that made a new release.

    A commit the team already has a release for advances that release to the
    stage and adds any new issues to it, so a CI retry, a second deploy job of the
    same commit and a promotion of it all land on one release. A new release, or
    one newly reaching the stage, runs the stage's status automation unless
    `automate` is off. `at` dates a backfilled release to when it shipped.
    `referenced` names issues the release carries without closing, which the
    automation leaves alone.

    A new release's name is unique within the team: one another release already
    carries falls to the next free candidate, so a reused `promote/<date>-a`
    branch names the second release `<date>-b`. A known commit keeps its
    release's name.
    """
    repository_key = repository_id or ""
    if sha:
        existing_id = repositories.releases.release_for_sha(workspace_id, team_id, repository_key, sha)
        if existing_id is not None:
            existing = repositories.releases.get(workspace_id, team_id, existing_id)
            if existing is not None:
                advanced = reach_stage(
                    repositories,
                    existing,
                    stage,
                    source=source,
                    environment=environment,
                    url=url,
                    actor_id=actor_id,
                    at=at,
                    automate=automate,
                )
                if pr_number is not None and advanced.pr_number is None:
                    advanced = repositories.releases.replace(
                        advanced.model_copy(update={"pr_number": pr_number, "pr_url": pr_url, "updated_at": utc_now()})
                    )
                return add_issues(repositories, advanced, issues, automate=automate, referenced=referenced), False
    release_id = new_release_id(at)
    issue_ids = list(dict.fromkeys(issue.issue_id for issue in issues))[:ISSUES_MAX]
    wanted = ((name or "").strip() or (version or "").strip() or auto_name(sha, release_id))[:NAME_MAX]
    taken = set(repositories.releases.names_in_use(workspace_id, team_id))
    release = Release(
        workspace_id=workspace_id,
        planning_key=release_key(team_id, release_id),
        release_id=release_id,
        team_id=team_id,
        name=unique_name(wanted, taken),
        version=version,
        description=description,
        source=source,
        repository_id=repository_id,
        repository=repository,
        sha=sha,
        previous_sha=previous_sha,
        url=url,
        pr_number=pr_number,
        pr_url=pr_url,
        issue_ids=issue_ids,
        referenced_issue_ids=[issue_id for issue_id in dict.fromkeys(referenced) if issue_id in issue_ids],
        stages=[_reached(stage, source=source, environment=environment, url=url, actor_id=actor_id, at=at)],
        created_by=actor_id,
        created_at=at or utc_now(),
    )
    stored: Release | None = None
    for _ in range(NAME_ATTEMPTS):
        try:
            stored = repositories.releases.create(release)
            break
        except ConditionFailed:
            if sha and repositories.releases.release_for_sha(workspace_id, team_id, repository_key, sha) is not None:
                return record_release(
                    repositories,
                    workspace_id,
                    team_id,
                    stage=stage,
                    source=source,
                    issues=issues,
                    sha=sha,
                    repository_id=repository_id,
                    repository=repository,
                    url=url,
                    environment=environment,
                    actor_id=actor_id,
                    pr_number=pr_number,
                    pr_url=pr_url,
                    at=at,
                    automate=automate,
                    referenced=referenced,
                )
            if repositories.releases.release_for_name(workspace_id, team_id, release.name) is None:
                raise
            taken.add(fold_name(release.name))
            release = release.model_copy(update={"name": unique_name(wanted, taken)})
    if stored is None:
        raise name_taken(release.name)
    if automate:
        apply_stage_automation(repositories, stored, stage, source=source)
    return stored, True


def source_of(context: AuthzContext) -> str:
    """Which source a caller records through: the app by hand, or a key or token through the API."""
    if context.actor != ActorKind.USER or context.scopes:
        return "api"
    return "manual"


def _visible_issues(repositories: Repositories, context: AuthzContext, release: Release) -> list[Issue]:
    """The release's issues the caller may see, keys as they read today, in key order."""
    rows = repositories.issues.get_many(context.workspace_id, list(release.issue_ids))
    visible = [rows[issue_id] for issue_id in release.issue_ids if issue_id in rows]
    visible = [issue for issue in visible if context.can_see_team(issue.team_id)]
    current = issue_keys.current_all(repositories.teams, visible)
    return sorted(current, key=lambda issue: (issue.key.rpartition("-")[0], issue.number))


def notes_for(issues: Sequence[Issue]) -> str:
    """The deterministic release notes: one `KEY title` line per issue, in the order given."""
    return "\n".join(f"{issue.key} {issue.title}" for issue in issues)


def detail(
    repositories: Repositories, context: AuthzContext, release: Release, *, skipped: Sequence[str] = ()
) -> ReleaseDetailRead:
    """One release with its visible issues and notes, against the team's current pipeline."""
    pipeline, _ = pipeline_for(repositories, context.workspace_id, release.team_id)
    issues = _visible_issues(repositories, context, release)
    categories: dict[str, dict[str, str]] = {}
    for team_id in {issue.team_id for issue in issues}:
        categories[team_id] = status_categories(repositories, context.workspace_id, team_id)
    base = ReleaseRead.from_row(release, pipeline)
    linked = repositories.releases.get_many(
        release.workspace_id,
        [(release.team_id, child_id) for child_id in [*release.included_release_ids, release.included_in] if child_id],
    )
    by_id = {row.release_id: row for row in linked}
    children = sorted(
        (by_id[child_id] for child_id in release.included_release_ids if child_id in by_id),
        key=lambda row: row.release_id,
        reverse=True,
    )
    parent = by_id.get(release.included_in) if release.included_in else None
    return ReleaseDetailRead(
        **base.model_dump(),
        included_releases=[IncludedReleaseRead.from_read(ReleaseRead.from_row(row, pipeline)) for row in children],
        included_in_release=IncludedReleaseRead.from_read(ReleaseRead.from_row(parent, pipeline)) if parent else None,
        issues=[
            ReleaseIssueRead(
                issue_id=issue.issue_id,
                key=issue.key,
                title=issue.title,
                status_id=issue.status_id,
                status_category=categories.get(issue.team_id, {}).get(issue.status_id),
            )
            for issue in issues
        ],
        notes=notes_for(issues),
        skipped_issues=list(skipped),
    )


def load_release(repositories: Repositories, context: AuthzContext, team_id: str, release_id: str) -> Release:
    """One release of a team the caller may read, or a 404."""
    require_team_reader(repositories, context, team_id)
    release = repositories.releases.get(context.workspace_id, team_id, release_id)
    if release is None:
        raise not_found()
    return release


def get_pipeline(repositories: Repositories, context: AuthzContext, team_id: str) -> ReleasePipelineRead:
    """The team's release pipeline, the default when it configured none."""
    require_team_reader(repositories, context, team_id)
    pipeline, configured = pipeline_for(repositories, context.workspace_id, team_id)
    return ReleasePipelineRead.from_row(pipeline, configured=configured)


def _stage_id(name: str, taken: set[str]) -> str:
    """A readable id for a new stage from its name, made unique among the pipeline's ids."""
    slug = "".join(char if char.isalnum() else "-" for char in name.casefold()).strip("-")
    slug = "-".join(part for part in slug.split("-") if part)[:32] or "stage"
    candidate = slug
    counter = 2
    while candidate in taken:
        candidate = f"{slug}-{counter}"
        counter += 1
    return candidate


def _stage_status(statuses: Sequence[Any], reference: str | None) -> str | None:
    """The id of the team status a stage names by id or name, or a 422 listing the statuses."""
    if not reference:
        return None
    folded = reference.casefold()
    for status in statuses:
        if status.status_id == reference:
            return str(status.status_id)
    for status in statuses:
        if str(status.name).casefold() == folded:
            return str(status.status_id)
    names = ", ".join(str(status.name) for status in statuses)
    raise unprocessable(f"No such status: {reference}. This team's statuses are: {names}")


def set_pipeline(
    repositories: Repositories, context: AuthzContext, team_id: str, payload: ReleasePipelineUpdate
) -> ReleasePipelineRead:
    """Replace the team's ordered stages, as a team administrator.

    A stage named with its id keeps it, so the releases that reached it stay on it
    under its new name. A new stage gets an id made from its name. A stage's status
    is named by id or name and stored as the id.
    """
    require_team_admin(repositories, context, team_id)
    statuses = repositories.team_config.list_statuses(context.workspace_id, team_id)
    taken = {stage.stage_id for stage in payload.stages if stage.stage_id}
    stages: list[PipelineStage] = []
    for stage in payload.stages:
        stage_id = stage.stage_id or _stage_id(stage.name, taken)
        taken.add(stage_id)
        stages.append(
            PipelineStage(
                stage_id=stage_id,
                name=stage.name,
                github_environments=list(stage.github_environments),
                status_id=_stage_status(statuses, stage.status_id),
                publish_github_release=stage.publish_github_release,
            )
        )
    pipeline = ReleasePipeline(
        workspace_id=context.workspace_id,
        planning_key=pipeline_key(team_id),
        team_id=team_id,
        stages=stages,
    )
    repositories.releases.put_pipeline(pipeline)
    return ReleasePipelineRead.from_row(pipeline, configured=True)


def cursor_scope(workspace_id: str, team_id: str) -> str:
    """The scope a release listing cursor is minted under, so it only resumes the same listing."""
    return f"releases:{workspace_id}:{team_id}"


def _start_key(cursor: str | None, workspace_id: str, team_id: str) -> Mapping[str, Any] | None:
    """A decoded cursor, or `None` when it would resume outside this team's releases."""
    start = resume_key(cursor, cursor_scope(workspace_id, team_id))
    if start is None:
        return None
    if start.get("workspace_id") != workspace_id:
        return None
    if not str(start.get("planning_key", "")).startswith(release_prefix(team_id)):
        return None
    return start


def _page(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    size: int,
    start: Mapping[str, Any] | None,
    *,
    show_included: bool,
) -> tuple[list[Release], Mapping[str, Any] | None]:
    """Up to `size` releases from `start`, skipping those a promotion carried unless asked, and where to resume.

    A page cut short of the rows read resumes after the last release it kept, so
    the next page starts exactly where this one stopped.
    """
    kept: list[Release] = []
    for _ in range(1 if show_included else LIST_SCANS):
        rows, last_key = repositories.releases.list_for_team(workspace_id, team_id, limit=size, start_key=start)
        for index, row in enumerate(rows):
            if row.included_in and not show_included:
                continue
            kept.append(row)
            if len(kept) == size:
                if index == len(rows) - 1:
                    return kept, last_key
                return kept, {"workspace_id": workspace_id, "planning_key": row.planning_key}
        if last_key is None:
            return kept, None
        start = last_key
    return kept, start


def list_releases(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    *,
    cursor: str | None = None,
    limit: int | None = None,
    show_included: bool = False,
) -> tuple[list[ReleaseRead], str | None]:
    """One page of a readable team's releases, newest first, and the next cursor.

    Releases a promotion carried to a later stage are left out unless
    `show_included` asks for them; the promotion's detail lists them. The first
    listing of a team also records the included releases of promotions that
    predate keeping them.
    """
    require_team_reader(repositories, context, team_id)
    pipeline, _ = pipeline_for(repositories, context.workspace_id, team_id)
    sweep_inclusions(repositories, context.workspace_id, team_id, pipeline)
    size = max(1, min(limit or DEFAULT_LIMIT, MAX_LIMIT))
    rows, last_key = _page(
        repositories,
        context.workspace_id,
        team_id,
        size,
        _start_key(cursor, context.workspace_id, team_id),
        show_included=show_included,
    )
    counts = _status_counts(repositories, context, rows)
    listed = [ReleaseRead.from_row(row, pipeline) for row in rows]
    for read in listed:
        read.status_counts = counts.get(read.release_id, {})
    return (listed, encode_start_key(last_key, scope=cursor_scope(context.workspace_id, team_id)))


def _status_counts(
    repositories: Repositories, context: AuthzContext, releases: Sequence[Release]
) -> dict[str, dict[str, int]]:
    """Each release's visible issues tallied by status category, read in one batch for the page."""
    wanted = list(dict.fromkeys(issue_id for release in releases for issue_id in release.issue_ids))
    if not wanted:
        return {}
    issues = repositories.issues.get_many(context.workspace_id, wanted)
    categories: dict[str, dict[str, str]] = {}
    tallies: dict[str, dict[str, int]] = {}
    for release in releases:
        tally: dict[str, int] = {}
        for issue_id in release.issue_ids:
            issue = issues.get(issue_id)
            if issue is None or not context.can_see_team(issue.team_id):
                continue
            if issue.team_id not in categories:
                categories[issue.team_id] = status_categories(repositories, context.workspace_id, issue.team_id)
            category = categories[issue.team_id].get(issue.status_id)
            if category is not None:
                tally[category] = tally.get(category, 0) + 1
        tallies[release.release_id] = tally
    return tallies


def get_release(repositories: Repositories, context: AuthzContext, team_id: str, release_id: str) -> ReleaseDetailRead:
    """One release of a readable team, with its issues, notes and the releases a promotion carried."""
    release = load_release(repositories, context, team_id, release_id)
    if not repositories.releases.fold_swept(context.workspace_id, team_id, FOLD_SWEEP_VERSION):
        pipeline, _ = pipeline_for(repositories, context.workspace_id, team_id)
        sweep_inclusions(repositories, context.workspace_id, team_id, pipeline)
        release = load_release(repositories, context, team_id, release_id)
    return detail(repositories, context, release)


def create_release(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    payload: ReleaseCreate,
    *,
    source: str | None = None,
) -> tuple[ReleaseDetailRead, bool]:
    """Record a release as a team member: its detail, and whether that made a new release."""
    require_team_member(repositories, context, team_id)
    pipeline, _ = pipeline_for(repositories, context.workspace_id, team_id)
    stage = resolve_stage(pipeline, payload.stage)
    named, skipped = resolve_issue_refs(repositories, context.workspace_id, team_id, payload.issues)
    mentioned = issues_from_messages(repositories, context.workspace_id, team_id, payload.commit_messages)
    issues = list({issue.issue_id: issue for issue in [*named, *mentioned]}.values())
    if len(issues) > ISSUES_MAX:
        raise unprocessable(f"A release carries at most {ISSUES_MAX} issues")
    release, created = record_release(
        repositories,
        context.workspace_id,
        team_id,
        stage=stage,
        source=source or source_of(context),
        issues=issues,
        name=payload.name,
        version=payload.version,
        description=payload.description,
        sha=payload.sha,
        previous_sha=payload.previous_sha,
        repository=payload.repository,
        url=payload.url,
        environment=payload.environment,
        actor_id=context.user_id,
    )
    return detail(repositories, context, release, skipped=skipped), created


def advance_release(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    release_id: str,
    payload: ReleaseStageAdvance,
    *,
    source: str | None = None,
) -> ReleaseDetailRead:
    """Mark a release as having reached a stage, as a team member; reaching it again changes nothing."""
    release = load_release(repositories, context, team_id, release_id)
    require_team_member(repositories, context, team_id)
    pipeline, _ = pipeline_for(repositories, context.workspace_id, team_id)
    stage = resolve_stage(pipeline, payload.stage)
    advanced = reach_stage(
        repositories,
        release,
        stage,
        source=source or source_of(context),
        environment=payload.environment,
        url=payload.url,
        actor_id=context.user_id,
    )
    return detail(repositories, context, advanced)


def update_release(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    release_id: str,
    payload: ReleaseUpdate,
) -> ReleaseDetailRead:
    """Rename a release or change its version, description or link, as a team member.

    A name another release of the team carries, compared case insensitively, is
    refused with a 409 so a lookup by name stays unambiguous.
    """
    release = load_release(repositories, context, team_id, release_id)
    require_team_member(repositories, context, team_id)
    changes: dict[str, Any] = {}
    for name in ("name", "version", "description", "url"):
        if name in payload.model_fields_set:
            changes[name] = getattr(payload, name)
    if "name" in changes and changes["name"] is None:
        raise unprocessable("A release needs a name")
    if not changes:
        return detail(repositories, context, release)
    if "name" in changes:
        changes["name"] = changes["name"].strip()
        if not changes["name"]:
            raise unprocessable("A release needs a name")
    updated = release.model_copy(update={**changes, "updated_at": utc_now()})
    if "name" not in changes or changes["name"] == release.name:
        try:
            stored = repositories.releases.replace(updated)
        except ConditionFailed as exc:
            raise not_found() from exc
        return detail(repositories, context, stored)
    holder = repositories.releases.names_in_use(context.workspace_id, team_id).get(fold_name(updated.name))
    if holder is not None and holder != release.release_id:
        raise name_taken(updated.name)
    try:
        stored = repositories.releases.rename(updated, release.name)
    except ConditionFailed as exc:
        if repositories.releases.get(context.workspace_id, team_id, release_id) is None:
            raise not_found() from exc
        raise name_taken(updated.name) from exc
    return detail(repositories, context, stored)


def add_release_issues(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    release_id: str,
    references: Sequence[str],
) -> ReleaseDetailRead:
    """Add issues of the release's team to it by key or id, echoing the refs that named none."""
    release = load_release(repositories, context, team_id, release_id)
    require_team_member(repositories, context, team_id)
    issues, skipped = resolve_issue_refs(repositories, context.workspace_id, team_id, references)
    return detail(repositories, context, add_issues(repositories, release, issues), skipped=skipped)


def remove_release_issue(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    release_id: str,
    issue_reference: str,
) -> ReleaseDetailRead:
    """Take one issue off a release by key or id; an issue it does not carry changes nothing."""
    release = load_release(repositories, context, team_id, release_id)
    require_team_member(repositories, context, team_id)
    issues, _ = resolve_issue_refs(repositories, context.workspace_id, team_id, [issue_reference])
    issue_id = issues[0].issue_id if issues else issue_reference.strip()
    if issue_id not in release.issue_ids:
        return detail(repositories, context, release)
    remaining = [value for value in release.issue_ids if value != issue_id]
    references = [value for value in release.referenced_issue_ids if value != issue_id]
    updated = release.model_copy(
        update={"issue_ids": remaining, "referenced_issue_ids": references, "updated_at": utc_now()}
    )
    try:
        stored = repositories.releases.replace(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    repositories.releases.unlink_issues(context.workspace_id, release.release_id, [issue_id])
    return detail(repositories, context, stored)


def delete_release(repositories: Repositories, context: AuthzContext, team_id: str, release_id: str) -> None:
    """Delete a release and its links as a team administrator; its issues are untouched.

    A deleted promotion lets go of the releases it carried, so they list again,
    and a deleted included release leaves its promotion's list.
    """
    release = load_release(repositories, context, team_id, release_id)
    require_team_admin(repositories, context, team_id)
    for child_id in release.included_release_ids:
        repositories.releases.clear_included(context.workspace_id, team_id, child_id, release.release_id)
    if release.included_in:
        parent = repositories.releases.get(context.workspace_id, team_id, release.included_in)
        if parent is not None:
            remaining = [value for value in parent.included_release_ids if value != release.release_id]
            repositories.releases.set_included(context.workspace_id, team_id, parent.release_id, remaining)
    repositories.releases.delete(release)


def issue_releases(repositories: Repositories, context: AuthzContext, issue_id: str) -> IssueReleaseListRead:
    """The releases one visible issue shipped in, newest first, each with its furthest stage.

    A release a promotion carried is left out when that promotion is listed too,
    so the issue reads as shipping once per stage rather than once per release.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    pairs = repositories.releases.list_for_issue(context.workspace_id, issue.issue_id)
    pairs = [(team_id, release_id) for team_id, release_id in pairs if context.can_see_team(team_id)]
    found = repositories.releases.get_many(context.workspace_id, pairs)
    releases = [row for row in found if issue.issue_id in row.issue_ids]
    pipelines: dict[str, ReleasePipeline] = {}
    for release in releases:
        if release.team_id not in pipelines:
            pipelines[release.team_id] = pipeline_for(repositories, context.workspace_id, release.team_id)[0]
    listed = {release.release_id for release in releases}
    carried: dict[str, str] = {}
    for team_id, pipeline in pipelines.items():
        carried.update(included_in([row for row in releases if row.team_id == team_id], pipeline))
    rows: list[IssueReleaseRead] = []
    for release in sorted(releases, key=lambda row: row.release_id, reverse=True):
        if carried.get(release.release_id) in listed:
            continue
        read = ReleaseRead.from_row(release, pipelines[release.team_id])
        rows.append(
            IssueReleaseRead(
                release_id=read.release_id,
                team_id=read.team_id,
                name=read.name,
                current_stage=read.current_stage,
                created_at=read.created_at,
            )
        )
    return IssueReleaseListRead(releases=rows)
