"""Rendering the four notification emails an inbox row also goes out as.

One message per notification kind, built from the same row the inbox renders, so
an email and the badge behind it can never describe different things. Both parts
are produced together and the HTML one is escaped in a single place, so a new kind
cannot be added with an unescaped title in it.

The link is built from `settings.frontend_base_url` rather than a request host,
because a stream consumer serves no request and the SPA lives on its own domain.
"""

from __future__ import annotations

import html
from string import Template
from typing import Mapping
from urllib.parse import quote

from webbpulse.identity.email import EmailMessage

from app.common.core.config import settings

EXCERPT_LIMIT = 280
"""How much of a comment an email carries before it is cut.

Long enough that most comments arrive whole and short enough that a pasted stack
trace does not become the message.
"""

_HEADLINES: Mapping[str, str] = {
    "assigned": "$actor assigned this issue to you.",
    "mentioned": "$actor mentioned you in a comment.",
    "commented": "$actor commented on this issue.",
    "status_changed": "$actor changed the status of this issue.",
    "mentioned_in_description": "$actor mentioned you in this issue.",
}

_DOCUMENT = Template(
    """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>$subject</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; \
font-size: 15px; line-height: 1.5; color: #1a1a1a;">
<p>$headline</p>
<p><a href="$link">$issue_key $title</a></p>
$excerpt<p style="color: #666; font-size: 13px;">You are receiving this because you \
follow activity on this issue. Turn these off in your $product_name notification settings.</p>
</body>
</html>
"""
)

_TEXT = Template(
    """$headline

$issue_key $title
$link
$excerpt
You are receiving this because you follow activity on this issue. Turn these off
in your $product_name notification settings.
"""
)


def issue_url(workspace_slug: str, issue_key: str) -> str:
    """The SPA link to one issue, or to the workspace list when the slug is gone.

    A workspace whose row cannot be read still gets a working link rather than a
    broken path, because an email that arrives after a rename is a link problem
    and not a reason to withhold the notification.
    """
    base = settings.frontend_base_url
    if not workspace_slug:
        return f"{base}/workspaces"
    return f"{base}/w/{quote(workspace_slug, safe='')}/issues/{quote(issue_key, safe='')}"


def excerpt(body: str) -> str:
    """One comment cut to `EXCERPT_LIMIT`, with an ellipsis when it was cut."""
    collapsed = " ".join(body.split())
    if len(collapsed) <= EXCERPT_LIMIT:
        return collapsed
    return collapsed[:EXCERPT_LIMIT].rstrip() + "..."


def render_notification(
    *,
    kind: str,
    to: str,
    actor_name: str,
    issue_key: str,
    issue_title: str,
    workspace_slug: str,
    comment_excerpt: str = "",
    headline_key: str | None = None,
) -> EmailMessage:
    """Render the email for one inbox notification.

    The subject is `[ABC-123] Title`, which is what threads a conversation about
    one issue together in a mail client and what a person scans for. An unknown
    kind falls back to the plainest headline rather than raising: the inbox row is
    already written, and a kind added without a template here should still mail.
    `headline_key` picks a more specific headline than the kind's own, such as a
    mention in a description rather than in a comment.
    """
    actor = actor_name.strip() or "Someone"
    title = issue_title.strip() or "Untitled issue"
    subject = f"[{issue_key}] {title}" if issue_key else title
    link = issue_url(workspace_slug, issue_key)
    headline = Template(_HEADLINES.get(headline_key or kind, "$actor updated this issue.")).substitute(actor=actor)

    values = {
        "subject": subject,
        "headline": headline,
        "issue_key": issue_key,
        "title": title,
        "link": link,
        "product_name": settings.PROJECT_NAME,
    }
    escaped = {key: html.escape(value, quote=True) for key, value in values.items()}

    trimmed = excerpt(comment_excerpt)
    text_excerpt = f"\n{trimmed}\n" if trimmed else ""
    html_excerpt = f"<blockquote>{html.escape(trimmed, quote=True)}</blockquote>\n" if trimmed else ""

    return EmailMessage(
        to=to,
        subject=subject,
        text=_TEXT.substitute(values, excerpt=text_excerpt),
        html=_DOCUMENT.substitute(escaped, excerpt=html_excerpt),
        tags={"purpose": "notification", "kind": kind},
    )
