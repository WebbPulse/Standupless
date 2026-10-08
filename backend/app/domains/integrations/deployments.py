"""The GitHub Deployments release source: a successful deployment records what reached a stage.

A `deployment_status` delivery in the `success` state names a repository, an
environment and a commit. Each team whose pipeline maps that environment to a stage
gets the range since the commit the repository last reached that stage at, read
from GitHub, and the team's issue keys in those commits, and in the titles and
branches of the pull requests they came from, are what shipped. The first
deployment of a repository to a stage starts its range at the environment's
previous successful deployment on GitHub.

Commits a team already released, say on staging, are advanced to the new stage
rather than released twice, which is how a promotion moves the staging releases to
production. A deployed commit that is a pull request's merge, such as a promotion
from `promote/2026-10-07-b`, makes a release named from that pull request carrying
every issue of the range. Otherwise only issues no earlier release carried make a
new release. A repository pinned to a team always records, so a deploy with no
keys is still on the record; an unpinned one records only for teams whose keys it
names. A stage set to publish makes the deployment's release a GitHub Release.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Mapping, Sequence, TypeVar

from app.common import issue_keys, releases
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.releases import ReleaseBackfill, ReleaseBackfillRead
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.releases import PipelineStage, Release
from app.common.planning_rules import unprocessable

_log = logging.getLogger(__name__)

SOURCE = releases.GITHUB_DEPLOYMENT

SUCCESS = "success"

PULL_READS_MAX = 30
"""How many pull requests one deployment reads for the keys its commits do not name."""

_PULL_NUMBER = re.compile(r"(?:\(#(\d+)\)\s*$|^Merge pull request #(\d+)\b)")

_KEY_LIKE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]{0,9}-\d+(?![0-9])")

_T = TypeVar("_T")


def _readable(read: Callable[[], _T], fallback: _T, what: str) -> _T:
    """One GitHub read, or the fallback when the App cannot see it.

    A missing App, a missing permission, a repository GitHub no longer shows or a
    value it cannot take is logged and read as the fallback, so the release is
    still recorded. A rate limit or an outage raises, so the record is retried.
    """
    from webbpulse.integrations.github import GitHubForbidden, GitHubNotConfigured, GitHubNotFound

    try:
        return read()
    except (GitHubNotConfigured, GitHubNotFound, GitHubForbidden, ValueError):
        _log.warning(
            "Could not read from GitHub for a deployment.",
            extra={"event": "integrations.deployment_read_unavailable", "read": what},
        )
        return fallback


@dataclass
class _GitHub:
    """The GitHub reads of one repository for one deployment, sharing one installation token."""

    installation_id: str
    repository_id: str
    _token: str | None = None
    _pulls: dict[str, Any] = field(default_factory=dict)

    def token(self) -> str:
        """An installation token, minted on first use."""
        from app.domains.integrations import github_issues

        if self._token is None:
            self._token = github_issues.installation_token(self.installation_id)
        return self._token

    def commits(self, previous_sha: str | None, sha: str) -> list[tuple[str, str]]:
        """The deployment's commits, with the pull request text their messages lack folded in."""
        from app.domains.integrations import github_issues

        def read() -> list[tuple[str, str]]:
            """The range from GitHub, or the head commit alone with no start."""
            if previous_sha and previous_sha != sha:
                return github_issues.compare_commits(self.token(), self.repository_id, previous_sha, sha)
            return [github_issues.commit(self.token(), self.repository_id, sha)]

        pairs = _readable(read, [(sha, "")], "commits")
        return self._with_pull_text(pairs)

    def _with_pull_text(self, pairs: list[tuple[str, str]]) -> list[tuple[str, str]]:
        """Each commit's message, plus its pull request's title and branch when the message names no key."""
        from app.domains.integrations import github_deployments

        reads = 0
        result: list[tuple[str, str]] = []
        for commit_sha, message in pairs:
            subject = message.split("\n", 1)[0]
            match = _PULL_NUMBER.search(subject)
            if match is None or _KEY_LIKE.search(message) or reads >= PULL_READS_MAX:
                result.append((commit_sha, message))
                continue
            reads += 1
            number = int(match.group(1) or match.group(2))
            pull = _readable(
                lambda: github_deployments.pull_request(self.token(), self.repository_id, number), None, "pull"
            )
            if pull is None:
                result.append((commit_sha, message))
                continue
            result.append((commit_sha, f"{message}\n{pull.title}\n{pull.head_ref}"))
        return result

    def merged_pull(self, sha: str) -> Any:
        """The pull request whose merge commit this is, or `None`, read once per commit."""
        from app.domains.integrations import github_deployments

        if sha not in self._pulls:
            self._pulls[sha] = _readable(
                lambda: github_deployments.merged_pull_for_commit(self.token(), self.repository_id, sha), None, "pulls"
            )
        return self._pulls[sha]

    def previous_success(self, environment: str, sha: str, deployment_id: int | None) -> str | None:
        """The commit the environment last deployed successfully before this one, or `None`."""
        from app.domains.integrations import github_deployments

        return _readable(
            lambda: github_deployments.previous_successful_sha(
                self.token(), self.repository_id, environment, sha, deployment_id=deployment_id
            ),
            None,
            "deployments",
        )


def _candidate_teams(repositories: Repositories, workspace_id: str, pinned_team_id: str | None) -> list[str]:
    """The teams a deployment may record a release for: the pinned team, or every team."""
    if pinned_team_id:
        return [pinned_team_id]
    return [team.team_id for team in repositories.teams.list_for_workspace(workspace_id) if team.key_prefix]


def _environment_url(status: Mapping[str, Any]) -> str | None:
    """The link a deployment status offers, the deployed site first, then its log."""
    for name in ("environment_url", "target_url", "log_url"):
        value = status.get(name)
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            return value[:2048]
    return None


def handle_deployment_status(repositories: Repositories, workspace_id: str, body: Mapping[str, Any]) -> None:
    """Record a successful deployment as releases of every team whose pipeline maps its environment."""
    status = body.get("deployment_status")
    deployment = body.get("deployment")
    repository = body.get("repository")
    installation = body.get("installation")
    if not (isinstance(status, Mapping) and isinstance(deployment, Mapping) and isinstance(repository, Mapping)):
        return
    if str(status.get("state", "")).lower() != SUCCESS:
        return
    sha = str(deployment.get("sha") or "").lower()
    environment = str(status.get("environment") or deployment.get("environment") or "").strip()
    repository_id = str(repository.get("id") or "")
    if not sha or not environment or not repository_id:
        return
    stored = repositories.github.get_repository(workspace_id, repository_id)
    if stored is None:
        return
    installation_id = str(installation.get("id", "")) if isinstance(installation, Mapping) else ""
    deployment_id = deployment.get("id") if isinstance(deployment.get("id"), int) else None
    full_name = str(repository.get("full_name") or stored.full_name)
    url = _environment_url(status)
    github = _GitHub(installation_id, repository_id)
    ranges: dict[str | None, list[tuple[str, str]]] = {}
    seeded: list[str | None] = []
    for team_id in _candidate_teams(repositories, workspace_id, stored.team_id):
        pipeline, _ = releases.pipeline_for(repositories, workspace_id, team_id)
        stage = releases.stage_for_environment(pipeline, environment)
        if stage is None:
            continue
        previous = repositories.releases.get_head(workspace_id, team_id, repository_id, stage.stage_id)
        if previous == sha:
            continue
        if previous is None:
            if not seeded:
                seeded.append(github.previous_success(environment, sha, deployment_id))
            previous = seeded[0]
        if previous not in ranges:
            ranges[previous] = github.commits(previous, sha)
        pinned = stored.team_id == team_id
        release = _record_for_team(
            repositories,
            workspace_id,
            team_id,
            stage,
            commits=ranges[previous],
            sha=sha,
            previous_sha=previous,
            repository_id=repository_id,
            repository=full_name,
            environment=environment,
            url=url,
            pinned=pinned,
            pull=github.merged_pull(sha),
        )
        if release is not None and pinned and stage.publish_github_release:
            _publish(repositories, github, release, stage, pipeline.stages)
        repositories.releases.set_head(workspace_id, team_id, repository_id, stage.stage_id, sha)


def _record_for_team(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    stage: PipelineStage,
    *,
    commits: list[tuple[str, str]],
    sha: str,
    previous_sha: str | None,
    repository_id: str,
    repository: str,
    environment: str,
    url: str | None,
    pinned: bool,
    pull: Any = None,
    at: datetime | None = None,
    automate: bool = True,
) -> Release | None:
    """Advance the team's releases of these commits to the stage, and release what none of them carried.

    Answers the release of the deployed commit, or `None` when the deployment
    made none. A deployed pull request merge names its release and carries every
    issue of the range, so a promotion reads as one release in the later stage.
    """
    shas = [*(commit_sha for commit_sha, _ in commits), sha]
    known = repositories.releases.releases_for_shas(workspace_id, team_id, repository_id, shas)
    pairs = [(team_id, release_id) for release_id in set(known.values())]
    earlier = repositories.releases.get_many(workspace_id, pairs)
    covered: set[str] = set()
    head_release: Release | None = None
    for release in earlier:
        advanced = releases.reach_stage(
            repositories, release, stage, source=SOURCE, environment=environment, url=url, at=at, automate=automate
        )
        covered.update(advanced.issue_ids)
        if known.get(sha) == release.release_id:
            head_release = advanced
    mentioned = releases.issues_from_messages(repositories, workspace_id, team_id, [message for _, message in commits])
    issues: list[Issue] = mentioned if pull is not None else [i for i in mentioned if i.issue_id not in covered]
    if head_release is not None:
        if issues:
            return releases.add_issues(repositories, head_release, issues, automate=automate)
        return head_release
    if not issues and not pinned:
        return None
    if not issues and pull is None and earlier:
        return None
    from app.domains.integrations import github_deployments

    release, _ = releases.record_release(
        repositories,
        workspace_id,
        team_id,
        stage=stage,
        source=SOURCE,
        issues=issues,
        name=github_deployments.release_name(pull) if pull is not None else None,
        sha=sha,
        previous_sha=previous_sha,
        repository_id=repository_id,
        repository=repository,
        url=url,
        environment=environment,
        pr_number=pull.number if pull is not None else None,
        pr_url=pull.url if pull is not None else None,
        at=at,
        automate=automate,
    )
    return release


def _notes(repositories: Repositories, release: Release) -> str:
    """The release's deterministic notes, one `KEY title` line per issue in key order."""
    rows = repositories.issues.get_many(release.workspace_id, list(release.issue_ids))
    issues = [rows[issue_id] for issue_id in release.issue_ids if issue_id in rows]
    issues = [issue for issue in issues if issue.team_id == release.team_id]
    current = issue_keys.current_all(repositories.teams, issues)
    ordered = sorted(current, key=lambda issue: (issue.key.rpartition("-")[0], issue.number))
    return releases.notes_for(ordered)


def _publish(
    repositories: Repositories,
    github: _GitHub,
    release: Release,
    stage: PipelineStage,
    stages: Sequence[PipelineStage],
) -> None:
    """Publish the release as a GitHub Release at its commit, tagged with its name, and keep the link.

    A stage before the pipeline's last publishes a pre-release. A refusal is
    logged rather than retried, since the release itself is already recorded; a
    rate limit or an outage raises, so the delivery is retried.
    """
    from webbpulse.integrations.github import GitHubError, GitHubRateLimited, GitHubUnavailable

    from app.domains.integrations import github_deployments

    if not release.sha:
        return
    is_last = bool(stages) and stages[-1].stage_id == stage.stage_id
    try:
        link = github_deployments.publish_release(
            github.token(),
            github.repository_id,
            tag=github_deployments.tag_for(release.name),
            sha=release.sha,
            name=release.name,
            body=_notes(repositories, release),
            prerelease=not is_last,
        )
    except (GitHubRateLimited, GitHubUnavailable):
        raise
    except (GitHubError, ValueError):
        _log.warning(
            "Could not publish a GitHub Release.",
            extra={"event": "integrations.github_release_unavailable"},
        )
        return
    if link and link != release.github_release_url:
        current = repositories.releases.get(release.workspace_id, release.team_id, release.release_id) or release
        repositories.releases.replace(current.model_copy(update={"github_release_url": link}))


def _cursor(repository_id: str, before_id: int | None, page: int) -> str:
    """A backfill cursor: the repository, the deployment to continue before, and the list page hint."""
    return f"{repository_id}:{before_id or ''}:{page}"


def _parse_cursor(cursor: str | None) -> tuple[str | None, int | None, int]:
    """A backfill cursor's parts, or a 422 when it is not one this route minted."""
    if not cursor:
        return None, None, 1
    parts = cursor.split(":")
    if len(parts) != 3 or not parts[0].isdigit() or not (parts[1] == "" or parts[1].isdigit()):
        raise unprocessable("Invalid backfill cursor")
    if not parts[2].isdigit() or int(parts[2]) < 1:
        raise unprocessable("Invalid backfill cursor")
    return parts[0], int(parts[1]) if parts[1] else None, int(parts[2])


def _backfill_repositories(
    repositories: Repositories, workspace_id: str, team_id: str, reference: str | None
) -> list[Any]:
    """The repositories a backfill reads: the one named by id or full name, else the team's pinned ones."""
    rows = repositories.github.list_repositories(workspace_id)
    if reference:
        folded = reference.casefold()
        named = [row for row in rows if row.repository_id == reference or row.full_name.casefold() == folded]
        if not named:
            raise unprocessable(f"No such repository: {reference}")
        return named
    pinned = sorted((row for row in rows if row.team_id == team_id), key=lambda row: int(row.repository_id))
    if not pinned:
        raise unprocessable("This team has no pinned repository; name one to backfill from")
    return pinned


def backfill(
    repositories: Repositories, workspace_id: str, team_id: str, payload: ReleaseBackfill
) -> ReleaseBackfillRead:
    """Rebuild one batch of a team's releases from an environment's past successful deployments.

    Works newest first, each deployment's range starting at the next older
    successful one, through the same path a live deployment takes, so a commit
    that already has a release only gains issues. It never moves issues, never
    publishes, and sets a repository's stage head only when it has none.
    """
    pipeline, _ = releases.pipeline_for(repositories, workspace_id, team_id)
    stage = releases.stage_for_environment(pipeline, payload.environment)
    if stage is None:
        raise unprocessable(f"No release stage of this team maps the GitHub environment {payload.environment}")
    targets = _backfill_repositories(repositories, workspace_id, team_id, payload.repository)
    cursor_repository, before_id, start_page = _parse_cursor(payload.cursor)
    if cursor_repository is not None:
        ids = [row.repository_id for row in targets]
        if cursor_repository not in ids:
            raise unprocessable("Invalid backfill cursor")
        targets = targets[ids.index(cursor_repository) :]
    installation = repositories.github.get_installation(workspace_id)
    target = targets[0]
    installation_id = str(target.installation_id or (installation.installation_id if installation else ""))
    github = _GitHub(installation_id, target.repository_id)
    created = 0
    updated = 0
    release_ids: list[str] = []

    from app.domains.integrations import github_deployments

    found = _readable(
        lambda: github_deployments.successful_deployments(
            github.token(),
            target.repository_id,
            payload.environment,
            before_id=before_id,
            count=payload.limit + 1,
            start_page=start_page,
        ),
        None,
        "deployments",
    )
    if found is None:
        raise unprocessable("GitHub would not list this repository's deployments; check the App's permissions")
    batch = found.deployments[: payload.limit]
    pinned = target.team_id == team_id
    if before_id is None and batch:
        if repositories.releases.get_head(workspace_id, team_id, target.repository_id, stage.stage_id) is None:
            repositories.releases.set_head(workspace_id, team_id, target.repository_id, stage.stage_id, batch[0].sha)
    for index, deployment in enumerate(batch):
        older = [row.sha for row in found.deployments[index + 1 :] if row.sha != deployment.sha]
        if older:
            previous: str | None = older[0]
        else:
            previous = github.previous_success(payload.environment, deployment.sha, deployment.deployment_id)
        had = repositories.releases.release_for_sha(workspace_id, team_id, target.repository_id, deployment.sha)
        release = _record_for_team(
            repositories,
            workspace_id,
            team_id,
            stage,
            commits=github.commits(previous, deployment.sha),
            sha=deployment.sha,
            previous_sha=previous,
            repository_id=target.repository_id,
            repository=target.full_name,
            environment=payload.environment,
            url=None,
            pinned=pinned,
            pull=github.merged_pull(deployment.sha),
            at=deployment.created_at,
            automate=False,
        )
        if release is None:
            continue
        release_ids.append(release.release_id)
        if had is None:
            created += 1
        else:
            updated += 1
    remaining = len(found.deployments) > len(batch) or found.more
    if remaining:
        before = batch[-1].deployment_id if batch else before_id
        next_cursor: str | None = _cursor(target.repository_id, before, found.page)
    elif len(targets) > 1:
        next_cursor = _cursor(targets[1].repository_id, None, 1)
    else:
        next_cursor = None
    return ReleaseBackfillRead(
        team_id=team_id,
        environment=payload.environment,
        deployments_scanned=len(batch),
        releases_created=created,
        releases_updated=updated,
        release_ids=list(dict.fromkeys(release_ids)),
        next_cursor=next_cursor,
    )
