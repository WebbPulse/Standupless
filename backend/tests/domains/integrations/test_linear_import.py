"""The Linear API importer, driven end to end against the fake Linear GraphQL server.

Every test points `linear_import.client_factory` at `FakeLinear` through an
in-process transport, so no request leaves the test and no real key is used.
With no queue configured an import runs inline, so most tests start one through
the route and read what it wrote straight back; the queued tests drive the
consumer a message at a time. What these tests watch: each Linear field lands
where it belongs, connections are followed page by page at both levels, a rate
limit is waited out, a second import updates what the first wrote instead of
duplicating it, the sealed key is deleted whenever a job ends, and the key never
appears in a log line, the job object, an audit row, a stored row or an answer.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.common import issue_import, linear_api, linear_import
from app.common.linear_api import LinearClient
from app.domains.integrations.consumers import import_jobs
from app.domains.integrations.mcp.transport import INSUFFICIENT_SCOPE
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.integrations.conftest import TEAM, WORKSPACE, sqs_record
from tests.domains.integrations.linear_fake import FAKE_KEY, FakeLinear, ref, sample
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

BUCKET = "standupless-test-imports"

QUEUE = "https://sqs.us-west-2.amazonaws.com/1/issue-import"

LINEAR_TEAM = "team-eng"

WRONG_KEY = "lin_api_wrong_1111111111111111111111111111"


@pytest.fixture
def bucket(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """A live moto S3 bucket with the attachments setting pointed at it and no import queue."""
    import boto3
    from moto import mock_aws
    from webbpulse.storage import reset_client_cache

    from app.common.core.config import settings

    reset_client_cache()
    with mock_aws():
        boto3.client("s3", region_name="us-west-2").create_bucket(
            Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "us-west-2"}
        )
        monkeypatch.setattr(settings, "ATTACHMENTS_BUCKET", BUCKET, raising=False)
        monkeypatch.setattr(settings, "AWS_REGION", "us-west-2", raising=False)
        monkeypatch.setattr(settings, "ISSUE_IMPORT_QUEUE_URL", "", raising=False)
        yield BUCKET
    reset_client_cache()


@pytest.fixture
def queued(monkeypatch: pytest.MonkeyPatch, bucket: str, enqueued: list[tuple[str, Any]]) -> list[tuple[str, Any]]:
    """An import queue configured, with every page message captured instead of sent."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "ISSUE_IMPORT_QUEUE_URL", QUEUE, raising=False)
    return enqueued


@pytest.fixture
def sleeps() -> list[float]:
    """Every pause the Linear client took, recorded instead of slept."""
    return []


@pytest.fixture
def linear(monkeypatch: pytest.MonkeyPatch, sleeps: list[float], repositories: Any, workspace: str) -> FakeLinear:
    """The sample Linear workspace, answering every Linear client the code builds.

    Its one team's issues are assigned to the member, and the Standupless team is
    put on the Fibonacci scale so estimates have somewhere to land.
    """
    fake = sample("member@example.com")
    monkeypatch.setattr(
        linear_import,
        "client_factory",
        lambda api_key: LinearClient(api_key=api_key, transport=fake.transport(), sleep=sleeps.append),
    )
    repositories.teams.update(WORKSPACE, TEAM, estimate_scale="fibonacci")
    return fake


def start_body(key: str = FAKE_KEY, team_id: str = TEAM, **flags: bool) -> dict[str, Any]:
    """The request that imports the sample team into one Standupless team, with any optional phases."""
    return {"api_key": key, "teams": [{"linear_team_id": LINEAR_TEAM, "team_id": team_id, **flags}]}


def start_with(client: TestClient, **flags: bool) -> Any:
    """Start an import of the sample team as the admin with optional phases switched on."""
    sign_in(client, ADMIN)
    return client.post(f"/api/workspaces/{WORKSPACE}/imports/linear", json=start_body(**flags))


def start(client: TestClient, key: str = FAKE_KEY) -> Any:
    """Start an import of the sample team as the admin and answer the response."""
    sign_in(client, ADMIN)
    return client.post(f"/api/workspaces/{WORKSPACE}/imports/linear", json=start_body(key))


def row_id(kind: str, linear_id: str, created_at: str) -> str:
    """The id one sample Linear record becomes in the test workspace."""
    return linear_import.linear_row_id(WORKSPACE, kind, linear_id, created_at)


def sample_issue(fake: FakeLinear, number: int) -> dict[str, Any]:
    """One of the sample team's Linear issues by its number."""
    return next(node for node in fake.issues[LINEAR_TEAM] if node["identifier"] == f"ENG-{number}")


def imported_issue(repositories: Any, fake: FakeLinear, number: int) -> Any:
    """The Standupless issue one sample Linear issue became."""
    node = sample_issue(fake, number)
    return repositories.issues.get(WORKSPACE, row_id("issue", node["id"], node["createdAt"]))


def team_issues(repositories: Any) -> list[Any]:
    """Every issue in the team."""
    return repositories.issues.read_team_newest(WORKSPACE, TEAM, below=None, max_items=100)


def status_name(repositories: Any, status_id: str) -> str:
    """The name of one of the team's statuses."""
    statuses = repositories.team_config.list_statuses(WORKSPACE, TEAM)
    return next(status.name for status in statuses if status.status_id == status_id)


def key_stored(workspace_id: str, import_id: str) -> bool:
    """Whether the sealed key of one import is still in the bucket."""
    import boto3

    listing = boto3.client("s3", region_name="us-west-2").list_objects_v2(
        Bucket=BUCKET, Prefix=linear_import.key_key(workspace_id, import_id)
    )
    return bool(listing.get("Contents"))


def every_stored_row() -> str:
    """Every DynamoDB row of every table, as one string a key could be searched for in."""
    from app.common.db.dynamo.client import get_client

    client = get_client()
    rows: list[Any] = []
    for name in client.list_tables()["TableNames"]:
        rows.extend(client.scan(TableName=name).get("Items", []))
    return json.dumps(rows, default=str)


def every_stored_object() -> str:
    """Every object in the import bucket but the sealed keys, as one string."""
    import boto3

    s3 = boto3.client("s3", region_name="us-west-2")
    parts = []
    for item in s3.list_objects_v2(Bucket=BUCKET).get("Contents", []):
        if not item["Key"].endswith(linear_import.KEY_FILE):
            parts.append(s3.get_object(Bucket=BUCKET, Key=item["Key"])["Body"].read().decode())
    return "\n".join(parts)


def drain(repositories: Any, queued: list[tuple[str, Any]], *, limit: int = 50) -> None:
    """Run every queued page message in order, including the ones each page queues."""
    handled = 0
    while handled < len(queued) and handled < limit:
        import_jobs.handle_record(repositories, sqs_record(dict(queued[handled][1].payload)))
        handled += 1


def test_the_teams_a_key_can_read_are_listed(client: TestClient, workspace: str, linear: FakeLinear) -> None:
    """The admin pastes a key and sees the Linear teams it reads, and nothing is stored."""
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/linear/teams", json={"api_key": f" {FAKE_KEY} "})

    assert response.status_code == 200, response.text
    assert response.json() == {"items": [{"id": LINEAR_TEAM, "key": "ENG", "name": "Engineering ENG"}]}
    assert [request.authorized for request in linear.requests] == [True]


def test_a_refused_key_is_a_400_that_never_repeats_the_key(
    client: TestClient, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """A key Linear refuses answers a plain refusal, and starting with it writes nothing."""
    sign_in(client, ADMIN)

    teams = client.post(f"/api/workspaces/{WORKSPACE}/imports/linear/teams", json={"api_key": WRONG_KEY})
    started = client.post(f"/api/workspaces/{WORKSPACE}/imports/linear", json=start_body(WRONG_KEY))

    for response in (teams, started):
        assert response.status_code == 400
        assert response.json()["error_code"] == "LINEAR_KEY_REFUSED"
        assert WRONG_KEY not in response.text
    assert issue_import.list_jobs(WORKSPACE) == []


@pytest.mark.parametrize("route", ["imports/linear/teams", "imports/linear/preview", "imports/linear"])
def test_only_an_owner_or_admin_may_import_from_linear(
    client: TestClient, workspace: str, bucket: str, linear: FakeLinear, route: str
) -> None:
    """A member is refused before Linear is ever asked."""
    sign_in(client, MEMBER)

    response = client.post(f"/api/workspaces/{WORKSPACE}/{route}", json=start_body())

    assert response.status_code == 403
    assert linear.requests == []


def test_a_team_the_key_cannot_read_is_a_422(
    client: TestClient, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """A Linear team id the key does not list, or one chosen twice, starts nothing."""
    sign_in(client, ADMIN)
    unknown = {"api_key": FAKE_KEY, "teams": [{"linear_team_id": "team-nope", "team_id": TEAM}]}
    twice = {"api_key": FAKE_KEY, "teams": [start_body()["teams"][0], start_body()["teams"][0]]}

    for body in (unknown, twice):
        response = client.post(f"/api/workspaces/{WORKSPACE}/imports/linear", json=body)
        assert response.status_code == 422, response.text
    empty = client.post(f"/api/workspaces/{WORKSPACE}/imports/linear", json={"api_key": FAKE_KEY, "teams": []})
    assert empty.status_code == 422
    assert issue_import.list_jobs(WORKSPACE) == []


def test_an_import_carries_every_issue_field(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """Title, description, attachments, state, priority, estimate, due date, people, labels and planning land."""
    response = start(client)

    assert response.status_code == 202, response.text
    job = response.json()
    assert job["kind"] == "linear"
    assert job["status"] == "completed"
    parent = imported_issue(repositories, linear, 1)
    child = imported_issue(repositories, linear, 2)
    shipped = imported_issue(repositories, linear, 3)
    dropped = imported_issue(repositories, linear, 4)
    assert sorted(issue.key for issue in team_issues(repositories)) == ["ABC-1", "ABC-2", "ABC-3", "ABC-4"]
    assert parent.title == "Import a Linear workspace"
    assert parent.external_ref == "ENG-1 https://linear.app/acme/issue/eng-1"
    assert parent.import_batch_id == job["import_id"]
    assert parent.body.startswith("Read Linear's API and write every team.")
    assert "- [Design (draft)](https://example.com/design)" in parent.body
    assert "file://" not in parent.body
    assert [status_name(repositories, issue.status_id) for issue in (parent, child, shipped, dropped)] == [
        "In Progress",
        "Todo",
        "Done",
        "Cancelled",
    ]
    assert [issue.priority for issue in (parent, child, shipped, dropped)] == ["urgent", "medium", "low", "none"]
    assert parent.estimate == "3"
    assert child.estimate is None
    assert parent.due_date == "2026-09-30"
    assert parent.assignee_id == MEMBER
    assert parent.created_by == MEMBER
    assert child.assignee_id is None
    assert child.created_by == ADMIN
    assert parent.created_at.isoformat().startswith("2026-09-01T09:00")
    labels = {label.label_id: label for label in repositories.team_config.list_labels(WORKSPACE, TEAM)}
    names = sorted(labels[label_id].name for label_id in parent.label_ids)
    assert names == ["Bug", "Frontend"]
    bug = next(labels[label_id] for label_id in parent.label_ids if labels[label_id].name == "Bug")
    assert bug.color == "#eb5757"
    assert labels[bug.parent_id].name == "Type"
    assert labels[bug.parent_id].is_group is True
    assert labels[bug.parent_id].allow_multiple is True
    frontend = next(labels[label_id] for label_id in parent.label_ids if labels[label_id].name == "Frontend")
    assert frontend.color == issue_import.label_color("Frontend")
    assert parent.cycle_id == row_id("cycle", "cycle-1", "2026-08-30T10:00:00.000Z")
    assert parent.project_id == row_id("project", "project-1", "2026-08-01T09:00:00.000Z")
    assert parent.project_milestone_id == row_id("milestone", "milestone-alpha", "2026-08-01T10:00:00.000Z")
    problems = {(problem["field"], problem["message"]) for problem in job["problems"]}
    assert ("estimate", "ENG-2: estimate 7 is not on the team's scale, left empty") in problems
    assert ("assignee", "ENG-2: the assignee is not a member, left unassigned") in problems


def test_an_import_carries_comments_links_and_planning(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """Comments keep author, time and thread; sub-issues and relations link; planning rows are written."""
    job = start(client).json()

    parent = imported_issue(repositories, linear, 1)
    child = imported_issue(repositories, linear, 2)
    shipped = imported_issue(repositories, linear, 3)
    dropped = imported_issue(repositories, linear, 4)
    comments = sorted(
        repositories.comments.iter_for_issue(WORKSPACE, parent.issue_id), key=lambda comment: comment.created_at
    )
    assert [(comment.author_id, comment.body) for comment in comments] == [
        (MEMBER, "First pass is up."),
        ("linear:Riley Stranger", "Looks good to me."),
        (MEMBER, "Agreed, thanks."),
    ]
    assert comments[2].parent_comment_id == comments[1].comment_id
    assert comments[0].created_at.isoformat().startswith("2026-09-02T09:00")
    assert all(comment.import_batch_id == job["import_id"] for comment in comments)
    assert child.parent_id == parent.issue_id
    assert repositories.relations.get(WORKSPACE, parent.issue_id, "blocks", shipped.issue_id) is not None
    assert repositories.relations.get(WORKSPACE, dropped.issue_id, "duplicate_of", parent.issue_id) is not None
    assert repositories.relations.get(WORKSPACE, dropped.issue_id, "relates_to", child.issue_id) is not None
    parent_links = repositories.relations.list_for_issue(WORKSPACE, parent.issue_id)
    assert {relation.target_issue_id for relation in parent_links} == {shipped.issue_id, dropped.issue_id}
    [cycle] = repositories.planning.list_cycles(WORKSPACE, TEAM)[0]
    assert (cycle.name, cycle.start_date, cycle.end_date, cycle.goal) == (
        "Cycle 7",
        "2026-09-01",
        "2026-09-14",
        "Ship the importer",
    )
    [project] = repositories.planning.list_projects(WORKSPACE)
    assert project.name == "Importer ENG"
    assert project.description == "Move every team off Linear in one go."
    assert (project.status, project.priority, project.lead_id, project.health) == (
        "in_progress",
        "high",
        MEMBER,
        "at_risk",
    )
    assert project.team_ids == [TEAM]
    milestones = sorted(
        repositories.planning.list_milestones(WORKSPACE, project.project_id), key=lambda row: row.sort_order
    )
    assert [row.name for row in milestones] == ["Alpha", "Beta"]
    updates, _ = repositories.planning.list_project_updates(WORKSPACE, project.project_id, limit=10)
    assert [(row.author_id, row.health) for row in updates] == [("linear:Riley Stranger", "at_risk")]
    [initiative] = repositories.planning.list_initiatives(WORKSPACE)
    assert (initiative.name, initiative.status, initiative.owner_id) == ("Leave Linear ENG", "active", MEMBER)
    assert project.initiative_id == initiative.initiative_id
    assert job["counts"] == {
        "cycles": 1,
        "projects": 1,
        "milestones": 2,
        "project_updates": 1,
        "issues_created": 4,
        "labels": 3,
        "comments": 3,
        "sub_issues": 1,
        "relations": 3,
        "initiatives": 1,
    }
    assert (job["created_count"], job["linked_count"], job["labels_created"]) == (4, 1, 3)
    assert job["phase"] is None
    assert job["phase_index"] == job["phase_count"] == 7


def test_no_account_or_invite_is_made_for_unmatched_people(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """Placeholder authors stand in for people Linear knows and the workspace does not."""
    members_before = {member.user_id for member in repositories.memberships.list_members(WORKSPACE)}

    start(client)

    assert {member.user_id for member in repositories.memberships.list_members(WORKSPACE)} == members_before
    assert repositories.invites.list_for_workspace(WORKSPACE) == []


def test_connections_are_followed_page_by_page(
    client: TestClient,
    repositories: Any,
    workspace: str,
    bucket: str,
    linear: FakeLinear,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With one node a page, top level and nested connections are both read to the end."""
    monkeypatch.setattr(linear_api, "PAGE_SIZE", 1)
    linear.nested_page_size = 1

    job = start(client).json()

    assert job["status"] == "completed"
    issue_pages = [request.variables.get("after") for request in linear.requests if request.operation == "Issues"]
    assert issue_pages == [None, "c1", "c2", "c3"]
    operations = linear.operations()
    assert "IssueComments" in operations
    assert "ProjectMilestones" in operations
    assert len(team_issues(repositories)) == 4
    parent = imported_issue(repositories, linear, 1)
    assert len(repositories.comments.iter_for_issue(WORKSPACE, parent.issue_id)) == 3
    [project] = repositories.planning.list_projects(WORKSPACE)
    assert len(repositories.planning.list_milestones(WORKSPACE, project.project_id)) == 2
    assert job["counts"]["relations"] == 3


def test_a_rate_limit_is_waited_out(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear, sleeps: list[float]
) -> None:
    """A 429 with a reset time pauses until then and retries, and the import still completes."""
    linear.rate_limit_next = 2

    job = start(client).json()

    assert job["status"] == "completed"
    assert len(sleeps) == 2
    assert all(1.0 <= pause <= linear_api.MAX_WAIT_SECONDS for pause in sleeps)
    assert len(team_issues(repositories)) == 4


def test_a_rate_limit_that_never_lifts_is_a_502(
    client: TestClient, workspace: str, bucket: str, linear: FakeLinear, sleeps: list[float]
) -> None:
    """After every retry the admin hears Linear is not answering, without the wait running forever."""
    linear.rate_limit_next = 100
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/linear/teams", json={"api_key": FAKE_KEY})

    assert response.status_code == 502
    assert response.json()["error_code"] == "LINEAR_UNAVAILABLE"
    assert len(sleeps) == linear_api.MAX_ATTEMPTS - 1


def test_a_second_import_updates_instead_of_duplicating(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """Running the import again finds every row it wrote and updates it in place."""
    first = start(client).json()
    keys = sorted(issue.key for issue in team_issues(repositories))
    sample_issue(linear, 1)["title"] = "Import a Linear workspace, renamed"
    parent_before = imported_issue(repositories, linear, 1)
    relations_before = len(repositories.relations.list_for_issue(WORKSPACE, parent_before.issue_id))

    second = start(client).json()

    assert second["import_id"] != first["import_id"]
    assert second["status"] == "completed"
    assert second["counts"]["issues_updated"] == 4
    assert second["counts"].get("issues_created", 0) == 0
    assert second["counts"].get("labels", 0) == 0
    assert second["updated_count"] == 4
    assert sorted(issue.key for issue in team_issues(repositories)) == keys
    parent = imported_issue(repositories, linear, 1)
    assert parent.title == "Import a Linear workspace, renamed"
    assert parent.issue_id == parent_before.issue_id
    assert len(repositories.comments.iter_for_issue(WORKSPACE, parent.issue_id)) == 3
    assert len(repositories.relations.list_for_issue(WORKSPACE, parent.issue_id)) == relations_before
    assert len(repositories.planning.list_cycles(WORKSPACE, TEAM)[0]) == 1
    [project] = repositories.planning.list_projects(WORKSPACE)
    assert len(repositories.planning.list_milestones(WORKSPACE, project.project_id)) == 2
    assert len(repositories.planning.list_initiatives(WORKSPACE)) == 1
    names = [label.name for label in repositories.team_config.list_labels(WORKSPACE, TEAM)]
    assert sorted(names) == ["Bug", "Frontend", "Type"]


def add_dependent_projects(fake: FakeLinear) -> tuple[dict[str, Any], dict[str, Any]]:
    """Give the sample team a second project the first blocks, plus a loop and a link to a project not imported."""
    [first] = fake.projects[LINEAR_TEAM]
    second = {
        **{key: value for key, value in first.items() if key not in ("milestones", "updates")},
        "id": "project-2",
        "name": "Rollout ENG",
        "createdAt": "2026-08-03T09:00:00.000Z",
        "milestones": [],
        "updates": [],
    }
    fake.projects[LINEAR_TEAM].append(second)
    elsewhere = {"id": "project-elsewhere", "createdAt": "2026-08-04T09:00:00.000Z"}

    def dependency(linear_id: str, project: Any, anchor: str, related: Any, related_anchor: str) -> dict[str, Any]:
        """One Linear project dependency."""
        return {
            "id": linear_id,
            "type": "dependency",
            "anchorType": anchor,
            "relatedAnchorType": related_anchor,
            "createdAt": "2026-08-05T09:00:00.000Z",
            "project": ref(project),
            "relatedProject": ref(related),
        }

    fake.project_relations = [
        dependency("relation-1", second, "start", first, "end"),
        dependency("relation-2", second, "end", first, "start"),
        dependency("relation-3", first, "end", elsewhere, "start"),
    ]
    return first, second


def test_project_dependencies_become_blocks_links_without_loops(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """A Linear dependency links the imported projects, a loop is left out with a warning, and a re-run adds none."""
    first, second = add_dependent_projects(linear)
    blocker = row_id("project", first["id"], first["createdAt"])
    blocked = row_id("project", second["id"], second["createdAt"])

    job = start(client).json()

    assert job["status"] == "completed"
    [relation] = repositories.planning.list_project_relations(WORKSPACE)
    assert (relation.project_id, relation.target_project_id) == (blocker, blocked)
    assert relation.relation_id == row_id("project_relation", "relation-1", "2026-08-05T09:00:00.000Z")
    assert relation.created_by == ADMIN
    assert job["counts"]["project_relations"] == 1
    problems = {(problem["field"], problem["message"]) for problem in job["problems"]}
    assert (
        "project_relations",
        "Rollout ENG blocking Importer ENG would make the projects wait on each other, left out",
    ) in problems

    again = start(client).json()

    assert again["counts"].get("project_relations", 0) == 0
    assert len(repositories.planning.list_project_relations(WORKSPACE)) == 1


def test_a_rejected_project_dependencies_query_still_completes_the_import(
    client: TestClient,
    repositories: Any,
    workspace: str,
    bucket: str,
    linear: FakeLinear,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A schema mismatch on the dependencies query is a warning and a log line, never a failed import."""
    add_dependent_projects(linear)
    linear.rejected_operations = {"ProjectRelations"}
    caplog.set_level(logging.WARNING)

    job = start(client).json()

    assert job["status"] == "completed", job
    assert job["error"] is None
    assert job["counts"]["issues_created"] == 4
    assert job["counts"].get("project_relations", 0) == 0
    assert repositories.planning.list_project_relations(WORKSPACE) == []
    problems = {(problem["field"], problem["message"]) for problem in job["problems"]}
    assert (
        "project_relations",
        "Linear would not list project dependencies (graphql_validation_failed), left out",
    ) in problems
    assert any(
        getattr(record, "event", "") == "issue.import.linear_project_relations_skipped" for record in caplog.records
    )
    assert not key_stored(WORKSPACE, job["import_id"])


def add_customers(fake: FakeLinear) -> None:
    """Two Linear customers: one on a status the workspace has, one on a tier it has not."""
    fake.customers = [
        {
            "id": "customer-1",
            "name": "Acme",
            "domains": ["https://www.Acme.example/about", "not a domain"],
            "revenue": 120000.4,
            "size": 40,
            "createdAt": "2026-08-01T09:00:00.000Z",
            "status": {"name": "active", "color": "#22C55E"},
            "tier": {"name": "Enterprise", "color": "#8b5cf6"},
            "owner": {"email": "member@example.com"},
        },
        {
            "id": "customer-2",
            "name": "Globex",
            "domains": ["acme.example", "globex.example"],
            "revenue": None,
            "size": None,
            "createdAt": "2026-08-02T09:00:00.000Z",
            "status": {"name": "Prospect", "color": "blue"},
            "tier": {"name": "enterprise", "color": "#000000"},
            "owner": None,
        },
    ]


def test_linear_customers_map_onto_the_workspace_statuses_and_tiers(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """A Linear status or tier reuses the workspace entry of the same name and adds the missing ones once."""
    add_customers(linear)

    job = start(client).json()

    assert job["status"] == "completed", job
    acme = repositories.customers.get(WORKSPACE, row_id("customer", "customer-1", "2026-08-01T09:00:00.000Z"))
    globex = repositories.customers.get(WORKSPACE, row_id("customer", "customer-2", "2026-08-02T09:00:00.000Z"))
    assert (acme.name, acme.domains, acme.owner_id, acme.revenue, acme.size) == (
        "Acme",
        ["acme.example"],
        MEMBER,
        120000,
        40,
    )
    assert acme.status_id == "active"
    assert globex.domains == ["globex.example"]
    tiers = repositories.customers.list_fields(WORKSPACE, "customer_tier")
    assert [(row.name, row.color) for row in tiers] == [("Enterprise", "#8b5cf6")]
    assert acme.tier_id == globex.tier_id == tiers[0].field_id
    statuses = repositories.customers.list_fields(WORKSPACE, "customer_status")
    prospect = next(row for row in statuses if row.name == "Prospect")
    assert (prospect.color, prospect.position) == (None, 5)
    assert globex.status_id == prospect.field_id
    assert job["counts"]["customers"] == 2
    assert job["counts"]["customer_statuses"] == 1
    assert job["counts"]["customer_tiers"] == 1

    again = start(client).json()

    assert again["counts"]["customers"] == 2
    assert again["counts"].get("customer_tiers", 0) == 0
    assert len(repositories.customers.list_customers(WORKSPACE, max_items=100)) == 2


def test_a_rejected_customers_query_still_completes_the_import(
    client: TestClient,
    repositories: Any,
    workspace: str,
    bucket: str,
    linear: FakeLinear,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A Linear plan without customers is a warning and a log line, never a failed import."""
    add_customers(linear)
    linear.rejected_operations = {"Customers"}
    caplog.set_level(logging.WARNING)

    job = start(client).json()

    assert job["status"] == "completed", job
    assert job["counts"].get("customers", 0) == 0
    assert repositories.customers.list_customers(WORKSPACE, max_items=100) == []
    problems = {(problem["field"], problem["message"]) for problem in job["problems"]}
    assert ("customers", "Linear would not list customers (graphql_validation_failed), left out") in problems
    assert any(getattr(record, "event", "") == "issue.import.linear_customers_skipped" for record in caplog.records)


def test_the_queue_runs_a_linear_import_a_step_at_a_time(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]], linear: FakeLinear
) -> None:
    """Each step queues the next, the job reports its phase, and the last step deletes the key."""
    job = start(client).json()
    assert job["status"] == "queued"
    assert key_stored(WORKSPACE, job["import_id"])

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))
    middle = client.get(f"/api/workspaces/{WORKSPACE}/imports/{job['import_id']}").json()
    assert middle["status"] == "running"
    assert middle["phase"] == "projects"
    assert (middle["phase_index"], middle["phase_count"]) == (1, 7)

    drain(repositories, queued)

    done = issue_import.load_job(WORKSPACE, job["import_id"])
    assert done is not None
    assert done.status == "completed"
    assert done.counts["issues_created"] == 4
    assert not key_stored(WORKSPACE, job["import_id"])
    [notice] = [dict(row) for row in repositories.inbox.list(WORKSPACE, ADMIN).items]
    assert notice["issue_title"] == "Imported 4 issues from Linear"


def test_a_cancelled_import_stops_and_deletes_the_key(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]], linear: FakeLinear
) -> None:
    """Cancelling keeps what was written, deletes the key, and the queued steps write nothing more."""
    job = start(client).json()
    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/{job['import_id']}/cancel")

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"
    assert not key_stored(WORKSPACE, job["import_id"])
    drain(repositories, queued)
    stored = issue_import.load_job(WORKSPACE, job["import_id"])
    assert stored is not None
    assert stored.status == "cancelled"
    assert len(repositories.planning.list_cycles(WORKSPACE, TEAM)[0]) == 1
    assert team_issues(repositories) == []
    [row] = repositories.audit.list_events(WORKSPACE, AuditQuery(action="import.cancelled")).events
    assert row.target.id == job["import_id"]
    again = client.post(f"/api/workspaces/{WORKSPACE}/imports/{job['import_id']}/cancel")
    assert again.json()["status"] == "cancelled"


def test_cancelling_an_unknown_import_is_a_404(client: TestClient, workspace: str, bucket: str) -> None:
    """There is nothing to cancel under an id the workspace never had."""
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/01JB00000000000000000NOPE/cancel")

    assert response.status_code == 404


def test_a_key_revoked_mid_import_fails_the_job_and_deletes_the_key(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]], linear: FakeLinear
) -> None:
    """Linear refusing the key part way through fails the job at once rather than retrying."""
    job = start(client).json()
    linear.keys.clear()

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))

    stored = issue_import.load_job(WORKSPACE, job["import_id"])
    assert stored is not None
    assert (stored.status, stored.error) == ("failed", "LinearAuthFailed")
    assert not key_stored(WORKSPACE, job["import_id"])
    assert len(queued) == 1
    [notice] = [dict(row) for row in repositories.inbox.list(WORKSPACE, ADMIN).items]
    assert notice["issue_title"] == "The import from Linear failed"


def test_a_job_whose_key_is_gone_fails(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]], linear: FakeLinear
) -> None:
    """A step that cannot open the sealed key fails the job instead of running without one."""
    job = start(client).json()
    linear_import.delete_key(WORKSPACE, job["import_id"])

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))

    stored = issue_import.load_job(WORKSPACE, job["import_id"])
    assert stored is not None
    assert (stored.status, stored.error) == ("failed", "KeyGone")


def test_a_sealed_key_opens_only_for_its_own_import(workspace: str, bucket: str, github_env: None) -> None:
    """A sealed key copied beside another import does not open there."""
    import boto3

    linear_import.seal_key(WORKSPACE, "01JB0000000000000000IMPRT1", FAKE_KEY)
    s3 = boto3.client("s3", region_name="us-west-2")
    raw = s3.get_object(Bucket=BUCKET, Key=linear_import.key_key(WORKSPACE, "01JB0000000000000000IMPRT1"))["Body"]
    sealed = raw.read()
    s3.put_object(Bucket=BUCKET, Key=linear_import.key_key(WORKSPACE, "01JB0000000000000000IMPRT2"), Body=sealed)

    assert FAKE_KEY.encode() not in sealed
    assert linear_import.open_key(WORKSPACE, "01JB0000000000000000IMPRT1") == FAKE_KEY
    with pytest.raises(linear_import.KeyGone):
        linear_import.open_key(WORKSPACE, "01JB0000000000000000IMPRT2")


def test_one_import_runs_per_workspace(
    client: TestClient, workspace: str, queued: list[tuple[str, Any]], linear: FakeLinear
) -> None:
    """A second import waits while the first is still queued."""
    start(client)

    response = start(client)

    assert response.status_code == 409


def test_the_key_never_reaches_a_log_the_job_an_audit_row_or_stored_data(
    client: TestClient,
    repositories: Any,
    workspace: str,
    queued: list[tuple[str, Any]],
    linear: FakeLinear,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Through a whole import, a failed one and a refused key, the key appears nowhere it could leak."""
    caplog.set_level(logging.DEBUG)
    sign_in(client, ADMIN)
    listed = client.post(f"/api/workspaces/{WORKSPACE}/imports/linear/teams", json={"api_key": FAKE_KEY})
    started = start(client)
    status = client.get(f"/api/workspaces/{WORKSPACE}/imports/{started.json()['import_id']}")
    drain(repositories, queued)
    listing = client.get(f"/api/workspaces/{WORKSPACE}/imports")
    refused = client.post(f"/api/workspaces/{WORKSPACE}/imports/linear/teams", json={"api_key": WRONG_KEY})
    second = start(client)
    linear.keys.clear()
    drain(repositories, queued)

    assert second.status_code == 202
    logged = caplog.text + "\n".join(json.dumps(vars(record), default=str) for record in caplog.records)
    answered = "\n".join(response.text for response in (listed, started, status, listing, refused, second))
    audited = "\n".join(repr(row) for row in repositories.audit.list_events(WORKSPACE, AuditQuery()).events)
    for secret in (FAKE_KEY, WRONG_KEY):
        assert secret not in logged
        assert secret not in answered
        assert secret not in audited
        assert secret not in every_stored_row()
        assert secret not in every_stored_object()
    assert not key_stored(WORKSPACE, started.json()["import_id"])
    assert not key_stored(WORKSPACE, second.json()["import_id"])


def test_the_mcp_tools_list_start_follow_and_cancel_an_import(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]], linear: FakeLinear
) -> None:
    """An agent with an admin's key lists Linear teams, starts an import, reads it and cancels it."""
    secret = mint_for(repositories, OWNER, ("settings:read", "settings:write", "admin"))

    teams = answer(tool(client, secret, "list_linear_teams", {"api_key": FAKE_KEY}))
    started = answer(
        tool(
            client,
            secret,
            "import_linear_workspace",
            {"api_key": FAKE_KEY, "teams": [{"linear_team_id": LINEAR_TEAM, "team_id": "ABC"}]},
        )
    )
    status = answer(tool(client, secret, "get_workspace_import", {"import_id": started["import_id"]}))
    cancelled = answer(tool(client, secret, "cancel_workspace_import", {"import_id": started["import_id"]}))
    unknown = refusal(tool(client, secret, "get_workspace_import", {"import_id": "01JB00000000000000000NOPE"}))
    bad_key = refusal(tool(client, secret, "list_linear_teams", {"api_key": WRONG_KEY}))

    assert teams == {"teams": [{"id": LINEAR_TEAM, "key": "ENG", "name": "Engineering ENG"}]}
    assert (started["kind"], started["status"], started["team_id"]) == ("linear", "queued", TEAM)
    assert status["import_id"] == started["import_id"]
    assert cancelled["status"] == "cancelled"
    assert not key_stored(WORKSPACE, started["import_id"])
    assert unknown
    assert "refused" in bad_key
    assert WRONG_KEY not in bad_key
    [row] = repositories.audit.list_events(WORKSPACE, AuditQuery(action="import.started")).events
    assert row.target.label == "Linear"
    assert row.after == {"preset": "linear_api", "teams": [{"linear_key": "ENG", "team_id": TEAM}]}


def test_a_member_key_cannot_import_over_mcp(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """The tools check the same admin capability the routes do."""
    secret = mint_for(repositories, MEMBER, ("settings:read", "settings:write", "admin"))

    refused = tool(client, secret, "list_linear_teams", {"api_key": FAKE_KEY})

    assert refused.json()["error"]["code"] == INSUFFICIENT_SCOPE
    assert linear.requests == []


def test_linear_row_ids_are_stable_and_distinct() -> None:
    """The same Linear record always maps to the same id, and kinds and workspaces never collide."""
    when = "2026-09-01T09:00:00.000Z"
    first = linear_import.linear_row_id(WORKSPACE, "issue", "abc", when)

    assert first == linear_import.linear_row_id(WORKSPACE, "issue", "abc", when)
    assert len(first) == 26
    assert first != linear_import.linear_row_id(WORKSPACE, "comment", "abc", when)
    assert first != linear_import.linear_row_id("01JB00000000000000000WS2", "issue", "abc", when)
    assert first[:10] < linear_import.linear_row_id(WORKSPACE, "issue", "abc", "2026-09-02T09:00:00.000Z")[:10]


def team_templates(repositories: Any) -> dict[str, Any]:
    """The team's own issue templates by name."""
    return {row.name: row for row in repositories.team_config.list_team_templates(WORKSPACE, TEAM)}


def test_missing_statuses_are_created_before_the_issues_land_in_them(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """A Linear state the team has no status for becomes one in its category, and its issues use it."""
    before = {status.name for status in repositories.team_config.list_statuses(WORKSPACE, TEAM)}

    job = start_with(client, create_statuses=True).json()

    assert job["status"] == "completed", job
    assert job["counts"]["statuses"] == 3
    statuses = repositories.team_config.list_statuses(WORKSPACE, TEAM)
    created = {status.name: status for status in statuses if status.name not in before}
    assert {name: status.category for name, status in created.items()} == {
        "Doing": "started",
        "Shipped": "completed",
        "Dropped": "cancelled",
    }
    assert all(status.import_batch_id == job["import_id"] for status in created.values())
    assert all(status.color for status in created.values())
    positions = [status.position for status in statuses if not status.hidden]
    assert len(positions) == len(set(positions))
    shipped = imported_issue(repositories, linear, 3)
    dropped = imported_issue(repositories, linear, 4)
    assert status_name(repositories, shipped.status_id) == "Shipped"
    assert status_name(repositories, dropped.status_id) == "Dropped"
    assert status_name(repositories, imported_issue(repositories, linear, 1).status_id) == "In Progress"
    assert "Templates" not in linear.operations()


def test_templates_are_imported_with_their_fields(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """Each Linear issue template becomes a team template with its title, body, priority, labels and estimate."""
    job = start_with(client, import_templates=True).json()

    assert job["status"] == "completed", job
    assert job["counts"]["templates"] == 2
    templates = team_templates(repositories)
    assert sorted(templates) == ["Bug report", "Spike"]
    bug = templates["Bug report"]
    assert bug.title == "Bug:"
    assert bug.body == "## Steps\n\n1."
    assert bug.priority == "high"
    assert bug.estimate == "3"
    assert bug.import_batch_id == job["import_id"]
    labels = {label.label_id: label for label in repositories.team_config.list_labels(WORKSPACE, TEAM)}
    assert [labels[label_id].name for label_id in bug.label_ids] == ["Bug"]
    spike = templates["Spike"]
    assert spike.body == "Timebox it."
    assert spike.priority is None
    assert spike.label_ids == []
    assert "WorkflowStates" not in linear.operations()


def test_a_second_run_creates_no_status_or_template_twice(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """Running the import again with both phases on finds what the first wrote."""
    first = start_with(client, create_statuses=True, import_templates=True).json()
    statuses = len(repositories.team_config.list_statuses(WORKSPACE, TEAM))
    labels = len(repositories.team_config.list_labels(WORKSPACE, TEAM))

    second = start_with(client, create_statuses=True, import_templates=True).json()

    assert (first["counts"]["statuses"], first["counts"]["templates"]) == (3, 2)
    assert second["status"] == "completed", second
    assert second["counts"].get("statuses", 0) == 0
    assert second["counts"].get("templates", 0) == 0
    assert len(repositories.team_config.list_statuses(WORKSPACE, TEAM)) == statuses
    assert len(repositories.team_config.list_labels(WORKSPACE, TEAM)) == labels
    assert sorted(team_templates(repositories)) == ["Bug report", "Spike"]


def test_a_template_name_the_team_already_has_is_skipped(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """A team template by the same name stays as it is and the Linear one is left out."""
    from app.common.db.dynamo.team_templates import IssueTemplate, template_key

    repositories.team_config.create_template(
        IssueTemplate(
            workspace_id=WORKSPACE,
            config_key=template_key(TEAM, "01JB0000000000000000TMPL01"),
            template_id="01JB0000000000000000TMPL01",
            team_id=TEAM,
            name="bug report",
            title="Ours",
        )
    )

    job = start_with(client, import_templates=True).json()

    assert job["counts"]["templates"] == 1
    templates = team_templates(repositories)
    assert sorted(templates) == ["Spike", "bug report"]
    assert templates["bug report"].title == "Ours"
    assert templates["bug report"].import_batch_id is None


def test_a_rejected_templates_query_still_completes_the_import(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """A schema mismatch on the templates query is a warning, never a failed import."""
    linear.rejected_operations = {"Templates"}

    job = start_with(client, import_templates=True).json()

    assert job["status"] == "completed", job
    assert job["counts"]["issues_created"] == 4
    assert job["counts"].get("templates", 0) == 0
    problems = {(problem["field"], problem["message"]) for problem in job["problems"]}
    assert ("templates", "Linear would not list the templates of ENG (graphql_validation_failed), left out") in problems


def test_the_preview_counts_statuses_and_templates_and_writes_nothing(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """The preview names what each team would gain, whether or not the phases are on, and imports nothing."""
    sign_in(client, ADMIN)
    statuses = len(repositories.team_config.list_statuses(WORKSPACE, TEAM))

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/linear/preview", json=start_body())

    assert response.status_code == 200, response.text
    [team] = response.json()["teams"]
    assert (team["linear_team_id"], team["linear_key"], team["team_id"]) == (LINEAR_TEAM, "ENG", TEAM)
    assert team["new_statuses"] == ["Doing", "Shipped", "Dropped"]
    assert team["new_templates"] == ["Bug report", "Spike"]
    assert (team["status_count"], team["template_count"]) == (3, 2)
    assert len(repositories.team_config.list_statuses(WORKSPACE, TEAM)) == statuses
    assert team_templates(repositories) == {}
    assert issue_import.list_jobs(WORKSPACE) == []
    start_with(client, create_statuses=True, import_templates=True)

    again = client.post(f"/api/workspaces/{WORKSPACE}/imports/linear/preview", json=start_body()).json()

    assert (again["teams"][0]["status_count"], again["teams"][0]["template_count"]) == (0, 0)


def test_the_queue_reports_the_optional_phases(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]], linear: FakeLinear
) -> None:
    """A team with both phases on walks statuses first and templates last."""
    job = start_with(client, create_statuses=True, import_templates=True).json()
    assert job["status"] == "queued"

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))
    middle = client.get(f"/api/workspaces/{WORKSPACE}/imports/{job['import_id']}").json()

    assert middle["phase"] == "cycles"
    assert (middle["phase_index"], middle["phase_count"]) == (1, 9)
    assert [team["create_statuses"] for team in middle["linear_teams"]] == [True]


def test_the_mcp_tool_passes_the_optional_phases(
    client: TestClient, repositories: Any, workspace: str, bucket: str, linear: FakeLinear
) -> None:
    """An agent switches the optional phases on per team the way the form does."""
    secret = mint_for(repositories, OWNER, ("settings:read", "settings:write", "admin"))
    teams = [{"linear_team_id": LINEAR_TEAM, "team_id": "ABC", "create_statuses": True, "import_templates": True}]

    started = answer(tool(client, secret, "import_linear_workspace", {"api_key": FAKE_KEY, "teams": teams}))

    assert started["status"] == "completed", started
    assert (started["counts"]["statuses"], started["counts"]["templates"]) == (3, 2)
