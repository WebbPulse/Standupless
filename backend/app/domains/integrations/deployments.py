"""The GitHub Deployments release source: a successful deployment records what reached a stage.

A `deployment_status` delivery in the `success` state names a repository, an
environment and a commit. Each team whose pipeline maps that environment to a stage
gets the range since the commit the repository last reached that stage at, read
from GitHub, and the team's issue keys in those commits are what shipped.

Commits a team already released, say on staging, are advanced to the new stage
rather than released twice, which is how a promotion moves the staging releases to
production. Only issues no earlier release carried make a new release. A
repository pinned to a team always records, so a deploy with no keys is still on
the record; an unpinned one records only for teams whose keys it names.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from app.common import releases
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.releases import PipelineStage, Release

_log = logging.getLogger(__name__)

SOURCE = "github_deployment"

SUCCESS = "success"


def _commits(
    installation_id: str, repository_id: str, previous_sha: str | None, sha: str
) -> list[tuple[str, str]]:
    """The deployment's commits from GitHub, or only its head commit when unreadable.

    A missing App, a repository GitHub no longer shows or a range GitHub cannot
    compare is logged and read as the head commit alone, so the release is still
    recorded. A rate limit or an outage raises, so the record is retried.
    """
    from webbpulse.integrations.github import GitHubForbidden, GitHubNotConfigured, GitHubNotFound

    from app.domains.integrations import github_issues

    try:
        token = github_issues.installation_token(installation_id)
        if previous_sha and previous_sha != sha:
            return github_issues.compare_commits(token, repository_id, previous_sha, sha)
        return [github_issues.commit(token, repository_id, sha)]
    except (GitHubNotConfigured, GitHubNotFound, GitHubForbidden, ValueError):
        _log.warning(
            "Could not read a deployment's commits.",
            extra={"event": "integrations.deployment_commits_unavailable"},
        )
        return [(sha, "")]


def _candidate_teams(
    repositories: Repositories, workspace_id: str, pinned_team_id: str | None
) -> list[str]:
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
    full_name = str(repository.get("full_name") or stored.full_name)
    url = _environment_url(status)
    ranges: dict[str | None, list[tuple[str, str]]] = {}
    for team_id in _candidate_teams(repositories, workspace_id, stored.team_id):
        pipeline, _ = releases.pipeline_for(repositories, workspace_id, team_id)
        stage = releases.stage_for_environment(pipeline, environment)
        if stage is None:
            continue
        previous = repositories.releases.get_head(workspace_id, team_id, repository_id, stage.stage_id)
        if previous == sha:
            continue
        if previous not in ranges:
            ranges[previous] = _commits(installation_id, repository_id, previous, sha)
        _record_for_team(
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
            pinned=stored.team_id == team_id,
        )
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
) -> None:
    """Advance the team's releases of these commits to the stage, and release what none of them carried."""
    shas = [*(commit_sha for commit_sha, _ in commits), sha]
    known = repositories.releases.releases_for_shas(workspace_id, team_id, repository_id, shas)
    earlier = repositories.releases.get_many(workspace_id, [(team_id, release_id) for release_id in set(known.values())])
    covered: set[str] = set()
    head_release: Release | None = None
    for release in earlier:
        advanced = releases.reach_stage(
            repositories, release, stage, source=SOURCE, environment=environment, url=url
        )
        covered.update(advanced.issue_ids)
        if known.get(sha) == release.release_id:
            head_release = advanced
    mentioned = releases.issues_from_messages(repositories, workspace_id, team_id, [message for _, message in commits])
    fresh: list[Issue] = [issue for issue in mentioned if issue.issue_id not in covered]
    if head_release is not None:
        if fresh:
            releases.add_issues(repositories, head_release, fresh)
        return
    if not fresh and (earlier or not pinned):
        return
    releases.record_release(
        repositories,
        workspace_id,
        team_id,
        stage=stage,
        source=SOURCE,
        issues=fresh,
        sha=sha,
        previous_sha=previous_sha,
        repository_id=repository_id,
        repository=repository,
        url=url,
        environment=environment,
    )
