"""The GitHub Deployments release source, with GitHub's commit reads stood in for.

These hold that a successful deployment records the issues its commits name as a
release at the stage its environment maps to, that the next deployment reads only
the range since the last one, that a promotion advances the staging release rather
than making another, and that a redelivery or a failed deployment changes nothing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from app.common.db.dynamo.releases import PipelineStage, ReleasePipeline, pipeline_key
from app.domains.integrations.deployments import handle_deployment_status
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


@dataclass
class FakeGitHub:
    """What the stood-in commit reads answer, and the calls they took."""

    messages: dict[str, str] = field(default_factory=dict)
    compares: list[tuple[str, str]] = field(default_factory=list)
    heads: list[str] = field(default_factory=list)


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch) -> FakeGitHub:
    """Stand in for the installation token, the compare read and the single commit read."""
    from app.domains.integrations import github_issues

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
