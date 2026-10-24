"""The one-off repair that leaves each issue on the first release that carried it to a stage, against moto."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from app.common.db.dynamo.releases import PipelineStage, ReleasePipeline, pipeline_key
from app.common.releases import include_releases, reach_stage, record_release
from scripts.dedupe_release_issues import main, run
from tests.domains.integrations.conftest import TEAM, WORKSPACE, seed_issue

STAGING = PipelineStage(stage_id="staging", name="Staging", github_environments=["staging"])

PRODUCTION = PipelineStage(stage_id="production", name="Production", github_environments=["production"])


def _at(hour: int) -> datetime:
    """A fixed time on one day, so the order the releases shipped in is explicit."""
    return datetime(2026, 10, 20, hour, tzinfo=timezone.utc)


def _ship(repositories: Any, stage: PipelineStage, issues: list[Any], digit: str, hour: int) -> Any:
    """Record one release of the home team at this stage, without status automation."""
    return record_release(
        repositories,
        WORKSPACE,
        TEAM,
        stage=stage,
        source="github",
        issues=issues,
        sha=digit * 40,
        at=_at(hour),
        automate=False,
    )


@pytest.fixture
def duplicated(repositories: Any, workspace: str) -> dict[str, str]:
    """The history the bug left: a staging release repeating its predecessor's issue and a promotion on staging.

    The second staging release ships its own issue and the first one's again, and
    the promotion that carried both reached staging after production, the way an
    end-to-end job reporting from the default branch made it.
    """
    pipeline = ReleasePipeline(
        workspace_id=WORKSPACE, planning_key=pipeline_key(TEAM), team_id=TEAM, stages=[STAGING, PRODUCTION]
    )
    repositories.releases.put_pipeline(pipeline)
    first_issue = seed_issue(repositories, WORKSPACE, TEAM, "issue-one", "ABC", 1)
    second_issue = seed_issue(repositories, WORKSPACE, TEAM, "issue-two", "ABC", 2)
    first, _ = _ship(repositories, STAGING, [first_issue], "1", 1)
    second, _ = _ship(repositories, STAGING, [first_issue, second_issue], "2", 2)
    promotion, _ = _ship(repositories, PRODUCTION, [first_issue, second_issue], "3", 3)
    promotion = reach_stage(repositories, promotion, STAGING, source="github", at=_at(4), automate=False)
    include_releases(repositories, promotion, [first, second], pipeline)
    return {"first": first.release_id, "second": second.release_id, "promotion": promotion.release_id}


def _release(repositories: Any, release_id: str) -> Any:
    """One stored release of the home team."""
    return repositories.releases.get(WORKSPACE, TEAM, release_id)


def _linked(repositories: Any, issue_id: str) -> set[str]:
    """The releases an issue's links name."""
    return {release_id for _, release_id in repositories.releases.list_for_issue(WORKSPACE, issue_id)}


def test_the_repair_keeps_each_issue_on_its_first_staging_release(
    repositories: Any, duplicated: dict[str, str]
) -> None:
    """A repeated issue leaves the later staging release, a promotion loses its bogus stage, and a rerun is a no-op."""
    tally = run(repositories, [WORKSPACE], dry_run=False)

    assert (tally.stages_dropped, tally.links_removed, tally.releases_written) == (1, 1, 2)
    assert _release(repositories, duplicated["first"]).issue_ids == ["issue-one"]
    assert _release(repositories, duplicated["second"]).issue_ids == ["issue-two"]
    promotion = _release(repositories, duplicated["promotion"])
    assert [entry.stage_id for entry in promotion.stages] == ["production"]
    assert promotion.issue_ids == ["issue-one", "issue-two"]
    assert _linked(repositories, "issue-one") == {duplicated["first"], duplicated["promotion"]}
    assert _linked(repositories, "issue-two") == {duplicated["second"], duplicated["promotion"]}

    again = run(repositories, [WORKSPACE], dry_run=False)
    assert (again.stages_dropped, again.links_removed, again.releases_written) == (0, 0, 0)


def test_a_dry_run_counts_and_writes_nothing(
    repositories: Any, duplicated: dict[str, str], capsys: pytest.CaptureFixture[str]
) -> None:
    """The command line prints counts only and leaves every release alone under `--dry-run`."""
    from app.common.core.config import settings

    stage = settings.dynamodb_table_prefix.removeprefix("standupless-")
    assert main(["--stage", stage, "--workspace", WORKSPACE, "--dry-run"]) == 0

    printed = capsys.readouterr().out.strip()
    assert printed.startswith("dry_run=True workspaces=1 teams=2 releases=3 ")
    assert printed.endswith("stages_dropped=1 links_removed=1 releases_written=2")
    assert _release(repositories, duplicated["second"]).issue_ids == ["issue-one", "issue-two"]
    assert [entry.stage_id for entry in _release(repositories, duplicated["promotion"]).stages] == [
        "production",
        "staging",
    ]
    assert duplicated["second"] in _linked(repositories, "issue-one")
