"""Fixtures the discussion route tests share: a client and a seeded two-project tenant.

The tenant mirrors the issues domain's, because the authorization rule is the same
one: a comment, a reaction and an attachment are readable exactly when the issue's
project is, so the guest holds a membership in one project and not the other and
every fail-closed test is a read of the second.

Issues are seeded through the repository rather than through a route, because this
domain only reads the `issues` table and has no route that writes one.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OWNER,
    add_member,
    add_project_member,
    make_project,
    make_user,
    make_workspace,
)

WORKSPACE = "01JB00000000000000000000WS"

PROJECT = "01JB000000000000000000PRJ1"

OTHER_PROJECT = "01JB000000000000000000PRJ2"

BUCKET = "standupless-test-attachments"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the discussion application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["discussion"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with two projects and one member of each workspace role.

    The guest is a member of `PROJECT` alone, which is what makes `OTHER_PROJECT`
    the thing a guest must not reach by any id.
    """
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, ADMIN, "admin@example.com", "Adam Admin")
    make_user(repositories, MEMBER, "member@example.com", "Mel Member")
    make_user(repositories, GUEST, "guest@example.com", "Gus Guest")
    make_project(repositories, WORKSPACE, PROJECT, "ABC")
    make_project(repositories, WORKSPACE, OTHER_PROJECT, "XYZ")
    add_project_member(repositories, WORKSPACE, PROJECT, GUEST, "member")
    return WORKSPACE


def seed_issue(repositories: Any, workspace_id: str, project_id: str, issue_id: str, number: int = 1) -> Issue:
    """Put one issue row in, so a comment has something to hang off.

    Written straight to the table because this domain reads `issues` and never
    writes it, so there is no route here that could create one.
    """
    statuses = repositories.project_config.list_statuses(workspace_id, project_id)
    return repositories.issues.create(
        Issue(
            workspace_id=workspace_id,
            issue_id=issue_id,
            project_id=project_id,
            key=f"ABC-{number}",
            number=number,
            title="An issue",
            status_id=statuses[0].status_id,
            created_by=OWNER,
        )
    )


@pytest.fixture
def issue(repositories: Any, workspace: str) -> Issue:
    """One issue in the project every role can see."""
    return seed_issue(repositories, workspace, PROJECT, "01JB0000000000000000000IS1", 1)


@pytest.fixture
def hidden_issue(repositories: Any, workspace: str) -> Issue:
    """One issue in the project the guest is outside of.

    Every fail-closed test reads this one as the guest and expects a 404 rather
    than a 403, so the id itself tells the guest nothing.
    """
    return seed_issue(repositories, workspace, OTHER_PROJECT, "01JB0000000000000000000IS2", 1)


@pytest.fixture
def attachments_bucket(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """A live moto S3 bucket, with the setting pointed at it.

    The presigners are real, so the signature, the headers and the key under test
    are the ones a deployed function would produce, and `object_exists` runs its
    real `HeadObject` against this bucket.

    The signed URL is not fetched over HTTP. moto answers a presigned request by
    looking the signing key up among its own IAM users and refuses the credentials
    it installs itself, so a PUT through the URL fails for a reason no deployment
    produces. A test that needs the object in the bucket puts it with the client
    instead, which is what the browser's PUT would have left behind.
    """
    import boto3
    from moto import mock_aws
    from webbpulse.storage import reset_client_cache

    from app.common.core.config import settings

    reset_client_cache()
    with mock_aws():
        client = boto3.client("s3", region_name="us-west-2")
        client.create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
        )
        monkeypatch.setattr(settings, "ATTACHMENTS_BUCKET", BUCKET, raising=False)
        yield BUCKET
    reset_client_cache()


def put_object(key: str, body: bytes, content_type: str = "image/png") -> None:
    """Leave one object in the bucket, standing in for the browser's PUT.

    Called inside the `attachments_bucket` fixture's mock, so it writes to the same
    backend the commit route's `HeadObject` reads.
    """
    import boto3

    boto3.client("s3", region_name="us-west-2").put_object(Bucket=BUCKET, Key=key, Body=body, ContentType=content_type)
