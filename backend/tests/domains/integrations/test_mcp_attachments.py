"""The MCP attachment tool and the attachment lists get_issue and list_comments carry.

An embedded screenshot is a content path only a browser with a media token opens,
so these tests hold that an agent can read it through `get_attachment` as image
content, that other files come back as a short-lived download URL, and that the
tool refuses exactly where the web download route refuses: another workspace, an
issue the caller may not read, and an attachment that is gone.

They also hold that an agent can upload through either tool path under the web's
rules, and that what it uploads embeds, reads back and shows in the activity feed.
"""

from __future__ import annotations

import base64
import json
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common import discussion_rules, plan_limits
from app.common.db.dynamo.activity import as_activity
from app.common.db.dynamo.attachments import Attachment, build_attachment, object_key
from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.issues import Issue
from app.common.upload_rules import MAX_UPLOAD_BYTES
from app.common.upload_ticket import read_ticket
from app.domains.integrations.mcp.attachment_tools import (
    MAX_INLINE_IMAGE_BYTES,
    MAX_INLINE_UPLOAD_BYTES,
    embed_markdown,
)
from tests.domains.helpers import GUEST, MEMBER, OWNER, make_team, make_workspace
from tests.domains.integrations.conftest import OTHER_WORKSPACE, TEAM, WORKSPACE, seed_issue
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

BUCKET = "standupless-test-attachments"

READ = ("issues:read",)

WRITE = ("issues:read", "issues:write")

PNG = b"\x89PNG\r\n\x1a\n" + b"pixels" * 10

FOREIGN_TEAM = "01JB000000000000000000FTM1"

FOREIGN_ISSUE = "01JB0000000000000000000FI1"


@pytest.fixture
def attachments_bucket(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """A live moto S3 bucket, with the setting pointed at it."""
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
        yield BUCKET
    reset_client_cache()


def stored_file(
    repositories: Any,
    workspace_id: str,
    issue: Issue,
    filename: str,
    body: bytes,
    content_type: str,
    *,
    size_bytes: int | None = None,
) -> Attachment:
    """One uploaded file on an issue: the object in the bucket and the row that makes it visible."""
    import boto3

    attachment = build_attachment(
        workspace_id,
        issue.issue_id,
        issue.team_id,
        "file",
        filename,
        OWNER,
        s3_key=object_key(workspace_id, issue.issue_id, "01JB00000000000000000UPLD1", filename),
        content_type=content_type,
        size_bytes=len(body) if size_bytes is None else size_bytes,
    )
    boto3.client("s3", region_name="us-west-2").put_object(
        Bucket=BUCKET, Key=attachment.s3_key, Body=body, ContentType=content_type
    )
    return repositories.attachments.create(attachment)


def content_path(workspace_id: str, issue_id: str, attachment_id: str) -> str:
    """The stable path a Markdown body embeds an uploaded image under."""
    return f"/api/workspaces/{workspace_id}/attachments/{attachment_id}/content?issue_id={issue_id}"


def test_an_image_comes_back_as_image_content(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """A PNG answers its summary as text and its bytes as an MCP image block."""
    image = stored_file(repositories, WORKSPACE, issue, "screenshot.png", PNG, "image/png")
    secret = mint_for(repositories, MEMBER, READ)

    body = tool(client, secret, "get_attachment", {"issue_id": "ABC-1", "attachment_id": image.attachment_id}).json()
    text, block = body["result"]["content"]

    assert body["result"]["isError"] is False
    assert json.loads(text["text"])["filename"] == "screenshot.png"
    assert block == {"type": "image", "data": base64.b64encode(PNG).decode("ascii"), "mimeType": "image/png"}


def test_another_file_comes_back_as_a_download_url(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """A PDF is not inlined; its metadata and a presigned GET for its key come back instead."""
    pdf = stored_file(repositories, WORKSPACE, issue, "spec.pdf", b"%PDF-1.7", "application/pdf")
    secret = mint_for(repositories, MEMBER, READ)

    found = answer(
        tool(client, secret, "get_attachment", {"issue_id": issue.issue_id, "attachment_id": pdf.attachment_id})
    )

    assert found["content_type"] == "application/pdf"
    assert found["size_bytes"] == 8
    assert BUCKET in found["download_url"] and "spec.pdf" in found["download_url"]
    assert found["expires_at"]


def test_as_url_answers_a_url_for_an_image_too(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """An agent that only wants the link gets it rather than the bytes."""
    image = stored_file(repositories, WORKSPACE, issue, "screenshot.png", PNG, "image/png")
    secret = mint_for(repositories, MEMBER, READ)

    found = answer(
        tool(
            client,
            secret,
            "get_attachment",
            {"issue_id": "ABC-1", "attachment_id": image.attachment_id, "as_url": True},
        )
    )

    assert "download_url" in found


def test_an_image_over_the_cap_is_refused_with_a_way_out(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """An image larger than the inline cap is a clear refusal naming as_url."""
    image = stored_file(
        repositories, WORKSPACE, issue, "huge.png", PNG, "image/png", size_bytes=MAX_INLINE_IMAGE_BYTES + 1
    )
    secret = mint_for(repositories, MEMBER, READ)

    text = refusal(tool(client, secret, "get_attachment", {"issue_id": "ABC-1", "attachment_id": image.attachment_id}))

    assert str(MAX_INLINE_IMAGE_BYTES) in text
    assert "as_url" in text


def test_a_deleted_attachment_is_not_found(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """Once the row is gone the object is unreachable, even though the bucket still holds it."""
    image = stored_file(repositories, WORKSPACE, issue, "screenshot.png", PNG, "image/png")
    repositories.attachments.delete(WORKSPACE, issue.issue_id, image.attachment_id)
    secret = mint_for(repositories, MEMBER, READ)

    text = refusal(tool(client, secret, "get_attachment", {"issue_id": "ABC-1", "attachment_id": image.attachment_id}))

    assert "not found" in text.lower()


def test_an_attachment_on_another_issue_is_not_found(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """The issue named is the one the row is looked up under, so a readable issue opens nothing else."""
    other = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS3", "ABC", 2)
    image = stored_file(repositories, WORKSPACE, other, "screenshot.png", PNG, "image/png")
    secret = mint_for(repositories, MEMBER, READ)

    assert refusal(tool(client, secret, "get_attachment", {"issue_id": "ABC-1", "attachment_id": image.attachment_id}))


def test_a_team_the_caller_is_outside_is_not_found(
    client: TestClient, repositories: Any, hidden_issue: Issue, attachments_bucket: str
) -> None:
    """A guest outside the issue's team gets the same not-found an absent attachment gets."""
    image = stored_file(repositories, WORKSPACE, hidden_issue, "screenshot.png", PNG, "image/png")
    secret = mint_for(repositories, GUEST, READ)

    text = refusal(
        tool(
            client, secret, "get_attachment", {"issue_id": hidden_issue.issue_id, "attachment_id": image.attachment_id}
        )
    )

    assert "not found" in text.lower()


def test_another_workspace_is_not_found(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """A key bound to one workspace cannot read a file in another, even for a member of both."""
    make_workspace(repositories, OTHER_WORKSPACE, "other", OWNER)
    make_team(repositories, OTHER_WORKSPACE, FOREIGN_TEAM, "OTH")
    foreign = seed_issue(repositories, OTHER_WORKSPACE, FOREIGN_TEAM, FOREIGN_ISSUE, "OTH", 1)
    image = stored_file(repositories, OTHER_WORKSPACE, foreign, "secret.png", PNG, "image/png")
    secret = mint_for(repositories, OWNER, READ)

    by_issue = tool(client, secret, "get_attachment", {"issue_id": FOREIGN_ISSUE, "attachment_id": image.attachment_id})
    by_home = tool(client, secret, "get_attachment", {"issue_id": issue.issue_id, "attachment_id": image.attachment_id})

    for response in (by_issue, by_home):
        text = refusal(response)
        assert "secret.png" not in text


def test_an_issue_the_shared_read_rule_hides_is_not_found(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The tool asks the discussion read rule the download route asks, so a private issue stays hidden.

    The rule is narrowed here to hide this one issue, standing in for any rule it
    learns, such as a private ask, without the tool changing.
    """
    image = stored_file(repositories, WORKSPACE, issue, "screenshot.png", PNG, "image/png")
    secret = mint_for(repositories, MEMBER, READ)
    shared_rule = discussion_rules.load_visible_issue

    def private(repositories: Any, context: Any, issue_id: str) -> Issue:
        """The shared rule, with this issue made private."""
        if issue_id == issue.issue_id:
            raise discussion_rules.not_found()
        return shared_rule(repositories, context, issue_id)

    monkeypatch.setattr(discussion_rules, "load_visible_issue", private)

    text = refusal(tool(client, secret, "get_attachment", {"issue_id": "ABC-1", "attachment_id": image.attachment_id}))

    assert "not found" in text.lower()


def test_get_issue_and_list_comments_list_embedded_files(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """Each body lists the files it embeds, so a client knows what get_attachment can fetch."""
    described = stored_file(repositories, WORKSPACE, issue, "before.png", PNG, "image/png")
    commented = stored_file(repositories, WORKSPACE, issue, "after.png", PNG, "image/png")
    stored = repositories.issues.get(WORKSPACE, issue.issue_id)
    repositories.issues.replace(
        stored.model_copy(
            update={
                "body": f"Broken: ![before]({content_path(WORKSPACE, issue.issue_id, described.attachment_id)}) "
                f"and ![elsewhere]({content_path(OTHER_WORKSPACE, issue.issue_id, commented.attachment_id)})"
            }
        )
    )
    repositories.comments.create(
        build_comment(
            WORKSPACE,
            issue.issue_id,
            TEAM,
            OWNER,
            f"Fixed: ![after]({content_path(WORKSPACE, issue.issue_id, commented.attachment_id)})",
        )
    )
    repositories.comments.create(build_comment(WORKSPACE, issue.issue_id, TEAM, OWNER, "No pictures"))
    secret = mint_for(repositories, MEMBER, READ)

    found = answer(tool(client, secret, "get_issue", {"issue_id": "ABC-1"}))
    listed = answer(tool(client, secret, "list_comments", {"issue_id": "ABC-1"}))

    assert found["attachments"] == [
        {
            "attachment_id": described.attachment_id,
            "issue_id": issue.issue_id,
            "filename": "before.png",
            "content_type": "image/png",
            "size_bytes": len(PNG),
        }
    ]
    assert {
        comment["body"][:5]: [row["attachment_id"] for row in comment["attachments"]] for comment in listed["comments"]
    } == {
        "Fixed": [commented.attachment_id],
        "No pi": [],
    }


def inline_upload(**overrides: Any) -> dict[str, Any]:
    """The arguments of one small PNG uploaded inside the call."""
    return {
        "issue_id": "ABC-1",
        "filename": "screenshot.png",
        "content_type": "image/png",
        "content_base64": base64.b64encode(PNG).decode("ascii"),
        **overrides,
    }


def bucket_keys() -> list[str]:
    """Every object key in the attachments bucket."""
    import boto3

    listed = boto3.client("s3", region_name="us-west-2").list_objects_v2(Bucket=BUCKET)
    return [row["Key"] for row in listed.get("Contents", [])]


def started_upload(client: TestClient, secret: str, **overrides: Any) -> dict[str, Any]:
    """One presigned upload of the small PNG, not yet sent."""
    return answer(
        tool(
            client,
            secret,
            "create_attachment_upload",
            {
                "issue_id": "ABC-1",
                "filename": "screenshot.png",
                "content_type": "image/png",
                "size_bytes": len(PNG),
                **overrides,
            },
        )
    )


def land_upload(started: dict[str, Any], issue: Issue, user_id: str) -> None:
    """Put the object where the ticket says, standing in for the agent's PUT to the presigned URL."""
    import boto3

    claims = read_ticket(started["ticket"], WORKSPACE, issue.issue_id, user_id)
    boto3.client("s3", region_name="us-west-2").put_object(Bucket=BUCKET, Key=str(claims["key"]), Body=PNG)


def test_an_inline_upload_embeds_reads_back_and_shows_in_the_feed(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """The bytes land, the answer's Markdown embeds on a comment, and the activity names the user and MCP."""
    secret = mint_for(repositories, MEMBER, WRITE)

    uploaded = answer(tool(client, secret, "upload_attachment", inline_upload()))
    attachment_id = uploaded["attachment_id"]

    assert uploaded["filename"] == "screenshot.png"
    assert uploaded["size_bytes"] == len(PNG)
    assert uploaded["markdown"] == f"![screenshot.png]({content_path(WORKSPACE, issue.issue_id, attachment_id)})"
    stored = repositories.attachments.get(WORKSPACE, issue.issue_id, attachment_id)
    assert stored.uploaded_by == MEMBER
    assert repositories.attachments.storage_used(WORKSPACE) == len(PNG)

    answer(tool(client, secret, "add_comment", {"issue_id": "ABC-1", "body": f"Look: {uploaded['markdown']}"}))
    listed = answer(tool(client, secret, "list_comments", {"issue_id": "ABC-1"}))
    assert [row["attachment_id"] for row in listed["comments"][0]["attachments"]] == [attachment_id]

    body = tool(client, secret, "get_attachment", {"issue_id": "ABC-1", "attachment_id": attachment_id}).json()
    assert body["result"]["content"][1]["data"] == base64.b64encode(PNG).decode("ascii")

    page = repositories.activity.list_for_issue(WORKSPACE, issue.issue_id, limit=50)
    rows = [row for row in map(as_activity, page.items) if row.kind == "attachment_added"]
    assert [(row.actor_id, row.to_value, row.source) for row in rows] == [(MEMBER, "screenshot.png", "mcp")]


def test_an_inline_upload_takes_wrapped_base64_and_a_title(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """What the base64 command prints decodes, and a title is what the file reads as."""
    secret = mint_for(repositories, MEMBER, WRITE)
    encoded = base64.encodebytes(PNG * 10).decode("ascii")

    uploaded = answer(tool(client, secret, "upload_attachment", inline_upload(content_base64=encoded, title="The bug")))

    assert uploaded["size_bytes"] == len(PNG) * 10
    assert uploaded["filename"] == "The bug"


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"content_type": "image/svg+xml"}, "cannot be uploaded"),
        ({"content_base64": "not base64!"}, "valid base64"),
        ({"content_base64": "===="}, "valid base64"),
        ({"filename": "x" * 201}, "at most 200"),
        ({"title": "x" * 201}, "at most 200"),
    ],
)
def test_an_inline_upload_the_rules_refuse_stores_nothing(
    client: TestClient,
    repositories: Any,
    issue: Issue,
    attachments_bucket: str,
    overrides: dict[str, Any],
    message: str,
) -> None:
    """A refused type, undecodable bytes or an overlong name leaves no object and no row."""
    secret = mint_for(repositories, MEMBER, WRITE)

    text = refusal(tool(client, secret, "upload_attachment", inline_upload(**overrides)))

    assert message in text
    assert bucket_keys() == []
    assert repositories.attachments.storage_used(WORKSPACE) == 0


def test_an_inline_upload_over_the_cap_names_the_tools_that_take_it(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """A file too large for one request is refused with the way to upload it anyway."""
    secret = mint_for(repositories, MEMBER, WRITE)
    encoded = base64.b64encode(bytes(MAX_INLINE_UPLOAD_BYTES + 1)).decode("ascii")

    text = refusal(tool(client, secret, "upload_attachment", inline_upload(content_base64=encoded)))

    assert "create_attachment_upload" in text
    assert bucket_keys() == []


@pytest.mark.parametrize("name", ["upload_attachment", "create_attachment_upload"])
def test_an_upload_past_the_plan_s_storage_is_refused(
    client: TestClient,
    repositories: Any,
    issue: Issue,
    attachments_bucket: str,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
) -> None:
    """Both ways in meet the pooled storage limit the web upload meets, and say why."""
    monkeypatch.setattr(plan_limits, "PREVIEW_FREE_STORAGE_BYTES", len(PNG) - 1)
    secret = mint_for(repositories, MEMBER, WRITE)
    arguments = (
        inline_upload()
        if name == "upload_attachment"
        else {"issue_id": "ABC-1", "filename": "a.png", "content_type": "image/png", "size_bytes": len(PNG)}
    )

    assert plan_limits.PLAN_LIMIT_REACHED in refusal(tool(client, secret, name, arguments))
    assert bucket_keys() == []


@pytest.mark.parametrize("name", ["upload_attachment", "create_attachment_upload"])
def test_a_team_the_caller_is_outside_cannot_upload(
    client: TestClient, repositories: Any, hidden_issue: Issue, attachments_bucket: str, name: str
) -> None:
    """An issue the guest cannot see answers the same not-found the read does."""
    secret = mint_for(repositories, GUEST, WRITE)
    arguments = (
        inline_upload(issue_id=hidden_issue.issue_id)
        if name == "upload_attachment"
        else {
            "issue_id": hidden_issue.issue_id,
            "filename": "a.png",
            "content_type": "image/png",
            "size_bytes": len(PNG),
        }
    )

    assert "not found" in refusal(tool(client, secret, name, arguments)).lower()
    assert bucket_keys() == []


@pytest.mark.parametrize("name", ["upload_attachment", "create_attachment_upload", "commit_attachment_upload"])
def test_a_read_only_key_cannot_upload(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str, name: str
) -> None:
    """Every upload tool needs the write scope, before any argument is read."""
    secret = mint_for(repositories, MEMBER, READ)

    body = tool(client, secret, name, {"issue_id": "ABC-1"}).json()

    assert "issues:write" in json.dumps(body)
    assert bucket_keys() == []


def test_a_presigned_upload_commits_once_the_object_landed(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """The pair records the type and size the ticket signed, and the commit answers the embed."""
    secret = mint_for(repositories, MEMBER, WRITE)

    started = started_upload(client, secret)
    assert BUCKET in started["url"]
    assert started["method"] == "PUT"
    assert started["headers"]["Content-Type"] == "image/png"
    assert started["max_bytes"] == len(PNG)
    assert repositories.attachments.storage_used(WORKSPACE) == 0

    land_upload(started, issue, MEMBER)
    committed = answer(
        tool(
            client,
            secret,
            "commit_attachment_upload",
            {"issue_id": "ABC-1", "upload_id": started["upload_id"], "ticket": started["ticket"]},
        )
    )

    assert committed["content_type"] == "image/png"
    assert committed["size_bytes"] == len(PNG)
    assert committed["markdown"].endswith(f"{content_path(WORKSPACE, issue.issue_id, committed['attachment_id'])})")
    assert repositories.attachments.storage_used(WORKSPACE) == len(PNG)
    page = repositories.activity.list_for_issue(WORKSPACE, issue.issue_id, limit=50)
    assert [as_activity(row).source for row in page.items if as_activity(row).kind == "attachment_added"] == ["mcp"]


def test_a_commit_before_the_object_landed_is_refused(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """A commit with no object is the web's refusal, and records no row."""
    secret = mint_for(repositories, MEMBER, WRITE)
    started = started_upload(client, secret)

    text = refusal(
        tool(
            client,
            secret,
            "commit_attachment_upload",
            {"issue_id": "ABC-1", "upload_id": started["upload_id"], "ticket": started["ticket"]},
        )
    )

    assert "not in the bucket" in text
    assert list(repositories.attachments.iter_for_issue(WORKSPACE, issue.issue_id)) == []


def test_a_ticket_opens_only_its_own_issue_and_member(
    client: TestClient, repositories: Any, issue: Issue, attachments_bucket: str
) -> None:
    """A good ticket named on another issue, by another member or with another id is the same not-found."""
    other = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS3", "ABC", 2)
    secret = mint_for(repositories, MEMBER, WRITE)
    started = started_upload(client, secret)
    land_upload(started, issue, MEMBER)
    good = {"upload_id": started["upload_id"], "ticket": started["ticket"]}

    answers = [
        tool(client, secret, "commit_attachment_upload", {"issue_id": other.issue_id, **good}),
        tool(
            client,
            mint_for(repositories, OWNER, WRITE),
            "commit_attachment_upload",
            {"issue_id": "ABC-1", **good},
        ),
        tool(client, secret, "commit_attachment_upload", {"issue_id": "ABC-1", **good, "upload_id": "another"}),
    ]

    for response in answers:
        assert "not found" in refusal(response).lower()
    assert repositories.attachments.storage_used(WORKSPACE) == 0


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"size_bytes": MAX_UPLOAD_BYTES + 1}, "limited to"),
        ({"size_bytes": 0}, "positive"),
        ({"size_bytes": "12"}, "positive"),
        ({"content_type": "application/x-msdownload"}, "cannot be uploaded"),
    ],
)
def test_a_presigned_upload_the_rules_refuse_signs_nothing(
    client: TestClient,
    repositories: Any,
    issue: Issue,
    attachments_bucket: str,
    overrides: dict[str, Any],
    message: str,
) -> None:
    """The web's ceilings and allow list hold on the way to a URL."""
    secret = mint_for(repositories, MEMBER, WRITE)
    arguments = {
        "issue_id": "ABC-1",
        "filename": "a.png",
        "content_type": "image/png",
        "size_bytes": len(PNG),
        **overrides,
    }

    assert message in refusal(tool(client, secret, "create_attachment_upload", arguments))


@pytest.mark.parametrize(
    ("title", "content_type", "expected"),
    [
        ("a.png", "image/png", "![a.png](PATH)"),
        ("a.png", "IMAGE/PNG; charset=binary", "![a.png](PATH)"),
        ("clip.mp4", "video/mp4", "![clip.mp4](PATH&media=video)"),
        ("spec.pdf", "application/pdf", "[spec.pdf](PATH)"),
        ("a]b[c\\d\ne.png", "image/png", "![a\\]b\\[c\\\\d e.png](PATH)"),
    ],
)
def test_the_embed_is_what_the_editor_writes(title: str, content_type: str, expected: str) -> None:
    """Images and videos embed, other files link, and a name cannot end the link text."""
    attachment = build_attachment(
        WORKSPACE,
        "01JB0000000000000000000IS1",
        TEAM,
        "file",
        title,
        OWNER,
        s3_key="workspaces/key",
        content_type=content_type,
        size_bytes=1,
    )
    path = content_path(WORKSPACE, attachment.issue_id, attachment.attachment_id)

    assert embed_markdown(attachment) == expected.replace("PATH", path)
