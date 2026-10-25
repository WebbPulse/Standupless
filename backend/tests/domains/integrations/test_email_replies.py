"""Reply by email: minting the Reply-To, verifying the token, and posting the reply as a comment.

The consumer runs against the real tables, so token verification, sender checks,
quote stripping, threading, duplicates and the refusal notice are held end to
end. Every address is under example.com, and mail goes to a recording sender.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Any, Iterator

import pytest
from webbpulse.identity.email import RecordingEmailSender

from app.common.change_source import EMAIL
from app.common.db.dynamo.comments import Comment, build_comment
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.notify_digests import DigestEntry
from app.common.email import ReplyableEmail, reset_email_sender
from app.common.email_replies import (
    TOKEN_LENGTH,
    mint_reply_address,
    reply_tokens,
    resolve_reply_token,
    token_digest,
    verify_reply_token,
)
from app.domains.integrations.consumers import email_intake as consumer
from app.domains.integrations.email_replies import reply_body
from app.domains.integrations.intake_mail import parse_mail
from app.domains.views.consumers.digest import _compose
from app.domains.views.email import REPLY_HINT
from tests.domains.helpers import GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import TEAM, WORKSPACE

DOMAIN = "intake.example.com"


@pytest.fixture(autouse=True)
def reply_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """An intake domain and a signing master, as a deployment with replies has."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "EMAIL_INTAKE_DOMAIN", DOMAIN, raising=False)
    monkeypatch.setattr(settings, "EMAIL_INTAKE_BUCKET", "intake-test", raising=False)
    monkeypatch.setenv("WEBHOOK_SIGNING_KEY", "dGVzdC1zaWduaW5nLWtleS1ub3QtYS1yZWFsLW9uZQ==")
    yield


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


@pytest.fixture
def verified(repositories: Any, workspace: str) -> None:
    """Every seeded member with a verified address, as a signed up account has."""
    for user_id in (OWNER, MEMBER, GUEST):
        repositories.users.update(user_id, email_verified=True)


def _address(repositories: Any, issue: Issue, user_id: str, comment_id: str = "", **kwargs: Any) -> str:
    """The reply address one member's email about one issue carries."""
    address = mint_reply_address(
        repositories.inbox.email_replies,
        workspace_id=WORKSPACE,
        issue_id=issue.issue_id,
        user_id=user_id,
        comment_id=comment_id,
        **kwargs,
    )
    assert address
    return address


def _reply(
    to: str,
    *,
    sender: str = "Mel Member <member@example.com>",
    body: str = "Sounds good, shipping it.\n\nOn Mon, 1 Jan 2026, Olive wrote:\n> the old words\n",
    message_id: str = "<r1@mail.example.com>",
    headers: dict[str, str] | None = None,
    files: tuple[tuple[str, str, bytes], ...] = (),
) -> bytes:
    """One raw reply mail to a reply address."""
    message = EmailMessage()
    message["From"] = sender
    message["To"] = to
    message["Subject"] = "Re: [ABC-1] An issue"
    message["Message-ID"] = message_id
    for name, value in (headers or {}).items():
        message[name] = value
    message.set_content(body)
    for filename, content_type, data in files:
        maintype, subtype = content_type.split("/")
        message.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
    return message.as_bytes()


def _comments(repositories: Any, issue: Issue) -> list[Comment]:
    """Every comment on one issue, oldest first."""
    page = repositories.comments.list_for_issue(WORKSPACE, issue.issue_id)
    return [Comment.model_validate(dict(item)) for item in page.items]


def _seed_comment(repositories: Any, issue: Issue, author: str, parent: str | None = None) -> Comment:
    """One comment on the issue, a reply when `parent` is given."""
    return repositories.comments.create(
        build_comment(WORKSPACE, issue.issue_id, issue.team_id, author, "A comment.", parent_comment_id=parent)
    )


def test_a_reply_address_is_signed_per_recipient_and_resolves_back(repositories: Any, issue: Issue) -> None:
    """Every recipient's address differs, fits a local part, and its row never holds the token."""
    member = _address(repositories, issue, MEMBER)
    owner = _address(repositories, issue, OWNER)
    assert member != owner
    local, _, domain = member.partition("@")
    assert domain == DOMAIN
    assert len(local) <= 64
    [token] = reply_tokens([member], DOMAIN)
    assert len(token) == TOKEN_LENGTH

    row = verify_reply_token(repositories.inbox.email_replies, token)
    assert row is not None
    assert (row.workspace_id, row.issue_id, row.user_id) == (WORKSPACE, issue.issue_id, MEMBER)
    stored = repositories.inbox.email_replies.get(token_digest(token))
    assert stored is not None
    assert token not in stored.model_dump_json()


def test_a_forged_or_expired_token_does_not_verify(repositories: Any, issue: Issue) -> None:
    """A guessed token resolves to nothing, and a genuine one stops verifying once expired."""
    store = repositories.inbox.email_replies
    assert verify_reply_token(store, "a" * TOKEN_LENGTH) is None

    long_ago = datetime.now(timezone.utc) - timedelta(days=31)
    [token] = reply_tokens([_address(repositories, issue, MEMBER, now=long_ago)], DOMAIN)
    assert verify_reply_token(store, token) is None
    assert resolve_reply_token(store, token) is not None


def test_a_row_edited_to_point_elsewhere_does_not_verify(repositories: Any, issue: Issue, hidden_issue: Issue) -> None:
    """The HMAC is recomputed over the stored row, so retargeting a row breaks its token."""
    store = repositories.inbox.email_replies
    [token] = reply_tokens([_address(repositories, issue, MEMBER)], DOMAIN)
    row = store.get(token_digest(token))
    assert row is not None
    store.put(token_digest(token), row.model_copy(update={"issue_id": hidden_issue.issue_id}))
    assert verify_reply_token(store, token) is None


def test_no_master_key_means_no_reply_address(repositories: Any, issue: Issue, monkeypatch: pytest.MonkeyPatch) -> None:
    """Minting fails soft, so an environment without the key sends no-reply email as before."""
    monkeypatch.setenv("WEBHOOK_SIGNING_KEY", "")
    assert (
        mint_reply_address(
            repositories.inbox.email_replies, workspace_id=WORKSPACE, issue_id=issue.issue_id, user_id=MEMBER
        )
        == ""
    )


def test_a_reply_posts_a_comment_by_the_member_via_email(
    repositories: Any, issue: Issue, verified: None, recorder: RecordingEmailSender
) -> None:
    """The quoted history is stripped and the comment is the member's, attributed to email."""
    assert consumer.handle_mail(repositories, _reply(_address(repositories, issue, MEMBER))) is None

    [comment] = _comments(repositories, issue)
    assert comment.author_id == MEMBER
    assert comment.body == "Sounds good, shipping it."
    assert comment.source == EMAIL
    assert comment.parent_comment_id is None
    assert recorder.sent == []


def test_a_sender_who_is_not_the_recipient_posts_nothing_and_hears_nothing(
    repositories: Any, issue: Issue, verified: None, recorder: RecordingEmailSender
) -> None:
    """A forwarded or spoofed reply is dropped silently, so no notice can be aimed at anyone."""
    to = _address(repositories, issue, MEMBER)
    consumer.handle_mail(repositories, _reply(to, sender="Ozzy <outsider@example.com>"))
    assert _comments(repositories, issue) == []
    assert recorder.sent == []


def test_an_unverified_account_cannot_post_by_reply(repositories: Any, issue: Issue, workspace: str) -> None:
    """The sender must match a verified address, not just any address on the account."""
    consumer.handle_mail(repositories, _reply(_address(repositories, issue, MEMBER)))
    assert _comments(repositories, issue) == []


def test_a_reply_to_a_comment_notification_threads_under_its_root(
    repositories: Any, issue: Issue, verified: None
) -> None:
    """A reply to a notification about a reply lands in that reply's thread, one level deep."""
    root = _seed_comment(repositories, issue, OWNER)
    reply = _seed_comment(repositories, issue, OWNER, parent=root.comment_id)

    consumer.handle_mail(repositories, _reply(_address(repositories, issue, MEMBER, reply.comment_id)))
    consumer.handle_mail(
        repositories,
        _reply(_address(repositories, issue, MEMBER, root.comment_id), message_id="<r2@mail.example.com>"),
    )

    posted = [comment for comment in _comments(repositories, issue) if comment.author_id == MEMBER]
    assert [comment.parent_comment_id for comment in posted] == [root.comment_id, root.comment_id]


def test_a_redelivered_reply_posts_once(repositories: Any, issue: Issue, verified: None) -> None:
    """The Message-ID is claimed, so SES redelivering the same mail adds no second comment."""
    raw = _reply(_address(repositories, issue, MEMBER))
    consumer.handle_mail(repositories, raw)
    consumer.handle_mail(repositories, raw)
    assert len(_comments(repositories, issue)) == 1


def test_an_empty_reply_posts_nothing(repositories: Any, issue: Issue, verified: None) -> None:
    """Nothing left once the quote and signature are gone means no comment."""
    body = "\n-- \nMel\n\nOn Mon, 1 Jan 2026, Olive wrote:\n> the old words\n"
    consumer.handle_mail(repositories, _reply(_address(repositories, issue, MEMBER), body=body))
    assert _comments(repositories, issue) == []


def test_attachments_on_a_reply_are_dropped(repositories: Any, issue: Issue, verified: None) -> None:
    """The text is posted and the file is not stored."""
    files = (("shot.png", "image/png", b"\x89PNG fake"),)
    consumer.handle_mail(repositories, _reply(_address(repositories, issue, MEMBER), files=files))
    [comment] = _comments(repositories, issue)
    assert comment.attachment_ids == []


def test_a_member_who_lost_access_gets_one_notice_and_no_comment(
    repositories: Any, hidden_issue: Issue, verified: None, recorder: RecordingEmailSender
) -> None:
    """A guest outside the team posts nothing and hears once a day at most, from no-reply."""
    to = _address(repositories, hidden_issue, GUEST)
    sender = "Gus Guest <guest@example.com>"
    consumer.handle_mail(repositories, _reply(to, sender=sender))
    consumer.handle_mail(repositories, _reply(to, sender=sender, message_id="<r2@mail.example.com>"))

    assert _comments(repositories, hidden_issue) == []
    assert [message.to for message in recorder.sent] == ["guest@example.com"]
    assert not getattr(recorder.sent[0], "reply_to", "")


def test_an_expired_reply_from_a_machine_is_never_answered(
    repositories: Any, issue: Issue, verified: None, recorder: RecordingEmailSender
) -> None:
    """An auto reply to an expired address posts nothing and sends nothing, so no loop can start."""
    long_ago = datetime.now(timezone.utc) - timedelta(days=31)
    to = _address(repositories, issue, MEMBER, now=long_ago)
    consumer.handle_mail(repositories, _reply(to, headers={"Auto-Submitted": "auto-replied"}))
    assert _comments(repositories, issue) == []
    assert recorder.sent == []

    consumer.handle_mail(repositories, _reply(to, message_id="<r2@mail.example.com>"))
    assert [message.to for message in recorder.sent] == ["member@example.com"]


def test_reply_body_strips_quotes_and_mobile_signatures() -> None:
    """The stripping is fixed rules: `>` lines, the "On ... wrote:" line, `-- ` and a phone trailer."""
    raw = _reply(
        f"reply-{'a' * TOKEN_LENGTH}@{DOMAIN}",
        body="Looks right.\n\nSent from my iPhone\n\nOn Tue, 2 Jan 2026, Olive wrote:\n> older\n> words\n",
    )
    assert reply_body(parse_mail(raw)) == "Looks right."


def _entry(issue: Issue, notification_id: str, comment_id: str = "") -> DigestEntry:
    """One held notification about the issue for the member."""
    return DigestEntry(
        workspace_id=WORKSPACE,
        recipient_id=MEMBER,
        notification_id=notification_id,
        kind="commented",
        team_id=TEAM,
        actor_name="Olive Owner",
        issue_id=issue.issue_id,
        issue_key=issue.key,
        issue_title=issue.title,
        comment_id=comment_id,
        excerpt="A comment.",
        created_at=datetime.now(timezone.utc),
    )


def test_a_single_issue_email_carries_a_reply_address_and_a_digest_does_not(
    repositories: Any, issue: Issue, workspace: str
) -> None:
    """One notification is replyable and says so; a grouped digest stays no-reply."""
    single = _compose(repositories, WORKSPACE, MEMBER, [_entry(issue, "n1", "c1")], check_inbox=False)
    assert isinstance(single, ReplyableEmail)
    [token] = reply_tokens([single.reply_to], DOMAIN)
    row = verify_reply_token(repositories.inbox.email_replies, token)
    assert row is not None and row.comment_id == "c1"
    assert REPLY_HINT in single.text

    digest = _compose(repositories, WORKSPACE, MEMBER, [_entry(issue, "n1"), _entry(issue, "n2")], check_inbox=False)
    assert digest is not None
    assert not getattr(digest, "reply_to", "")
    assert REPLY_HINT not in digest.text


def test_the_sender_adds_the_reply_to_header() -> None:
    """SES gets `ReplyToAddresses` only for a message that names one."""
    from app.common.email.delivery import ReplyToSesSender

    class Client:
        """Records each SendEmail request."""

        def __init__(self) -> None:
            """Start empty."""
            self.requests: list[dict[str, Any]] = []

        def send_email(self, **kwargs: Any) -> dict[str, str]:
            """Record one request."""
            self.requests.append(kwargs)
            return {"MessageId": "m"}

    client = Client()
    sender = ReplyToSesSender(client, from_address="no-reply@example.com")
    sender.send(ReplyableEmail(to="a@example.com", subject="s", text="t", html="h", reply_to="reply-x@example.com"))
    sender.send(ReplyableEmail(to="a@example.com", subject="s", text="t", html="h"))
    assert client.requests[0]["ReplyToAddresses"] == ["reply-x@example.com"]
    assert "ReplyToAddresses" not in client.requests[1]
