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

A release moves only the issues it closes. An issue whose pull requests in the
repository name it without a closing keyword, such as `Refs ABC-1`, and none of
which merged with `Fixes`, `Closes` or `Resolves`, is carried as referenced: it
is listed with the release and its status is left alone.
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
from app.common.db.dynamo.github import IssueLink
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

LINKS_READ = 50
"""How many of an issue's newest pull request links decide whether a release closes it."""


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
    _pulls_by_number: dict[int, Any] = field(default_factory=dict)
    _ranges: dict[tuple[str | None, str], list[tuple[str, str]]] = field(default_factory=dict)
    stored_pulls: Callable[[list[int]], Mapping[int, Any]] | None = None
    best_effort_pulls: bool = False
    pulls_unread: int = 0

    def token(self) -> str:
        """An installation token, minted on first use."""
        from app.domains.integrations import github_issues

        if self._token is None:
            self._token = github_issues.installation_token(self.installation_id)
        return self._token

    def commits(self, previous_sha: str | None, sha: str) -> list[tuple[str, str]]:
        """The deployment's commits, with the pull request text their messages lack folded in, read once per range."""
        key = (previous_sha, sha)
        if key not in self._ranges:
            self._ranges[key] = self._read_commits(previous_sha, sha)
        return self._ranges[key]

    def _read_commits(self, previous_sha: str | None, sha: str) -> list[tuple[str, str]]:
        """The deployment's commits from GitHub, with their pull request text."""
        from app.domains.integrations import github_issues

        def read() -> list[tuple[str, str]]:
            """The range from GitHub, or the head commit alone with no start."""
            if previous_sha and previous_sha != sha:
                return github_issues.compare_commits(self.token(), self.repository_id, previous_sha, sha)
            return [github_issues.commit(self.token(), self.repository_id, sha)]

        pairs = _readable(read, [(sha, "")], "commits")
        return self._with_pull_text(pairs)

    def _with_pull_text(self, pairs: list[tuple[str, str]]) -> list[tuple[str, str]]:
        """Each commit's message, plus its pull request's title and branch when the message names no key.

        Pull requests already stored are read from `stored_pulls` first. With
        `best_effort_pulls` set, a read the call budget's deadline refuses ends the
        pull request reads and the remaining messages are kept as they are, counted
        in `pulls_unread`, so the deployment is still recorded.
        """
        from app.domains.integrations import github_budget, github_deployments

        numbers = [_pull_number(message) for _, message in pairs]
        self._remember_stored([number for number in numbers if number is not None])
        reads = 0
        cut = False
        result: list[tuple[str, str]] = []
        for (commit_sha, message), number in zip(pairs, numbers):
            if number is None:
                result.append((commit_sha, message))
                continue
            if number not in self._pulls_by_number:
                if cut or reads >= PULL_READS_MAX:
                    if cut:
                        self.pulls_unread += 1
                    result.append((commit_sha, message))
                    continue
                reads += 1
                wanted: int = number
                try:
                    self._pulls_by_number[number] = _readable(
                        lambda: github_deployments.pull_request(self.token(), self.repository_id, wanted), None, "pull"
                    )
                except github_budget.BudgetSpent as error:
                    if not self.best_effort_pulls or error.reason != github_budget.TIME:
                        raise
                    cut = True
                    self.pulls_unread += 1
                    result.append((commit_sha, message))
                    continue
            pull = self._pulls_by_number[number]
            if pull is None:
                result.append((commit_sha, message))
                continue
            result.append((commit_sha, f"{message}\n{pull.title}\n{pull.head_ref}"))
        return result

    def _remember_stored(self, numbers: list[int]) -> None:
        """Fill the pull request cache from `stored_pulls` for the numbers it does not hold yet."""
        if self.stored_pulls is None:
            return
        missing = [number for number in dict.fromkeys(numbers) if number not in self._pulls_by_number]
        if missing:
            self._pulls_by_number.update(self.stored_pulls(missing))

    def merged_pull(self, sha: str) -> Any:
        """The pull request whose merge commit this is, or `None`, read once per commit."""
        from app.domains.integrations import github_deployments

        if sha not in self._pulls:
            self._pulls[sha] = _readable(
                lambda: github_deployments.merged_pull_for_commit(self.token(), self.repository_id, sha), None, "pulls"
            )
        return self._pulls[sha]

    def previous_success(
        self, environment: str, sha: str, deployment_id: int | None, *, start_page: int = 1
    ) -> str | None:
        """The commit the environment last deployed successfully before this one, or `None`."""
        from app.domains.integrations import github_deployments

        return _readable(
            lambda: github_deployments.previous_successful_sha(
                self.token(), self.repository_id, environment, sha, deployment_id=deployment_id, start_page=start_page
            ),
            None,
            "deployments",
        )


def _pull_number(message: str) -> int | None:
    """The pull request a commit's subject names, when its message names no key to read it for."""
    match = _PULL_NUMBER.search(message.split("\n", 1)[0])
    if match is None or _KEY_LIKE.search(message):
        return None
    return int(match.group(1) or match.group(2))


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


def _in_repository(link: IssueLink, repository_id: str, repository: str) -> bool:
    """Whether a live link is to a pull request of this repository, by id or, on an older row, by name."""
    if link.detached:
        return False
    if link.repository_id:
        return link.repository_id == repository_id
    return link.repository_full_name == repository


def _closed_by_a_merge(links: Sequence[IssueLink], repository_id: str, repository: str) -> bool | None:
    """Whether a merged pull request of this repository closes the issue, or `None` when none links it."""
    mine = [link for link in links if _in_repository(link, repository_id, repository)]
    if not mine:
        return None
    return any(link.magic_word and link.pr_state == "merged" for link in mine)


def referenced_only(
    repositories: Repositories, workspace_id: str, repository_id: str, repository: str, issue_ids: Sequence[str]
) -> list[str]:
    """The issues pull requests of this repository only reference, which a release must not move.

    An issue no pull request of the repository links, say one named in a direct
    commit, still counts as closed, as it did before links were read.
    """
    referenced: list[str] = []
    for issue_id in dict.fromkeys(issue_ids):
        page = repositories.github.list_links_for_issue(workspace_id, issue_id, limit=LINKS_READ)
        links = [IssueLink.model_validate(dict(item)) for item in page.items]
        if _closed_by_a_merge(links, repository_id, repository) is False:
            referenced.append(issue_id)
    return referenced


def _with_references(repositories: Repositories, release: Release, repository_id: str, repository: str) -> Release:
    """The release with its referenced issues read afresh from the links, written when they changed."""
    referenced = referenced_only(repositories, release.workspace_id, repository_id, repository, release.issue_ids)
    if referenced == release.referenced_issue_ids:
        return release
    return repositories.releases.replace(release.model_copy(update={"referenced_issue_ids": referenced}))


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
        release = _with_references(repositories, release, repository_id, repository)
        advanced = releases.reach_stage(
            repositories, release, stage, source=SOURCE, environment=environment, url=url, at=at, automate=automate
        )
        covered.update(advanced.issue_ids)
        if known.get(sha) == release.release_id:
            head_release = advanced
    mentioned = releases.issues_from_messages(repositories, workspace_id, team_id, [message for _, message in commits])
    issues: list[Issue] = mentioned if pull is not None else [i for i in mentioned if i.issue_id not in covered]
    referenced = referenced_only(
        repositories, workspace_id, repository_id, repository, [issue.issue_id for issue in issues]
    )
    if head_release is not None:
        if issues:
            return releases.add_issues(repositories, head_release, issues, automate=automate, referenced=referenced)
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
        referenced=referenced,
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


BACKFILL_PAGE_SECONDS = 12.0
"""How long one backfill page may start GitHub calls for, so it answers well inside the 29 second API timeout."""

BACKFILL_FIRST_SECONDS = 16.0
"""How long a page may keep starting GitHub calls while it has recorded or skipped no deployment yet.

Every call is cut off by the GitHub client's timeout, so the last one a page starts
still answers inside the 29 second API timeout, and the first deployment of a
page has room to finish however long the deployment list took.
"""

BACKFILL_SCAN_PER_DEPLOYMENT = 3
"""How many deployments' statuses one page reads per deployment it asks for, so failed ones cannot stall it."""

STORED_PULLS_BATCH = 100
"""How many stored pull requests one batch read asks for."""


def _recorded_at_stage(
    repositories: Repositories, workspace_id: str, team_id: str, repository_id: str, sha: str, stage_id: str
) -> bool:
    """Whether this commit's release already reached the stage, so a backfill has nothing to read for it."""
    release_id = repositories.releases.release_for_sha(workspace_id, team_id, repository_id, sha)
    if release_id is None:
        return False
    release = repositories.releases.get(workspace_id, team_id, release_id)
    return release is not None and any(reached.stage_id == stage_id for reached in release.stages)


def _stored_pulls(
    repositories: Repositories, workspace_id: str, repository_id: str
) -> Callable[[list[int]], dict[int, Any]]:
    """Pull request titles and branches as GitHub deliveries stored them, so a backfill need not read them again."""
    from app.domains.integrations.github_deployments import PullRef

    def read(numbers: list[int]) -> dict[int, Any]:
        """The stored pull requests among these numbers, by number."""
        found: dict[int, Any] = {}
        for start in range(0, len(numbers), STORED_PULLS_BATCH):
            keys = [(repository_id, number) for number in numbers[start : start + STORED_PULLS_BATCH]]
            for state in repositories.github.get_pr_states(workspace_id, keys):
                if not (state.title or state.head_ref):
                    continue
                found[state.pr_number] = PullRef(
                    number=state.pr_number,
                    title=state.title,
                    head_ref=state.head_ref,
                    url=state.url if state.url.startswith("https://") else None,
                )
        return found

    return read


def _stopped(error: Exception, budget: Any) -> tuple[str, datetime | None]:
    """Why a backfill page stopped early, said so a caller knows when to pass the cursor back."""
    from webbpulse.integrations.github import GitHubRateLimited

    from app.domains.integrations import github_budget

    reset = budget.reset_at
    when = reset.strftime("%Y-%m-%d %H:%M UTC") if reset is not None else "the top of the hour"
    left = f"{budget.remaining} of {budget.limit}" if budget.remaining is not None and budget.limit else "too few"
    if isinstance(error, github_budget.BudgetSpent) and error.reason == github_budget.RATE:
        return (
            f"Stopped early to keep the GitHub App's API budget for live sync: {left} calls left this hour. "
            f"Pass next_cursor back after {when}, when the budget resets.",
            reset,
        )
    if isinstance(error, github_budget.BudgetSpent):
        return "Stopped early to answer inside the request timeout. Pass next_cursor back to continue.", None
    if isinstance(error, GitHubRateLimited):
        return f"GitHub rate limited the App. Pass next_cursor back after {when}, when the budget resets.", reset
    return "GitHub did not answer. Pass next_cursor back in a few minutes to continue.", None


def _stalled(error: Exception, budget: Any, deployment_id: int | None) -> tuple[str, datetime | None]:
    """Why a backfill page recorded and skipped nothing, naming the deployment it could not reach."""
    from app.domains.integrations import github_budget

    where = f"deployment {deployment_id}" if deployment_id is not None else "the deployment list"
    if isinstance(error, github_budget.BudgetSpent) and error.reason == github_budget.TIME:
        return (
            f"Made no progress: reading {where} did not finish inside the request timeout. "
            "Passing next_cursor back unchanged repeats this; pass it with a smaller limit.",
            None,
        )
    message, reset = _stopped(error, budget)
    return f"Made no progress before {where}. {message}", reset


def backfill(
    repositories: Repositories, workspace_id: str, team_id: str, payload: ReleaseBackfill
) -> ReleaseBackfillRead:
    """Rebuild one batch of a team's releases from an environment's past successful deployments.

    Works newest first, each deployment's range starting at the next older
    successful one, through the same path a live deployment takes, so a commit
    that already has a release only gains issues. It never moves issues, never
    publishes, and sets a repository's stage head only when it has none.

    The GitHub App's hourly budget is shared with live sync, so a page stops
    before any call that would leave less than half of it, or that would start
    after `BACKFILL_PAGE_SECONDS`, and answers a cursor at the first deployment
    it did not record. A deployment whose release already reached the stage
    costs no GitHub call, and pull requests the deliveries stored are not read
    again.

    So that every page moves the cursor, the first deployment a page reads may
    start calls until `BACKFILL_FIRST_SECONDS`, and its pull request reads stop
    there rather than the page: it is recorded with the pull request text read
    so far. When even its range cannot be read in that time it is passed over
    and named in `unreadable_deployment_ids`; a later backfill without a cursor
    reads it again. A page that still records and skips nothing, for the rate
    budget or an outage, sets `stalled` and says so in its message.
    """
    from webbpulse.integrations.github import GitHubRateLimited, GitHubUnavailable

    from app.domains.integrations import github_budget, github_deployments

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
    unreadable: list[int] = []
    found: Any = None
    batch: list[Any] = []
    scan = min(github_deployments.DEPLOYMENTS_SCANNED, (payload.limit + 1) * BACKFILL_SCAN_PER_DEPLOYMENT)
    stop: tuple[str, datetime | None] | None = None
    stalled = False

    with github_budget.capped(BACKFILL_PAGE_SECONDS) as budget:
        try:
            budget.until(BACKFILL_FIRST_SECONDS)
            found = _readable(
                lambda: github_deployments.successful_deployments(
                    github.token(),
                    target.repository_id,
                    payload.environment,
                    before_id=before_id,
                    count=payload.limit + 1,
                    scan=scan,
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
                    repositories.releases.set_head(
                        workspace_id, team_id, target.repository_id, stage.stage_id, batch[0].sha
                    )
            for index, deployment in enumerate(batch):
                if _recorded_at_stage(
                    repositories, workspace_id, team_id, target.repository_id, deployment.sha, stage.stage_id
                ):
                    skipped += 1
                    done += 1
                    continue
                first = done == 0
                budget.until(BACKFILL_FIRST_SECONDS if first else BACKFILL_PAGE_SECONDS)
                github.best_effort_pulls = first
                try:
                    older = [row.sha for row in found.deployments[index + 1 :] if row.sha != deployment.sha]
                    if older:
                        previous: str | None = older[0]
                    else:
                        previous = github.previous_success(
                            payload.environment, deployment.sha, deployment.deployment_id, start_page=start_page
                        )
                    pull = github.merged_pull(deployment.sha)
                    commits = github.commits(previous, deployment.sha)
                except github_budget.BudgetSpent as error:
                    if not first or error.reason != github_budget.TIME:
                        raise
                    unreadable.append(deployment.deployment_id)
                    done += 1
                    _log.warning(
                        "A release backfill passed over a deployment it could not read in time.",
                        extra={
                            "event": "integrations.release_backfill_unreadable",
                            "deployment_id": deployment.deployment_id,
                            "github_calls": budget.calls,
                        },
                    )
                    continue
                had = repositories.releases.release_for_sha(workspace_id, team_id, target.repository_id, deployment.sha)
                release = _record_for_team(
                    repositories,
                    workspace_id,
                    team_id,
                    stage,
                    commits=commits,
                    sha=deployment.sha,
                    previous_sha=previous,
                    repository_id=target.repository_id,
                    repository=target.full_name,
                    environment=payload.environment,
                    url=None,
                    pinned=pinned,
                    pull=pull,
                    at=deployment.created_at,
                    automate=False,
                )
                done += 1
                if release is None:
                    continue
                release_ids.append(release.release_id)
                if had is None:
                    created += 1
                else:
                    updated += 1
        except (github_budget.BudgetSpent, GitHubRateLimited, GitHubUnavailable) as error:
            stalled = done == 0
            waiting = batch[0].deployment_id if batch else None
            stop = _stalled(error, budget, waiting) if stalled else _stopped(error, budget)
            _log.warning(
                "A release backfill page stopped early.",
                extra={
                    "event": f"integrations.release_backfill_{'stalled' if stalled else 'stopped'}",
                    "reason": type(error).__name__,
                    "github_calls": budget.calls,
                    "rate_limit_remaining": budget.remaining,
                },
            )
    if stop is not None:
        before = batch[done - 1].deployment_id if done else before_id
        next_cursor: str | None = _cursor(target.repository_id, before, start_page)
    elif len(found.deployments) > len(batch) or found.more:
        before = batch[-1].deployment_id if batch else before_id
        next_cursor = _cursor(target.repository_id, before, found.page)
    elif len(targets) > 1:
        next_cursor = _cursor(targets[1].repository_id, None, 1)
    else:
        next_cursor = None
    message = stop[0] if stop is not None else None
    if unreadable:
        named = ", ".join(str(deployment_id) for deployment_id in unreadable)
        passed = (
            f"Passed over deployment {named}: its range could not be read inside the request timeout. "
            "A backfill without a cursor reads it again."
        )
        message = f"{passed} {message}" if message else passed
    return ReleaseBackfillRead(
        team_id=team_id,
        environment=payload.environment,
        deployments_scanned=done,
        deployments_skipped=skipped,
        releases_created=created,
        releases_updated=updated,
        release_ids=list(dict.fromkeys(release_ids)),
        next_cursor=next_cursor,
        stopped_early=stop is not None,
        stalled=stalled,
        unreadable_deployment_ids=unreadable,
        pull_reads_skipped=github.pulls_unread,
        message=message,
        resume_after=stop[1] if stop is not None else None,
        github_calls=budget.calls,
        rate_limit_remaining=budget.remaining,
        rate_limit=budget.limit,
    )
