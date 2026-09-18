"""The attachment routes: the URL attachment, the three call upload, and the reads.

The upload tests run against a real moto bucket with the real presigners, so the
signed URL, its headers and its key are the ones a deployed function would mint.
The browser's PUT is stood in for by writing the object with the client, because
moto refuses a presigned request signed by the credentials it installs itself; what
that PUT would have left behind is an object at the signed key, which is exactly
what the commit route's existence check reads.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.domains.discussion.schemas.discussion import MAX_UPLOAD_BYTES
from tests.domains.discussion.conftest import put_object
from tests.domains.helpers import ADMIN, MEMBER, sign_in

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


def request_upload(client: TestClient, workspace: str, issue_id: str, **payload: Any) -> "dict[str, Any]":
    """Ask for a ticket, failing loudly on a refusal."""
    body: "dict[str, Any]" = {
        "issue_id": issue_id,
        "filename": "shot.png",
        "content_type": "image/png",
        "size_bytes": len(PNG),
    }
    body.update(payload)
    response = client.post(f"/api/workspaces/{workspace}/attachments/uploads", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def land_object(ticket: "dict[str, Any]", body: bytes = PNG) -> None:
    """Leave the object the browser's PUT would have left at the signed key."""
    put_object(ticket["s3_key"], body)


def upload(client: TestClient, workspace: str, issue_id: str, **payload: Any) -> "dict[str, Any]":
    """The whole three call upload, answering with the committed attachment."""
    ticket = request_upload(client, workspace, issue_id, **payload)
    land_object(ticket)
    response = client.post(
        f"/api/workspaces/{workspace}/attachments",
        json={"issue_id": issue_id, "upload_id": ticket["upload_id"], "ticket": ticket["ticket"]},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_a_member_attaches_a_url(client: TestClient, workspace: str, issue: Any) -> None:
    """The URL attachment is recorded with a derived favicon and no fetch."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/attachments/url",
        json={"issue_id": issue.issue_id, "url": "https://example.com/spec", "title": "The spec"},
    )
    assert response.status_code == 201, response.text
    created = response.json()

    assert created["kind"] == "url"
    assert created["title"] == "The spec"
    assert created["url"] == "https://example.com/spec"
    assert created["favicon_url"]
    assert created["uploaded_by"] == MEMBER
    assert created["s3_key"] is None


def test_a_url_title_defaults_to_the_host(client: TestClient, workspace: str, issue: Any) -> None:
    """No crawl, so an unnamed link is titled by the only thing already known."""
    sign_in(client, MEMBER)
    created = client.post(
        f"/api/workspaces/{workspace}/attachments/url",
        json={"issue_id": issue.issue_id, "url": "https://example.com/spec"},
    ).json()
    assert created["title"] == "example.com"


def test_an_http_url_is_refused(client: TestClient, workspace: str, issue: Any) -> None:
    """Refused rather than upgraded, because a reader follows what was stored."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/attachments/url",
        json={"issue_id": issue.issue_id, "url": "http://example.com/spec"},
    )
    assert response.status_code == 422, response.text


def test_an_upload_ticket_signs_the_type_and_the_size(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """The ticket hands back the exact headers S3 will enforce."""
    sign_in(client, MEMBER)
    ticket = request_upload(client, workspace, issue.issue_id)

    assert ticket["upload_id"]
    assert ticket["ticket"]
    assert ticket["s3_key"].startswith(f"workspaces/{workspace}/issues/{issue.issue_id}/")
    assert ticket["headers"]["Content-Type"] == "image/png"
    assert ticket["headers"]["Content-Length"] == str(len(PNG))
    assert ticket["max_bytes"] == len(PNG)


def test_the_three_call_upload_records_an_attachment(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """Presign, PUT, commit: only the third call makes the object visible."""
    sign_in(client, MEMBER)
    created = upload(client, workspace, issue.issue_id)

    assert created["kind"] == "file"
    assert created["title"] == "shot.png"
    assert created["content_type"] == "image/png"
    assert created["size_bytes"] == len(PNG)
    assert created["s3_key"]
    assert created["uploaded_by"] == MEMBER


def test_the_recorded_type_comes_from_the_ticket(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """The commit body cannot restate a type or size other than the signed one."""
    sign_in(client, MEMBER)
    ticket = request_upload(client, workspace, issue.issue_id)
    land_object(ticket)

    created = client.post(
        f"/api/workspaces/{workspace}/attachments",
        json={
            "issue_id": issue.issue_id,
            "upload_id": ticket["upload_id"],
            "ticket": ticket["ticket"],
            "content_type": "text/html",
            "size_bytes": 999999,
        },
    ).json()
    assert created["content_type"] == "image/png"
    assert created["size_bytes"] == len(PNG)


def test_a_commit_title_overrides_the_filename(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """A caller may name the attachment; the filename is only the fallback."""
    sign_in(client, MEMBER)
    ticket = request_upload(client, workspace, issue.issue_id)
    land_object(ticket)

    created = client.post(
        f"/api/workspaces/{workspace}/attachments",
        json={
            "issue_id": issue.issue_id,
            "upload_id": ticket["upload_id"],
            "ticket": ticket["ticket"],
            "title": "The screenshot",
        },
    ).json()
    assert created["title"] == "The screenshot"


def test_committing_an_upload_that_never_happened_is_a_conflict(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """A row pointing at nothing is the failure the existence check prevents."""
    sign_in(client, MEMBER)
    ticket = request_upload(client, workspace, issue.issue_id)

    response = client.post(
        f"/api/workspaces/{workspace}/attachments",
        json={"issue_id": issue.issue_id, "upload_id": ticket["upload_id"], "ticket": ticket["ticket"]},
    )
    assert response.status_code == 409, response.text


def test_an_unsupported_type_never_gets_a_signature(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """Refused before signing, so the object is never created at all."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/attachments/uploads",
        json={
            "issue_id": issue.issue_id,
            "filename": "run.exe",
            "content_type": "application/x-msdownload",
            "size_bytes": 10,
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "UNSUPPORTED_MEDIA_TYPE"


def test_svg_is_refused_even_though_the_package_allows_it(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """An SVG is a script the bucket origin would otherwise be asked to serve."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/attachments/uploads",
        json={
            "issue_id": issue.issue_id,
            "filename": "logo.svg",
            "content_type": "image/svg+xml",
            "size_bytes": 10,
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "UNSUPPORTED_MEDIA_TYPE"


def test_a_file_over_the_cap_is_refused_before_the_upload(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """Refused at the start rather than at the end of a long upload."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/attachments/uploads",
        json={
            "issue_id": issue.issue_id,
            "filename": "huge.png",
            "content_type": "image/png",
            "size_bytes": MAX_UPLOAD_BYTES + 1,
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "UPLOAD_TOO_LARGE"


def test_the_signed_size_is_the_declared_one(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """`Content-Length` is inside the signature, so the cap is not advisory.

    S3 refuses a PUT whose length differs from the signed one, which is what makes
    the declared size an enforced ceiling rather than a hint the client could raise.
    """
    sign_in(client, MEMBER)
    ticket = request_upload(client, workspace, issue.issue_id)

    assert ticket["headers"]["Content-Length"] == str(len(PNG))
    assert ticket["max_bytes"] == len(PNG)


def test_an_attachment_lists_on_its_issue(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """The list is the issue's attachments and mints no URL for any of them."""
    sign_in(client, MEMBER)
    upload(client, workspace, issue.issue_id)
    client.post(
        f"/api/workspaces/{workspace}/attachments/url",
        json={"issue_id": issue.issue_id, "url": "https://example.com/spec"},
    )

    response = client.get(f"/api/workspaces/{workspace}/attachments", params={"issue_id": issue.issue_id})
    assert response.status_code == 200, response.text
    rows = response.json()["attachments"]
    assert len(rows) == 2
    assert {row["kind"] for row in rows} == {"file", "url"}

    by_kind = {row["kind"]: row for row in rows}
    assert by_kind["url"]["url"] == "https://example.com/spec"
    assert by_kind["file"]["url"] is None


def test_the_attachment_list_pages(client: TestClient, workspace: str, issue: Any) -> None:
    """A page hands back a cursor that resumes exactly where it stopped."""
    sign_in(client, MEMBER)
    for index in range(3):
        client.post(
            f"/api/workspaces/{workspace}/attachments/url",
            json={"issue_id": issue.issue_id, "url": f"https://example.com/{index}"},
        )

    first = client.get(
        f"/api/workspaces/{workspace}/attachments",
        params={"issue_id": issue.issue_id, "limit": 2},
    ).json()
    assert len(first["attachments"]) == 2
    assert first["next_cursor"]

    second = client.get(
        f"/api/workspaces/{workspace}/attachments",
        params={"issue_id": issue.issue_id, "limit": 2, "cursor": first["next_cursor"]},
    ).json()
    assert len(second["attachments"]) == 1


def test_a_download_url_is_minted_per_request(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """The URL names the stored key and expires, and two calls are two URLs."""
    sign_in(client, MEMBER)
    created = upload(client, workspace, issue.issue_id)

    response = client.get(
        f"/api/workspaces/{workspace}/attachments/{created['attachment_id']}/download",
        params={"issue_id": issue.issue_id},
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert created["s3_key"] in body["url"]
    assert "X-Amz-Signature" in body["url"]
    assert body["expires_at"]


def test_a_download_forces_a_filename(client: TestClient, workspace: str, issue: Any, attachments_bucket: str) -> None:
    """The disposition rides in the signature, so a ULID key saves under a name."""
    sign_in(client, MEMBER)
    created = upload(client, workspace, issue.issue_id)

    url = client.get(
        f"/api/workspaces/{workspace}/attachments/{created['attachment_id']}/download",
        params={"issue_id": issue.issue_id},
    ).json()["url"]
    assert "response-content-disposition" in url.lower()


def test_a_link_has_nothing_to_download(client: TestClient, workspace: str, issue: Any) -> None:
    """A URL attachment has no object, so the download route refuses it."""
    sign_in(client, MEMBER)
    created = client.post(
        f"/api/workspaces/{workspace}/attachments/url",
        json={"issue_id": issue.issue_id, "url": "https://example.com/spec"},
    ).json()

    response = client.get(
        f"/api/workspaces/{workspace}/attachments/{created['attachment_id']}/download",
        params={"issue_id": issue.issue_id},
    )
    assert response.status_code == 422, response.text


def test_the_uploader_detaches_their_own_attachment(client: TestClient, workspace: str, issue: Any) -> None:
    """The row is what a reader sees, so removing it is the whole delete."""
    sign_in(client, MEMBER)
    created = client.post(
        f"/api/workspaces/{workspace}/attachments/url",
        json={"issue_id": issue.issue_id, "url": "https://example.com/spec"},
    ).json()

    response = client.delete(
        f"/api/workspaces/{workspace}/attachments/{created['attachment_id']}",
        params={"issue_id": issue.issue_id},
    )
    assert response.status_code == 204, response.text

    rows = client.get(
        f"/api/workspaces/{workspace}/attachments",
        params={"issue_id": issue.issue_id},
    ).json()["attachments"]
    assert rows == []


def test_an_admin_detaches_someone_else_s_attachment(client: TestClient, workspace: str, issue: Any) -> None:
    """Moderation, so an admin can remove what a member attached."""
    sign_in(client, MEMBER)
    created = client.post(
        f"/api/workspaces/{workspace}/attachments/url",
        json={"issue_id": issue.issue_id, "url": "https://example.com/spec"},
    ).json()

    sign_in(client, ADMIN)
    response = client.delete(
        f"/api/workspaces/{workspace}/attachments/{created['attachment_id']}",
        params={"issue_id": issue.issue_id},
    )
    assert response.status_code == 204, response.text


def test_an_unknown_attachment_is_a_404(client: TestClient, workspace: str, issue: Any) -> None:
    """An id that is not in the issue's partition is simply not there."""
    sign_in(client, MEMBER)
    response = client.delete(
        f"/api/workspaces/{workspace}/attachments/01JB00000000000000000NONE",
        params={"issue_id": issue.issue_id},
    )
    assert response.status_code == 404, response.text
