"""The team purge chain: its message handling, and a whole team drained end to end.

The chain is driven the way SQS would drive it, with every send captured and fed
back to the stage it names, so the end to end test covers the hand-offs, the
cursors and the tombstone guard together rather than each stage in isolation.
"""

from __future__ import annotations

import json
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.events import EventEnvelope
from webbpulse.identity.share_tokens import mint_share_token

from app.common import team_purge
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.attachments import build_attachment
from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.github import IssueLink, Repository_, link_key, repo_key
from app.common.db.dynamo.github import ws_issue as github_ws_issue
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import Cycle, Project, cycle_key, project_key
from app.common.db.dynamo.reactions import build_reaction
from app.common.db.dynamo.share_links import ShareLinkView, share_capability
from app.common.db.dynamo.views import SavedView, team_view_key
from app.domains.discussion.consumers import purge as discussion_purge
from app.domains.integrations.consumers import purge as integrations_purge
from app.domains.issues.consumers import purge as issues_purge
from app.domains.planning.consumers import purge as planning_purge
from app.domains.teams.consumers import purge as teams_purge
from app.domains.views.consumers import purge as views_purge
from tests.domains.helpers import OWNER, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER_TEAM = "01JB000000000000000000PRJ2"

BUCKET = "standupless-test-attachments"

STEPS: dict[str, team_purge.StageStep] = {
    "discussion": discussion_purge.step,
    "integrations": integrations_purge.step,
    "views": views_purge.step,
    "planning": planning_purge.step,
    "issues": issues_purge.step,
    "teams": teams_purge.step,
}


def record(stage: str, *, team_id: str = TEAM, cursor: int = 0) -> dict[str, Any]:
    """One SQS record carrying a purge job, as the event source mapping delivers it."""
    envelope = EventEnvelope(
        name=team_purge.EVENT_NAME,
        payload={"workspace_id": WORKSPACE, "team_id": team_id, "stage": stage, "cursor": cursor},
        scope=WORKSPACE,
    )
    return {"body": envelope.to_json()}


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    """Every purge send, as (queue url, payload), with every stage's queue configured."""
    from app.common.core.config import settings

    captured: list[tuple[str, dict[str, Any]]] = []
    for stage in team_purge.STAGES:
        monkeypatch.setattr(settings, f"TEAM_PURGE_{stage.upper()}_QUEUE_URL", f"https://sqs/{stage}", raising=False)

    def fake_enqueue(url: str, envelope: EventEnvelope, **_: Any) -> None:
        """Capture the send instead of reaching SQS."""
        captured.append((url, dict(envelope.payload)))

    monkeypatch.setattr(team_purge, "enqueue", fake_enqueue)
    return captured


def drain(repositories: Any, sent: list[tuple[str, dict[str, Any]]]) -> list[str]:
    """Deliver every captured send to its stage until the chain stops, answering the stages run."""
    ran: list[str] = []
    while sent:
        _, payload = sent.pop(0)
        stage = payload["stage"]
        ran.append(stage)
        envelope = EventEnvelope(name=team_purge.EVENT_NAME, payload=payload, scope=payload["workspace_id"])
        team_purge.handle_record(repositories, {"body": envelope.to_json()}, stage, STEPS[stage])
    return ran


def test_parse_reads_a_job_and_refuses_a_malformed_one() -> None:
    """A well formed record parses, and anything else is `None` rather than an error."""
    job = team_purge.parse(record("views", cursor=7))

    assert job == team_purge.PurgeJob(WORKSPACE, TEAM, "views", 7)
    assert team_purge.parse({"body": "not json"}) is None
    assert team_purge.parse({"body": json.dumps({"payload": {"team_id": TEAM, "stage": "views"}})}) is None
    assert team_purge.parse({"body": json.dumps({"payload": {**job.__dict__, "stage": "elsewhere"}})}) is None
    assert team_purge.parse({}) is None


def test_start_is_a_no_op_without_a_queue(monkeypatch: pytest.MonkeyPatch) -> None:
    """With no queue URL configured nothing is sent, so the code ships before the queues."""
    calls: list[Any] = []
    monkeypatch.setattr(team_purge, "enqueue", lambda *args, **kwargs: calls.append(args))

    assert team_purge.start(WORKSPACE, TEAM) is False
    assert calls == []


def test_a_team_that_is_not_deleting_is_left_alone(repositories: Any, sent: list[Any]) -> None:
    """The tombstone is the only authority, so a stray message deletes nothing."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    calls: list[team_purge.PurgeJob] = []

    def step(_: Any, job: team_purge.PurgeJob, __: team_purge.Deadline) -> int | None:
        """Record the call."""
        calls.append(job)
        return None

    team_purge.handle_record(repositories, record("views"), "views", step)

    assert calls == []
    assert sent == []
    assert repositories.teams.get(WORKSPACE, TEAM) is not None


def test_a_stage_resumes_itself_or_hands_on(repositories: Any, sent: list[tuple[str, dict[str, Any]]]) -> None:
    """A cursor puts the same stage back on its queue, and `None` sends the next stage."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    repositories.teams.mark_deleting(WORKSPACE, TEAM)

    def resume(*_: Any) -> int | None:
        """Stop part way."""
        return 12

    def finish(*_: Any) -> int | None:
        """Finish."""
        return None

    team_purge.handle_record(repositories, record("views"), "views", resume)
    team_purge.handle_record(repositories, record("views"), "views", finish)
    team_purge.handle_record(repositories, record("teams"), "teams", finish)
    team_purge.handle_record(repositories, record("teams"), "views", finish)

    assert sent == [
        ("https://sqs/views", {"workspace_id": WORKSPACE, "team_id": TEAM, "stage": "views", "cursor": 12}),
        ("https://sqs/planning", {"workspace_id": WORKSPACE, "team_id": TEAM, "stage": "planning", "cursor": 0}),
    ]


def test_an_expired_budget_resumes_after_the_last_issue_done(
    repositories: Any, sent: list[tuple[str, dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A stage that runs out of time re-queues from the issue it finished, then carries on."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    for number in (1, 2, 3):
        issue = seed_issue(repositories, TEAM, number)
        repositories.comments.create(build_comment(WORKSPACE, issue.issue_id, TEAM, OWNER, "note"))
    repositories.teams.mark_deleting(WORKSPACE, TEAM)
    monkeypatch.setattr(team_purge, "BUDGET_SECONDS", 0.0)

    team_purge.handle_record(repositories, record("discussion"), "discussion", discussion_purge.step)

    assert [payload["cursor"] for _, payload in sent] == [1]
    assert drain(repositories, sent)[:3] == ["discussion", "discussion", "discussion"]


def seed_issue(repositories: Any, team_id: str, number: int, *, parent_id: str | None = None) -> Issue:
    """Put one issue row in under a team."""
    statuses = repositories.team_config.list_statuses(WORKSPACE, team_id)
    return repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            team_id=team_id,
            key=f"T-{number}",
            number=number,
            title=f"Issue {number}",
            status_id=statuses[0].status_id if statuses else "todo",
            created_by=OWNER,
            parent_id=parent_id,
        )
    )


@pytest.fixture
def versioned_bucket(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """A versioned moto bucket like the deployed one, with the setting pointed at it."""
    import boto3
    from moto import mock_aws

    from app.common.core.config import settings

    with mock_aws():
        client = boto3.client("s3", region_name="us-west-2")
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "us-west-2"})
        client.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={"Status": "Enabled"})
        monkeypatch.setattr(settings, "ATTACHMENTS_BUCKET", BUCKET, raising=False)
        monkeypatch.setattr(settings, "AWS_REGION", "us-west-2", raising=False)
        yield client


@pytest.fixture
def teams_client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as client:
        yield client


def test_deleting_a_team_purges_every_domain_and_leaves_other_teams_alone(
    repositories: Any,
    sent: list[tuple[str, dict[str, Any]]],
    versioned_bucket: Any,
    teams_client: TestClient,
) -> None:
    """The route starts the chain, and draining it removes the team and everything it owned."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    make_team(repositories, WORKSPACE, OTHER_TEAM, "XYZ")

    doomed = [seed_issue(repositories, TEAM, number) for number in (1, 2, 3)]
    kept = seed_issue(repositories, OTHER_TEAM, 1)
    orphan = seed_issue(repositories, OTHER_TEAM, 2, parent_id=doomed[0].issue_id)
    first = doomed[0].issue_id

    comment = repositories.comments.create(build_comment(WORKSPACE, first, TEAM, OWNER, "note"))
    kept_comment = repositories.comments.create(build_comment(WORKSPACE, kept.issue_id, OTHER_TEAM, OWNER, "note"))
    repositories.reactions.put(build_reaction(WORKSPACE, comment.comment_id, "comment", TEAM, "+1", OWNER))
    repositories.reactions.put(build_reaction(WORKSPACE, first, "issue", TEAM, "+1", OWNER))

    object_key = f"{WORKSPACE}/{first}/upload/file.txt"
    versioned_bucket.put_object(Bucket=BUCKET, Key=object_key, Body=b"one")
    versioned_bucket.put_object(Bucket=BUCKET, Key=object_key, Body=b"two")
    versioned_bucket.put_object(Bucket=BUCKET, Key="kept/file.txt", Body=b"kept")
    repositories.attachments.create(
        build_attachment(WORKSPACE, first, TEAM, "file", "file.txt", OWNER, s3_key=object_key)
    )
    repositories.attachments.create(
        build_attachment(WORKSPACE, first, TEAM, "link", "Docs", OWNER, url="https://example.com")
    )

    repositories.github.put_repository(
        Repository_(
            workspace_id=WORKSPACE,
            github_key=repo_key("R1"),
            repository_id="R1",
            installation_id="I1",
            full_name="acme/api",
            name="api",
            team_id=TEAM,
        )
    )
    repositories.github.put_link(
        IssueLink(
            workspace_id=WORKSPACE,
            github_key=link_key("PR1"),
            ws_issue=github_ws_issue(WORKSPACE, first),
            link_id="PR1",
            issue_id=first,
            issue_key="ABC-1",
            repository_full_name="acme/api",
            pr_number=1,
        )
    )

    repositories.relations.link(WORKSPACE, first, "blocks", kept.issue_id, OWNER)
    repositories.activity.record(build_activity(WORKSPACE, TEAM, first, OWNER, "created"))

    repositories.views.create(
        SavedView(
            workspace_id=WORKSPACE,
            view_key=team_view_key(TEAM, "V1"),
            view_id="V1",
            name="Mine",
            team_id=TEAM,
            owner_id=OWNER,
        )
    )
    repositories.views.create(
        SavedView(
            workspace_id=WORKSPACE,
            view_key=team_view_key(OTHER_TEAM, "V2"),
            view_id="V2",
            name="Kept",
            owner_id=OWNER,
            team_id=OTHER_TEAM,
        )
    )
    repositories.search_index.add(WORKSPACE, TEAM, "issue", first)
    repositories.search_index.add(WORKSPACE, OTHER_TEAM, "issue", kept.issue_id)
    for team_id, issue_id in ((TEAM, first), (OTHER_TEAM, kept.issue_id)):
        mint_share_token(
            tenant_id=WORKSPACE,
            capability=share_capability(team_id, "Shared"),
            target=("issue", issue_id),
            name="Shared",
            created_by=OWNER,
            store=repositories.share_links,
        )

    repositories.planning.create_cycle(
        Cycle(
            workspace_id=WORKSPACE,
            planning_key=cycle_key(TEAM, "C1"),
            cycle_id="C1",
            team_id=TEAM,
            name="Cycle 1",
            start_date="2026-09-01",
            end_date="2026-09-14",
            created_by=OWNER,
        )
    )
    repositories.planning.create_cycle(
        Cycle(
            workspace_id=WORKSPACE,
            planning_key=cycle_key(OTHER_TEAM, "C2"),
            cycle_id="C2",
            team_id=OTHER_TEAM,
            name="Cycle 2",
            start_date="2026-09-01",
            end_date="2026-09-14",
            created_by=OWNER,
        )
    )
    for project_id, team_ids in (("P1", [TEAM]), ("P2", [TEAM, OTHER_TEAM])):
        repositories.planning.create_project(
            Project(
                workspace_id=WORKSPACE,
                planning_key=project_key(project_id),
                project_id=project_id,
                team_ids=team_ids,
                name=project_id,
                created_by=OWNER,
            )
        )

    sign_in(teams_client, OWNER)
    assert teams_client.delete(f"/api/workspaces/{WORKSPACE}/teams/{TEAM}").status_code == 204

    assert drain(repositories, sent) == list(team_purge.STAGES)

    assert repositories.teams.get_including_deleting(WORKSPACE, TEAM) is None
    for issue in doomed:
        assert repositories.issues.get(WORKSPACE, issue.issue_id) is None
    assert repositories.comments.iter_for_issue(WORKSPACE, first) == []
    assert repositories.reactions.list_for_target(WORKSPACE, first) == []
    assert repositories.reactions.list_for_target(WORKSPACE, comment.comment_id) == []
    assert repositories.attachments.iter_for_issue(WORKSPACE, first) == []
    versions = versioned_bucket.list_object_versions(Bucket=BUCKET)
    assert {entry["Key"] for entry in versions.get("Versions", [])} == {"kept/file.txt"}
    assert versions.get("DeleteMarkers", []) == []
    assert repositories.github.list_links_for_issue(WORKSPACE, first).items == []
    assert repositories.github.get_repository(WORKSPACE, "R1").team_id is None
    assert repositories.relations.list_for_issue(WORKSPACE, kept.issue_id) == []
    assert repositories.activity.delete_for_issue(WORKSPACE, first) == 0
    assert repositories.views.list_for_team(WORKSPACE, TEAM) == []
    assert repositories.search_index.postings(WORKSPACE, TEAM, "issue") == []
    assert repositories.planning.list_cycles(WORKSPACE, TEAM)[0] == []
    assert repositories.planning.get_project(WORKSPACE, "P1") is None
    assert repositories.planning.get_project(WORKSPACE, "P2").team_ids == [OTHER_TEAM]
    links = {ShareLinkView(record).target_id: record for record in repositories.share_links.list_for_tenant(WORKSPACE)}
    assert links[first].is_revoked
    assert not links[kept.issue_id].is_revoked

    assert repositories.issues.get(WORKSPACE, kept.issue_id) is not None
    assert repositories.issues.get(WORKSPACE, orphan.issue_id).parent_id is None
    assert [row.comment_id for row in repositories.comments.iter_for_issue(WORKSPACE, kept.issue_id)] == [
        kept_comment.comment_id
    ]
    assert len(repositories.views.list_for_team(WORKSPACE, OTHER_TEAM)) == 1
    assert repositories.search_index.postings(WORKSPACE, OTHER_TEAM, "issue") == [kept.issue_id]
    assert len(repositories.planning.list_cycles(WORKSPACE, OTHER_TEAM)[0]) == 1
    assert repositories.teams.get(WORKSPACE, OTHER_TEAM) is not None


def test_a_replayed_chain_after_the_purge_is_a_no_op(repositories: Any, sent: list[tuple[str, dict[str, Any]]]) -> None:
    """Once the team row is gone, every replayed stage is dropped by the tombstone guard."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    repositories.teams.mark_deleting(WORKSPACE, TEAM)
    team_purge.start(WORKSPACE, TEAM)
    drain(repositories, sent)

    step_calls: list[str] = []

    def spy(*_: Any) -> int | None:
        """Record the call."""
        step_calls.append("called")
        return None

    for stage in team_purge.STAGES:
        team_purge.handle_record(repositories, record(stage), stage, spy)

    assert step_calls == []
    assert sent == []
