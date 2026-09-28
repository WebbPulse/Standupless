"""Workspace, team and person icons: permissions, validation, serving and cleanup.

Each route runs in its own domain's application against the mocked tables, so a
route reaching a table its function is not granted fails here as it would when
deployed. The bucket is a versioned moto bucket like the deployed one, and the
browser's PUT is stood in for by a direct `put_object` at the key the presign
call named, because moto refuses the credentials it signs with.
"""

from __future__ import annotations

from typing import Any, Iterator
from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.icons import MAX_ICON_BYTES, delete_icon_objects, parse_icon_path
from app.common.team_purge import WORKSPACE as WORKSPACE_KIND
from app.common.team_purge import Deadline, PurgeJob
from app.domains.teams.consumers import purge as teams_purge
from app.domains.workspaces.consumers import purge as workspaces_purge
from tests.domains.helpers import (
    ADMIN,
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

BUCKET = "standupless-test-icons"

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64

WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 64


@pytest.fixture
def bucket(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """A versioned moto bucket with the setting pointed at it, yielding its client."""
    import boto3
    from moto import mock_aws
    from webbpulse.storage import reset_client_cache

    from app.common.core.config import settings

    reset_client_cache()
    with mock_aws():
        client = boto3.client("s3", region_name="us-west-2")
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "us-west-2"})
        client.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={"Status": "Enabled"})
        monkeypatch.setattr(settings, "ATTACHMENTS_BUCKET", BUCKET, raising=False)
        monkeypatch.setattr(settings, "AWS_REGION", "us-west-2", raising=False)
        yield client
    reset_client_cache()


def _client(repositories: Any, domain: str) -> Iterator[TestClient]:
    """A client for one domain's application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS[domain])
    bind_repositories(app, repositories)
    with TestClient(app, follow_redirects=False) as client:
        yield client


@pytest.fixture
def workspaces(repositories: Any) -> Iterator[TestClient]:
    """The workspaces application, which also serves every icon URL."""
    yield from _client(repositories, "workspaces")


@pytest.fixture
def teams(repositories: Any) -> Iterator[TestClient]:
    """The teams application."""
    yield from _client(repositories, "teams")


@pytest.fixture
def identity(repositories: Any) -> Iterator[TestClient]:
    """The identity application, which owns the caller's avatar."""
    yield from _client(repositories, "identity")


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with an owner, an admin and a member, and one team."""
    make_user(repositories, OWNER, "owner@example.com", "Owner")
    make_user(repositories, ADMIN, "admin@example.com", "Admin")
    make_user(repositories, MEMBER, "member@example.com", "Member")
    make_workspace(repositories, WORKSPACE, "icons", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_team(repositories, WORKSPACE, TEAM, "ICO")
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    return WORKSPACE


def _upload(client: TestClient, s3: Any, base: str, body: bytes, content_type: str = "image/png") -> str:
    """Presign an icon, leave its bytes where the PUT would, and return the upload id."""
    response = client.post(f"{base}/uploads", json={"content_type": content_type, "size_bytes": len(body)})
    assert response.status_code == 201, response.text
    ticket = response.json()
    key = urlparse(ticket["url"]).path.lstrip("/").removeprefix(f"{BUCKET}/")
    assert key.endswith(ticket["upload_id"])
    assert ticket["headers"]["Content-Type"] == content_type
    s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType=content_type)
    return ticket["upload_id"]


def _versions(s3: Any, prefix: str) -> list[str]:
    """Every object version and delete marker left under a prefix."""
    page = s3.list_object_versions(Bucket=BUCKET, Prefix=prefix)
    return [entry["Key"] for entry in [*page.get("Versions", []), *page.get("DeleteMarkers", [])]]


def _key_of(url: str) -> str:
    """The object key an icon URL names."""
    key = parse_icon_path(url.split("/api/icons/", 1)[1])
    assert key is not None
    return key


def test_an_admin_sets_replaces_and_clears_the_workspace_icon(
    workspaces: TestClient, bucket: Any, workspace: str
) -> None:
    """Each commit shows on the workspace reads, and a replaced or cleared logo is deleted with every version."""
    sign_in(workspaces, ADMIN)
    base = f"/api/workspaces/{workspace}/icon"
    first = workspaces.put(base, json={"upload_id": _upload(workspaces, bucket, base, PNG)})
    assert first.status_code == 200, first.text
    first_url = first.json()["icon_url"]
    assert first_url.startswith("http") and "/api/icons/workspace/" in first_url
    first_key = _key_of(first_url)
    bucket.put_object(Bucket=BUCKET, Key=first_key, Body=PNG, ContentType="image/png")

    listed = workspaces.get("/api/workspaces").json()["workspaces"]
    assert listed[0]["icon_url"] == first_url
    assert workspaces.get(f"/api/workspaces/{workspace}").json()["icon_url"] == first_url

    second = workspaces.put(base, json={"upload_id": _upload(workspaces, bucket, base, JPEG, "image/jpeg")})
    assert second.status_code == 200
    second_key = _key_of(second.json()["icon_url"])
    assert second_key != first_key
    assert set(_versions(bucket, f"icons/workspace/{workspace}/")) == {second_key}

    cleared = workspaces.delete(base)
    assert cleared.status_code == 200
    assert cleared.json()["icon_url"] is None
    assert _versions(bucket, f"icons/workspace/{workspace}/") == []


def test_a_member_cannot_change_the_workspace_icon(workspaces: TestClient, bucket: Any, workspace: str) -> None:
    """Presign, commit and clear are workspace admin only."""
    sign_in(workspaces, MEMBER)
    base = f"/api/workspaces/{workspace}/icon"
    assert workspaces.post(f"{base}/uploads", json={"content_type": "image/png", "size_bytes": 10}).status_code == 403
    assert workspaces.put(base, json={"upload_id": "a" * 22}).status_code == 403
    assert workspaces.delete(base).status_code == 403


@pytest.mark.parametrize(
    ("content_type", "size", "code"),
    [
        ("image/svg+xml", 100, "UNSUPPORTED_MEDIA_TYPE"),
        ("text/html", 100, "UNSUPPORTED_MEDIA_TYPE"),
        ("image/png", MAX_ICON_BYTES + 1, "UPLOAD_TOO_LARGE"),
    ],
)
def test_the_presign_refuses_other_types_and_oversized_files(
    workspaces: TestClient, bucket: Any, workspace: str, content_type: str, size: int, code: str
) -> None:
    """SVG and anything not a raster image are refused, as is a file over the cap."""
    sign_in(workspaces, OWNER)
    response = workspaces.post(
        f"/api/workspaces/{workspace}/icon/uploads", json={"content_type": content_type, "size_bytes": size}
    )
    assert response.status_code == 422
    assert response.json()["error_code"] == code


def test_a_commit_before_the_upload_lands_is_a_conflict(workspaces: TestClient, bucket: Any, workspace: str) -> None:
    """No object at the key means the PUT has not finished, and nothing is recorded."""
    sign_in(workspaces, OWNER)
    response = workspaces.put(f"/api/workspaces/{workspace}/icon", json={"upload_id": "b" * 22})
    assert response.status_code == 409
    assert workspaces.get(f"/api/workspaces/{workspace}").json()["icon_url"] is None


def test_a_malformed_upload_id_is_refused(workspaces: TestClient, bucket: Any, workspace: str) -> None:
    """An upload id outside the minted shape never becomes a key."""
    sign_in(workspaces, OWNER)
    response = workspaces.put(f"/api/workspaces/{workspace}/icon", json={"upload_id": "../../attachments"})
    assert response.status_code == 422


def test_bytes_that_are_not_the_claimed_image_are_refused_and_deleted(
    workspaces: TestClient, bucket: Any, workspace: str
) -> None:
    """A file whose magic number does not match its type is a 422 and does not linger."""
    sign_in(workspaces, OWNER)
    base = f"/api/workspaces/{workspace}/icon"
    upload_id = _upload(workspaces, bucket, base, b"<html><script>alert(1)</script></html>")
    response = workspaces.put(base, json={"upload_id": upload_id})
    assert response.status_code == 422
    assert response.json()["error_code"] == "INVALID_IMAGE"
    assert _versions(bucket, f"icons/workspace/{workspace}/") == []


def test_an_object_stored_under_another_type_is_refused(workspaces: TestClient, bucket: Any, workspace: str) -> None:
    """The stored content type is checked too, not only the one declared at presign."""
    sign_in(workspaces, OWNER)
    base = f"/api/workspaces/{workspace}/icon"
    upload_id = _upload(workspaces, bucket, base, PNG)
    bucket.put_object(
        Bucket=BUCKET, Key=f"icons/workspace/{workspace}/{upload_id}", Body=PNG, ContentType="image/svg+xml"
    )
    response = workspaces.put(base, json={"upload_id": upload_id})
    assert response.status_code == 422
    assert response.json()["error_code"] == "UNSUPPORTED_MEDIA_TYPE"


def test_an_oversized_object_is_refused(workspaces: TestClient, bucket: Any, workspace: str) -> None:
    """The stored size is checked against the cap, whatever the presign was told."""
    sign_in(workspaces, OWNER)
    base = f"/api/workspaces/{workspace}/icon"
    upload_id = _upload(workspaces, bucket, base, PNG)
    bucket.put_object(
        Bucket=BUCKET,
        Key=f"icons/workspace/{workspace}/{upload_id}",
        Body=PNG + b"\x00" * MAX_ICON_BYTES,
        ContentType="image/png",
    )
    response = workspaces.put(base, json={"upload_id": upload_id})
    assert response.status_code == 422
    assert response.json()["error_code"] == "UPLOAD_TOO_LARGE"


def test_the_icon_route_redirects_only_icon_keys(workspaces: TestClient, bucket: Any, workspace: str) -> None:
    """An icon key redirects to a presigned GET with no credential, and any other path is a 404."""
    sign_in(workspaces, OWNER)
    base = f"/api/workspaces/{workspace}/icon"
    url = workspaces.put(base, json={"upload_id": _upload(workspaces, bucket, base, WEBP, "image/webp")}).json()[
        "icon_url"
    ]
    workspaces.headers.clear()
    path = urlparse(url).path
    response = workspaces.get(path)
    assert response.status_code == 302
    assert _key_of(url) in response.headers["location"]
    assert "X-Amz-Signature" in response.headers["location"]
    assert response.headers["cache-control"].startswith("private, max-age=")

    for bad in (
        "/api/icons/workspace/x",
        f"/api/icons/workspace/{workspace}/short",
        "/api/icons/../workspaces/x/attachments/y/abcdefghijklmnopqrstuv",
        "/api/icons/other/abc/abcdefghijklmnopqrstuv",
    ):
        assert workspaces.get(bad).status_code == 404, bad


def test_a_team_admin_sets_the_team_icon_and_a_member_cannot(teams: TestClient, bucket: Any, workspace: str) -> None:
    """The team icon is team admin only and shows on the single and list reads."""
    base = f"/api/workspaces/{workspace}/teams/{TEAM}/icon"
    sign_in(teams, MEMBER)
    assert teams.post(f"{base}/uploads", json={"content_type": "image/png", "size_bytes": 10}).status_code == 403
    assert teams.delete(base).status_code == 403

    sign_in(teams, ADMIN)
    response = teams.put(base, json={"upload_id": _upload(teams, bucket, base, PNG)})
    assert response.status_code == 200, response.text
    url = response.json()["icon_url"]
    assert f"/api/icons/team/{workspace}/{TEAM}/" in url
    listed = teams.get(f"/api/workspaces/{workspace}/teams").json()["teams"]
    assert [row["icon_url"] for row in listed] == [url]

    cleared = teams.delete(base)
    assert cleared.json()["icon_url"] is None
    assert _versions(bucket, f"icons/team/{workspace}/{TEAM}/") == []


def test_a_person_sets_their_avatar_and_it_shows_on_member_lists(
    identity: TestClient, workspaces: TestClient, teams: TestClient, bucket: Any, workspace: str
) -> None:
    """The avatar lands on `/me`, the workspace members and the team members, and clearing deletes it."""
    sign_in(identity, MEMBER)
    base = "/api/users/me/avatar"
    response = identity.put(base, json={"upload_id": _upload(identity, bucket, base, PNG)})
    assert response.status_code == 200, response.text
    url = response.json()["avatar_url"]
    assert f"/api/icons/user/{MEMBER}/" in url
    assert identity.get("/api/users/me").json()["avatar_url"] == url

    sign_in(workspaces, OWNER)
    members = workspaces.get(f"/api/workspaces/{workspace}/members").json()["members"]
    assert {row["user_id"]: row["avatar_url"] for row in members}[MEMBER] == url
    assert {row["user_id"]: row["avatar_url"] for row in members}[OWNER] is None

    sign_in(teams, OWNER)
    team_members = teams.get(f"/api/workspaces/{workspace}/teams/{TEAM}/members").json()["members"]
    assert [row["avatar_url"] for row in team_members if row["user_id"] == MEMBER] == [url]

    cleared = identity.delete(base)
    assert cleared.status_code == 200
    assert cleared.json()["avatar_url"] is None
    assert _versions(bucket, f"icons/user/{MEMBER}/") == []


def test_a_committed_avatar_sweeps_uploads_that_were_never_committed(
    identity: TestClient, bucket: Any, workspace: str
) -> None:
    """An abandoned presign under the same owner is deleted by the next commit."""
    sign_in(identity, OWNER)
    base = "/api/users/me/avatar"
    _upload(identity, bucket, base, PNG)
    kept = _upload(identity, bucket, base, PNG)
    identity.put(base, json={"upload_id": kept})
    assert _versions(bucket, f"icons/user/{OWNER}/") == [f"icons/user/{OWNER}/{kept}"]


def _seed(s3: Any, key: str) -> None:
    """Leave two versions of one icon, as a replaced upload would."""
    s3.put_object(Bucket=BUCKET, Key=key, Body=PNG, ContentType="image/png")
    s3.put_object(Bucket=BUCKET, Key=key, Body=PNG, ContentType="image/png")


def test_the_team_purge_deletes_the_team_icon(repositories: Any, bucket: Any, workspace: str) -> None:
    """Deleting a team removes every version of its icon and leaves other teams' alone."""
    doomed = f"icons/team/{workspace}/{TEAM}/{'a' * 22}"
    kept = f"icons/team/{workspace}/OTHERTEAM/{'b' * 22}"
    _seed(bucket, doomed)
    _seed(bucket, kept)
    repositories.teams.mark_deleting(workspace, TEAM)
    teams_purge.step(repositories, PurgeJob(workspace_id=workspace, team_id=TEAM, stage="teams"), Deadline(30))
    assert set(_versions(bucket, f"icons/team/{workspace}/")) == {kept}


def test_the_workspace_purge_deletes_the_logo_and_every_team_icon(
    repositories: Any, bucket: Any, workspace: str
) -> None:
    """The teams and workspaces stages clear the tenant's icons, and nobody else's."""
    _seed(bucket, f"icons/workspace/{workspace}/{'a' * 22}")
    _seed(bucket, f"icons/team/{workspace}/{TEAM}/{'b' * 22}")
    _seed(bucket, f"icons/workspace/OTHER/{'c' * 22}")
    job = PurgeJob(workspace_id=workspace, team_id="", stage="teams", kind=WORKSPACE_KIND)
    teams_purge.workspace_step(repositories, job, Deadline(30))
    workspaces_purge.workspace_step(repositories, job, Deadline(30))
    assert _versions(bucket, "icons/") == [f"icons/workspace/OTHER/{'c' * 22}"] * 2


def test_the_account_purge_deletes_the_avatar(repositories: Any, bucket: Any, workspace: str) -> None:
    """The account's last step deletes every version of the avatar before the users row."""
    _seed(bucket, f"icons/user/{MEMBER}/{'a' * 22}")
    _seed(bucket, f"icons/user/{OWNER}/{'b' * 22}")
    job = PurgeJob(workspace_id="", team_id="", stage="workspaces", user_id=MEMBER)
    workspaces_purge.account_step(repositories, job, Deadline(30))
    assert set(_versions(bucket, "icons/user/")) == {f"icons/user/{OWNER}/{'b' * 22}"}


def test_cleanup_refuses_a_prefix_outside_icons() -> None:
    """The sweep can never be pointed at attachments or the whole bucket."""
    for prefix in ("", "workspaces/", "icons", "icons/workspace/x"):
        with pytest.raises(ValueError):
            delete_icon_objects(prefix)
