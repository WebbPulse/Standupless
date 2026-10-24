"""The Shortcut API importer, driven end to end against the fake Shortcut REST API.

Every test points `shortcut_import.client_factory` at `FakeShortcut` through an
in-process transport, so no request leaves the test and no real token is used.
With no queue configured an import runs inline, so most tests start one through
the route and read what it wrote straight back; the queued tests drive the
consumer a message at a time. What these tests watch: each Shortcut field lands
where it belongs, a team's stories are read page by page, a rate limit is waited
out, a second import updates what the first wrote instead of duplicating it, the
sealed token is deleted whenever a job ends, and the token never appears in a log
line, the job object, an audit row, a stored row or an answer.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.common import issue_import, linear_import
from app.domains.integrations import shortcut_api, shortcut_import
from app.domains.integrations.consumers import import_jobs
from app.domains.integrations.mcp.transport import INSUFFICIENT_SCOPE
from app.domains.integrations.shortcut_api import ShortcutClient
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE, sqs_record
from tests.domains.integrations.shortcut_fake import FAKE_TOKEN, OTHER_TEAM_ID, TEAM_ID, FakeShortcut, sample
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

BUCKET = "standupless-test-imports"

QUEUE = "https://sqs.us-west-2.amazonaws.com/1/issue-import"

WRONG_TOKEN = "sc-wrong-token-11111111-1111-4111-8111-111111111111"


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
    """Every pause the Shortcut client took, recorded instead of slept."""
    return []


@pytest.fixture
def shortcut(monkeypatch: pytest.MonkeyPatch, sleeps: list[float], repositories: Any, workspace: str) -> FakeShortcut:
    """The sample Shortcut workspace, answering every Shortcut client the code builds.

    Its stories are owned by the member, and the Standupless team is put on the
    Fibonacci scale so estimates have somewhere to land.
    """
    fake = sample("member@example.com")
    monkeypatch.setattr(
        shortcut_import,
        "client_factory",
        lambda token: ShortcutClient(token=token, transport=fake.transport(), sleep=sleeps.append),
    )
    repositories.teams.update(WORKSPACE, TEAM, estimate_scale="fibonacci")
    return fake


def start_body(token: str = FAKE_TOKEN, team_id: str = TEAM) -> dict[str, Any]:
    """The request that imports the sample team into one Standupless team."""
    return {"api_token": token, "teams": [{"shortcut_team_id": TEAM_ID, "team_id": team_id}]}


def start(client: TestClient, token: str = FAKE_TOKEN, body: Any = None) -> Any:
    """Start an import of the sample team as the admin and answer the response."""
    sign_in(client, ADMIN)
    return client.post(f"/api/workspaces/{WORKSPACE}/imports/shortcut", json=body or start_body(token))


def row_id(kind: str, shortcut_id: Any, created_at: str) -> str:
    """The id one sample Shortcut record becomes in the test workspace."""
    return shortcut_import.shortcut_row_id(WORKSPACE, kind, shortcut_id, created_at)


def imported_story(repositories: Any, fake: FakeShortcut, story_id: int) -> Any:
    """The Standupless issue one sample Shortcut story became."""
    node = fake.story(story_id)
    return repositories.issues.get(WORKSPACE, row_id("story", node["id"], node["created_at"]))


def team_issues(repositories: Any, team_id: str = TEAM) -> list[Any]:
    """Every issue in one team."""
    return repositories.issues.read_team_newest(WORKSPACE, team_id, below=None, max_items=100)


def status_name(repositories: Any, status_id: str) -> str:
    """The name of one of the team's statuses."""
    statuses = repositories.team_config.list_statuses(WORKSPACE, TEAM)
    return next(status.name for status in statuses if status.status_id == status_id)


def key_stored(workspace_id: str, import_id: str) -> bool:
    """Whether the sealed token of one import is still in the bucket."""
    import boto3

    listing = boto3.client("s3", region_name="us-west-2").list_objects_v2(
        Bucket=BUCKET, Prefix=linear_import.key_key(workspace_id, import_id)
    )
    return bool(listing.get("Contents"))


def every_stored_row() -> str:
    """Every DynamoDB row of every table, as one string a token could be searched for in."""
    from app.common.db.dynamo.client import get_client

    client = get_client()
    rows: list[Any] = []
    for name in client.list_tables()["TableNames"]:
        rows.extend(client.scan(TableName=name).get("Items", []))
    return json.dumps(rows, default=str)


def every_stored_object() -> str:
    """Every object in the import bucket but the sealed tokens, as one string."""
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


def test_the_teams_a_token_can_read_are_listed(client: TestClient, workspace: str, shortcut: FakeShortcut) -> None:
    """The admin pastes a token and sees the Shortcut teams it reads, archived ones left out."""
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/shortcut/teams", json={"api_token": f" {FAKE_TOKEN} "})

    assert response.status_code == 200, response.text
    assert response.json() == {
        "items": [
            {"id": TEAM_ID, "key": "eng", "name": "Engineering"},
            {"id": OTHER_TEAM_ID, "key": "ops", "name": "Operations"},
        ]
    }
    assert [(request.path, request.authorized) for request in shortcut.requests] == [("/api/v3/groups", True)]


def test_a_refused_token_is_a_400_that_never_repeats_the_token(
    client: TestClient, workspace: str, bucket: str, shortcut: FakeShortcut
) -> None:
    """A token Shortcut refuses answers a plain refusal, and starting or previewing with it writes nothing."""
    sign_in(client, ADMIN)

    teams = client.post(f"/api/workspaces/{WORKSPACE}/imports/shortcut/teams", json={"api_token": WRONG_TOKEN})
    previewed = client.post(f"/api/workspaces/{WORKSPACE}/imports/shortcut/preview", json=start_body(WRONG_TOKEN))
    started = client.post(f"/api/workspaces/{WORKSPACE}/imports/shortcut", json=start_body(WRONG_TOKEN))

    for response in (teams, previewed, started):
        assert response.status_code == 400
        assert response.json()["error_code"] == "SHORTCUT_TOKEN_REFUSED"
        assert WRONG_TOKEN not in response.text
    assert issue_import.list_jobs(WORKSPACE) == []


@pytest.mark.parametrize("route", ["imports/shortcut/teams", "imports/shortcut/preview", "imports/shortcut"])
def test_only_an_owner_or_admin_may_import_from_shortcut(
    client: TestClient, workspace: str, bucket: str, shortcut: FakeShortcut, route: str
) -> None:
    """A member is refused before Shortcut is ever asked."""
    sign_in(client, MEMBER)

    response = client.post(f"/api/workspaces/{WORKSPACE}/{route}", json=start_body())

    assert response.status_code == 403
    assert shortcut.requests == []


def test_a_team_the_token_cannot_read_is_a_422(
    client: TestClient, workspace: str, bucket: str, shortcut: FakeShortcut
) -> None:
    """A Shortcut team id the token does not list, an archived one, or one chosen twice starts nothing."""
    sign_in(client, ADMIN)
    unknown = {"api_token": FAKE_TOKEN, "teams": [{"shortcut_team_id": "team-nope", "team_id": TEAM}]}
    archived = {
        "api_token": FAKE_TOKEN,
        "teams": [{"shortcut_team_id": "5f0c0000-0000-4000-8000-0000000000e3", "team_id": TEAM}],
    }
    twice = {"api_token": FAKE_TOKEN, "teams": [start_body()["teams"][0], start_body()["teams"][0]]}

    for body in (unknown, archived, twice):
        response = client.post(f"/api/workspaces/{WORKSPACE}/imports/shortcut", json=body)
        assert response.status_code == 422, response.text
    empty = client.post(f"/api/workspaces/{WORKSPACE}/imports/shortcut", json={"api_token": FAKE_TOKEN, "teams": []})
    assert empty.status_code == 422
    assert issue_import.list_jobs(WORKSPACE) == []


def test_the_preview_counts_what_would_come_over_and_writes_nothing(
    client: TestClient, repositories: Any, workspace: str, bucket: str, shortcut: FakeShortcut
) -> None:
    """Stories, epics, iterations, where each state lands, new labels and owner matches, with nothing stored."""
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/shortcut/preview", json=start_body())

    assert response.status_code == 200, response.text
    [team] = response.json()["teams"]
    assert {key: team[key] for key in team if key != "statuses"} == {
        "shortcut_team_id": TEAM_ID,
        "name": "Engineering",
        "team_id": TEAM,
        "stories": 4,
        "stories_capped": False,
        "epics": 1,
        "iterations": 1,
        "new_labels": ["Bug", "Chore", "Feature", "Frontend"],
        "matched_owners": 1,
        "unmatched_owners": 1,
    }
    assert sorted((row["source"], row["status_name"], row["count"]) for row in team["statuses"]) == [
        ("Backlog", "Backlog", 1),
        ("Done", "Done", 1),
        ("In Development", "In Progress", 1),
        ("Ready", "Todo", 1),
    ]
    assert team_issues(repositories) == []
    assert issue_import.list_jobs(WORKSPACE) == []
    assert repositories.team_config.list_labels(WORKSPACE, TEAM) == []


def test_an_import_carries_every_story_field(
    client: TestClient, repositories: Any, workspace: str, bucket: str, shortcut: FakeShortcut
) -> None:
    """Title, description, tasks, state, estimate, deadline, owner, requester, labels, epic and iteration land."""
    response = start(client)

    assert response.status_code == 202, response.text
    job = response.json()
    assert job["kind"] == "shortcut"
    assert job["status"] == "completed"
    assert job["source_teams"] == [{"source_id": TEAM_ID, "key": "eng", "name": "Engineering", "team_id": TEAM}]
    parent = imported_story(repositories, shortcut, 101)
    child = imported_story(repositories, shortcut, 102)
    shipped = imported_story(repositories, shortcut, 103)
    duplicate = imported_story(repositories, shortcut, 104)
    assert sorted(issue.key for issue in team_issues(repositories)) == ["ABC-1", "ABC-2", "ABC-3", "ABC-4"]
    assert team_issues(repositories, OTHER_TEAM) == []
    assert parent.title == "Import a Shortcut workspace"
    assert parent.external_ref == "sc-101 https://app.shortcut.com/acme/story/101"
    assert parent.import_batch_id == job["import_id"]
    assert parent.body == (
        "Read Shortcut's API and write every team.\n\n**Tasks**\n- [x] Read the API\n- [ ] Write the rows"
    )
    assert child.body is None
    assert [status_name(repositories, issue.status_id) for issue in (parent, child, shipped, duplicate)] == [
        "In Progress",
        "Todo",
        "Done",
        "Backlog",
    ]
    assert {issue.priority for issue in (parent, child, shipped, duplicate)} == {"none"}
    assert parent.estimate == "3"
    assert child.estimate is None
    assert parent.due_date == "2026-09-30"
    assert parent.assignee_id == MEMBER
    assert parent.created_by == MEMBER
    assert child.assignee_id is None
    assert child.created_by == ADMIN
    assert parent.created_at.isoformat().startswith("2026-09-01T09:00")
    labels = {label.label_id: label for label in repositories.team_config.list_labels(WORKSPACE, TEAM)}
    assert sorted(labels[label_id].name for label_id in parent.label_ids) == ["Feature", "Frontend"]
    assert sorted(labels[label_id].name for label_id in shipped.label_ids) == ["Bug"]
    frontend = next(labels[label_id] for label_id in parent.label_ids if labels[label_id].name == "Frontend")
    assert frontend.color == "#eb5757"
    assert parent.cycle_id == row_id("iteration", 20, "2026-08-30T10:00:00Z")
    assert parent.project_id == row_id("epic", 10, "2026-08-01T09:00:00Z")
    assert child.project_id == parent.project_id
    assert child.cycle_id is None
    problems = {(problem["field"], problem["message"]) for problem in job["problems"]}
    assert ("estimate", "sc-102: estimate 7 is not on the team's scale, left empty") in problems
    assert ("assignee", "sc-102: no owner is a member who can see this team, left unassigned") in problems


def test_an_import_carries_comments_links_and_planning(
    client: TestClient, repositories: Any, workspace: str, bucket: str, shortcut: FakeShortcut
) -> None:
    """Comments keep author, time and thread; sub-tasks and story links link; cycles and projects are written."""
    job = start(client).json()

    parent = imported_story(repositories, shortcut, 101)
    child = imported_story(repositories, shortcut, 102)
    shipped = imported_story(repositories, shortcut, 103)
    duplicate = imported_story(repositories, shortcut, 104)
    comments = sorted(
        repositories.comments.iter_for_issue(WORKSPACE, parent.issue_id), key=lambda comment: comment.created_at
    )
    assert [(comment.author_id, comment.body) for comment in comments] == [
        (MEMBER, "First pass is up."),
        ("shortcut:Riley Stranger", "Looks good to me."),
        (MEMBER, "Agreed, thanks."),
    ]
    assert comments[2].parent_comment_id == comments[1].comment_id
    assert comments[0].created_at.isoformat().startswith("2026-09-02T09:00")
    assert all(comment.import_batch_id == job["import_id"] for comment in comments)
    assert child.parent_id == parent.issue_id
    assert repositories.relations.get(WORKSPACE, parent.issue_id, "blocks", shipped.issue_id) is not None
    assert repositories.relations.get(WORKSPACE, duplicate.issue_id, "duplicate_of", parent.issue_id) is not None
    assert repositories.relations.get(WORKSPACE, duplicate.issue_id, "relates_to", child.issue_id) is not None
    [cycle] = repositories.planning.list_cycles(WORKSPACE, TEAM)[0]
    assert (cycle.name, cycle.start_date, cycle.end_date, cycle.goal) == (
        "Sprint 7",
        "2026-09-01",
        "2026-09-14",
        "Ship the importer",
    )
    [project] = repositories.planning.list_projects(WORKSPACE)
    assert project.name == "Importer"
    assert project.description == "Move every team off Shortcut in one go."
    assert (project.status, project.lead_id, project.start_date, project.target_date) == (
        "in_progress",
        MEMBER,
        "2026-09-01",
        "2026-10-15",
    )
    assert project.team_ids == [TEAM]
    assert job["counts"] == {
        "cycles": 1,
        "projects": 1,
        "issues_created": 4,
        "labels": 4,
        "comments": 3,
        "sub_issues": 1,
        "relations": 3,
    }
    assert (job["created_count"], job["linked_count"], job["labels_created"]) == (4, 1, 4)
    assert job["phase"] is None
    assert job["phase_index"] == job["phase_count"] == 3


def test_two_teams_import_into_their_own_teams_and_share_what_names_both(
    client: TestClient, repositories: Any, workspace: str, bucket: str, shortcut: FakeShortcut
) -> None:
    """Each Shortcut team lands in its own team, a teamless iteration goes to both, and a shared epic spans both."""
    shortcut.epics[0]["group_ids"] = [TEAM_ID, OTHER_TEAM_ID]
    body = {
        "api_token": FAKE_TOKEN,
        "teams": [
            {"shortcut_team_id": TEAM_ID, "team_id": TEAM},
            {"shortcut_team_id": OTHER_TEAM_ID, "team_id": OTHER_TEAM},
        ],
    }

    job = start(client, body=body).json()

    assert job["status"] == "completed", job
    assert job["phase_count"] == 6
    assert len(team_issues(repositories)) == 4
    [other] = team_issues(repositories, OTHER_TEAM)
    assert other.title == "Rotate the on call"
    assert other.key == "XYZ-1"
    assert len(repositories.planning.list_cycles(WORKSPACE, TEAM)[0]) == 1
    assert len(repositories.planning.list_cycles(WORKSPACE, OTHER_TEAM)[0]) == 1
    projects = {project.name: project for project in repositories.planning.list_projects(WORKSPACE)}
    assert projects["Importer"].team_ids == [TEAM, OTHER_TEAM]
    assert projects["Operations only"].team_ids == [OTHER_TEAM]
    assert other.project_id == projects["Operations only"].project_id


def test_no_account_or_invite_is_made_for_unmatched_people(
    client: TestClient, repositories: Any, workspace: str, bucket: str, shortcut: FakeShortcut
) -> None:
    """Placeholder authors stand in for people Shortcut knows and the workspace does not."""
    members_before = {member.user_id for member in repositories.memberships.list_members(WORKSPACE)}

    start(client)

    assert {member.user_id for member in repositories.memberships.list_members(WORKSPACE)} == members_before
    assert repositories.invites.list_for_workspace(WORKSPACE) == []


def test_stories_are_read_page_by_page(
    client: TestClient,
    repositories: Any,
    workspace: str,
    bucket: str,
    shortcut: FakeShortcut,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With one story a page, every page is read and links across pages still land."""
    monkeypatch.setattr(shortcut_import, "PAGE_SIZE", 1)

    job = start(client).json()

    assert job["status"] == "completed"
    offsets = [request.params.get("offset") for request in shortcut.requests if request.path.endswith("/stories")]
    assert offsets == ["0", "1", "2", "3", "4"]
    assert len(team_issues(repositories)) == 4
    assert job["counts"]["relations"] == 3
    assert job["counts"]["sub_issues"] == 1


def test_a_rate_limit_is_waited_out(
    client: TestClient, repositories: Any, workspace: str, bucket: str, shortcut: FakeShortcut, sleeps: list[float]
) -> None:
    """A 429 with Retry-After pauses that long and retries, and the import still completes."""
    shortcut.rate_limit_next = 2

    job = start(client).json()

    assert job["status"] == "completed"
    assert sleeps == [2.0, 2.0]
    assert len(team_issues(repositories)) == 4


def test_a_rate_limit_that_never_lifts_is_a_502(
    client: TestClient, workspace: str, bucket: str, shortcut: FakeShortcut, sleeps: list[float]
) -> None:
    """After every retry the admin hears Shortcut is not answering, without the wait running forever."""
    shortcut.rate_limit_next = 100
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/shortcut/teams", json={"api_token": FAKE_TOKEN})

    assert response.status_code == 502
    assert response.json()["error_code"] == "SHORTCUT_UNAVAILABLE"
    assert len(sleeps) == shortcut_api.MAX_ATTEMPTS - 1


def test_a_second_import_updates_instead_of_duplicating(
    client: TestClient, repositories: Any, workspace: str, bucket: str, shortcut: FakeShortcut
) -> None:
    """Running the import again finds every row it wrote and updates it in place."""
    first = start(client).json()
    keys = sorted(issue.key for issue in team_issues(repositories))
    shortcut.story(101)["name"] = "Import a Shortcut workspace, renamed"
    parent_before = imported_story(repositories, shortcut, 101)
    relations_before = len(repositories.relations.list_for_issue(WORKSPACE, parent_before.issue_id))

    second = start(client).json()

    assert second["import_id"] != first["import_id"]
    assert second["status"] == "completed"
    assert second["counts"]["issues_updated"] == 4
    assert second["counts"].get("issues_created", 0) == 0
    assert second["counts"].get("labels", 0) == 0
    assert second["counts"].get("relations", 0) == 0
    assert second["updated_count"] == 4
    assert sorted(issue.key for issue in team_issues(repositories)) == keys
    parent = imported_story(repositories, shortcut, 101)
    assert parent.title == "Import a Shortcut workspace, renamed"
    assert parent.issue_id == parent_before.issue_id
    assert len(repositories.comments.iter_for_issue(WORKSPACE, parent.issue_id)) == 3
    assert len(repositories.relations.list_for_issue(WORKSPACE, parent.issue_id)) == relations_before
    assert len(repositories.planning.list_cycles(WORKSPACE, TEAM)[0]) == 1
    assert len(repositories.planning.list_projects(WORKSPACE)) == 1
    names = [label.name for label in repositories.team_config.list_labels(WORKSPACE, TEAM)]
    assert sorted(names) == ["Bug", "Chore", "Feature", "Frontend"]


def test_the_queue_runs_a_shortcut_import_a_step_at_a_time(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]], shortcut: FakeShortcut
) -> None:
    """Each step queues the next, the job reports its phase, and the last step deletes the token."""
    job = start(client).json()
    assert job["status"] == "queued"
    assert key_stored(WORKSPACE, job["import_id"])

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))
    middle = client.get(f"/api/workspaces/{WORKSPACE}/imports/{job['import_id']}").json()
    assert middle["status"] == "running"
    assert middle["phase"] == "epics"
    assert (middle["phase_index"], middle["phase_count"]) == (1, 3)

    drain(repositories, queued)

    done = issue_import.load_job(WORKSPACE, job["import_id"])
    assert done is not None
    assert done.status == "completed"
    assert done.counts["issues_created"] == 4
    assert not key_stored(WORKSPACE, job["import_id"])
    [notice] = [dict(row) for row in repositories.inbox.list(WORKSPACE, ADMIN).items]
    assert notice["issue_title"] == "Imported 4 issues from Shortcut"


def test_a_cancelled_import_stops_and_deletes_the_token(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]], shortcut: FakeShortcut
) -> None:
    """Cancelling keeps what was written, deletes the token, and the queued steps write nothing more."""
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


def test_a_token_revoked_mid_import_fails_the_job_and_deletes_the_token(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]], shortcut: FakeShortcut
) -> None:
    """Shortcut refusing the token part way through fails the job at once rather than retrying."""
    job = start(client).json()
    shortcut.tokens.clear()

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))

    stored = issue_import.load_job(WORKSPACE, job["import_id"])
    assert stored is not None
    assert (stored.status, stored.error) == ("failed", "ShortcutAuthFailed")
    assert not key_stored(WORKSPACE, job["import_id"])
    assert len(queued) == 1
    [notice] = [dict(row) for row in repositories.inbox.list(WORKSPACE, ADMIN).items]
    assert notice["issue_title"] == "The import from Shortcut failed"


def test_a_job_whose_token_is_gone_fails(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]], shortcut: FakeShortcut
) -> None:
    """A step that cannot open the sealed token fails the job instead of running without one."""
    job = start(client).json()
    linear_import.delete_key(WORKSPACE, job["import_id"])

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))

    stored = issue_import.load_job(WORKSPACE, job["import_id"])
    assert stored is not None
    assert (stored.status, stored.error) == ("failed", "KeyGone")


def test_a_sealed_token_opens_only_under_its_own_purpose(workspace: str, bucket: str, github_env: None) -> None:
    """A Shortcut token sealed for one import never opens as a Linear key."""
    import_id = "01JB0000000000000000IMPRT1"
    linear_import.seal_key(WORKSPACE, import_id, FAKE_TOKEN, purpose=shortcut_import.SEAL_PURPOSE)

    assert linear_import.open_key(WORKSPACE, import_id, purpose=shortcut_import.SEAL_PURPOSE) == FAKE_TOKEN
    with pytest.raises(linear_import.KeyGone):
        linear_import.open_key(WORKSPACE, import_id)


def test_one_import_runs_per_workspace(
    client: TestClient, workspace: str, queued: list[tuple[str, Any]], shortcut: FakeShortcut
) -> None:
    """A second import waits while the first is still queued."""
    start(client)

    response = start(client)

    assert response.status_code == 409


def test_the_token_never_reaches_a_log_the_job_an_audit_row_or_stored_data(
    client: TestClient,
    repositories: Any,
    workspace: str,
    queued: list[tuple[str, Any]],
    shortcut: FakeShortcut,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Through a whole import, a failed one and a refused token, the token appears nowhere it could leak."""
    caplog.set_level(logging.DEBUG)
    sign_in(client, ADMIN)
    listed = client.post(f"/api/workspaces/{WORKSPACE}/imports/shortcut/teams", json={"api_token": FAKE_TOKEN})
    previewed = client.post(f"/api/workspaces/{WORKSPACE}/imports/shortcut/preview", json=start_body())
    started = start(client)
    status = client.get(f"/api/workspaces/{WORKSPACE}/imports/{started.json()['import_id']}")
    drain(repositories, queued)
    listing = client.get(f"/api/workspaces/{WORKSPACE}/imports")
    refused = client.post(f"/api/workspaces/{WORKSPACE}/imports/shortcut/teams", json={"api_token": WRONG_TOKEN})
    second = start(client)
    shortcut.tokens.clear()
    drain(repositories, queued)

    assert second.status_code == 202
    logged = caplog.text + "\n".join(json.dumps(vars(record), default=str) for record in caplog.records)
    answered = "\n".join(response.text for response in (listed, previewed, started, status, listing, refused, second))
    audited = "\n".join(repr(row) for row in repositories.audit.list_events(WORKSPACE, AuditQuery()).events)
    for secret in (FAKE_TOKEN, WRONG_TOKEN):
        assert secret not in logged
        assert secret not in answered
        assert secret not in audited
        assert secret not in every_stored_row()
        assert secret not in every_stored_object()
    assert not key_stored(WORKSPACE, started.json()["import_id"])
    assert not key_stored(WORKSPACE, second.json()["import_id"])


def test_the_mcp_tools_list_preview_start_and_cancel_an_import(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]], shortcut: FakeShortcut
) -> None:
    """An agent with an admin's key lists Shortcut teams, previews and starts an import, and cancels it."""
    secret = mint_for(repositories, OWNER, ("settings:read", "settings:write", "admin"))
    teams_arg = [{"shortcut_team_id": TEAM_ID, "team_id": "ABC"}]

    teams = answer(tool(client, secret, "list_shortcut_teams", {"api_token": FAKE_TOKEN}))
    previewed = answer(tool(client, secret, "preview_shortcut_import", {"api_token": FAKE_TOKEN, "teams": teams_arg}))
    started = answer(tool(client, secret, "import_shortcut_workspace", {"api_token": FAKE_TOKEN, "teams": teams_arg}))
    cancelled = answer(tool(client, secret, "cancel_workspace_import", {"import_id": started["import_id"]}))
    bad_token = refusal(tool(client, secret, "list_shortcut_teams", {"api_token": WRONG_TOKEN}))

    assert teams == {
        "teams": [
            {"id": TEAM_ID, "key": "eng", "name": "Engineering"},
            {"id": OTHER_TEAM_ID, "key": "ops", "name": "Operations"},
        ]
    }
    assert previewed["teams"][0]["stories"] == 4
    assert (started["kind"], started["status"], started["team_id"]) == ("shortcut", "queued", TEAM)
    assert cancelled["status"] == "cancelled"
    assert not key_stored(WORKSPACE, started["import_id"])
    assert "refused" in bad_token
    assert WRONG_TOKEN not in bad_token
    [row] = repositories.audit.list_events(WORKSPACE, AuditQuery(action="import.started")).events
    assert row.target.label == "Shortcut"
    assert row.after == {"preset": "shortcut_api", "teams": [{"shortcut_team": "eng", "team_id": TEAM}]}


def test_a_member_key_cannot_import_over_mcp(
    client: TestClient, repositories: Any, workspace: str, bucket: str, shortcut: FakeShortcut
) -> None:
    """The tools check the same admin capability the routes do."""
    secret = mint_for(repositories, MEMBER, ("settings:read", "settings:write", "admin"))

    refused = tool(client, secret, "list_shortcut_teams", {"api_token": FAKE_TOKEN})

    assert refused.json()["error"]["code"] == INSUFFICIENT_SCOPE
    assert shortcut.requests == []


def test_shortcut_row_ids_are_stable_and_distinct_from_linear() -> None:
    """The same Shortcut record always maps to the same id, never to a Linear record's id."""
    when = "2026-09-01T09:00:00Z"
    first = shortcut_import.shortcut_row_id(WORKSPACE, "story", 101, when)

    assert first == shortcut_import.shortcut_row_id(WORKSPACE, "story", "101", when)
    assert len(first) == 26
    assert first != shortcut_import.shortcut_row_id(WORKSPACE, "comment", 101, when)
    assert first != linear_import.linear_row_id(WORKSPACE, "story", "101", when)
