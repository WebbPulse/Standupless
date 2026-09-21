"""The four notification emails a written inbox row goes out as.

What these hold is the part a reader sees: the subject is the issue key and title,
the body names the actor and links into the SPA, and a title carrying markup
cannot escape the HTML part.
"""

from __future__ import annotations

import pytest

from app.common.core.config import settings
from app.domains.views.email import EXCERPT_LIMIT, excerpt, issue_url, render_notification

KINDS = ("assigned", "mentioned", "commented", "status_changed")


def render(**overrides: object) -> object:
    """One rendered notification, with sensible defaults for what a test ignores."""
    values: "dict[str, object]" = {
        "kind": "assigned",
        "to": "member@example.com",
        "actor_name": "Olive Owner",
        "issue_key": "ABC-123",
        "issue_title": "The bug",
        "workspace_slug": "acme",
    }
    values.update(overrides)
    return render_notification(**values)  # type: ignore[arg-type]


@pytest.mark.parametrize("kind", KINDS)
def test_every_kind_renders_both_parts(kind: str) -> None:
    """All four kinds mail, because all four write an inbox row."""
    message = render(kind=kind)
    assert message.subject == "[ABC-123] The bug"
    assert message.text.strip()
    assert message.html.strip().startswith("<!doctype html>")
    assert message.tags == {"purpose": "notification", "kind": kind}


@pytest.mark.parametrize(
    ("kind", "phrase"),
    [
        ("assigned", "assigned this issue to you"),
        ("mentioned", "mentioned you in a comment"),
        ("commented", "commented on this issue"),
        ("status_changed", "changed the status"),
    ],
)
def test_each_kind_says_what_happened(kind: str, phrase: str) -> None:
    """The headline is the whole reason four templates exist rather than one."""
    message = render(kind=kind)
    assert phrase in message.text
    assert phrase in message.html
    assert "Olive Owner" in message.text


def test_the_body_links_into_the_frontend() -> None:
    """The link is built from the setting, never from a request host."""
    message = render()
    expected = f"{settings.frontend_base_url}/w/acme/issues/ABC-123"
    assert expected in message.text
    assert expected in message.html


def test_a_missing_slug_still_gives_a_working_link() -> None:
    """A workspace that cannot be read is a link problem, not a reason to withhold."""
    assert issue_url("", "ABC-1") == f"{settings.frontend_base_url}/workspaces"


def test_a_comment_excerpt_is_carried() -> None:
    """A comment notification that showed no comment would say nothing useful."""
    message = render(kind="commented", comment_excerpt="Looks wrong to me")
    assert "Looks wrong to me" in message.text
    assert "Looks wrong to me" in message.html


def test_an_issue_notification_carries_no_empty_quote() -> None:
    """An assignment has no comment, so the excerpt block is absent rather than blank."""
    assert "<blockquote>" not in render(kind="assigned").html


def test_a_long_comment_is_cut() -> None:
    """A pasted stack trace must not become the message."""
    trimmed = excerpt("x" * (EXCERPT_LIMIT + 50))
    assert len(trimmed) == EXCERPT_LIMIT + 3
    assert trimmed.endswith("...")


def test_markup_in_a_title_cannot_escape_the_html_part() -> None:
    """The title is user input, so the one escape in the renderer is what holds."""
    message = render(issue_title="<script>alert(1)</script>")
    assert "<script>" not in message.html
    assert "&lt;script&gt;" in message.html


def test_markup_in_a_comment_cannot_escape_the_html_part() -> None:
    """A comment body is markdown from a person, so it is escaped the same way."""
    message = render(kind="commented", comment_excerpt="<img onerror=x>")
    assert "<img" not in message.html


def test_a_nameless_actor_still_reads_as_a_sentence() -> None:
    """A user row that is gone leaves no name, and the mail still has to make sense."""
    assert "Someone assigned this issue to you." in render(actor_name="").text


def test_no_em_dashes_anywhere() -> None:
    """House style, held here rather than in review."""
    for kind in KINDS:
        message = render(kind=kind, comment_excerpt="a comment")
        assert "—" not in message.text
        assert "—" not in message.html
        assert "—" not in message.subject
