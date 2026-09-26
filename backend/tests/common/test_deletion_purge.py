"""The hourly sweep and the workspace and account purges it starts, drained end to end.

Every send is captured and fed back to the stage it names, the way SQS would drive
the chain, so these cover the grace period, the cancel, the sole owner check at
purge time, the hand-offs between stages and the replay of a finished purge.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.events import EventEnvelope

from app.common import team_purge
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.attachments import build_attachment
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.github import Repository_, repo_key
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.views import SavedView, team_view_key
from app.domains.discussion.consumers import purge as discussion_purge
from app.domains.integrations.consumers import purge as integrations_purge
from app.domains.issues.consumers import purge as issues_purge
from app.domains.planning.consumers import purge as planning_purge
from app.domains.teams.consumers import purge as teams_purge
from app.domains.views.consumers import purge as views_purge
from app.domains.workspaces.consumers import purge as workspaces_purge
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_team, make_user, make_workspace, sign_in

DOOMED = "01JB00000000000000000000WS"

KEPT = "01JB0000000000000000000WS2"

TEAM = "01JB000000000000000000PRJ1"

KEPT_TEAM = "01JB000000000000000000PRJ2"

BUCKET = "standupless-test-attachments"

STEPS: dict[str, team_purge.StageSteps] = {
    "discussion": team_purge.StageSteps(team=discussion_purge.step),
    "integrations": team_purge.StageSteps(team=integrations_purge.step, workspace=integrations_purge.workspace_step),
    "views": team_purge.StageSteps(
        team=views_purge.step, workspace=views_purge.workspace_step, account=views_purge.account_step
    ),
    "planning": team_purge.StageSteps(team=planning_purge.step, workspace=planning_purge.workspace_step),
    "issues": team_purge.StageSteps(team=issues_purge.step, workspace=issues_purge.workspace_step),
    "teams": team_purge.StageSteps(team=teams_purge.step, workspace=teams_purge.workspace_step),
    "workspaces": team_purge.StageSteps(
        workspace=workspaces_purge.workspace_step,
        account=workspaces_purge.account_step,
        sweep=workspaces_purge.sweep,
    ),
}


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Every purge send's payload, with every stage's queue configured."""
    from app.common.core.config import settings

    captured: list[dict[str, Any]] = []
    for stage in team_purge.ALL_STAGES:
        monkeypatch.setattr(settings, f"TEAM_PURGE_{stage.upper()}_QUEUE_URL", f"https://sqs/{stage}", raising=False)

    def fake_enqueue(url: str, envelope: EventEnvelope, **_: Any) -> None:
        """Capture the send instead of reaching SQS."""
        captured.append(dict(envelope.payload))

    monkeypatch.setattr(team_purge, "enqueue", fake_enqueue)
    return captured


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Any:
    """The sweep's clock, which a test moves past the grace period."""

    class Clock:
        """A settable now for the sweep."""

        def __init__(self) -> None:
            """Start at the real now."""
            self.now: datetime = utc_now()

        def advance(self, delta: timedelta) -> None:
            """Move the clock forward."""
            self.now = self.now + delta

    current = Clock()
    monkeypatch.setattr(workspaces_purge, "utc_now", lambda: current.now)
    return current


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
def workspaces_client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as client:
        yield client


def sweep_record() -> dict[str, Any]:
    """The record the hourly schedule puts on the workspaces queue."""
    envelope = EventEnvelope(
        name=team_purge.EVENT_NAME,
        payload={"kind": team_purge.SWEEP, "stage": team_purge.WORKSPACE_STAGE},
        scope=team_purge.SWEEP,
    )
    return {"body": envelope.to_json()}


def run_sweep(repositories: Any) -> None:
    """Deliver one sweep to the workspaces stage."""
    team_purge.handle_record(
        repositories, sweep_record(), team_purge.WORKSPACE_STAGE, steps=STEPS[team_purge.WORKSPACE_STAGE]
    )


def drain(repositories: Any, sent: list[dict[str, Any]]) -> list[str]:
    """Deliver every captured send to its stage until the chain stops, answering the stages run."""
    ran: list[str] = []
    while sent:
        payload = sent.pop(0)
        stage = payload["stage"]
        ran.append(stage)
        envelope = EventEnvelope(name=team_purge.EVENT_NAME, payload=payload, scope="test")
        team_purge.handle_record(repositories, {"body": envelope.to_json()}, stage, steps=STEPS[stage])
    return ran


def seed_issue(repositories: Any, workspace_id: str, team_id: str, number: int, author: str = OWNER) -> Issue:
    """Put one issue row in under a team."""
    statuses = repositories.team_config.list_statuses(workspace_id, team_id)
    return repositories.issues.create(
        Issue(
            workspace_id=workspace_id,
            team_id=team_id,
            key=f"T-{number}",
            number=number,
            title=f"Issue {number}",
            status_id=statuses[0].status_id if statuses else "todo",
            created_by=author,
        )
    )


def seed_workspace(repositories: Any, workspace_id: str, slug: str, team_id: str, prefix: str) -> Issue:
    """A workspace with a team, an issue carrying a comment, a view and a connected repository."""
    make_workspace(repositories, workspace_id, slug, OWNER)
    make_team(repositories, workspace_id, team_id, prefix)
    issue = seed_issue(repositories, workspace_id, team_id, 1)
    repositories.comments.create(build_comment(workspace_id, issue.issue_id, team_id, OWNER, "note"))
    repositories.views.create(
        SavedView(
            workspace_id=workspace_id,
            view_key=team_view_key(team_id, "V1"),
            view_id="V1",
            name="Mine",
            team_id=team_id,
            owner_id=OWNER,
        )
    )
    repositories.github.put_repository(
        Repository_(
            workspace_id=workspace_id,
            github_key=repo_key(f"R-{slug}"),
            repository_id=f"R-{slug}",
            installation_id="I1",
            full_name=f"{slug}/api",
            name="api",
            team_id=team_id,
        )
    )
    return issue


def test_a_workspace_is_purged_only_after_its_grace_period_and_everything_goes(
    repositories: Any,
    sent: list[dict[str, Any]],
    clock: Any,
    versioned_bucket: Any,
    workspaces_client: TestClient,
) -> None:
    """Scheduled, swept too early, swept after fourteen days, drained, and replayed as a no-op."""
    make_user(repositories, OWNER, "owner@example.com", "Olive")
    make_user(repositories, MEMBER, "member@example.com", "Max")
    doomed_issue = seed_workspace(repositories, DOOMED, "doomed", TEAM, "ABC")
    kept_issue = seed_workspace(repositories, KEPT, "kept", KEPT_TEAM, "XYZ")
    add_member(repositories, DOOMED, MEMBER, "member")

    object_key = f"{DOOMED}/{doomed_issue.issue_id}/upload/file.txt"
    versioned_bucket.put_object(Bucket=BUCKET, Key=object_key, Body=b"one")
    versioned_bucket.put_object(Bucket=BUCKET, Key="kept/file.txt", Body=b"kept")
    repositories.attachments.create(
        build_attachment(DOOMED, doomed_issue.issue_id, TEAM, "file", "file.txt", OWNER, s3_key=object_key)
    )

    sign_in(workspaces_client, OWNER)
    key = workspaces_client.post(f"/api/workspaces/{DOOMED}/api-keys", json={"name": "CI", "scopes": ["issues:read"]})
    assert key.status_code == 201
    invite = workspaces_client.post(
        f"/api/workspaces/{DOOMED}/invites", json={"email": "x@example.com", "role": "member"}
    )
    assert invite.status_code == 201
    scheduled = workspaces_client.post(f"/api/workspaces/{DOOMED}/deletion", json={"confirm_name": "Doomed"})
    assert scheduled.status_code == 200

    run_sweep(repositories)
    assert sent == []
    assert repositories.workspaces.get(DOOMED).purging_at is None

    clock.advance(timedelta(days=14, minutes=1))
    run_sweep(repositories)

    row = repositories.workspaces.get(DOOMED)
    assert row.is_purging
    assert sorted(row.purge_member_ids) == sorted([OWNER, MEMBER])
    assert repositories.memberships.list_members(DOOMED) == []
    assert repositories.invites.list_for_workspace(DOOMED) == []
    assert all(record.revoked_at for record in repositories.api_keys.list_for_tenant(DOOMED))
    assert workspaces_client.get(f"/api/workspaces/{DOOMED}").status_code == 404

    ran = drain(repositories, sent)

    assert ran[-1] == "workspaces"
    assert set(team_purge.ALL_STAGES) <= set(ran)
    assert repositories.workspaces.get(DOOMED) is None
    assert repositories.teams.list_team_ids(DOOMED) == []
    assert repositories.issues.get(DOOMED, doomed_issue.issue_id) is None
    assert list(repositories.comments.iter_for_issue(DOOMED, doomed_issue.issue_id)) == []
    assert repositories.attachments.iter_for_issue(DOOMED, doomed_issue.issue_id) == []
    listed = versioned_bucket.list_object_versions(Bucket=BUCKET)
    assert [version["Key"] for version in listed.get("Versions", [])] == ["kept/file.txt"]
    assert repositories.views.get(DOOMED, team_view_key(TEAM, "V1")) is None
    assert repositories.github.get_repository(DOOMED, "R-doomed") is None

    assert repositories.workspaces.get(KEPT) is not None
    assert repositories.issues.get(KEPT, kept_issue.issue_id) is not None
    assert repositories.views.get(KEPT, team_view_key(KEPT_TEAM, "V1")) is not None
    assert repositories.memberships.get(KEPT, OWNER) is not None

    run_sweep(repositories)
    assert sent == []


def test_a_cancelled_workspace_deletion_is_never_purged(
    repositories: Any, sent: list[dict[str, Any]], clock: Any
) -> None:
    """Cancelling during the grace period takes the workspace off the sweep for good."""
    make_workspace(repositories, DOOMED, "doomed", OWNER)
    repositories.workspaces.schedule_deletion(DOOMED, OWNER, now=clock.now)
    repositories.workspaces.cancel_deletion(DOOMED)

    clock.advance(timedelta(days=30))
    run_sweep(repositories)

    assert sent == []
    assert repositories.workspaces.get(DOOMED).purging_at is None
    assert repositories.memberships.get(DOOMED, OWNER) is not None


def test_two_sweeps_start_a_purge_once(repositories: Any, sent: list[dict[str, Any]], clock: Any) -> None:
    """The conditional purge mark keeps a second sweep from starting a second chain."""
    make_workspace(repositories, DOOMED, "doomed", OWNER)
    repositories.workspaces.schedule_deletion(DOOMED, OWNER, now=clock.now)
    clock.advance(timedelta(days=15))

    run_sweep(repositories)
    run_sweep(repositories)

    assert [payload["stage"] for payload in sent] == ["discussion"]


def test_an_account_purge_deletes_its_solo_workspace_and_leaves_the_rest(
    repositories: Any, sent: list[dict[str, Any]], clock: Any
) -> None:
    """A solo workspace goes with the account, other memberships go, authored content stays."""
    make_user(repositories, MEMBER, "member@example.com", "Max")
    make_user(repositories, OWNER, "owner@example.com", "Olive")
    kept_issue = seed_workspace(repositories, KEPT, "kept", KEPT_TEAM, "XYZ")
    add_member(repositories, KEPT, MEMBER, "member")
    authored = seed_issue(repositories, KEPT, KEPT_TEAM, 2, author=MEMBER)
    make_workspace(repositories, DOOMED, "solo", MEMBER)

    repositories.users.schedule_deletion(MEMBER, now=clock.now)
    clock.advance(timedelta(days=14, minutes=1))
    run_sweep(repositories)

    user = repositories.users.get(MEMBER)
    assert user.is_purging
    assert repositories.memberships.get(KEPT, MEMBER) is None
    assert repositories.memberships.get(DOOMED, MEMBER) is None
    assert repositories.workspaces.get(DOOMED).is_purging

    ran = drain(repositories, sent)

    assert "workspaces" in ran
    assert repositories.users.get(MEMBER) is None
    assert repositories.workspaces.get(DOOMED) is None
    assert repositories.workspaces.get(KEPT) is not None
    assert repositories.memberships.get(KEPT, OWNER) is not None
    assert repositories.issues.get(KEPT, authored.issue_id).created_by == MEMBER
    assert repositories.issues.get(KEPT, kept_issue.issue_id) is not None

    run_sweep(repositories)
    assert sent == []


def test_an_account_that_became_a_sole_owner_is_not_purged(
    repositories: Any, sent: list[dict[str, Any]], clock: Any
) -> None:
    """Ownership can change during the grace period, so the rule is checked again at purge time."""
    make_user(repositories, ADMIN, "admin@example.com", "Ada")
    make_workspace(repositories, KEPT, "kept", OWNER)
    add_member(repositories, KEPT, ADMIN, "member")
    repositories.users.schedule_deletion(ADMIN, now=clock.now)
    repositories.memberships.set_role(KEPT, ADMIN, "owner")
    repositories.memberships.set_role(KEPT, OWNER, "member")

    clock.advance(timedelta(days=15))
    run_sweep(repositories)

    assert sent == []
    user = repositories.users.get(ADMIN)
    assert user.purging_at is None
    assert user.purge_after is not None
    assert repositories.memberships.get(KEPT, ADMIN).role == "owner"


def test_a_workspace_scheduled_but_not_yet_due_still_blocks_its_owners_account_purge(
    repositories: Any, sent: list[dict[str, Any]], clock: Any
) -> None:
    """A workspace deletion that might still be cancelled cannot be counted on at purge time."""
    make_user(repositories, OWNER, "owner@example.com", "Olive")
    make_workspace(repositories, KEPT, "kept", OWNER)
    add_member(repositories, KEPT, MEMBER, "member")
    repositories.users.schedule_deletion(OWNER, now=clock.now)
    clock.advance(timedelta(days=14, minutes=1))
    repositories.workspaces.schedule_deletion(KEPT, OWNER, now=clock.now)

    run_sweep(repositories)

    assert sent == []
    assert repositories.users.get(OWNER).purging_at is None
