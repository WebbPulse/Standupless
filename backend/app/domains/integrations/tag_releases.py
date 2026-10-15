"""The tag and GitHub Release release sources: a package repository's version tags record its releases.

A repository pinned to a team whose release source is `tags` records a release
when a tag matching its pattern is pushed, which GitHub sends as a `create`
delivery, and one whose source is `github_releases` records one when a GitHub
Release of a matching tag is published. The release is named after the
repository and the tag, carries the version the tag spells, links to the tag's
GitHub page, and holds the team's issues named in the commits since the previous
matching tag by version, with the pull request text their messages lack folded in
as a deployment's range is. The first tag of a repository carries only what its
own commit names.

It lands at the last stage of the team's pipeline and moves the issues it closes
to the source's status, the team's Done unless another is set, forward only;
issues only referenced are carried without moving. A backfill walks the matching
tags newest first, a page at a time, and never moves issues.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime
from fnmatch import fnmatchcase
from typing import Any, Mapping, Sequence
from urllib.parse import quote

from app.common import releases
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.releases import ReleaseBackfill, ReleaseBackfillRead
from app.common.db.dynamo.github import (
    RELEASE_SOURCE_DEPLOYMENTS,
    RELEASE_SOURCE_GITHUB_RELEASES,
    RELEASE_SOURCE_TAGS,
    Repository_,
    RepositoryReleaseSource,
)
from app.common.db.dynamo.releases import PipelineStage, Release, ReleasePipeline
from app.common.planning_rules import unprocessable
from app.domains.integrations.deployments import (
    BACKFILL_FIRST_SECONDS,
    BACKFILL_PAGE_SECONDS,
    _backfill_repositories,
    _cursor,
    _GitHub,
    _parse_cursor,
    _readable,
    _stalled,
    _stopped,
    _stored_pulls,
    referenced_only,
)

_log = logging.getLogger(__name__)

CURSOR_PREFIX = "tag:"

COMPLETED = "completed"

DONE = "done"

_VERSION_CORE = re.compile(r"\d+(?:\.\d+)*")

_DIGIT = re.compile(r"\d")


@dataclass(frozen=True)
class TagVersion:
    """One matching tag as a release source reads it: its name, commit, page and publish time."""

    tag: str
    sha: str
    url: str | None
    at: datetime | None


def matches(source: RepositoryReleaseSource, tag: str) -> bool:
    """Whether a tag is one the source records: any tag without a pattern, else a glob match."""
    if not tag:
        return False
    return fnmatchcase(tag, source.tag_pattern) if source.tag_pattern else True


def version_of(tag: str) -> str:
    """The version a tag spells, from its first digit on, so `python-v0.89.0` reads `0.89.0`."""
    found = _DIGIT.search(tag)
    return tag[found.start() :] if found else tag


def version_key(tag: str) -> tuple[Any, ...]:
    """A tag's sort key by version: the numeric core, then a release above its pre-releases."""
    version = version_of(tag)
    core = _VERSION_CORE.match(version)
    numbers = tuple(int(part) for part in core.group().split(".")) if core else ()
    rest = version[core.end() :] if core else version
    return (numbers, 0 if rest else 1, rest, tag)


def tag_url(full_name: str, tag: str) -> str:
    """The GitHub page of one tag."""
    return f"https://github.com/{full_name}/releases/tag/{quote(tag, safe='')}"


def source_for(kind: str) -> str:
    """The release `source` a repository's release source records under."""
    return releases.GITHUB_RELEASE if kind == RELEASE_SOURCE_GITHUB_RELEASES else releases.GITHUB_TAG


def versions(github: _GitHub, repository: Repository_) -> list[TagVersion]:
    """Every tag the repository's source records, newest version first.

    The `github_releases` source keeps only the tags a published Release holds,
    with that Release's page and publish time.
    """
    from app.domains.integrations import github_deployments

    source = repository.release_source
    tags = github_deployments.list_tags(github.token(), repository.repository_id)
    by_tag = {row.name: row.sha for row in tags if matches(source, row.name)}
    if source.kind == RELEASE_SOURCE_GITHUB_RELEASES:
        published = github_deployments.list_releases(github.token(), repository.repository_id)
        rows = [
            TagVersion(row.tag, by_tag[row.tag], row.url or tag_url(repository.full_name, row.tag), row.published_at)
            for row in published
            if row.tag in by_tag
        ]
    else:
        rows = [TagVersion(name, sha, tag_url(repository.full_name, name), None) for name, sha in by_tag.items()]
    unique = {row.tag: row for row in rows}
    return sorted(unique.values(), key=lambda row: version_key(row.tag), reverse=True)


def older_than(rows: Sequence[TagVersion], tag: str) -> list[TagVersion]:
    """The versions before this tag, newest first."""
    key = version_key(tag)
    return [row for row in rows if row.tag != tag and version_key(row.tag) < key]


def done_status(repositories: Repositories, workspace_id: str, team_id: str) -> str | None:
    """The team's Done status: the completed status named Done, else its first completed one."""
    rows = repositories.team_config.list_statuses(workspace_id, team_id)
    completed = sorted((row for row in rows if row.category == COMPLETED), key=lambda row: row.position)
    named = [row for row in completed if row.name.strip().casefold() == DONE]
    chosen = named or completed
    return chosen[0].status_id if chosen else None


def resolve_release_source(
    repositories: Repositories,
    workspace_id: str,
    team_id: str | None,
    *,
    kind: str,
    tag_pattern: str | None = None,
    status: str | None = None,
    move_issues: bool = True,
) -> RepositoryReleaseSource:
    """A release source checked against the repository's team, or a 422 saying what is wrong.

    A tag or Release source needs a pinned team, since its releases and status
    moves are that team's, and `status` must name one of the team's statuses by
    id or name. The deployments source keeps no pattern or status.
    """
    if kind == RELEASE_SOURCE_DEPLOYMENTS:
        return RepositoryReleaseSource()
    if not team_id:
        raise unprocessable("Pin the repository to a team before choosing tags or GitHub Releases")
    status_id: str | None = None
    if status:
        folded = status.casefold()
        rows = repositories.team_config.list_statuses(workspace_id, team_id)
        named = [row for row in rows if row.status_id == status or row.name.strip().casefold() == folded]
        if not named:
            raise unprocessable(f"No such status on this team: {status}")
        status_id = named[0].status_id
    return RepositoryReleaseSource.model_validate(
        {"kind": kind, "tag_pattern": tag_pattern, "status_id": status_id, "move_issues": move_issues}
    )


def tag_stage(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    pipeline: ReleasePipeline,
    source: RepositoryReleaseSource,
) -> PipelineStage:
    """The pipeline's last stage as a tag reaches it: moving issues to the source's status, publishing nothing."""
    status_id: str | None = None
    if source.move_issues:
        known = {row.status_id for row in repositories.team_config.list_statuses(workspace_id, team_id)}
        status_id = source.status_id if source.status_id in known else done_status(repositories, workspace_id, team_id)
    return pipeline.stages[-1].model_copy(update={"status_id": status_id, "publish_github_release": False})


def record(
    repositories: Repositories,
    repository: Repository_,
    github: _GitHub,
    *,
    tag: str,
    sha: str,
    previous_sha: str | None,
    url: str | None,
    at: datetime | None,
    automate: bool,
) -> tuple[Release, bool]:
    """Record one tag as a release of the repository's pinned team, and whether that made a new one."""
    workspace_id = repository.workspace_id
    team_id = str(repository.team_id)
    pipeline, _ = releases.pipeline_for(repositories, workspace_id, team_id)
    stage = tag_stage(repositories, workspace_id, team_id, pipeline, repository.release_source)
    commits = github.commits(previous_sha, sha)
    issues = releases.issues_from_messages(repositories, workspace_id, team_id, [message for _, message in commits])
    referenced = referenced_only(
        repositories,
        workspace_id,
        repository.repository_id,
        repository.full_name,
        [issue.issue_id for issue in issues],
    )
    return releases.record_release(
        repositories,
        workspace_id,
        team_id,
        stage=stage,
        source=source_for(repository.release_source.kind),
        issues=issues,
        name=f"{repository.name} {tag}",
        version=version_of(tag),
        sha=sha,
        previous_sha=previous_sha,
        repository_id=repository.repository_id,
        repository=repository.full_name,
        url=url or tag_url(repository.full_name, tag),
        at=at,
        automate=automate,
        referenced=referenced,
    )


def _installation_id(body: Mapping[str, Any]) -> str:
    """The installation a delivery came through."""
    installation = body.get("installation")
    return str(installation.get("id", "")) if isinstance(installation, Mapping) else ""


def _handle(
    repositories: Repositories,
    workspace_id: str,
    body: Mapping[str, Any],
    tag: str,
    *,
    kind: str,
    url: str | None,
    at: datetime | None,
) -> None:
    """Record a tag of a pinned repository whose release source is `kind`, when the tag matches."""
    from app.domains.integrations import github_deployments

    repository = body.get("repository")
    if not isinstance(repository, Mapping):
        return
    repository_id = str(repository.get("id") or "")
    if not tag or not repository_id:
        return
    stored = repositories.github.get_repository(workspace_id, repository_id)
    if stored is None or not stored.team_id or stored.release_source.kind != kind:
        return
    if not matches(stored.release_source, tag):
        return
    github = _GitHub(_installation_id(body), repository_id)
    resolved = _readable(lambda: github_deployments.tag_commit(github.token(), repository_id, tag), None, "tag")
    if resolved is None:
        return
    sha, _ = resolved
    known = _readable(lambda: versions(github, stored), [], "tags")
    older = older_than(known, tag)
    record(
        repositories,
        stored,
        github,
        tag=tag,
        sha=sha,
        previous_sha=older[0].sha if older else None,
        url=url,
        at=at,
        automate=True,
    )


def handle_create(repositories: Repositories, workspace_id: str, body: Mapping[str, Any]) -> None:
    """Record a pushed tag as a release of a repository whose release source is `tags`."""
    if str(body.get("ref_type", "")) != "tag":
        return
    _handle(repositories, workspace_id, body, str(body.get("ref") or ""), kind=RELEASE_SOURCE_TAGS, url=None, at=None)


def handle_release(repositories: Repositories, workspace_id: str, body: Mapping[str, Any]) -> None:
    """Record a published GitHub Release as a release of a repository whose release source is `github_releases`."""
    from app.domains.integrations import github_deployments

    if str(body.get("action", "")) != "published":
        return
    release = body.get("release")
    if not isinstance(release, Mapping) or release.get("draft"):
        return
    url = release.get("html_url")
    _handle(
        repositories,
        workspace_id,
        body,
        str(release.get("tag_name") or ""),
        kind=RELEASE_SOURCE_GITHUB_RELEASES,
        url=url if isinstance(url, str) and url.startswith("https://") else None,
        at=github_deployments._timestamp(release.get("published_at")),
    )


def _tag_cursor(repository_id: str, before: str | None) -> str:
    """A tag backfill cursor: the repository and the tag to continue before, empty to start at the newest."""
    return f"{CURSOR_PREFIX}{repository_id}:{before or ''}"


def _parse_tag_cursor(cursor: str) -> tuple[str, str | None]:
    """A tag backfill cursor's repository and tag, or a 422 when it is not one this route minted."""
    parts = cursor[len(CURSOR_PREFIX) :].split(":", 1)
    if len(parts) != 2 or not parts[0].isdigit():
        raise unprocessable("Invalid backfill cursor")
    return parts[0], parts[1] or None


def route(
    repositories: Repositories, workspace_id: str, team_id: str, payload: ReleaseBackfill
) -> ReleaseBackfillRead | None:
    """A tag backfill page when the repository the call reaches records from tags, else `None`.

    A tag cursor continues one; a deployment cursor or no cursor starts one when
    the repository it names, or the first pinned one, records from tags or
    Releases, so one cursor walks a team whose repositories mix the sources.
    """
    if payload.deployment_ids:
        return None
    targets = _backfill_repositories(repositories, workspace_id, team_id, payload.repository)
    ids = [row.repository_id for row in targets]
    before: str | None = None
    if payload.cursor and payload.cursor.startswith(CURSOR_PREFIX):
        repository_id, before = _parse_tag_cursor(payload.cursor)
        if repository_id not in ids:
            raise unprocessable("Invalid backfill cursor")
        index = ids.index(repository_id)
        if targets[index].release_source.kind == RELEASE_SOURCE_DEPLOYMENTS:
            raise unprocessable("Invalid backfill cursor")
    elif payload.cursor:
        repository_id, before_id, page = _parse_cursor(payload.cursor)
        if repository_id not in ids:
            return None
        index = ids.index(str(repository_id))
        if before_id is not None or page != 1:
            return None
    else:
        index = 0
    if targets[index].release_source.kind == RELEASE_SOURCE_DEPLOYMENTS:
        return None
    return backfill(repositories, workspace_id, team_id, payload, targets[index:], before)


def backfill(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    payload: ReleaseBackfill,
    targets: Sequence[Repository_],
    before: str | None,
) -> ReleaseBackfillRead:
    """Rebuild one page of a repository's releases from its matching tags, newest first.

    Each tag's range starts at the next older matching tag by version, through the
    same path a pushed tag takes, so a tag that already has a release costs no
    GitHub call and the backfill never moves issues. The counts named for
    deployments count tags here, and `environment` is not read. The page keeps to
    the GitHub App's budget and the request timeout as a deployment backfill does,
    answering a cursor at the first tag it did not record. A tag GitHub will not
    read is passed over and named in `unreadable_tags`, so the cursor moves past it.
    """
    from webbpulse.integrations.github import (
        GitHubNotFound,
        GitHubRateLimited,
        GitHubUnavailable,
        GitHubUnprocessable,
    )

    from app.domains.integrations import github_budget, github_deployments

    target = targets[0]
    installation = repositories.github.get_installation(workspace_id)
    installation_id = str(target.installation_id or (installation.installation_id if installation else ""))
    github = _GitHub(
        installation_id,
        target.repository_id,
        stored_pulls=_stored_pulls(repositories, workspace_id, target.repository_id),
    )
    created = 0
    updated = 0
    skipped = 0
    done = 0
    release_ids: list[str] = []
    unreadable: list[str] = []
    remaining: list[TagVersion] = []
    batch: list[TagVersion] = []
    stop: tuple[str, datetime | None] | None = None
    stalled = False

    with github_budget.capped(BACKFILL_PAGE_SECONDS) as budget:
        try:
            budget.until(BACKFILL_FIRST_SECONDS)
            found = _readable(lambda: versions(github, target), None, "tags")
            if found is None:
                raise unprocessable("GitHub would not list this repository's tags; check the App's permissions")
            remaining = older_than(found, before) if before else found
            batch = remaining[: payload.limit]
            for index, version in enumerate(batch):
                if repositories.releases.release_for_sha(workspace_id, team_id, target.repository_id, version.sha):
                    skipped += 1
                    done += 1
                    continue
                first = done == 0
                budget.until(BACKFILL_FIRST_SECONDS if first else BACKFILL_PAGE_SECONDS)
                github.best_effort_pulls = first
                previous = remaining[index + 1].sha if index + 1 < len(remaining) else None
                try:
                    at = version.at
                    if at is None:
                        tagged = version.tag
                        _, at = _readable(
                            lambda: github_deployments.tag_commit(github.token(), target.repository_id, tagged),
                            (version.sha, None),
                            "tag",
                        )
                    release, made = record(
                        repositories,
                        target,
                        github,
                        tag=version.tag,
                        sha=version.sha,
                        previous_sha=previous,
                        url=version.url,
                        at=at,
                        automate=False,
                    )
                except (GitHubUnprocessable, GitHubNotFound) as error:
                    unreadable.append(version.tag)
                    done += 1
                    _log.warning(
                        "A tag release backfill passed over a tag GitHub would not read.",
                        extra={
                            "event": "integrations.tag_backfill_unreadable",
                            "tag": version.tag,
                            "reason": type(error).__name__,
                        },
                    )
                    continue
                done += 1
                release_ids.append(release.release_id)
                if made:
                    created += 1
                else:
                    updated += 1
        except (github_budget.BudgetSpent, GitHubRateLimited, GitHubUnavailable) as error:
            stalled = done == 0
            stop = _stalled(error, budget, None) if stalled else _stopped(error, budget)
            _log.warning(
                "A tag release backfill page stopped early.",
                extra={
                    "event": f"integrations.tag_backfill_{'stalled' if stalled else 'stopped'}",
                    "reason": type(error).__name__,
                    "github_calls": budget.calls,
                    "rate_limit_remaining": budget.remaining,
                },
            )
    if stop is not None:
        next_cursor: str | None = _tag_cursor(target.repository_id, batch[done - 1].tag if done else before)
    elif len(remaining) > len(batch):
        next_cursor = _tag_cursor(target.repository_id, batch[-1].tag)
    elif len(targets) > 1:
        next_cursor = _cursor(targets[1].repository_id, None, 1)
    else:
        next_cursor = None
    return ReleaseBackfillRead(
        team_id=team_id,
        environment=payload.environment,
        source=source_for(target.release_source.kind),
        deployments_scanned=done,
        deployments_skipped=skipped,
        releases_created=created,
        releases_updated=updated,
        release_ids=list(dict.fromkeys(release_ids)),
        unreadable_tags=unreadable,
        next_cursor=next_cursor,
        stopped_early=stop is not None,
        stalled=stalled,
        pull_reads_skipped=github.pulls_unread,
        message=stop[0] if stop is not None else None,
        resume_after=stop[1] if stop is not None else None,
        github_calls=budget.calls,
        rate_limit_remaining=budget.remaining,
        rate_limit=budget.limit,
    )
