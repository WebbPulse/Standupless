"""The embedded media surface: the member token read and the anonymous content route.

The content route is reached by `<img>` and `<video>` elements with no identity at
all, so the tests that matter are the refusals. A token opens exactly the one
attachment it names, under the one issue and workspace it names, and every other
presentation is the same 404.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from app.common.media_tokens import mint_media_token, read_media_token
from app.domains.discussion.schemas.discussion import MAX_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES
from tests.domains.discussion.conftest import seed_issue
from tests.domains.discussion.test_attachments import request_upload, upload
from tests.domains.helpers import GUEST, MEMBER, sign_in, sign_out


def content_url(workspace: str, attachment_id: str, token: str) -> str:
    """The content path an embed stores, with its token appended."""
    return f"/api/workspaces/{workspace}/attachments/{attachment_id}/content?token={token}"


def media_tokens(client: TestClient, workspace: str, issue_id: str) -> "dict[str, str]":
    """The member token map for one issue, failing loudly on a refusal."""
    response = client.get(f"/api/workspaces/{workspace}/attachments/media", params={"issue_id": issue_id})
    assert response.status_code == 200, response.text
    return response.json()["tokens"]


def test_a_member_gets_a_token_for_each_file(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """Files get tokens and links do not, since a link has nothing to serve."""
    sign_in(client, MEMBER)
    created = upload(client, workspace, issue.issue_id)
    client.post(
        f"/api/workspaces/{workspace}/attachments/url",
        json={"issue_id": issue.issue_id, "url": "https://example.com/spec"},
    )

    tokens = media_tokens(client, workspace, issue.issue_id)

    assert list(tokens) == [created["attachment_id"]]
    grant = read_media_token(tokens[created["attachment_id"]], workspace, created["attachment_id"])
    assert grant.issue_id == issue.issue_id


def test_the_token_read_is_refused_on_an_invisible_issue(client: TestClient, workspace: str, hidden_issue: Any) -> None:
    """A guest outside the team cannot mint tokens for its issues."""
    sign_in(client, GUEST)
    response = client.get(f"/api/workspaces/{workspace}/attachments/media", params={"issue_id": hidden_issue.issue_id})
    assert response.status_code == 404, response.text


def test_the_content_route_redirects_anonymously_to_a_presigned_get(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """With no session at all, a valid token is a 302 to the object, inline."""
    sign_in(client, MEMBER)
    created = upload(client, workspace, issue.issue_id)
    token = media_tokens(client, workspace, issue.issue_id)[created["attachment_id"]]
    sign_out(client)

    response = client.get(content_url(workspace, created["attachment_id"], token), follow_redirects=False)

    assert response.status_code == 302, response.text
    target = urlparse(response.headers["location"])
    assert attachments_bucket in response.headers["location"]
    query = parse_qs(target.query)
    assert query["response-content-type"] == ["image/png"]
    assert query["response-content-disposition"][0].startswith("inline")
    assert "max-age" in response.headers["cache-control"]


def test_a_video_plays_inline(client: TestClient, workspace: str, issue: Any, attachments_bucket: str) -> None:
    """A video is served inline so it plays rather than downloads when opened alone."""
    sign_in(client, MEMBER)
    created = upload(client, workspace, issue.issue_id, filename="clip.mp4", content_type="video/mp4")
    token = media_tokens(client, workspace, issue.issue_id)[created["attachment_id"]]

    response = client.get(content_url(workspace, created["attachment_id"], token), follow_redirects=False)

    assert response.status_code == 302, response.text
    query = parse_qs(urlparse(response.headers["location"]).query)
    assert query["response-content-disposition"][0].startswith("inline")


def test_a_missing_or_garbled_token_is_a_404(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """No token is a validation 422, a bad one the shared 404."""
    sign_in(client, MEMBER)
    created = upload(client, workspace, issue.issue_id)
    sign_out(client)

    assert client.get(f"/api/workspaces/{workspace}/attachments/{created['attachment_id']}/content").status_code == 422
    garbled = client.get(content_url(workspace, created["attachment_id"], "not-a-token"), follow_redirects=False)
    assert garbled.status_code == 404


def test_a_token_opens_no_other_attachment(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """A token for one attachment presented under another id is refused."""
    sign_in(client, MEMBER)
    first = upload(client, workspace, issue.issue_id)
    second = upload(client, workspace, issue.issue_id)
    token = media_tokens(client, workspace, issue.issue_id)[first["attachment_id"]]

    response = client.get(content_url(workspace, second["attachment_id"], token), follow_redirects=False)

    assert response.status_code == 404


def test_a_token_is_refused_under_another_workspace(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """The workspace in the path must be the one the token was minted for."""
    sign_in(client, MEMBER)
    created = upload(client, workspace, issue.issue_id)
    token = media_tokens(client, workspace, issue.issue_id)[created["attachment_id"]]
    sign_out(client)

    other = "01JB00000000000000000000W2"
    response = client.get(content_url(other, created["attachment_id"], token), follow_redirects=False)

    assert response.status_code == 404


def test_a_token_minted_for_another_workspace_opens_nothing_here(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """A token signed for a second workspace names no row in this one."""
    sign_in(client, MEMBER)
    created = upload(client, workspace, issue.issue_id)
    sign_out(client)

    other = "01JB00000000000000000000W2"
    token = mint_media_token(other, issue.issue_id, created["attachment_id"])
    response = client.get(content_url(other, created["attachment_id"], token), follow_redirects=False)

    assert response.status_code == 404


def test_a_token_bound_to_another_issue_finds_nothing(
    client: TestClient, repositories: Any, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """The issue comes from the token, so an attachment filed elsewhere is unreachable."""
    sign_in(client, MEMBER)
    created = upload(client, workspace, issue.issue_id)
    elsewhere = seed_issue(repositories, workspace, issue.team_id, "01JB0000000000000000000IS3", 3)

    token = mint_media_token(workspace, elsewhere.issue_id, created["attachment_id"])
    response = client.get(content_url(workspace, created["attachment_id"], token), follow_redirects=False)

    assert response.status_code == 404


def test_a_detached_attachment_stops_resolving(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """Deleting the row is what an embed observes, even with a live token."""
    sign_in(client, MEMBER)
    created = upload(client, workspace, issue.issue_id)
    token = media_tokens(client, workspace, issue.issue_id)[created["attachment_id"]]
    client.delete(
        f"/api/workspaces/{workspace}/attachments/{created['attachment_id']}", params={"issue_id": issue.issue_id}
    )

    response = client.get(content_url(workspace, created["attachment_id"], token), follow_redirects=False)

    assert response.status_code == 404


def test_a_video_type_is_accepted_up_to_its_own_ceiling(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """Video carries a larger cap than documents, and is still bounded."""
    sign_in(client, MEMBER)
    for content_type in ("video/mp4", "video/webm", "video/quicktime"):
        request_upload(
            client,
            workspace,
            issue.issue_id,
            filename="clip",
            content_type=content_type,
            size_bytes=MAX_UPLOAD_BYTES + 1,
        )

    over = client.post(
        f"/api/workspaces/{workspace}/attachments/uploads",
        json={
            "issue_id": issue.issue_id,
            "filename": "clip.mp4",
            "content_type": "video/mp4",
            "size_bytes": MAX_VIDEO_UPLOAD_BYTES + 1,
        },
    )
    assert over.status_code == 422
    assert over.json()["error_code"] == "UPLOAD_TOO_LARGE"


def test_other_video_types_are_refused(client: TestClient, workspace: str, issue: Any) -> None:
    """Only the three embeddable containers are admitted."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/attachments/uploads",
        json={"issue_id": issue.issue_id, "filename": "clip.avi", "content_type": "video/x-msvideo", "size_bytes": 10},
    )
    assert response.status_code == 422
    assert response.json()["error_code"] == "UNSUPPORTED_MEDIA_TYPE"
