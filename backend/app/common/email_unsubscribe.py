"""Signed unsubscribe tokens, the credential a notification email's footer links carry.

A person reading a notification email is often signed out, and the API sits on
its own origin, so the footer's one-click links cannot lean on a session. A signed
token in the query is the credential instead: it names the one person it was mailed
to, the one workspace, and exactly one thing to stop, either one issue, one project
or one notification kind. It never carries an email address.

The views domain mints the tokens when it renders an email and the identity domain
redeems them, so the module lives in `app.common`, which both may import. It is
signed with `SECRET_KEY` from the existing app secret under its own audience, so no
other token the product signs replays as one of these.

Undoing a change is a second token, minted when the first is applied, carrying what
to put back: the subscription's team and reason, or the switch's earlier value.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Collection, Sequence
from urllib.parse import quote

from webbpulse.email_layout import EmailLink
from webbpulse.security import ExpiredToken, InvalidToken, create_token, decode_token

from app.common.core.config import settings

UNSUBSCRIBE_AUDIENCE = "standupless.email-unsubscribe"
"""What an unsubscribe token may be presented for, pinned so no other token replays as one."""

UNSUBSCRIBE_PATH = "/api/email/unsubscribe"
"""The public route that redeems a token, on the API origin."""

UNSUBSCRIBE_TOKEN_TTL = timedelta(days=60)
"""How long a footer link works.

Long enough for an email found again weeks later, short enough that an old
forwarded message stops being able to change anyone's settings.
"""

UNDO_TOKEN_TTL = timedelta(days=7)
"""How long the Undo button on the confirmation page works."""

ISSUE = "issue"
"""Stop following one issue."""

PROJECT = "project"
"""Stop project update emails for one project."""

KIND = "kind"
"""Turn email off for one notification kind."""

ACTIONS = (ISSUE, PROJECT, KIND)

STOP = "stop"
"""A token that applies its action."""

UNDO = "undo"
"""A token that reverses an applied action."""

PULSE_DIGEST_KIND = "pulse_digest"
"""The Pulse digest, which is a cadence on the person rather than a notification kind switch."""

KIND_TITLES: dict[str, str] = {
    "assigned": "Assigned to you",
    "mentioned": "Mentions",
    "commented": "Comments",
    "status_changed": "Status changes",
    "subscribed": "Subscribed by someone",
    "project_update": "Project updates",
    "project_update_comment": "Replies on project updates",
    "project_update_due": "Project update reminders",
    "initiative_update_due": "Initiative update reminders",
    "project_lead_assigned": "Made a project lead",
    "project_member_added": "Added to a project",
    "initiative_owner_assigned": "Made an initiative owner",
    "due_soon": "Due date approaching",
    "overdue": "Overdue issues",
    "reminder": "Issue reminders",
    "standup_digest": "Standup digests",
    "sla_at_risk": "SLA at risk",
    "sla_breached": "SLA breached",
    "review_requested": "Review requests",
    "triage_new": "New in triage",
    "view_issue_added": "Issues added to views you follow",
    "view_project_added": "Projects added to views you follow",
    "reaction": "Reactions",
    "issue_completed": "Issue completed",
    "issue_cancelled": "Issue canceled",
    "priority_urgent": "Urgent priority",
    "blocking_changed": "Blocking changes",
    "team_issue_created": "New team issues",
    "document_comment": "Document comments",
    PULSE_DIGEST_KIND: "Pulse digests",
}
"""The names the notification settings page gives each kind, for the confirmation page."""


class UnsubscribeTokenError(Exception):
    """A token that did not verify, for any reason, answered with the same neutral page."""


@dataclass(frozen=True)
class UnsubscribeGrant:
    """What one verified token asks for.

    `restore` carries what an undo token puts back, and is empty on a stop token.
    `label` is a short name for the target, such as an issue key, shown on the
    confirmation page without reading the issue.
    """

    user_id: str
    workspace_id: str
    action: str
    target: str
    op: str = STOP
    label: str = ""
    restore: dict[str, Any] | None = None


def mint_unsubscribe_token(
    *,
    user_id: str,
    workspace_id: str,
    action: str,
    target: str,
    op: str = STOP,
    label: str = "",
    restore: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> str:
    """Sign one token naming one person, one workspace and one thing to stop or put back."""
    if action not in ACTIONS:
        raise ValueError(f"Unknown unsubscribe action {action!r}")
    claims: dict[str, Any] = {"sub": user_id, "ws": workspace_id, "act": action, "tgt": target, "op": op}
    if label:
        claims["lbl"] = label[:64]
    if restore:
        claims["rst"] = dict(restore)
    return create_token(
        claims,
        settings.SECRET_KEY,
        expires_in=UNDO_TOKEN_TTL if op == UNDO else UNSUBSCRIBE_TOKEN_TTL,
        audience=UNSUBSCRIBE_AUDIENCE,
        now=now,
    )


def read_unsubscribe_token(token: str) -> UnsubscribeGrant:
    """The grant a token carries, refusing an expired, tampered or malformed one."""
    if not token:
        raise UnsubscribeTokenError("No unsubscribe token")
    try:
        claims = decode_token(
            token,
            settings.SECRET_KEY,
            audience=UNSUBSCRIBE_AUDIENCE,
            require=["exp", "sub", "ws", "act", "tgt", "op"],
        )
    except (ExpiredToken, InvalidToken) as exc:
        raise UnsubscribeTokenError("The unsubscribe token is not valid") from exc

    action = str(claims.get("act", ""))
    op = str(claims.get("op", ""))
    user_id = str(claims.get("sub", ""))
    workspace_id = str(claims.get("ws", ""))
    target = str(claims.get("tgt", ""))
    if action not in ACTIONS or op not in (STOP, UNDO) or not user_id or not workspace_id or not target:
        raise UnsubscribeTokenError("The unsubscribe token names nothing to change")
    restore = claims.get("rst")
    return UnsubscribeGrant(
        user_id=user_id,
        workspace_id=workspace_id,
        action=action,
        target=target,
        op=op,
        label=str(claims.get("lbl", "")),
        restore=dict(restore) if isinstance(restore, dict) else None,
    )


def unsubscribe_url(token: str) -> str:
    """The absolute link that redeems one token."""
    return f"{settings.api_base_url}{UNSUBSCRIBE_PATH}?token={quote(token, safe='')}"


ISSUE_UNSUBSCRIBE_KINDS = frozenset(
    {
        "assigned",
        "mentioned",
        "commented",
        "status_changed",
        "subscribed",
        "issue_completed",
        "issue_cancelled",
        "priority_urgent",
        "blocking_changed",
    }
)
"""The issue kinds that follow from a subscription, so unsubscribing stops what comes next.

A reminder, a due date, an SLA, triage duty or a followed view reaches a person for
a reason a subscription does not hold, so their emails offer only the kind link.
"""

PROJECT_UNSUBSCRIBE_KINDS = frozenset({"project_update"})
"""The project kinds a project unfollow stops emailing."""


def unsubscribe_links(
    *,
    user_id: str,
    workspace_id: str,
    kinds: Collection[str],
    issue_id: str = "",
    issue_key: str = "",
    project_id: str = "",
) -> tuple[EmailLink, ...]:
    """The footer links for one email: the target link when one applies, then the kind link.

    `kinds` are the kinds of every notification the email carries. The issue or
    project link is offered only when every one of them follows from that target,
    and the kind link only when they are all one kind, so a link never stops more
    than the email it sits in. Empty when the email names no person or workspace.
    """
    if not user_id or not workspace_id or not kinds:
        return ()
    distinct = set(kinds)
    links: list[EmailLink] = []
    if issue_id and distinct <= ISSUE_UNSUBSCRIBE_KINDS:
        token = mint_unsubscribe_token(
            user_id=user_id, workspace_id=workspace_id, action=ISSUE, target=issue_id, label=issue_key
        )
        links.append(EmailLink("Unsubscribe from this issue", unsubscribe_url(token)))
    elif project_id and distinct <= PROJECT_UNSUBSCRIBE_KINDS:
        token = mint_unsubscribe_token(user_id=user_id, workspace_id=workspace_id, action=PROJECT, target=project_id)
        links.append(EmailLink("Unsubscribe from this project", unsubscribe_url(token)))
    if len(distinct) == 1:
        (kind,) = distinct
        if kind in KIND_TITLES:
            token = mint_unsubscribe_token(user_id=user_id, workspace_id=workspace_id, action=KIND, target=kind)
            links.append(EmailLink("Stop emails like this", unsubscribe_url(token)))
    return tuple(links)


ONE_CLICK_POST = "List-Unsubscribe=One-Click"
"""The RFC 8058 `List-Unsubscribe-Post` value that marks the link as one-click."""


def list_unsubscribe_headers(links: Sequence[EmailLink]) -> dict[str, str]:
    """The RFC 2369 and RFC 8058 headers for an email whose footer carries `links`.

    The first link is the most specific one `unsubscribe_links` offers, the issue or
    project link ahead of the kind link, so a mail client's unsubscribe control stops
    the same thing the footer's first link does. Only an https link qualifies, since
    RFC 8058 requires one, so an email with no such link carries no headers.
    """
    if not links or not links[0].url.startswith("https://"):
        return {}
    return {"List-Unsubscribe": f"<{links[0].url}>", "List-Unsubscribe-Post": ONE_CLICK_POST}
