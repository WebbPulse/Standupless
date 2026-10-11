"""The GitHub Deployments release source, with GitHub's commit reads stood in for.

These hold that a successful deployment records the issues its commits name as a
release at the stage its environment maps to, that the next deployment reads only
the range since the last one, that a promotion advances the staging release rather
than making another, and that a redelivery or a failed deployment changes nothing.
They also hold that a promotion pull request names its release, that a first
deployment seeds its range from GitHub, that a stage can publish a GitHub Release,
and that a backfill rebuilds history without moving issues and moves its cursor
even past a deployment too slow for one page. Driven through the
github-events consumer, under that function's own grant, a deployment records its
release, moves its issues, publishes, and is listed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import pytest

from app.common.api.schemas.releases import ReleaseBackfill
from app.common.db.dynamo.github import IssueLink, link_key
from app.common.db.dynamo.releases import PipelineStage, ReleasePipeline, pipeline_key
from app.domains.integrations.deployments import backfill, handle_deployment_status
from app.domains.integrations.github_deployments import DeploymentPage, DeploymentRef, PullRef
from tests.domains.integrations.conftest import (
    OTHER_TEAM,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    TEAM,
    WORKSPACE,
    seed_issue,
)

FIRST = "1" * 40

SECOND = "2" * 40

THIRD = "3" * 40


@dataclass
class FakeGitHub:
    """What the stood-in commit reads answer, and the calls they took."""

    messages: dict[str, str] = field(default_factory=dict)
    compares: list[tuple[str, str]] = field(default_factory=list)
    heads: list[str] = field(default_factory=list)
    merges: dict[str, PullRef] = field(default_factory=dict)
    pulls: dict[int, PullRef] = field(default_factory=dict)
    previous: str | None = None
    deployments: list[DeploymentRef] = field(default_factory=list)
    published: list[dict[str, Any]] = field(default_factory=list)


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch) -> FakeGitHub:
    """Stand in for the installation token, the commit reads, and the deployment and pull request reads."""
    from app.domains.integrations import github_deployments, github_issues

    state = FakeGitHub()

    def compare(token: str, repository_id: Any, base: str, head: str) -> list[tuple[str, str]]:
        """Every known commit after the base, in order."""
        state.compares.append((base, head))
        shas = list(state.messages)
        start = shas.index(base) + 1 if base in shas else 0
        return [(sha, state.messages[sha]) for sha in shas[start : shas.index(head) + 1]]

    def one(token: str, repository_id: Any, sha: str) -> tuple[str, str]:
        """One commit's message."""
        state.heads.append(sha)
        return sha, state.messages.get(sha, "")

    monkeypatch.setattr(github_issues, "installation_token", lambda installation_id: "token")
    monkeypatch.setattr(github_issues, "compare_commits", compare)
    monkeypatch.setattr(github_issues, "commit", one)

    def deployments(token: str, repository_id: Any, environment: str, **options: Any) -> DeploymentPage:
        """The stood-in successful deployments older than `before_id`, up to `count`."""
        before = options.get("before_id")
        older = [row for row in state.deployments if before is None or row.deployment_id < before]
        return DeploymentPage(older[: options["count"]], len(older) > options["count"], 1)

    def publish(token: str, repository_id: Any, **fields: Any) -> str:
        """Record the publish and answer the Release's link."""
        state.published.append(fields)
        return f"https://github.com/acme/app/releases/tag/{fields['tag']}"

    monkeypatch.setattr(github_deployments, "merged_pull_for_commit", lambda token, repo, sha: state.merges.get(sha))
    monkeypatch.setattr(github_deployments, "pull_request", lambda token, repo, number: state.pulls.get(number))
    monkeypatch.setattr(github_deployments, "previous_successful_sha", lambda *args, **kwargs: state.previous)
    monkeypatch.setattr(github_deployments, "successful_deployments", deployments)
    monkeypatch.setattr(github_deployments, "publish_release", publish)
    return state


def _delivery(sha: str, environment: str = "production", state: str = "success") -> dict[str, Any]:
    """A `deployment_status` delivery as GitHub sends it, trimmed to what the source reads."""
    return {
        "action": "created",
        "deployment_status": {
            "state": state,
            "environment": environment,
            "environment_url": "https://app.example.test",
        },
        "deployment": {"sha": sha, "environment": environment},
        "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
        "installation": {"id": 44551122},
    }


def _releases(repositories: Any, team_id: str = TEAM) -> list[Any]:
    """Every release of a team, newest first."""
    return repositories.releases.list_for_team(WORKSPACE, team_id, limit=50)[0]


def _pin(repositories: Any) -> None:
    """Pin the installed repository to the home team."""
    stored = repositories.github.get_repository(WORKSPACE, REPOSITORY_ID)
    repositories.github.put_repository(stored.model_copy(update={"team_id": TEAM}))


def _staging_then_production(repositories: Any) -> None:
    """Give the home team a Staging stage before Production."""
    repositories.releases.put_pipeline(
        ReleasePipeline(
            workspace_id=WORKSPACE,
            planning_key=pipeline_key(TEAM),
            team_id=TEAM,
            stages=[
                PipelineStage(stage_id="staging", name="Staging", github_environments=["staging"]),
                PipelineStage(stage_id="production", name="Production", github_environments=["production"]),
            ],
        )
    )


def test_a_first_deployment_releases_the_issues_its_head_commit_names(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """With no earlier deployment only the head commit is read, and only teams it names record."""
    issue = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    github.messages = {FIRST: "Fix login (ABC-1)"}

    handle_deployment_status(repositories, WORKSPACE, _delivery(FIRST))

    [release] = _releases(repositories)
    assert release.issue_ids == [issue.issue_id]
    assert release.source == "github_deployment"
    assert release.repository == REPOSITORY_FULL_NAME
    assert release.stages[0].stage_id == "production"
    assert release.stages[0].url == "https://app.example.test"
    assert github.heads == [FIRST]
    assert _releases(repositories, OTHER_TEAM) == []


def test_the_next_deployment_reads_the_range_since_the_last(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """The second deployment compares from the first, and a redelivery changes nothing."""
    seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    second = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS3", "ABC", 2)
    github.messages = {FIRST: "ABC-1", SECOND: "Refs abc-2"}

    handle_deployment_status(repositories, WORKSPACE, _delivery(FIRST))
    handle_deployment_status(repositories, WORKSPACE, _delivery(SECOND))
    handle_deployment_status(repositories, WORKSPACE, _delivery(SECOND))

    newest, oldest = _releases(repositories)
    assert newest.issue_ids == [second.issue_id]
    assert newest.previous_sha == FIRST
    assert github.compares == [(FIRST, SECOND)]


def test_a_promotion_advances_the_staging_release(repositories: Any, installed: str, github: FakeGitHub) -> None:
    """Deploying the staged commit to production moves its release on instead of making another."""
    _staging_then_production(repositories)
    seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    github.messages = {FIRST: "ABC-1"}

    handle_deployment_status(repositories, WORKSPACE, _delivery(FIRST, "staging"))
    handle_deployment_status(repositories, WORKSPACE, _delivery(FIRST, "production"))

    [release] = _releases(repositories)
    assert [stage.stage_id for stage in release.stages] == ["staging", "production"]


def test_a_pinned_repository_records_a_deploy_with_no_keys(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """A repository a team owns keeps a record of every deploy, keys or not."""
    _pin(repositories)
    github.messages = {FIRST: "Bump dependencies"}

    handle_deployment_status(repositories, WORKSPACE, _delivery(FIRST))

    [release] = _releases(repositories)
    assert release.issue_ids == []
    assert release.sha == FIRST


@pytest.mark.parametrize(
    ("environment", "state"),
    [("production", "failure"), ("production", "in_progress"), ("preview", "success")],
)
def test_failed_and_unmapped_deployments_record_nothing(
    repositories: Any, installed: str, github: FakeGitHub, environment: str, state: str
) -> None:
    """Only a success to an environment the pipeline maps is a release."""
    _pin(repositories)
    github.messages = {FIRST: "ABC-1"}

    handle_deployment_status(repositories, WORKSPACE, _delivery(FIRST, environment, state))

    assert _releases(repositories) == []


PROMOTION = PullRef(
    number=230,
    title="Promote staging to main",
    head_ref="promote/2026-10-07-b",
    url="https://github.com/acme/app/pull/230",
)


def test_a_promotion_merge_names_its_release_and_carries_the_range(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """A deployed promotion merge is one release named from its branch, with every issue it shipped."""
    _pin(repositories)
    first = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    second = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS3", "ABC", 2)
    github.messages = {
        FIRST: "ABC-1: Fix login (#228)",
        SECOND: "ABC-2: Add export (#229)",
        THIRD: "Merge pull request #230",
    }
    github.previous = FIRST
    github.merges = {THIRD: PROMOTION}

    handle_deployment_status(repositories, WORKSPACE, _delivery(THIRD))

    [release] = _releases(repositories)
    assert release.name == "2026-10-07-b"
    assert release.pr_number == 230
    assert release.pr_url == PROMOTION.url
    assert release.previous_sha == FIRST
    assert github.compares == [(FIRST, THIRD)]
    assert set(release.issue_ids) == {second.issue_id}
    assert first.issue_id not in release.issue_ids


def test_a_reused_promotion_branch_gets_the_next_letter(repositories: Any, installed: str, github: FakeGitHub) -> None:
    """A second promotion from a reused branch name is the next letter; a redelivery keeps its name."""
    _pin(repositories)
    github.messages = {SECOND: "Merge pull request #230", THIRD: "Merge pull request #231"}
    github.merges = {
        SECOND: PROMOTION,
        THIRD: PullRef(number=231, title="Promote", head_ref=PROMOTION.head_ref, url=None),
    }

    handle_deployment_status(repositories, WORKSPACE, _delivery(SECOND))
    handle_deployment_status(repositories, WORKSPACE, _delivery(THIRD))
    handle_deployment_status(repositories, WORKSPACE, _delivery(THIRD))

    newest, oldest = _releases(repositories)
    assert oldest.name == "2026-10-07-b"
    assert newest.name == "2026-10-07-c"
    assert newest.pr_number == 231


def test_keys_come_from_pull_request_titles_and_branches(repositories: Any, installed: str, github: FakeGitHub) -> None:
    """A squash commit whose message names no key is read through its pull request's title and branch."""
    issue = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    github.messages = {FIRST: "Fix login (#12)"}
    github.pulls = {12: PullRef(number=12, title="Fix login", head_ref="abc-1-fix-login", url=None)}

    handle_deployment_status(repositories, WORKSPACE, _delivery(FIRST))

    [release] = _releases(repositories)
    assert release.issue_ids == [issue.issue_id]


def test_a_first_deployment_seeds_its_range_from_the_last_success(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """With no head yet, the range starts at the environment's previous successful deployment."""
    seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    second = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS3", "ABC", 2)
    github.messages = {FIRST: "ABC-1", SECOND: "ABC-2"}
    github.previous = FIRST

    handle_deployment_status(repositories, WORKSPACE, _delivery(SECOND))

    [release] = _releases(repositories)
    assert github.compares == [(FIRST, SECOND)]
    assert release.issue_ids == [second.issue_id]
    assert release.previous_sha == FIRST


def test_a_publishing_stage_makes_a_github_release(repositories: Any, installed: str, github: FakeGitHub) -> None:
    """A pinned repository's deployment to a publishing stage publishes the notes and keeps the link."""
    _pin(repositories)
    repositories.releases.put_pipeline(
        ReleasePipeline(
            workspace_id=WORKSPACE,
            planning_key=pipeline_key(TEAM),
            team_id=TEAM,
            stages=[
                PipelineStage(
                    stage_id="staging", name="Staging", github_environments=["staging"], publish_github_release=True
                ),
                PipelineStage(
                    stage_id="production",
                    name="Production",
                    github_environments=["production"],
                    publish_github_release=True,
                ),
            ],
        )
    )
    seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    github.messages = {THIRD: "Merge pull request #230 from acme/promote/2026-10-07-b\n\nABC-1"}
    github.merges = {THIRD: PROMOTION}

    handle_deployment_status(repositories, WORKSPACE, _delivery(THIRD, "staging"))
    handle_deployment_status(repositories, WORKSPACE, _delivery(THIRD, "production"))

    assert [call["tag"] for call in github.published] == ["2026-10-07-b", "2026-10-07-b"]
    assert [call["prerelease"] for call in github.published] == [True, False]
    assert github.published[0]["sha"] == THIRD
    assert "ABC-1 An issue" in github.published[0]["body"]
    [release] = _releases(repositories)
    assert release.github_release_url == "https://github.com/acme/app/releases/tag/2026-10-07-b"


def test_a_stage_that_does_not_publish_makes_no_github_release(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """Publishing is opt in per stage."""
    _pin(repositories)
    github.messages = {FIRST: "Bump dependencies"}

    handle_deployment_status(repositories, WORKSPACE, _delivery(FIRST))

    assert github.published == []


def _at(day: int) -> datetime:
    """A deployment time in October 2026."""
    return datetime(2026, 10, day, 12, tzinfo=timezone.utc)


def test_a_backfill_rebuilds_history_without_moving_issues(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """Past deployments become dated releases, newest first, through a cursor, and no issue changes status."""
    _pin(repositories)
    first = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    second = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS3", "ABC", 2)
    done = next(row for row in repositories.team_config.list_statuses(WORKSPACE, TEAM) if row.category == "completed")
    pipeline = ReleasePipeline(
        workspace_id=WORKSPACE,
        planning_key=pipeline_key(TEAM),
        team_id=TEAM,
        stages=[
            PipelineStage(
                stage_id="production",
                name="Production",
                github_environments=["production"],
                status_id=done.status_id,
                publish_github_release=True,
            )
        ],
    )
    repositories.releases.put_pipeline(pipeline)
    github.messages = {FIRST: "ABC-1", SECOND: "ABC-2", THIRD: "Merge pull request #230"}
    github.merges = {THIRD: PROMOTION}
    github.deployments = [
        DeploymentRef(deployment_id=30, sha=THIRD, created_at=_at(7)),
        DeploymentRef(deployment_id=20, sha=SECOND, created_at=_at(5)),
        DeploymentRef(deployment_id=10, sha=FIRST, created_at=_at(3)),
    ]

    page = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=2))
    assert page.deployments_scanned == 2
    assert page.releases_created == 2
    assert page.next_cursor == f"{REPOSITORY_ID}:20:1"
    rest = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=2, cursor=page.next_cursor))
    assert rest.releases_created == 1
    assert rest.next_cursor is None

    newest, middle, oldest = _releases(repositories)
    assert newest.name == "2026-10-07-b"
    assert newest.created_at == _at(7)
    assert newest.stages[0].reached_at == _at(7)
    assert middle.issue_ids == [second.issue_id]
    assert oldest.issue_ids == [first.issue_id]
    assert oldest.created_at == _at(3)
    assert repositories.releases.get_head(WORKSPACE, TEAM, REPOSITORY_ID, "production") == THIRD
    assert github.published == []
    for issue in (first, second):
        assert repositories.issues.get(WORKSPACE, issue.issue_id).status_id == issue.status_id


def test_a_backfill_refuses_an_unmapped_environment_and_a_bad_cursor(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """Only an environment the pipeline maps backfills, and only through a cursor the route minted."""
    from fastapi import HTTPException

    _pin(repositories)
    with pytest.raises(HTTPException) as unmapped:
        backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(environment="preview"))
    assert unmapped.value.status_code == 422
    with pytest.raises(HTTPException) as bad:
        backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(cursor="nope"))
    assert bad.value.status_code == 422


def _three_deployments(repositories: Any, github: FakeGitHub) -> None:
    """A pinned repository with a Production stage and three past deployments, two naming ABC-1 and ABC-2."""
    _pin(repositories)
    seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS3", "ABC", 2)
    repositories.releases.put_pipeline(
        ReleasePipeline(
            workspace_id=WORKSPACE,
            planning_key=pipeline_key(TEAM),
            team_id=TEAM,
            stages=[PipelineStage(stage_id="production", name="Production", github_environments=["production"])],
        )
    )
    github.messages = {FIRST: "ABC-1", SECOND: "ABC-2", THIRD: "Bump dependencies"}
    github.deployments = [
        DeploymentRef(deployment_id=30, sha=THIRD, created_at=_at(7)),
        DeploymentRef(deployment_id=20, sha=SECOND, created_at=_at(5)),
        DeploymentRef(deployment_id=10, sha=FIRST, created_at=_at(3)),
    ]


def test_a_backfill_skips_recorded_deployments_without_reading_github(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """A second pass over deployments whose releases reached the stage reads no commits or pull requests."""
    _three_deployments(repositories, github)
    first = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=5))
    assert first.releases_created == 3
    reads = (len(github.compares), len(github.heads))

    again = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=5))

    assert again.deployments_scanned == 3
    assert again.deployments_skipped == 3
    assert again.releases_created == 0
    assert (len(github.compares), len(github.heads)) == reads
    assert again.stopped_early is False


def _low_after_first_compare(monkeypatch: pytest.MonkeyPatch, github: FakeGitHub) -> None:
    """Make the stood-in compare go through the budget and report the installation low after its first answer."""
    from app.domains.integrations import github_budget, github_issues

    def compare(token: str, repository_id: Any, base: str, head: str) -> list[tuple[str, str]]:
        """Check the budget, answer the range, and report 2000 of 5000 calls left."""
        github_budget.before_call()
        github.compares.append((base, head))
        github_budget.after_call(
            {"x-ratelimit-limit": "5000", "x-ratelimit-remaining": "2000", "x-ratelimit-reset": "1791000000"}
        )
        shas = list(github.messages)
        start = shas.index(base) + 1 if base in shas else 0
        return [(sha, github.messages[sha]) for sha in shas[start : shas.index(head) + 1]]

    monkeypatch.setattr(github_issues, "compare_commits", compare)


def test_a_backfill_stops_early_to_keep_half_the_budget_for_live_sync(
    repositories: Any, installed: str, github: FakeGitHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Below half the installation budget a page stops, keeps what it recorded, and says when to resume."""
    _three_deployments(repositories, github)
    _low_after_first_compare(monkeypatch, github)

    page = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=3))

    assert page.stopped_early is True
    assert page.deployments_scanned == 1
    assert page.releases_created == 1
    assert page.next_cursor == f"{REPOSITORY_ID}:30:1"
    assert page.rate_limit_remaining == 2000
    assert page.rate_limit == 5000
    assert page.resume_after == datetime.fromtimestamp(1_791_000_000, tz=timezone.utc)
    assert page.message is not None and "2000 of 5000" in page.message
    assert len(github.compares) == 1


def test_a_stopped_backfill_resumes_from_its_cursor(
    repositories: Any, installed: str, github: FakeGitHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Passing the cursor back after the reset records the deployments the stopped page did not reach."""
    _three_deployments(repositories, github)
    _low_after_first_compare(monkeypatch, github)
    page = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=3))
    from app.domains.integrations import github_issues

    def plain(token: str, repository_id: Any, base: str, head: str) -> list[tuple[str, str]]:
        """The range with a full budget behind it."""
        github.compares.append((base, head))
        shas = list(github.messages)
        return [(sha, github.messages[sha]) for sha in shas[shas.index(base) + 1 : shas.index(head) + 1]]

    monkeypatch.setattr(github_issues, "compare_commits", plain)

    rest = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=3, cursor=page.next_cursor))

    assert rest.stopped_early is False
    assert rest.releases_created == 2
    assert rest.next_cursor is None
    assert len(_releases(repositories)) == 3


def test_a_rate_limited_backfill_answers_a_cursor_rather_than_failing(
    repositories: Any, installed: str, github: FakeGitHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A rate limit GitHub enforces stops the page with the cursor it started from and a message."""
    from webbpulse.integrations.github import GitHubRateLimited

    from app.domains.integrations import github_issues

    _three_deployments(repositories, github)

    def limited(token: str, repository_id: Any, base: str, head: str) -> list[tuple[str, str]]:
        """Refuse as GitHub does once the installation is out of calls."""
        raise GitHubRateLimited("GET compare answered 403")

    monkeypatch.setattr(github_issues, "compare_commits", limited)

    page = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=3))

    assert page.stopped_early is True
    assert page.deployments_scanned == 0
    assert page.next_cursor == f"{REPOSITORY_ID}::1"
    assert page.stalled is True
    assert page.message is not None and "rate limited" in page.message
    assert page.message.startswith("Made no progress before deployment 30.")


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """A stood-in monotonic clock for the call budget, which the stood-in GitHub reads move forward."""
    from types import SimpleNamespace

    from app.domains.integrations import github_budget

    now = [1000.0]
    monkeypatch.setattr(github_budget, "time", SimpleNamespace(monotonic=lambda: now[0]))
    return now


def _slow_reads(
    monkeypatch: pytest.MonkeyPatch, github: FakeGitHub, clock: list[float], *, compare_seconds: float
) -> list[int]:
    """Make the stood-in compare and pull request reads check the budget and take time; answer the pulls read."""
    from app.domains.integrations import github_budget, github_deployments, github_issues

    reads: list[int] = []

    def compare(token: str, repository_id: Any, base: str, head: str) -> list[tuple[str, str]]:
        """Check the budget before each of two pages, as a long range does, then answer the range."""
        for _ in range(2):
            github_budget.before_call()
            clock[0] += compare_seconds / 2
        github.compares.append((base, head))
        shas = list(github.messages)
        start = shas.index(base) + 1 if base in shas else 0
        return [(sha, github.messages[sha]) for sha in shas[start : shas.index(head) + 1]]

    def pull(token: str, repository_id: Any, number: int) -> PullRef | None:
        """Check the budget and take a second, as one pull request read does."""
        github_budget.before_call()
        reads.append(number)
        clock[0] += 1
        return github.pulls.get(number)

    monkeypatch.setattr(github_issues, "compare_commits", compare)
    monkeypatch.setattr(github_deployments, "pull_request", pull)
    return reads


def _bumps(github: FakeGitHub, count: int) -> None:
    """Put `count` squash merges whose messages name no key between the second and third deployments."""
    messages = {FIRST: github.messages[FIRST], SECOND: github.messages[SECOND]}
    for index in range(count):
        messages[f"a{index:039d}"] = f"Bump lib {index} (#{100 + index})"
        github.pulls[100 + index] = PullRef(100 + index, f"Bump lib {index}", f"dependabot/lib-{index}", None)
    messages[THIRD] = github.messages[THIRD]
    github.messages = messages


def test_a_deployment_too_slow_for_one_page_is_still_recorded(
    repositories: Any, installed: str, github: FakeGitHub, monkeypatch: pytest.MonkeyPatch, clock: list[float]
) -> None:
    """A first deployment whose pull request reads outrun the page records with what it read and moves the cursor."""
    _three_deployments(repositories, github)
    _bumps(github, 20)
    reads = _slow_reads(monkeypatch, github, clock, compare_seconds=0)

    page = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=3))

    assert page.stalled is False
    assert page.stopped_early is True
    assert page.deployments_scanned == 1
    assert page.releases_created == 1
    assert page.next_cursor == f"{REPOSITORY_ID}:30:1"
    assert len(reads) == 16
    assert page.pull_reads_skipped == 4
    assert page.message == "Stopped early to answer inside the request timeout. Pass next_cursor back to continue."
    assert github.compares == [(SECOND, THIRD)]


def test_pull_requests_the_deliveries_stored_are_not_read_again(
    repositories: Any, installed: str, github: FakeGitHub, monkeypatch: pytest.MonkeyPatch, clock: list[float]
) -> None:
    """A stored pull request's title and branch stand in for a GitHub read, and its keys still count."""
    from app.common.db.dynamo.github import PullRequestState, pr_state_key

    _three_deployments(repositories, github)
    _bumps(github, 20)
    reads = _slow_reads(monkeypatch, github, clock, compare_seconds=0)
    for number in range(100, 120):
        state = PullRequestState(
            workspace_id=WORKSPACE,
            github_key=pr_state_key(REPOSITORY_ID, number),
            repository_id=REPOSITORY_ID,
            pr_number=number,
            title="Fix ABC-1 again" if number == 100 else f"Bump lib {number}",
            head_ref=f"dependabot/lib-{number}",
        )
        assert repositories.github.save_pr_state(state, expected_version=0)

    page = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=1))

    assert reads == []
    assert page.releases_created == 1
    assert page.pull_reads_skipped == 0
    (release,) = _releases(repositories)
    assert "01JB0000000000000000000IS1" in release.issue_ids


def test_a_deployment_whose_range_cannot_be_read_in_time_is_passed_over(
    repositories: Any, installed: str, github: FakeGitHub, monkeypatch: pytest.MonkeyPatch, clock: list[float]
) -> None:
    """A first deployment whose range outruns even the first deployment's allowance is named and passed over."""
    _three_deployments(repositories, github)
    _slow_reads(monkeypatch, github, clock, compare_seconds=40)

    page = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=3))

    assert page.stalled is False
    assert page.unreadable_deployment_ids == [30]
    assert page.deployments_scanned == 1
    assert page.releases_created == 0
    assert page.next_cursor == f"{REPOSITORY_ID}:30:1"
    assert page.message is not None and page.message.startswith("Passed over deployment 30:")
    assert _releases(repositories) == []

    again = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=3, cursor=page.next_cursor))

    assert again.next_cursor != page.next_cursor


def test_a_page_that_cannot_list_deployments_in_time_says_it_made_no_progress(
    repositories: Any, installed: str, github: FakeGitHub, monkeypatch: pytest.MonkeyPatch, clock: list[float]
) -> None:
    """A page that records and skips nothing sets stalled and says so rather than telling the caller to continue."""
    from app.domains.integrations import github_budget, github_deployments

    _three_deployments(repositories, github)

    def slow(token: str, repository_id: Any, environment: str, **options: Any) -> DeploymentPage:
        """Take longer than the page may run, then ask for one more call."""
        clock[0] += 20
        github_budget.before_call()
        return DeploymentPage(github.deployments, False, 1)

    monkeypatch.setattr(github_deployments, "successful_deployments", slow)

    page = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=1, cursor=f"{REPOSITORY_ID}:40:5"))

    assert page.stalled is True
    assert page.stopped_early is True
    assert page.deployments_scanned == 0
    assert page.next_cursor == f"{REPOSITORY_ID}:40:5"
    assert page.message is not None and page.message.startswith("Made no progress: reading the deployment list")
    assert "Pass next_cursor back to continue" not in page.message


def _consume(repositories: Any, delivery: dict[str, Any]) -> None:
    """Run one deployment delivery through the github-events consumer, under that function's own grant."""
    from app.domains.integrations.consumers import events
    from tests.domains.integrations.conftest import sqs_record

    events.handle_record(repositories, sqs_record({"event": "deployment_status", "body": delivery}))


def _publishing_production(repositories: Any) -> Any:
    """Give the home team one Production stage that moves issues to a finished status and publishes; answer it."""
    done = next(row for row in repositories.team_config.list_statuses(WORKSPACE, TEAM) if row.category == "completed")
    repositories.releases.put_pipeline(
        ReleasePipeline(
            workspace_id=WORKSPACE,
            planning_key=pipeline_key(TEAM),
            team_id=TEAM,
            stages=[
                PipelineStage(
                    stage_id="production",
                    name="Production",
                    github_environments=["production"],
                    status_id=done.status_id,
                    publish_github_release=True,
                )
            ],
        )
    )
    return done


def test_the_events_consumer_records_moves_and_publishes_a_deployment(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """Through the consumer's own grant, a deployment records its release, moves its issues and publishes."""
    _pin(repositories)
    done = _publishing_production(repositories)
    issue = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    github.messages = {THIRD: "Merge pull request #230 from acme/promote/2026-10-07-b\n\nABC-1"}
    github.merges = {THIRD: PROMOTION}

    _consume(repositories, _delivery(THIRD))

    [release] = _releases(repositories)
    assert release.name == "2026-10-07-b"
    assert release.issue_ids == [issue.issue_id]
    assert repositories.issues.get(WORKSPACE, issue.issue_id).status_id == done.status_id
    assert [call["tag"] for call in github.published] == ["2026-10-07-b"]
    assert release.github_release_url == "https://github.com/acme/app/releases/tag/2026-10-07-b"


def test_list_releases_answers_a_release_a_deployment_recorded(
    client: Any, repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """A release the deployment source recorded is in the team's list, as get_release finds it."""
    from tests.domains.helpers import MEMBER
    from tests.domains.integrations.test_mcp import tool
    from tests.domains.integrations.test_mcp_tools import answer, mint_for

    _pin(repositories)
    _publishing_production(repositories)
    seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    github.messages = {FIRST: "Fix login (ABC-1)"}
    _consume(repositories, _delivery(FIRST))

    secret = mint_for(repositories, MEMBER, ("releases:read",))
    listed = answer(tool(client, secret, "list_releases", {"team_id": "ABC"}))
    [release] = _releases(repositories)
    found = answer(tool(client, secret, "get_release", {"team_id": "ABC", "release_id": release.release_id}))

    assert [row["release_id"] for row in listed["releases"]] == [release.release_id]
    assert listed["releases"][0]["source"] == "github_deployment"
    assert found["release_id"] == release.release_id


def _link(issue: Any, number: int, magic_word: str | None, state: str = "merged") -> IssueLink:
    """One pull request link of `issue` in the installed repository, closing it when `magic_word` is set."""
    link_id = f"PR_{number}#{issue.issue_id}"
    return IssueLink(
        workspace_id=WORKSPACE,
        github_key=link_key(link_id),
        ws_issue=f"{WORKSPACE}#{issue.issue_id}",
        link_id=link_id,
        issue_id=issue.issue_id,
        issue_key=f"ABC-{issue.number}",
        repository_full_name=REPOSITORY_FULL_NAME,
        repository_id=REPOSITORY_ID,
        pr_number=number,
        pr_state=state,
        magic_word=magic_word,
        pr_updated_ms=1,
    )


def test_a_release_moves_only_the_issues_a_pull_request_closes(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """An issue its merged pull request only references stays put; the one it fixes is finished."""
    _pin(repositories)
    done = _publishing_production(repositories)
    fixed = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    referenced = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS3", "ABC", 2)
    repositories.github.put_link(_link(fixed, 7, "fixes"))
    repositories.github.put_link(_link(referenced, 8, None))
    github.messages = {THIRD: "Merge pull request #230 from acme/promote/2026-10-07-b\n\nABC-1 ABC-2"}
    github.merges = {THIRD: PROMOTION}

    _consume(repositories, _delivery(THIRD))

    [release] = _releases(repositories)
    assert release.issue_ids == [fixed.issue_id, referenced.issue_id]
    assert release.referenced_issue_ids == [referenced.issue_id]
    assert repositories.issues.get(WORKSPACE, fixed.issue_id).status_id == done.status_id
    assert repositories.issues.get(WORKSPACE, referenced.issue_id).status_id == referenced.status_id


def test_a_promotion_rereads_which_issues_its_release_closes(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """A release staged before its links were read still leaves a referenced issue alone on promotion."""
    done = next(row for row in repositories.team_config.list_statuses(WORKSPACE, TEAM) if row.category == "completed")
    repositories.releases.put_pipeline(
        ReleasePipeline(
            workspace_id=WORKSPACE,
            planning_key=pipeline_key(TEAM),
            team_id=TEAM,
            stages=[
                PipelineStage(stage_id="staging", name="Staging", github_environments=["staging"]),
                PipelineStage(
                    stage_id="production",
                    name="Production",
                    github_environments=["production"],
                    status_id=done.status_id,
                ),
            ],
        )
    )
    referenced = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    github.messages = {FIRST: "Refs ABC-1"}

    handle_deployment_status(repositories, WORKSPACE, _delivery(FIRST, "staging"))
    repositories.github.put_link(_link(referenced, 9, None))
    handle_deployment_status(repositories, WORKSPACE, _delivery(FIRST, "production"))

    [release] = _releases(repositories)
    assert [stage.stage_id for stage in release.stages] == ["staging", "production"]
    assert release.referenced_issue_ids == [referenced.issue_id]
    assert repositories.issues.get(WORKSPACE, referenced.issue_id).status_id == referenced.status_id
