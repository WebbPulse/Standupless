"""Rendering the notification emails an inbox row also goes out as.

One message per notification kind, built from the same row the inbox renders, so
an email and the badge behind it can never describe different things. Both parts
are produced together and the HTML one is escaped in a single place, so a new kind
cannot be added with an unescaped title in it.

The link is built from `settings.frontend_base_url` rather than a request host,
because a stream consumer serves no request and the SPA lives on its own domain.
"""

from __future__ import annotations

import html
import re
from string import Template
from typing import Mapping, Sequence
from urllib.parse import quote

from webbpulse.identity.email import EmailMessage

from app.common.core.config import settings
from app.common.db.dynamo.notify_digests import DigestEntry

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


MARKDOWN_IMAGE = re.compile(r"!\[(?P<alt>[^\]]*)\]\((?P<src>[^)\s]+)(?:\s+\"[^\"]*\")?\)")
"""An inline image or video embed in a Markdown body."""


def _media_label(match: "re.Match[str]") -> str:
    """The plain text an embedded image or video reads as in an email."""
    kind = "Video" if "media=video" in match.group("src") else "Image"
    alt = match.group("alt").strip()
    return f"[{kind}: {alt}]" if alt else f"[{kind}]"


def excerpt(body: str) -> str:
    """One comment cut to `EXCERPT_LIMIT`, with an ellipsis when it was cut.

    Embedded images and videos read as a short label rather than a URL, because
    the content URL needs a token the email cannot carry; the issue link beside
    the excerpt is where the reader sees them.
    """
    collapsed = " ".join(MARKDOWN_IMAGE.sub(_media_label, body).split())
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


_HEALTH_LABELS: Mapping[str, str] = {"on_track": "On track", "at_risk": "At risk", "off_track": "Off track"}

_PROJECT_DOCUMENT = Template(
    """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>$subject</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; \
font-size: 15px; line-height: 1.5; color: #1a1a1a;">
<p>$headline</p>
<p><a href="$link">$title</a> is $health.</p>
$excerpt<p style="color: #666; font-size: 13px;">You are receiving this because you \
lead or are a member of this project. Turn these off in your $product_name notification settings.</p>
</body>
</html>
"""
)

_PROJECT_TEXT = Template(
    """$headline

$title is $health.
$link
$excerpt
You are receiving this because you lead or are a member of this project. Turn these
off in your $product_name notification settings.
"""
)


def project_url(workspace_slug: str, project_id: str) -> str:
    """The SPA link to one project's updates, or to the workspace list when the slug is gone."""
    base = settings.frontend_base_url
    if not workspace_slug:
        return f"{base}/workspaces"
    return f"{base}/w/{quote(workspace_slug, safe='')}/projects/{quote(project_id, safe='')}?tab=updates"


def render_project_update_notification(
    *,
    to: str,
    actor_name: str,
    project_id: str,
    project_name: str,
    health: str,
    workspace_slug: str,
    body: str = "",
) -> EmailMessage:
    """Render the email for one project update notification.

    The subject is `[Project] Name`, so every update on one project threads
    together in a mail client the way an issue's notifications do.
    """
    actor = actor_name.strip() or "Someone"
    title = project_name.strip() or "Untitled project"
    subject = f"[Project] {title}"
    values = {
        "subject": subject,
        "headline": f"{actor} posted a project update.",
        "title": title,
        "health": _HEALTH_LABELS.get(health, "updated").lower(),
        "link": project_url(workspace_slug, project_id),
        "product_name": settings.PROJECT_NAME,
    }
    escaped = {key: html.escape(value, quote=True) for key, value in values.items()}

    trimmed = excerpt(body)
    text_excerpt = f"\n{trimmed}\n" if trimmed else ""
    html_excerpt = f"<blockquote>{html.escape(trimmed, quote=True)}</blockquote>\n" if trimmed else ""

    return EmailMessage(
        to=to,
        subject=subject,
        text=_PROJECT_TEXT.substitute(values, excerpt=text_excerpt),
        html=_PROJECT_DOCUMENT.substitute(escaped, excerpt=html_excerpt),
        tags={"purpose": "notification", "kind": "project_update"},
    )


PROJECT_UPDATE_DUE = "project_update_due"

_DUE_DOCUMENT = Template(
    """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>$subject</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; \
font-size: 15px; line-height: 1.5; color: #1a1a1a;">
<p>$headline</p>
<p><a href="$link">Write an update for $title</a></p>
<p style="color: #666; font-size: 13px;">You are receiving this because you \
lead this project. Change its update cadence in the project, or turn these off in your \
$product_name notification settings.</p>
</body>
</html>
"""
)

_DUE_TEXT = Template(
    """$headline

Write an update for $title:
$link

You are receiving this because you lead this project. Change its update cadence in
the project, or turn these off in your $product_name notification settings.
"""
)


def render_project_update_due_notification(
    *, to: str, project_id: str, project_name: str, workspace_slug: str
) -> EmailMessage:
    """Render the reminder a project lead gets when the project's update comes due.

    The subject is `[Project] Name`, so the reminder threads with the project's
    update notifications.
    """
    title = project_name.strip() or "Untitled project"
    subject = f"[Project] {title}"
    values = {
        "subject": subject,
        "headline": "A project update is due.",
        "title": title,
        "link": project_url(workspace_slug, project_id),
        "product_name": settings.PROJECT_NAME,
    }
    escaped = {key: html.escape(value, quote=True) for key, value in values.items()}
    return EmailMessage(
        to=to,
        subject=subject,
        text=_DUE_TEXT.substitute(values),
        html=_DUE_DOCUMENT.substitute(escaped),
        tags={"purpose": "notification", "kind": PROJECT_UPDATE_DUE},
    )


DIGEST_LINE_LIMIT = 50
"""How many notifications one digest lists before it points at the inbox for the rest.

A bulk edit can put hundreds of lines into one window, and an email that long is
read by nobody; the inbox holds every one of them anyway.
"""

_DIGEST_DOCUMENT = Template(
    """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>$subject</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; \
font-size: 15px; line-height: 1.5; color: #1a1a1a;">
<p>$headline</p>
$sections$more<p style="color: #666; font-size: 13px;">You are receiving this because you \
follow activity in $product_name. Turn these off in your notification settings.</p>
</body>
</html>
"""
)

_DIGEST_TEXT = Template(
    """$headline

$sections$more
You are receiving this because you follow activity in $product_name. Turn these off
in your notification settings.
"""
)


def _entry_line(entry: DigestEntry) -> str:
    """The one sentence a digest says about one notification."""
    if entry.kind == PROJECT_UPDATE_DUE:
        return "A project update is due."
    actor = entry.actor_name.strip() or "Someone"
    if entry.kind == "project_update":
        health = _HEALTH_LABELS.get(entry.health, "updated").lower()
        return f"{actor} posted a project update. The project is {health}."
    template = _HEADLINES.get(entry.headline_key or entry.kind, "$actor updated this issue.")
    return Template(template).substitute(actor=actor)


def _entry_group(entry: DigestEntry, workspace_slug: str) -> tuple[str, str, str]:
    """The group one entry is listed under: its grouping key, its label and its link."""
    if entry.kind in ("project_update", PROJECT_UPDATE_DUE):
        name = entry.project_name.strip() or "Untitled project"
        return f"project#{entry.project_id}", f"Project: {name}", project_url(workspace_slug, entry.project_id)
    title = entry.issue_title.strip() or "Untitled issue"
    label = f"{entry.issue_key} {title}" if entry.issue_key else title
    return f"issue#{entry.issue_id or entry.issue_key}", label, issue_url(workspace_slug, entry.issue_key)


def render_single(entry: DigestEntry, *, to: str, workspace_slug: str) -> EmailMessage:
    """Render a window holding one notification as that notification's own email.

    A quiet window reads exactly as it did before digests, which keeps the
    per-issue subject a mail client threads by.
    """
    if entry.kind == PROJECT_UPDATE_DUE:
        return render_project_update_due_notification(
            to=to, project_id=entry.project_id, project_name=entry.project_name, workspace_slug=workspace_slug
        )
    if entry.kind == "project_update":
        return render_project_update_notification(
            to=to,
            actor_name=entry.actor_name,
            project_id=entry.project_id,
            project_name=entry.project_name,
            health=entry.health,
            workspace_slug=workspace_slug,
            body=entry.excerpt,
        )
    return render_notification(
        kind=entry.kind,
        to=to,
        actor_name=entry.actor_name,
        issue_key=entry.issue_key,
        issue_title=entry.issue_title,
        workspace_slug=workspace_slug,
        comment_excerpt=entry.excerpt,
        headline_key=entry.headline_key,
    )


def render_digest(entries: Sequence[DigestEntry], *, to: str, workspace_slug: str) -> EmailMessage:
    """Render one window's notifications as one email, grouped by issue or project.

    One notification renders as its own email. More are grouped under the issue
    or project they are about, in the order they happened, and the subject is the
    one issue's own when they are all about the same one, so a burst on one issue
    still threads with its earlier mail.
    """
    if len(entries) == 1:
        return render_single(entries[0], to=to, workspace_slug=workspace_slug)

    ordered = sorted(entries, key=lambda entry: (entry.created_at, entry.notification_id))
    listed = ordered[:DIGEST_LINE_LIMIT]
    groups: dict[str, tuple[str, str, list[DigestEntry]]] = {}
    for entry in listed:
        key, label, link = _entry_group(entry, workspace_slug)
        groups.setdefault(key, (label, link, []))[2].append(entry)

    subjects = {_entry_group(entry, workspace_slug)[0] for entry in ordered}
    if len(subjects) == 1 and ordered[0].kind not in ("project_update", PROJECT_UPDATE_DUE):
        title = ordered[0].issue_title.strip() or "Untitled issue"
        subject = f"[{ordered[0].issue_key}] {title}" if ordered[0].issue_key else title
    else:
        subject = f"{len(ordered)} new notifications in {settings.PROJECT_NAME}"
    headline = f"You have {len(ordered)} new notifications."

    text_sections: list[str] = []
    html_sections: list[str] = []
    for label, link, members in groups.values():
        text_lines = [label, link]
        html_items: list[str] = []
        for entry in members:
            line = _entry_line(entry)
            trimmed = excerpt(entry.excerpt)
            text_lines.append(f"  - {line}")
            if trimmed:
                text_lines.append(f"    {trimmed}")
            quote_html = f"<blockquote>{html.escape(trimmed, quote=True)}</blockquote>" if trimmed else ""
            html_items.append(f"<li>{html.escape(line, quote=True)}{quote_html}</li>")
        text_sections.append("\n".join(text_lines) + "\n\n")
        html_sections.append(
            f'<p><a href="{html.escape(link, quote=True)}">{html.escape(label, quote=True)}</a></p>\n'
            f"<ul>{''.join(html_items)}</ul>\n"
        )

    hidden = len(ordered) - len(listed)
    more_text = f"And {hidden} more in your inbox.\n" if hidden else ""
    more_html = f"<p>And {hidden} more in your inbox.</p>\n" if hidden else ""
    product = settings.PROJECT_NAME
    return EmailMessage(
        to=to,
        subject=subject,
        text=_DIGEST_TEXT.substitute(
            headline=headline, sections="".join(text_sections), more=more_text, product_name=product
        ),
        html=_DIGEST_DOCUMENT.substitute(
            subject=html.escape(subject, quote=True),
            headline=html.escape(headline, quote=True),
            sections="".join(html_sections),
            more=more_html,
            product_name=html.escape(product, quote=True),
        ),
        tags={"purpose": "notification", "kind": "digest"},
    )
