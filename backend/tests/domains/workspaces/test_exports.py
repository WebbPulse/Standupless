"""The workspace export routes and the bundle they build.

Exports run inline in development, so a start here builds the whole bundle
before the response and every test can open the zip straight out of the moto
bucket. What these tests watch: every entity file is present and carries the
seeded rows, only an owner or admin may export, member emails are masked on
request, a workspace larger than one read page is walked to its end, and the
requester's inbox hears about the result.
"""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common import workspace_export
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.attachments import build_attachment
from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.documents import Document, DocumentBody
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import (
    Cycle,
    Project,
    ProjectMilestone,
    ProjectUpdateRow,
    cycle_key,
    milestone_key,
    project_key,
    project_update_key,
)
from app.common.db.dynamo.releases import Release, release_key
from app.common.db.dynamo.team_config import Label, label_key
from app.common.db.dynamo.views import SavedView, personal_view_key, team_view_key
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OWNER,
    add_member,
    add_team_member,
    make_team,
    make_user,
    make_workspace,
    sign_in,
)

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

BUCKET = "standupless-test-exports"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def bucket(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """A live moto S3 bucket with the attachments setting pointed at it."""
    import boto3
    from moto import mock_aws
    from webbpulse.storage import reset_client_cache

    from app.common.core.config import settings

    reset_client_cache()
    with mock_aws():
        boto3.client("s3", region_name="us-west-2").create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
        )
        monkeypatch.setattr(settings, "ATTACHMENTS_BUCKET", BUCKET, raising=False)
        monkeypatch.setattr(settings, "AWS_REGION", "us-west-2", raising=False)
        monkeypatch.setattr(settings, "WORKSPACE_EXPORT_QUEUE_URL", "", raising=False)
        yield BUCKET
    reset_client_cache()


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with one team and a member of each role."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, ADMIN, "admin@example.com", "Adam Admin")
    make_user(repositories, MEMBER, "member@example.com", "Mel Member")
    make_user(repositories, GUEST, "guest@example.com", "Gus Guest")
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    add_team_member(repositories, WORKSPACE, TEAM, ADMIN, "member")
    return WORKSPACE


def seed_issue(repositories: Any, number: int, *, parent_id: str | None = None) -> Issue:
    """One issue in the team, numbered so the walk reads it in order."""
    statuses = repositories.team_config.list_statuses(WORKSPACE, TEAM)
    return repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            issue_id=f"01JB00000000000000000IS{number:03d}",
            team_id=TEAM,
            key=f"ABC-{number}",
            number=number,
            title=f"Issue {number}",
            status_id=statuses[0].status_id,
            created_by=OWNER,
            parent_id=parent_id,
        )
    )


def seed_everything(repositories: Any) -> None:
    """One row of every entity a bundle has a file for."""
    repositories.team_config.create_label(
        Label(
            workspace_id=WORKSPACE,
            config_key=label_key(TEAM, "01JB0000000000000000LABL01"),
            team_id=TEAM,
            label_id="01JB0000000000000000LABL01",
            name="Bug",
            color="#d64545",
        )
    )
    first = seed_issue(repositories, 1)
    second = seed_issue(repositories, 2, parent_id=first.issue_id)
    repositories.relations.link(WORKSPACE, first.issue_id, "blocks", second.issue_id, OWNER)
    repositories.comments.create(build_comment(WORKSPACE, first.issue_id, TEAM, OWNER, "A comment"))
    repositories.attachments.create(
        build_attachment(
            WORKSPACE,
            first.issue_id,
            TEAM,
            "file",
            "spec.pdf",
            OWNER,
            s3_key=f"attachments/{WORKSPACE}/{first.issue_id}/up/spec.pdf",
            content_type="application/pdf",
            size_bytes=10,
        )
    )
    repositories.attachments.create(
        build_attachment(WORKSPACE, first.issue_id, TEAM, "link", "Docs", OWNER, url="https://example.com/docs")
    )
    project = repositories.planning.create_project(
        Project(
            workspace_id=WORKSPACE,
            planning_key=project_key("01JB0000000000000000PROJ01"),
            project_id="01JB0000000000000000PROJ01",
            team_ids=[TEAM],
            name="Launch",
            created_by=OWNER,
        )
    )
    repositories.planning.create_milestone(
        ProjectMilestone(
            workspace_id=WORKSPACE,
            planning_key=milestone_key(project.project_id, "01JB0000000000000000MILE01"),
            milestone_id="01JB0000000000000000MILE01",
            project_id=project.project_id,
            name="Beta",
            sort_order="a0",
            created_by=OWNER,
        )
    )
    repositories.planning.create_project_update(
        ProjectUpdateRow(
            workspace_id=WORKSPACE,
            planning_key=project_update_key(project.project_id, "01JB0000000000000000UPDT01"),
            update_id="01JB0000000000000000UPDT01",
            project_id=project.project_id,
            body="On track",
            health="on_track",
            author_id=OWNER,
        )
    )
    repositories.documents.create(
        Document(
            workspace_id=WORKSPACE,
            document_id="01JB0000000000000000DOCU01",
            parent_kind="project",
            parent_id=project.project_id,
            title="Launch plan",
            author_id=OWNER,
            updated_by=OWNER,
        ),
        DocumentBody(
            workspace_id=WORKSPACE,
            document_id="01JB0000000000000000DOCU01",
            parent_kind="project",
            parent_id=project.project_id,
            body="Ship it",
        ),
    )
    repositories.planning.create_cycle(
        Cycle(
            workspace_id=WORKSPACE,
            planning_key=cycle_key(TEAM, "01JB0000000000000000CYCL01"),
            cycle_id="01JB0000000000000000CYCL01",
            team_id=TEAM,
            name="Cycle 1",
            start_date="2026-10-01",
            end_date="2026-10-14",
            created_by=OWNER,
        )
    )
    repositories.releases.create(
        Release(
            workspace_id=WORKSPACE,
            planning_key=release_key(TEAM, "01JB0000000000000000RELS01"),
            release_id="01JB0000000000000000RELS01",
            team_id=TEAM,
            name="v1",
            source="manual",
        )
    )
    repositories.views.create(
        SavedView(
            workspace_id=WORKSPACE,
            view_key=team_view_key(TEAM, "01JB0000000000000000VIEW01"),
            view_id="01JB0000000000000000VIEW01",
            name="Team view",
            team_id=TEAM,
            owner_id=OWNER,
        )
    )
    repositories.views.create(
        SavedView(
            workspace_id=WORKSPACE,
            view_key=personal_view_key(ADMIN, "01JB0000000000000000VIEW02"),
            view_id="01JB0000000000000000VIEW02",
            name="Mine",
            owner_id=ADMIN,
        )
    )


def open_bundle(workspace_id: str, export_id: str) -> zipfile.ZipFile:
    """The finished bundle, read straight from the bucket."""
    import boto3

    body = (
        boto3.client("s3", region_name="us-west-2")
        .get_object(Bucket=BUCKET, Key=workspace_export.bundle_key(workspace_id, export_id))["Body"]
        .read()
    )
    return zipfile.ZipFile(io.BytesIO(body))


def rows(bundle: zipfile.ZipFile, name: str) -> list[dict[str, Any]]:
    """Every row of one entity file."""
    text = bundle.read(f"{name}.ndjson").decode()
    return [json.loads(line) for line in text.splitlines() if line]


def start(client: TestClient, **body: Any) -> Any:
    """Start an export through the route."""
    return client.post(f"/api/workspaces/{WORKSPACE}/exports", json=body or None)


def test_an_admin_exports_every_entity(client: TestClient, repositories: Any, workspace: str, bucket: str) -> None:
    """A bundle carries a manifest and one populated NDJSON file per entity."""
    seed_everything(repositories)
    sign_in(client, ADMIN)

    started = start(client)
    assert started.status_code == 202, started.text
    job = started.json()
    assert job["status"] == "ready"
    assert job["format_version"] == workspace_export.FORMAT_VERSION
    assert job["download_url"].startswith("https://")

    bundle = open_bundle(workspace, job["export_id"])
    manifest = json.loads(bundle.read("manifest.json"))
    assert manifest["format_version"] == workspace_export.FORMAT_VERSION
    assert manifest["workspace"]["slug"] == "acme"
    assert [entry["name"] for entry in manifest["files"]] == [
        f"{name}.ndjson" for name in workspace_export.ENTITY_FILES
    ]
    for name in workspace_export.ENTITY_FILES:
        assert rows(bundle, name), name

    issues = {row["key"]: row for row in rows(bundle, "issues")}
    assert issues["ABC-2"]["parent_id"] == issues["ABC-1"]["issue_id"]
    assert len(rows(bundle, "relations")) == 1
    assert {row["name"] for row in rows(bundle, "views")} == {"Team view", "Mine"}
    assert [(row["title"], row["body"]) for row in rows(bundle, "documents")] == [("Launch plan", "Ship it")]
    assert {row["email"] for row in rows(bundle, "members")} >= {"owner@example.com", "guest@example.com"}

    attachments = {row["title"]: row for row in rows(bundle, "attachments")}
    assert "s3_key" not in attachments["spec.pdf"]
    assert attachments["spec.pdf"]["download_url"].startswith("https://")
    assert attachments["spec.pdf"]["download_path"].startswith(f"/api/workspaces/{WORKSPACE}/attachments/")
    assert "download_url" not in attachments["Docs"]
    assert attachments["Docs"]["url"] == "https://example.com/docs"

    for line in rows(bundle, "comments") + rows(bundle, "issues"):
        assert not set(line) & workspace_export.STORAGE_KEYS
    assert job["counts"]["issues"] == 2


@pytest.mark.parametrize("role_user", [MEMBER, GUEST])
def test_only_an_admin_may_export(client: TestClient, workspace: str, bucket: str, role_user: str) -> None:
    """A member or guest is refused every export route."""
    sign_in(client, role_user)

    assert start(client).status_code == 403
    assert client.get(f"/api/workspaces/{WORKSPACE}/exports").status_code == 403
    assert client.get(f"/api/workspaces/{WORKSPACE}/exports/anything").status_code == 403


def test_emails_are_masked_on_request(client: TestClient, workspace: str, bucket: str) -> None:
    """Asking for no emails keeps only a hint of each address in the bundle."""
    sign_in(client, OWNER)

    job = start(client, include_emails=False).json()
    assert job["emails_masked"] is True

    emails = {row["email"] for row in rows(open_bundle(workspace, job["export_id"]), "members")}
    assert "o***@example.com" in emails
    assert not any(email.endswith("@example.com") and "***" not in email for email in emails)


def test_masking_rule() -> None:
    """Only an owner or admin who asks for addresses gets them."""
    assert workspace_export.masks_emails("admin", True) is False
    assert workspace_export.masks_emails("owner", False) is True
    assert workspace_export.masks_emails("member", True) is True
    assert workspace_export.mask_email("tyler@example.com") == "t***@example.com"
    assert workspace_export.mask_email("nope") == "***"


def test_a_large_workspace_pages_through(
    client: TestClient, repositories: Any, workspace: str, bucket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Issues and comments beyond one read page are all exported, each once."""
    monkeypatch.setattr(workspace_export, "READ_CHUNK", 3)
    for number in range(1, 11):
        seed_issue(repositories, number)
    first = f"01JB00000000000000000IS{1:03d}"
    for index in range(7):
        repositories.comments.create(build_comment(WORKSPACE, first, TEAM, OWNER, f"Comment {index}"))
    sign_in(client, ADMIN)

    job = start(client).json()
    bundle = open_bundle(workspace, job["export_id"])

    assert sorted(row["number"] for row in rows(bundle, "issues")) == list(range(1, 11))
    assert len(rows(bundle, "comments")) == 7


def test_a_second_export_waits_for_the_first(client: TestClient, workspace: str, bucket: str) -> None:
    """A queued job blocks another start with 409."""
    workspace_export.save_job(
        workspace_export.ExportJob(
            export_id="01JB0000000000000000EXPRT1",
            workspace_id=WORKSPACE,
            requested_by=OWNER,
            requester_role="owner",
        )
    )
    sign_in(client, ADMIN)

    refused = start(client)
    assert refused.status_code == 409
    assert refused.json()["error_code"] == "CONFLICT"


def test_reads_list_jobs_and_mint_a_fresh_link(client: TestClient, workspace: str, bucket: str) -> None:
    """The list omits links, a single read carries one, and an unknown id is 404."""
    sign_in(client, ADMIN)
    export_id = start(client).json()["export_id"]

    listed = client.get(f"/api/workspaces/{WORKSPACE}/exports").json()["items"]
    assert [item["export_id"] for item in listed] == [export_id]
    assert listed[0]["download_url"] is None

    one = client.get(f"/api/workspaces/{WORKSPACE}/exports/{export_id}").json()
    assert one["download_url"].startswith("https://")
    assert "requester_role" not in one

    assert client.get(f"/api/workspaces/{WORKSPACE}/exports/01JB00000000000000000NOPE").status_code == 404


def test_the_requester_hears_when_it_is_ready(
    client: TestClient, repositories: Any, workspace: str, bucket: str
) -> None:
    """A finished export leaves an inbox notice for the requester alone."""
    sign_in(client, ADMIN)
    export_id = start(client).json()["export_id"]

    notices = [row for row in repositories.inbox.list(WORKSPACE, ADMIN).items if row["kind"] == "export_ready"]
    assert len(notices) == 1
    assert notices[0]["issue_key"] == export_id
    assert repositories.inbox.list(WORKSPACE, OWNER).items == []


def test_an_unconfigured_environment_answers_503(
    client: TestClient, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No bucket means no exports, said plainly rather than as a server error."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "ATTACHMENTS_BUCKET", "", raising=False)
    sign_in(client, ADMIN)

    refused = start(client)
    assert refused.status_code == 503
    assert refused.json()["error_code"] == "NOT_CONFIGURED"


def test_the_consumer_builds_a_queued_job(repositories: Any, workspace: str, bucket: str) -> None:
    """A queue record names the job, and handling it twice builds it once."""
    from app.domains.workspaces.consumers.export import handle_record

    job = workspace_export.save_job(
        workspace_export.ExportJob(
            export_id="01JB0000000000000000EXPRT2",
            workspace_id=WORKSPACE,
            requested_by=OWNER,
            requester_role="owner",
        )
    )
    record = {
        "body": json.dumps(
            {
                "name": workspace_export.EVENT_NAME,
                "payload": {"workspace_id": WORKSPACE, "export_id": job.export_id},
                "scope": WORKSPACE,
            }
        )
    }

    handle_record(repositories, record)
    handle_record(repositories, record)

    finished = workspace_export.load_job(WORKSPACE, job.export_id)
    assert finished is not None and finished.status == "ready"
    notices = [row for row in repositories.inbox.list(WORKSPACE, OWNER).items if row["kind"] == "export_ready"]
    assert len(notices) == 1
