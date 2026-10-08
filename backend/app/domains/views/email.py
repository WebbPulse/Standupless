"""Rendering the notification emails an inbox row also goes out as.

One message per notification kind, built from the same row the inbox renders, so
an email and the badge behind it can never describe different things. Both parts
come from the same blocks through the shared branded shell, which escapes every
value, so a new kind cannot be added with an unescaped title in it.

The link is built from `settings.frontend_base_url` rather than a request host,
because a stream consumer serves no request and the SPA lives on its own domain.
"""

from __future__ import annotations

import re
from string import Template
from typing import Mapping, Sequence
from urllib.parse import quote

from webbpulse.email_layout import (
    BulletList,
    Button,
    EmailBlock,
    EmailLink,
    Heading,
    ListItem,
    Paragraph,
    Quote,
)
from webbpulse.identity.email import EmailMessage

from app.common.core.config import settings
from app.common.db.dynamo.notify_digests import DigestEntry
from app.common.email.brand import notification_settings_url, render

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
    "due_soon": "This issue assigned to you is due soon.",
    "overdue": "This issue assigned to you is overdue.",
}

DUE_KINDS: frozenset[str] = frozenset({"due_soon", "overdue"})
"""The due date reminders, which have no actor and reach the assignee alone."""

_ISSUE_REASON = (
    "You are receiving this because you follow activity on this issue. "
    "Turn these off in your {product} notification settings."
)
_ASSIGNEE_REASON = (
    "You are receiving this because this issue is assigned to you. "
    "Turn these off in your {product} notification settings."
)
_PROJECT_REASON = (
    "You are receiving this because you lead or are a member of this project. "
    "Turn these off in your {product} notification settings."
)
_DIGEST_REASON = (
    "You are receiving this because you follow activity in {product}. Turn these off in your notification settings."
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


def _settings_link(workspace_slug: str) -> tuple[EmailLink, ...]:
    """The footer link to the reader's notification settings."""
    return (EmailLink("Notification settings", notification_settings_url(workspace_slug)),)


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
    accent: str | None = None,
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
    label = f"{issue_key} {title}" if issue_key else title
    subject = f"[{issue_key}] {title}" if issue_key else title
    link = issue_url(workspace_slug, issue_key)
    headline = Template(_HEADLINES.get(headline_key or kind, "$actor updated this issue.")).substitute(actor=actor)
    trimmed = excerpt(comment_excerpt)

    blocks: list[EmailBlock] = [Heading(label), Paragraph(headline)]
    if trimmed:
        blocks.append(Quote(trimmed))
    blocks.append(Button("Open issue", link, show_url=True))
    return render(
        to=to,
        subject=subject,
        preheader=headline,
        blocks=blocks,
        footer_note=(_ASSIGNEE_REASON if kind in DUE_KINDS else _ISSUE_REASON).format(product=settings.PROJECT_NAME),
        footer_links=_settings_link(workspace_slug),
        tags={"purpose": "notification", "kind": kind},
        accent=accent,
    )


_HEALTH_LABELS: Mapping[str, str] = {"on_track": "On track", "at_risk": "At risk", "off_track": "Off track"}


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
    accent: str | None = None,
) -> EmailMessage:
    """Render the email for one project update notification.

    The subject is `[Project] Name`, so every update on one project threads
    together in a mail client the way an issue's notifications do.
    """
    actor = actor_name.strip() or "Someone"
    title = project_name.strip() or "Untitled project"
    health_label = _HEALTH_LABELS.get(health, "updated").lower()
    trimmed = excerpt(body)

    blocks: list[EmailBlock] = [
        Heading(title),
        Paragraph(f"{actor} posted a project update."),
        Paragraph(f"{title} is {health_label}."),
    ]
    if trimmed:
        blocks.append(Quote(trimmed))
    blocks.append(Button("Open project updates", project_url(workspace_slug, project_id), show_url=True))
    return render(
        to=to,
        subject=f"[Project] {title}",
        preheader=f"{actor} posted a project update. {title} is {health_label}.",
        blocks=blocks,
        footer_note=_PROJECT_REASON.format(product=settings.PROJECT_NAME),
        footer_links=_settings_link(workspace_slug),
        tags={"purpose": "notification", "kind": "project_update"},
        accent=accent,
    )


PROJECT_UPDATE_DUE = "project_update_due"

_DUE_REASON = (
    "You are receiving this because you lead this project. Change its update cadence in the project, "
    "or turn these off in your {product} notification settings."
)


def render_project_update_due_notification(
    *, to: str, project_id: str, project_name: str, workspace_slug: str, accent: str | None = None
) -> EmailMessage:
    """Render the reminder a project lead gets when the project's update comes due.

    The subject is `[Project] Name`, so the reminder threads with the project's
    update notifications.
    """
    title = project_name.strip() or "Untitled project"
    return render(
        to=to,
        subject=f"[Project] {title}",
        preheader=f"A project update is due for {title}.",
        blocks=[
            Heading(title),
            Paragraph("A project update is due."),
            Button(f"Write an update for {title}", project_url(workspace_slug, project_id), show_url=True),
        ],
        footer_note=_DUE_REASON.format(product=settings.PROJECT_NAME),
        footer_links=_settings_link(workspace_slug),
        tags={"purpose": "notification", "kind": PROJECT_UPDATE_DUE},
        accent=accent,
    )


DIGEST_LINE_LIMIT = 50
"""How many notifications one digest lists before it points at the inbox for the rest.

A bulk edit can put hundreds of lines into one window, and an email that long is
read by nobody; the inbox holds every one of them anyway.
"""


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


def render_single(entry: DigestEntry, *, to: str, workspace_slug: str, accent: str | None = None) -> EmailMessage:
    """Render a window holding one notification as that notification's own email.

    A quiet window reads exactly as it did before digests, which keeps the
    per-issue subject a mail client threads by.
    """
    if entry.kind == PROJECT_UPDATE_DUE:
        return render_project_update_due_notification(
            to=to,
            project_id=entry.project_id,
            project_name=entry.project_name,
            workspace_slug=workspace_slug,
            accent=accent,
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
            accent=accent,
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
        accent=accent,
    )


def render_digest(
    entries: Sequence[DigestEntry], *, to: str, workspace_slug: str, accent: str | None = None
) -> EmailMessage:
    """Render one window's notifications as one email, grouped by issue or project.

    One notification renders as its own email. More are grouped under the issue
    or project they are about, in the order they happened, and the subject is the
    one issue's own when they are all about the same one, so a burst on one issue
    still threads with its earlier mail.
    """
    if len(entries) == 1:
        return render_single(entries[0], to=to, workspace_slug=workspace_slug, accent=accent)

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

    blocks: list[EmailBlock] = [Heading(headline)]
    for label, link, members in groups.values():
        blocks.append(Paragraph(EmailLink(label, link)))
        blocks.append(BulletList(tuple(ListItem(_entry_line(entry), excerpt(entry.excerpt)) for entry in members)))

    hidden = len(ordered) - len(listed)
    if hidden:
        blocks.append(Paragraph(f"And {hidden} more in your inbox."))
    blocks.append(Button("Open your inbox", _inbox_url(workspace_slug)))
    return render(
        to=to,
        subject=subject,
        preheader=headline,
        blocks=blocks,
        footer_note=_DIGEST_REASON.format(product=settings.PROJECT_NAME),
        footer_links=_settings_link(workspace_slug),
        tags={"purpose": "notification", "kind": "digest"},
        accent=accent,
    )


def _inbox_url(workspace_slug: str) -> str:
    """The SPA inbox of one workspace, or the workspace list when the slug is gone."""
    base = settings.frontend_base_url
    if not workspace_slug:
        return f"{base}/workspaces"
    return f"{base}/w/{quote(workspace_slug, safe='')}/inbox"
