"""Custom workspace emoji: upload validation and resizing, names, permissions and deletion.

The routes run in the workspaces application against the mocked tables and a
versioned moto bucket, and the browser's PUT is stood in for by a `put_object`
at the key the presign call named, as the icon tests do.
"""

from __future__ import annotations

import io
from typing import Any, Iterator
from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.custom_emoji import EMOJI_SIZE, MAX_EMOJI_BYTES, check_name, is_builtin_shortcode
from app.common.discussion_reads import check_emoji
from app.common.team_purge import WORKSPACE as WORKSPACE_KIND
from app.common.team_purge import Deadline, PurgeJob
from app.domains.workspaces.consumers import purge as workspaces_purge
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, make_user, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

OTHER_MEMBER = "01JB000000000000000000OTHR"

BUCKET = "standupless-test-emoji"

BASE = f"/api/workspaces/{WORKSPACE}/emoji"


def _image(image_format: str, size: int = 32, frames: int = 1) -> bytes:
    """A real image of one format, square, with as many frames as asked for."""
    pictures = [Image.new("RGBA", (size, size), (index * 40 % 255, 120, 200, 255)) for index in range(frames)]
    buffer = io.BytesIO()
    options: dict[str, Any] = {"format": image_format}
    if frames > 1:
        options.update(save_all=True, append_images=pictures[1:], duration=80, loop=0)
    pictures[0].save(buffer, **options)
    return buffer.getvalue()


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


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """The workspaces application, which owns the emoji routes and serves their images."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app, follow_redirects=False) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with an owner, an admin, a member and a guest."""
    make_user(repositories, OWNER, "owner@example.com", "Owner")
    make_user(repositories, ADMIN, "admin@example.com", "Admin")
    make_user(repositories, MEMBER, "member@example.com", "Member")
    make_user(repositories, GUEST, "guest@example.com", "Guest")
    make_workspace(repositories, WORKSPACE, "emoji", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    return WORKSPACE


def _upload(client: TestClient, s3: Any, body: bytes, content_type: str = "image/png") -> str:
    """Presign an emoji image, leave its bytes where the PUT would, and return the upload id."""
    response = client.post(f"{BASE}/uploads", json={"content_type": content_type, "size_bytes": len(body)})
    assert response.status_code == 201, response.text
    ticket = response.json()
    key = urlparse(ticket["url"]).path.lstrip("/").removeprefix(f"{BUCKET}/")
    assert key == f"icons/emoji/{WORKSPACE}/{ticket['upload_id']}"
    s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType=content_type)
    return ticket["upload_id"]


def _add(client: TestClient, s3: Any, name: str, body: bytes | None = None, content_type: str = "image/png") -> Any:
    """Upload an image and name it, answering the create response."""
    upload_id = _upload(client, s3, body if body is not None else _image("PNG"), content_type)
    return client.post(BASE, json={"name": name, "upload_id": upload_id})


def _stored(s3: Any, name: str, client: TestClient) -> bytes:
    """The bytes stored for one listed emoji."""
    listed = {row["name"]: row for row in client.get(BASE).json()["emoji"]}
    key = "icons/" + listed[name]["url"].split("/api/icons/", 1)[1]
    return s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()


def _versions(s3: Any, prefix: str) -> list[str]:
    """Every object version and delete marker left under a prefix."""
    page = s3.list_object_versions(Bucket=BUCKET, Prefix=prefix)
    return [entry["Key"] for entry in [*page.get("Versions", []), *page.get("DeleteMarkers", [])]]


def test_a_member_adds_an_emoji_and_everyone_sees_it_with_its_uploader(
    client: TestClient, bucket: Any, workspace: str
) -> None:
    """The create answers the shortcode and URL, and the list names who uploaded it."""
    sign_in(client, MEMBER)
    created = _add(client, bucket, "party-parrot")
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["shortcode"] == ":party-parrot:"
    assert "/api/icons/emoji/" in body["url"]
    assert body["created_by"] == MEMBER

    sign_in(client, GUEST)
    listed = client.get(BASE).json()["emoji"]
    assert [(row["name"], row["created_by_name"]) for row in listed] == [("party-parrot", "Member")]

    client.headers.clear()
    served = client.get(urlparse(body["url"]).path)
    assert served.status_code == 302


def test_a_large_image_is_resized_and_animation_is_kept(client: TestClient, bucket: Any, workspace: str) -> None:
    """An image over the emoji size is shrunk in place, frames and all; a small one is untouched."""
    sign_in(client, MEMBER)
    small = _image("PNG", size=64)
    assert _add(client, bucket, "small", small).status_code == 201
    assert _stored(bucket, "small", client) == small

    assert _add(client, bucket, "big", _image("PNG", size=512)).status_code == 201
    with Image.open(io.BytesIO(_stored(bucket, "big", client))) as image:
        assert image.size == (EMOJI_SIZE, EMOJI_SIZE)

    assert _add(client, bucket, "spin", _image("GIF", size=300, frames=3), "image/gif").status_code == 201
    with Image.open(io.BytesIO(_stored(bucket, "spin", client))) as image:
        assert image.format == "GIF"
        assert image.size == (EMOJI_SIZE, EMOJI_SIZE)
        assert getattr(image, "n_frames", 1) == 3

    assert _add(client, bucket, "tide-pool", _image("WEBP", size=200), "image/webp").status_code == 201
    with Image.open(io.BytesIO(_stored(bucket, "tide-pool", client))) as image:
        assert image.format == "WEBP"
        assert max(image.size) == EMOJI_SIZE


@pytest.mark.parametrize(
    ("content_type", "size", "code"),
    [
        ("image/jpeg", 100, "UNSUPPORTED_MEDIA_TYPE"),
        ("image/svg+xml", 100, "UNSUPPORTED_MEDIA_TYPE"),
        ("image/png", MAX_EMOJI_BYTES + 1, "UPLOAD_TOO_LARGE"),
    ],
)
def test_the_presign_refuses_other_types_and_oversized_files(
    client: TestClient, bucket: Any, workspace: str, content_type: str, size: int, code: str
) -> None:
    """Only PNG, GIF and WebP under the emoji cap are signed."""
    sign_in(client, MEMBER)
    response = client.post(f"{BASE}/uploads", json={"content_type": content_type, "size_bytes": size})
    assert response.status_code == 422
    assert response.json()["error_code"] == code


def test_bytes_that_do_not_decode_are_refused_and_deleted(client: TestClient, bucket: Any, workspace: str) -> None:
    """A PNG header over garbage passes the magic check but not the decode, and does not linger."""
    sign_in(client, MEMBER)
    response = _add(client, bucket, "broken", b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
    assert response.status_code == 422
    assert response.json()["error_code"] == "INVALID_IMAGE"
    assert _versions(bucket, f"icons/emoji/{WORKSPACE}/") == []
    assert client.get(BASE).json()["emoji"] == []


def test_a_file_that_is_another_format_than_it_claims_is_refused(
    client: TestClient, bucket: Any, workspace: str
) -> None:
    """A GIF stored as a PNG is refused once Pillow says what it really is."""
    sign_in(client, MEMBER)
    upload_id = _upload(client, bucket, _image("PNG"))
    bucket.put_object(
        Bucket=BUCKET, Key=f"icons/emoji/{WORKSPACE}/{upload_id}", Body=_image("WEBP"), ContentType="image/gif"
    )
    response = client.post(BASE, json={"name": "liar", "upload_id": upload_id})
    assert response.status_code == 422


def test_names_are_unique_per_workspace(client: TestClient, bucket: Any, workspace: str) -> None:
    """A second emoji under a taken name is a conflict, and its image is not kept."""
    sign_in(client, MEMBER)
    assert _add(client, bucket, "shipit").status_code == 201
    sign_in(client, ADMIN)
    second = _add(client, bucket, "shipit")
    assert second.status_code == 409
    assert second.json()["error_code"] == "EMOJI_NAME_TAKEN"
    assert len(client.get(BASE).json()["emoji"]) == 1


@pytest.mark.parametrize("name", ["a", "Has Space", "emoji!", "x" * 33, "-leading", "tada", "thumbsup", "+1"])
def test_bad_or_builtin_names_are_refused(client: TestClient, bucket: Any, workspace: str, name: str) -> None:
    """Names are lowercase shortcodes and may not shadow a built-in one."""
    sign_in(client, MEMBER)
    assert client.post(BASE, json={"name": name, "upload_id": "a" * 22}).status_code == 422


def test_name_rules() -> None:
    """Colons and case are forgiven, built-in shortcodes in either spelling are not."""
    assert check_name(":Team-Logo:") == "team-logo"
    assert is_builtin_shortcode("thumbs-up") or is_builtin_shortcode("thumbsup")
    assert is_builtin_shortcode("tada")
    assert not is_builtin_shortcode("team-logo")


def test_a_reaction_accepts_unicode_builtin_and_custom_shortcodes() -> None:
    """A built-in shortcode becomes its emoji, a custom one stays a shortcode, and text is refused."""
    assert check_emoji(":tada:") == "\N{PARTY POPPER}"
    assert check_emoji(":Team-Logo:") == ":team-logo:"
    assert check_emoji("\N{THUMBS UP SIGN}") == "\N{THUMBS UP SIGN}"
    with pytest.raises(ValueError):
        check_emoji("team-logo")
    with pytest.raises(ValueError):
        check_emoji(":not a name:")


def test_a_guest_cannot_add_an_emoji(client: TestClient, bucket: Any, workspace: str) -> None:
    """Guests read the set but cannot sign or name an upload."""
    sign_in(client, GUEST)
    assert client.post(f"{BASE}/uploads", json={"content_type": "image/png", "size_bytes": 10}).status_code == 403
    assert client.post(BASE, json={"name": "guesty", "upload_id": "a" * 22}).status_code == 403


def test_only_the_uploader_or_an_admin_deletes(
    client: TestClient, bucket: Any, workspace: str, repositories: Any
) -> None:
    """Another member is refused; the uploader and an admin may delete, and the image goes with it."""
    make_user(repositories, OTHER_MEMBER, "other@example.com", "Other")
    add_member(repositories, WORKSPACE, OTHER_MEMBER, "member")
    sign_in(client, MEMBER)
    assert _add(client, bucket, "mine").status_code == 201
    assert _add(client, bucket, "also-mine").status_code == 201

    sign_in(client, OTHER_MEMBER)
    assert client.delete(f"{BASE}/mine").status_code == 403

    sign_in(client, MEMBER)
    assert client.delete(f"{BASE}/mine").status_code == 204
    sign_in(client, ADMIN)
    assert client.delete(f"{BASE}/also-mine").status_code == 204
    assert client.delete(f"{BASE}/also-mine").status_code == 404
    assert client.get(BASE).json()["emoji"] == []
    assert _versions(bucket, f"icons/emoji/{WORKSPACE}/") == []


def test_the_workspace_purge_deletes_every_emoji_image(repositories: Any, bucket: Any, workspace: str) -> None:
    """The workspaces purge stage clears the tenant's emoji images and nobody else's."""
    for key in (f"icons/emoji/{WORKSPACE}/{'a' * 22}", f"icons/emoji/OTHER/{'b' * 22}"):
        bucket.put_object(Bucket=BUCKET, Key=key, Body=b"x", ContentType="image/png")
    job = PurgeJob(workspace_id=WORKSPACE, team_id="", stage="teams", kind=WORKSPACE_KIND)
    workspaces_purge.workspace_step(repositories, job, Deadline(30))
    assert _versions(bucket, "icons/emoji/") == [f"icons/emoji/OTHER/{'b' * 22}"]
