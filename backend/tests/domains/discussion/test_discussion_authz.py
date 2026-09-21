"""The refusals, gathered in one file so loosening a rule fails here.

The shape every test holds to: a caller who may not see the issue gets 404 rather
than 403, because a 403 on an id is itself an answer about whether that id exists.
403 is reserved for a caller who can see the thing and may not act on it, which is
the only case where the existence is already known.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.discussion.conftest import OTHER_TEAM, TEAM, seed_issue
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, OWNER, sign_in, sign_out

THUMBS_UP = "\N{THUMBS UP SIGN}"


def comment_as(client: TestClient, workspace: str, issue_id: str, user: str) -> str:
    """One comment written by the named user, for a later refusal to act on."""
    sign_in(client, user)
    response = client.post(
        f"/api/workspaces/{workspace}/issues/{issue_id}/comments",
        json={"body": "A comment"},
    )
    assert response.status_code == 201, response.text
    return response.json()["comment_id"]


def test_an_unauthenticated_caller_is_refused(client: TestClient, workspace: str, issue: Any) -> None:
    """No claims at all is 401, before any row is read."""
    sign_out(client)
    response = client.get(f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments")
    assert response.status_code == 401, response.text


def test_an_unauthenticated_write_is_refused(client: TestClient, workspace: str, issue: Any) -> None:
    """The writes are guarded by the same dependency as the reads."""
    sign_out(client)
    response = client.post(
        f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments",
        json={"body": "Hello"},
    )
    assert response.status_code == 401, response.text


def test_a_non_member_cannot_read_a_thread(client: TestClient, workspace: str, issue: Any) -> None:
    """A stranger to the workspace gets 404, so the workspace id tells them nothing."""
    sign_in(client, OUTSIDER)
    response = client.get(f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments")
    assert response.status_code == 404, response.text


def test_a_non_member_cannot_comment(client: TestClient, workspace: str, issue: Any) -> None:
    """The write is refused the same way the read is."""
    sign_in(client, OUTSIDER)
    response = client.post(
        f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments",
        json={"body": "Hello"},
    )
    assert response.status_code == 404, response.text


def test_a_guest_outside_a_team_cannot_read_its_thread(
    client: TestClient, workspace: str, hidden_issue: Any
) -> None:
    """404 rather than 403: a guest learns nothing about a team they are outside."""
    sign_in(client, GUEST)
    response = client.get(f"/api/workspaces/{workspace}/issues/{hidden_issue.issue_id}/comments")
    assert response.status_code == 404, response.text


def test_a_guest_inside_a_team_can_read_its_thread(client: TestClient, workspace: str, issue: Any) -> None:
    """The other half of the rule, so the 404 above is about the team and not the role."""
    sign_in(client, GUEST)
    response = client.get(f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments")
    assert response.status_code == 200, response.text


def test_a_guest_outside_a_team_cannot_comment(client: TestClient, workspace: str, hidden_issue: Any) -> None:
    """The write is refused as a 404 too, for the same reason the read is."""
    sign_in(client, GUEST)
    response = client.post(
        f"/api/workspaces/{workspace}/issues/{hidden_issue.issue_id}/comments",
        json={"body": "Hello"},
    )
    assert response.status_code == 404, response.text


def test_a_comment_in_an_invisible_team_is_a_404_by_id(
    client: TestClient, workspace: str, hidden_issue: Any
) -> None:
    """Holding the comment id does not make it readable, because the issue decides."""
    comment_id = comment_as(client, workspace, hidden_issue.issue_id, OWNER)

    sign_in(client, GUEST)
    response = client.get(
        f"/api/workspaces/{workspace}/comments/{comment_id}",
        params={"issue_id": hidden_issue.issue_id},
    )
    assert response.status_code == 404, response.text


def test_only_the_author_edits_a_comment(client: TestClient, workspace: str, issue: Any) -> None:
    """403 rather than 404: the caller can already see the comment."""
    comment_id = comment_as(client, workspace, issue.issue_id, MEMBER)

    sign_in(client, ADMIN)
    response = client.patch(
        f"/api/workspaces/{workspace}/comments/{comment_id}",
        json={"issue_id": issue.issue_id, "body": "Rewritten"},
    )
    assert response.status_code == 403, response.text


def test_an_admin_deletes_a_comment_they_did_not_write(client: TestClient, workspace: str, issue: Any) -> None:
    """Moderation is a delete and not an edit, which is the whole of the asymmetry."""
    comment_id = comment_as(client, workspace, issue.issue_id, MEMBER)

    sign_in(client, ADMIN)
    response = client.delete(
        f"/api/workspaces/{workspace}/comments/{comment_id}",
        params={"issue_id": issue.issue_id},
    )
    assert response.status_code == 204, response.text


def test_a_member_cannot_delete_another_member_s_comment(client: TestClient, workspace: str, issue: Any) -> None:
    """A peer is neither the author nor an admin, so the delete is refused."""
    comment_id = comment_as(client, workspace, issue.issue_id, ADMIN)

    sign_in(client, MEMBER)
    response = client.delete(
        f"/api/workspaces/{workspace}/comments/{comment_id}",
        params={"issue_id": issue.issue_id},
    )
    assert response.status_code == 403, response.text


def test_a_guest_cannot_react_across_a_team_boundary(client: TestClient, workspace: str, hidden_issue: Any) -> None:
    """The reaction target resolves to an issue, so it inherits the same 404."""
    sign_in(client, GUEST)
    response = client.put(
        f"/api/workspaces/{workspace}/reactions",
        json={"target_id": hidden_issue.issue_id, "target_kind": "issue", "emoji": THUMBS_UP},
    )
    assert response.status_code == 404, response.text


def test_a_guest_cannot_read_reactions_on_an_invisible_issue(
    client: TestClient, workspace: str, hidden_issue: Any
) -> None:
    """A count is an answer about the issue, so the read is refused too."""
    sign_in(client, GUEST)
    response = client.get(
        f"/api/workspaces/{workspace}/reactions",
        params={"target_id": hidden_issue.issue_id, "target_kind": "issue"},
    )
    assert response.status_code == 404, response.text


def test_a_guest_cannot_list_attachments_on_an_invisible_issue(
    client: TestClient, workspace: str, hidden_issue: Any
) -> None:
    """The attachment list is decided by the issue, exactly as the thread is."""
    sign_in(client, GUEST)
    response = client.get(
        f"/api/workspaces/{workspace}/attachments",
        params={"issue_id": hidden_issue.issue_id},
    )
    assert response.status_code == 404, response.text


def test_a_guest_cannot_request_an_upload_on_an_invisible_issue(
    client: TestClient, workspace: str, hidden_issue: Any, attachments_bucket: str
) -> None:
    """No signature is minted for an issue the caller cannot see."""
    sign_in(client, GUEST)
    response = client.post(
        f"/api/workspaces/{workspace}/attachments/uploads",
        json={
            "issue_id": hidden_issue.issue_id,
            "filename": "shot.png",
            "content_type": "image/png",
            "size_bytes": 10,
        },
    )
    assert response.status_code == 404, response.text


def test_a_ticket_cannot_be_committed_by_another_caller(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """The ticket is bound to the caller, so a stolen one is simply unknown."""
    from tests.domains.discussion.conftest import put_object

    sign_in(client, MEMBER)
    ticket = client.post(
        f"/api/workspaces/{workspace}/attachments/uploads",
        json={
            "issue_id": issue.issue_id,
            "filename": "shot.png",
            "content_type": "image/png",
            "size_bytes": 10,
        },
    ).json()
    put_object(ticket["s3_key"], b"0" * 10)

    sign_in(client, ADMIN)
    response = client.post(
        f"/api/workspaces/{workspace}/attachments",
        json={"issue_id": issue.issue_id, "upload_id": ticket["upload_id"], "ticket": ticket["ticket"]},
    )
    assert response.status_code == 404, response.text


def test_a_ticket_cannot_be_committed_against_another_issue(
    client: TestClient, repositories: Any, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """The issue is inside the signature, so a ticket cannot be moved between issues."""
    from tests.domains.discussion.conftest import put_object

    other = seed_issue(repositories, workspace, TEAM, "01JB0000000000000000000IS7", 7)
    sign_in(client, MEMBER)
    ticket = client.post(
        f"/api/workspaces/{workspace}/attachments/uploads",
        json={
            "issue_id": issue.issue_id,
            "filename": "shot.png",
            "content_type": "image/png",
            "size_bytes": 10,
        },
    ).json()
    put_object(ticket["s3_key"], b"0" * 10)

    response = client.post(
        f"/api/workspaces/{workspace}/attachments",
        json={"issue_id": other.issue_id, "upload_id": ticket["upload_id"], "ticket": ticket["ticket"]},
    )
    assert response.status_code == 404, response.text


def test_an_unknown_ticket_is_a_404(client: TestClient, workspace: str, issue: Any, attachments_bucket: str) -> None:
    """A forged ticket does not verify, so it names no upload at all."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/attachments",
        json={"issue_id": issue.issue_id, "upload_id": "01JB00000000000000000UPLD", "ticket": "not.a.ticket"},
    )
    assert response.status_code == 404, response.text


def test_an_upload_id_that_does_not_match_its_ticket_is_a_404(
    client: TestClient, workspace: str, issue: Any, attachments_bucket: str
) -> None:
    """The upload id is signed, so the pair has to be the one that was issued."""
    sign_in(client, MEMBER)
    ticket = client.post(
        f"/api/workspaces/{workspace}/attachments/uploads",
        json={
            "issue_id": issue.issue_id,
            "filename": "shot.png",
            "content_type": "image/png",
            "size_bytes": 10,
        },
    ).json()

    response = client.post(
        f"/api/workspaces/{workspace}/attachments",
        json={"issue_id": issue.issue_id, "upload_id": "01JB00000000000000000UPLD", "ticket": ticket["ticket"]},
    )
    assert response.status_code == 404, response.text


def test_a_member_cannot_detach_another_member_s_attachment(client: TestClient, workspace: str, issue: Any) -> None:
    """Neither the uploader nor a team admin, so the delete is a 403."""
    sign_in(client, ADMIN)
    created = client.post(
        f"/api/workspaces/{workspace}/attachments/url",
        json={"issue_id": issue.issue_id, "url": "https://example.com/spec"},
    ).json()

    sign_in(client, MEMBER)
    response = client.delete(
        f"/api/workspaces/{workspace}/attachments/{created['attachment_id']}",
        params={"issue_id": issue.issue_id},
    )
    assert response.status_code == 403, response.text


def test_a_guest_cannot_download_from_an_invisible_issue(
    client: TestClient, workspace: str, hidden_issue: Any, attachments_bucket: str
) -> None:
    """No presigned GET is minted for an issue the caller cannot see."""
    sign_in(client, OWNER)
    created = client.post(
        f"/api/workspaces/{workspace}/attachments/url",
        json={"issue_id": hidden_issue.issue_id, "url": "https://example.com/spec"},
    ).json()

    sign_in(client, GUEST)
    response = client.get(
        f"/api/workspaces/{workspace}/attachments/{created['attachment_id']}/download",
        params={"issue_id": hidden_issue.issue_id},
    )
    assert response.status_code == 404, response.text


def test_a_workspace_id_from_another_tenant_is_a_404(client: TestClient, workspace: str, issue: Any) -> None:
    """Every key carries the workspace, so a foreign one matches nothing."""
    sign_in(client, MEMBER)
    response = client.get(f"/api/workspaces/01JB0000000000000000000XWS/issues/{issue.issue_id}/comments")
    assert response.status_code == 404, response.text


def test_an_issue_from_another_team_is_not_reachable_by_id(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The team on the issue decides, not the team the caller names."""
    hidden = seed_issue(repositories, workspace, OTHER_TEAM, "01JB0000000000000000000IS8", 8)
    sign_in(client, GUEST)
    response = client.get(
        f"/api/workspaces/{workspace}/attachments",
        params={"issue_id": hidden.issue_id},
    )
    assert response.status_code == 404, response.text
