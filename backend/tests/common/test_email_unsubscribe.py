"""The signed tokens a notification email's unsubscribe links carry, and the links themselves."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from webbpulse.email_layout import EmailLink
from webbpulse.identity.email import EmailMessage
from webbpulse.security import create_token

from app.common.core.config import settings
from app.common.db.dynamo.notify_digests import DigestEntry
from app.common.email.delivery import ReplyToSesSender, with_reply_to
from app.common.email.invite import render_invite
from app.common.email_unsubscribe import (
    ISSUE,
    KIND,
    PROJECT,
    UNDO,
    UNSUBSCRIBE_PATH,
    UNSUBSCRIBE_TOKEN_TTL,
    UnsubscribeTokenError,
    list_unsubscribe_headers,
    mint_unsubscribe_token,
    read_unsubscribe_token,
    unsubscribe_links,
)
from app.domains.views.consumers.digest import footer_unsubscribe_links
from app.domains.views.email import render_digest, render_notification

USER = "01JB0000000000000000000USR"
WORKSPACE = "01JB00000000000000000000WS"


def _token_of(url: str) -> str:
    """The token a link carries in its query."""
    return parse_qs(urlsplit(url).query)["token"][0]


def test_a_token_round_trips_every_claim() -> None:
    """What was minted is what is read back, the restore data included."""
    token = mint_unsubscribe_token(
        user_id=USER,
        workspace_id=WORKSPACE,
        action=ISSUE,
        target="ISSUE1",
        op=UNDO,
        label="ENG-1",
        restore={"team": "T1", "reason": "assigned"},
    )
    grant = read_unsubscribe_token(token)
    assert (grant.user_id, grant.workspace_id, grant.action, grant.target, grant.op, grant.label) == (
        USER,
        WORKSPACE,
        ISSUE,
        "ISSUE1",
        UNDO,
        "ENG-1",
    )
    assert grant.restore == {"team": "T1", "reason": "assigned"}


def test_a_token_never_carries_an_email_address() -> None:
    """The link names a user id, never the address it was mailed to."""
    token = mint_unsubscribe_token(user_id=USER, workspace_id=WORKSPACE, action=KIND, target="mentioned")
    assert "@" not in token


def test_a_tampered_token_is_refused() -> None:
    """Changing any byte of the signed token breaks it."""
    token = mint_unsubscribe_token(user_id=USER, workspace_id=WORKSPACE, action=KIND, target="mentioned")
    head, body, signature = token.split(".")
    middle = len(signature) // 2
    flipped = signature[:middle] + ("B" if signature[middle] == "A" else "A") + signature[middle + 1 :]
    with pytest.raises(UnsubscribeTokenError):
        read_unsubscribe_token(f"{head}.{body}.{flipped}")
    other = mint_unsubscribe_token(user_id="SOMEONEELSE", workspace_id=WORKSPACE, action=KIND, target="mentioned")
    with pytest.raises(UnsubscribeTokenError):
        read_unsubscribe_token(f"{head}.{other.split('.')[1]}.{signature}")


def test_a_token_signed_with_another_key_is_refused() -> None:
    """Only `SECRET_KEY` signs these."""
    forged = create_token(
        {"sub": USER, "ws": WORKSPACE, "act": KIND, "tgt": "mentioned", "op": "stop"},
        "some-other-key-entirely-not-ours",
        expires_in=timedelta(days=1),
        audience="standupless.email-unsubscribe",
    )
    with pytest.raises(UnsubscribeTokenError):
        read_unsubscribe_token(forged)


def test_a_token_for_another_audience_is_refused() -> None:
    """A token the product signs for anything else does not replay as an unsubscribe."""
    other = create_token(
        {"sub": USER, "ws": WORKSPACE, "act": KIND, "tgt": "mentioned", "op": "stop"},
        settings.SECRET_KEY,
        expires_in=timedelta(days=1),
        audience="standupless.something-else",
    )
    with pytest.raises(UnsubscribeTokenError):
        read_unsubscribe_token(other)


def test_an_expired_token_is_refused() -> None:
    """A link older than its lifetime stops working."""
    token = mint_unsubscribe_token(
        user_id=USER,
        workspace_id=WORKSPACE,
        action=KIND,
        target="mentioned",
        now=datetime.now(UTC) - UNSUBSCRIBE_TOKEN_TTL - timedelta(minutes=5),
    )
    with pytest.raises(UnsubscribeTokenError):
        read_unsubscribe_token(token)


def test_an_unknown_action_is_refused() -> None:
    """A signed token naming no known action changes nothing."""
    token = create_token(
        {"sub": USER, "ws": WORKSPACE, "act": "everything", "tgt": "x", "op": "stop"},
        settings.SECRET_KEY,
        expires_in=timedelta(days=1),
        audience="standupless.email-unsubscribe",
    )
    with pytest.raises(UnsubscribeTokenError):
        read_unsubscribe_token(token)
    with pytest.raises(ValueError):
        mint_unsubscribe_token(user_id=USER, workspace_id=WORKSPACE, action="everything", target="x")


def test_an_empty_token_is_refused() -> None:
    """No token is the same refusal as a bad one."""
    with pytest.raises(UnsubscribeTokenError):
        read_unsubscribe_token("")


def test_an_issue_email_offers_the_issue_and_the_kind_link() -> None:
    """A single subscription driven kind gets both links, the target first."""
    links = unsubscribe_links(
        user_id=USER, workspace_id=WORKSPACE, kinds=["commented"], issue_id="ISSUE1", issue_key="ENG-1"
    )
    assert [link.label for link in links] == ["Unsubscribe from this issue", "Stop emails like this"]
    assert all(UNSUBSCRIBE_PATH in link.url for link in links)
    issue, kind = (read_unsubscribe_token(_token_of(link.url)) for link in links)
    assert (issue.action, issue.target, issue.label) == (ISSUE, "ISSUE1", "ENG-1")
    assert (kind.action, kind.target) == (KIND, "commented")


def test_a_project_update_email_offers_the_project_link() -> None:
    """Project updates get the project link instead of an issue link."""
    links = unsubscribe_links(user_id=USER, workspace_id=WORKSPACE, kinds=["project_update"], project_id="P1")
    assert [link.label for link in links] == ["Unsubscribe from this project", "Stop emails like this"]
    grant = read_unsubscribe_token(_token_of(links[0].url))
    assert (grant.action, grant.target) == (PROJECT, "P1")


def test_a_reminder_offers_only_the_kind_link() -> None:
    """A kind a subscription does not drive gets no issue link, since unsubscribing would not stop it."""
    links = unsubscribe_links(user_id=USER, workspace_id=WORKSPACE, kinds=["due_soon"], issue_id="ISSUE1")
    assert [link.label for link in links] == ["Stop emails like this"]


def test_a_mixed_digest_offers_no_kind_link() -> None:
    """A link never stops more than the email it sits in, so mixed kinds get no kind link."""
    links = unsubscribe_links(user_id=USER, workspace_id=WORKSPACE, kinds=["commented", "mentioned"], issue_id="ISSUE1")
    assert [link.label for link in links] == ["Unsubscribe from this issue"]
    assert unsubscribe_links(user_id=USER, workspace_id=WORKSPACE, kinds=["commented", "mentioned"]) == ()


def test_no_person_or_workspace_means_no_links() -> None:
    """An email with nobody to name carries only the settings link."""
    assert unsubscribe_links(user_id="", workspace_id=WORKSPACE, kinds=["commented"]) == ()
    assert unsubscribe_links(user_id=USER, workspace_id="", kinds=["commented"]) == ()


def _entry(kind: str, issue_id: str = "", project_id: str = "") -> DigestEntry:
    """One held notification for the member."""
    return DigestEntry(
        workspace_id=WORKSPACE,
        recipient_id=USER,
        notification_id=f"N-{kind}-{issue_id}",
        kind=kind,
        team_id="T1",
        issue_id=issue_id,
        issue_key="ENG-1" if issue_id else "",
        project_id=project_id,
        created_at=datetime.now(UTC),
    )


def test_a_digest_about_one_issue_names_it() -> None:
    """Every entry about one issue and one kind gets both links."""
    links = footer_unsubscribe_links(WORKSPACE, USER, [_entry("commented", "I1"), _entry("commented", "I1")])
    assert [link.label for link in links] == ["Unsubscribe from this issue", "Stop emails like this"]


def test_a_digest_across_issues_names_none() -> None:
    """Entries about two issues get no issue link, only the shared kind's."""
    links = footer_unsubscribe_links(WORKSPACE, USER, [_entry("commented", "I1"), _entry("commented", "I2")])
    assert [link.label for link in links] == ["Stop emails like this"]


def test_a_project_update_digest_names_the_project() -> None:
    """A project update entry carries the project link."""
    links = footer_unsubscribe_links(WORKSPACE, USER, [_entry("project_update", project_id="P1")])
    assert [link.label for link in links] == ["Unsubscribe from this project", "Stop emails like this"]


def test_the_footer_renders_before_the_settings_link() -> None:
    """The rendered email carries the unsubscribe links next to the settings link."""
    entry = _entry("commented", "I1")
    message = render_digest(
        [entry],
        to="reader@example.com",
        workspace_slug="acme",
        unsubscribe_links=footer_unsubscribe_links(WORKSPACE, USER, [entry]),
    )
    html = message.html
    assert "Unsubscribe from this issue" in html
    assert "Stop emails like this" in html
    assert html.index("Stop emails like this") < html.index("Notification settings")
    assert UNSUBSCRIBE_PATH in html


API_ORIGIN = "https://api.example.test"


@pytest.fixture
def https_api(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point unsubscribe links at an https API origin, as staging and production do."""
    monkeypatch.setattr(settings, "API_URL", API_ORIGIN, raising=False)


def _issue_notification() -> tuple[EmailMessage, tuple[EmailLink, ...]]:
    """One rendered comment notification with its footer unsubscribe links."""
    links = unsubscribe_links(
        user_id=USER, workspace_id=WORKSPACE, kinds=["commented"], issue_id="ISSUE1", issue_key="ENG-1"
    )
    return render_notification(
        kind="commented",
        to="reader@example.com",
        actor_name="Ada",
        issue_key="ENG-1",
        issue_title="Fix the build",
        workspace_slug="acme",
        unsubscribe_links=links,
    ), links


def test_a_notification_carries_the_one_click_headers(https_api: None) -> None:
    """The header points at the most specific footer link, the issue one, and is one-click."""
    message, links = _issue_notification()
    assert message.headers == {
        "List-Unsubscribe": f"<{links[0].url}>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    }
    grant = read_unsubscribe_token(_token_of(links[0].url))
    assert (grant.action, grant.target) == (ISSUE, "ISSUE1")


def test_a_digest_carries_the_headers_for_its_first_link(https_api: None) -> None:
    """A digest's header uses the same link that leads its footer."""
    entry = _entry("commented", "I1")
    links = footer_unsubscribe_links(WORKSPACE, USER, [entry])
    message = render_digest([entry], to="reader@example.com", workspace_slug="acme", unsubscribe_links=links)
    assert message.headers["List-Unsubscribe"] == f"<{links[0].url}>"
    assert message.headers["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"


def test_only_an_https_link_makes_headers() -> None:
    """RFC 8058 needs https, so a plain http link or no link means no headers."""
    assert list_unsubscribe_headers(()) == {}
    assert list_unsubscribe_headers((EmailLink("Stop emails like this", "http://localhost:8000/x"),)) == {}
    assert list_unsubscribe_headers((EmailLink("Stop emails like this", "https://api.example.test/x"),)) == {
        "List-Unsubscribe": "<https://api.example.test/x>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    }


def test_a_notification_without_links_carries_no_headers(https_api: None) -> None:
    """An email that names nobody has no unsubscribe link, so no headers either."""
    message = render_notification(
        kind="commented",
        to="reader@example.com",
        actor_name="Ada",
        issue_key="ENG-1",
        issue_title="Fix the build",
        workspace_slug="acme",
    )
    assert message.headers == {}


def test_transactional_mail_carries_no_headers(https_api: None) -> None:
    """An invite is not a notification and offers no unsubscribe."""
    message = render_invite(
        to="new@example.com",
        token="t",
        workspace_name="Acme",
        role="member",
        inviter_name="Ada",
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    assert message.headers == {}


class _Client:
    """Records each SES SendEmail request."""

    def __init__(self) -> None:
        """Start empty."""
        self.requests: list[dict[str, Any]] = []

    def send_email(self, **kwargs: Any) -> dict[str, str]:
        """Record one request."""
        self.requests.append(kwargs)
        return {"MessageId": "m"}


def test_the_headers_reach_ses_with_and_without_a_reply_address(https_api: None) -> None:
    """Both sender paths send the headers, and the reply path still sets Reply-To."""
    message, _ = _issue_notification()
    replyable = with_reply_to(message, "reply-x@example.com")
    assert replyable.headers == message.headers

    client = _Client()
    sender = ReplyToSesSender(client, from_address="no-reply@example.com")
    sender.send(replyable)
    sender.send(message)
    expected = [{"Name": name, "Value": value} for name, value in message.headers.items()]
    for request in client.requests:
        assert request["Content"]["Simple"]["Headers"] == expected
    assert client.requests[0]["ReplyToAddresses"] == ["reply-x@example.com"]
    assert "ReplyToAddresses" not in client.requests[1]
