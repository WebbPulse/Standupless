"""The public one-click unsubscribe route a notification email's footer links point at.

`GET` renders a small confirmation page, because mail scanners and link previews
fetch every link in a message and a fetch must change nothing. Its button posts
back to the same URL. `POST` applies the change at once, which is also what an
RFC 8058 `List-Unsubscribe=One-Click` request from a mail client sends, and answers
a page with an Undo button carrying a second, shorter lived token.

The token in the query is the whole credential. It names one person and one
workspace, and the change is refused, with the same neutral page an expired or
tampered token gets, when that person's account is disabled or deleted or they
are no longer a member of the workspace, so a forwarded link stops working once
access is revoked.
"""

from __future__ import annotations

import logging
from html import escape
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import HTMLResponse

from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.core.config import settings
from app.common.db.dynamo.inbox import NOTIFICATION_KINDS
from app.common.db.dynamo.users import PULSE_DIGESTS, User, channel_default
from app.common.email.brand import BRAND_ACCENT_DARK, notification_settings_url
from app.common.email_unsubscribe import (
    ISSUE,
    KIND,
    KIND_TITLES,
    PROJECT,
    PULSE_DIGEST_KIND,
    UNDO,
    UNSUBSCRIBE_PATH,
    UnsubscribeGrant,
    UnsubscribeTokenError,
    mint_unsubscribe_token,
    read_unsubscribe_token,
    unsubscribe_url,
)

_log = logging.getLogger(__name__)

router = APIRouter(tags=["email"])

TokenQuery = Annotated[str, Query(max_length=4096, description="The signed token the email link carries.")]


class _Refused(Exception):
    """A token that verified but may no longer change anything, answered with the neutral page."""


def _page(title: str, body: str, *, code: int = status.HTTP_200_OK) -> HTMLResponse:
    """One small standalone page in the product's dark theme, never cached.

    `body` is markup the caller already escaped.
    """
    page = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<meta name="robots" content="noindex">'
        f"<title>{escape(title)} - {escape(settings.PROJECT_NAME)}</title></head>"
        '<body style="margin:0;background:#141518;color:#e7e7eb;'
        "font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif\">"
        '<main style="max-width:28rem;margin:4rem auto;padding:1.5rem;background:#1b1c20;'
        'border:1px solid #2a2b31;border-radius:8px">'
        f'<h1 style="font-size:1.125rem;margin:0 0 0.75rem">{escape(title)}</h1>{body}</main></body></html>'
    )
    return HTMLResponse(page, status_code=code, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


def _paragraph(text: str) -> str:
    """One escaped paragraph of muted text."""
    return f'<p style="color:#9b9da7;line-height:1.5;margin:0 0 1rem">{escape(text)}</p>'


def _button(label: str, token: str) -> str:
    """A form posting one token back to this route, so the change takes a deliberate press."""
    action = escape(unsubscribe_url(token), quote=True)
    return (
        f'<form method="post" action="{action}" style="margin:0 0 1rem">'
        f'<button type="submit" style="background:{BRAND_ACCENT_DARK};color:#17120f;border:0;'
        'border-radius:6px;padding:0.5rem 1rem;font:inherit;font-weight:600;cursor:pointer">'
        f"{escape(label)}</button></form>"
    )


def _settings_link(url: str) -> str:
    """The link to the person's notification settings, which asks them to sign in first."""
    return (
        f'<p style="margin:0"><a href="{escape(url, quote=True)}" style="color:{BRAND_ACCENT_DARK}">'
        "Manage notification settings</a></p>"
    )


def _neutral() -> HTMLResponse:
    """The one page every unusable token gets, naming nothing about the person or the target."""
    return _page(
        "This link has expired",
        _paragraph("This unsubscribe link is no longer valid. Sign in to change your email notifications.")
        + _settings_link(f"{settings.frontend_base_url}/workspaces"),
        code=status.HTTP_400_BAD_REQUEST,
    )


def _target_phrase(grant: UnsubscribeGrant) -> str:
    """What the change is about, in the words the pages use."""
    if grant.action == ISSUE:
        return f"issue {grant.label}" if grant.label else "this issue"
    if grant.action == PROJECT:
        return "this project"
    return f"{KIND_TITLES.get(grant.target, 'these notifications')} emails"


def _verified(repositories: Repositories, token: str) -> tuple[UnsubscribeGrant, User, str]:
    """The grant, the person and the workspace's settings URL, or `_Refused` when any of them is gone."""
    try:
        grant = read_unsubscribe_token(token)
    except UnsubscribeTokenError as exc:
        raise _Refused from exc
    if grant.action == KIND and grant.target not in NOTIFICATION_KINDS and grant.target != PULSE_DIGEST_KIND:
        raise _Refused
    user = repositories.users.get(grant.user_id)
    if user is None or user.disabled or user.is_deleted:
        raise _Refused
    membership = repositories.memberships.get(grant.workspace_id, grant.user_id)
    if membership is None or membership.is_suspended:
        raise _Refused
    workspace = repositories.workspaces.get(grant.workspace_id)
    if workspace is None:
        raise _Refused
    return grant, user, notification_settings_url(workspace.slug)


def _stop(repositories: Repositories, grant: UnsubscribeGrant, user: User) -> dict[str, Any] | None:
    """Apply one stop, answering what an undo would put back, or `None` when nothing changed."""
    if grant.action == ISSUE:
        existing = repositories.subscriptions.get(grant.workspace_id, grant.target, grant.user_id)
        if existing is None:
            return None
        repositories.subscriptions.unsubscribe(grant.workspace_id, grant.target, grant.user_id)
        return {"team": existing.team_id, "reason": existing.reason}
    if grant.action == PROJECT:
        previous = repositories.planning.get_pulse_follow(grant.workspace_id, grant.user_id, "project", grant.target)
        if previous is False:
            return None
        repositories.planning.set_pulse_follow(
            grant.workspace_id, grant.user_id, "project", grant.target, following=False
        )
        return {"following": True}
    if grant.target == PULSE_DIGEST_KIND:
        if user.pulse_digest == "off":
            return None
        repositories.users.update(user.id, pulse_digest="off")
        return {"cadence": user.pulse_digest}
    if not _email_switch(user, grant.target):
        return None
    repositories.users.update(user.id, notification_preferences=_with_email(user, grant.target, False))
    return {"email": True}


def _email_switch(user: User, kind: str) -> bool:
    """The stored email switch for one kind, which the account wide switch does not override."""
    return bool(user.notification_preferences.get(kind, {}).get("email", channel_default(kind, "email")))


def _with_email(user: User, kind: str, value: bool) -> dict[str, dict[str, bool]]:
    """The person's switches with one kind's email set, kept sparse like the settings route keeps them."""
    merged = {name: dict(channels) for name, channels in user.notification_preferences.items()}
    channels = merged.setdefault(kind, {})
    if value == channel_default(kind, "email"):
        channels.pop("email", None)
    else:
        channels["email"] = value
    return {name: switches for name, switches in merged.items() if switches}


def _undo(repositories: Repositories, grant: UnsubscribeGrant, user: User) -> None:
    """Put back what one stop changed, from what its undo token carries."""
    restore = grant.restore or {}
    if grant.action == ISSUE:
        team_id = str(restore.get("team", ""))
        if team_id:
            repositories.subscriptions.subscribe(
                grant.workspace_id, grant.target, team_id, grant.user_id, str(restore.get("reason", "manual"))
            )
        return
    if grant.action == PROJECT:
        repositories.planning.set_pulse_follow(
            grant.workspace_id, grant.user_id, "project", grant.target, following=bool(restore.get("following", True))
        )
        return
    if grant.target == PULSE_DIGEST_KIND:
        cadence = str(restore.get("cadence", ""))
        if cadence in PULSE_DIGESTS and cadence != "off":
            repositories.users.update(user.id, pulse_digest=cadence)
        return
    repositories.users.update(
        user.id, notification_preferences=_with_email(user, grant.target, bool(restore.get("email", True)))
    )


@router.get(
    UNSUBSCRIBE_PATH,
    response_class=HTMLResponse,
    summary="Confirm an email unsubscribe",
    responses={400: {"description": "The link is expired, tampered with or no longer valid."}},
)
def confirm_unsubscribe(
    repositories: Annotated[Repositories, Depends(get_repositories)],
    token: TokenQuery = "",
) -> HTMLResponse:
    """The confirmation page for one footer link, which changes nothing until its button is pressed."""
    try:
        grant, _, settings_url = _verified(repositories, token)
    except _Refused:
        return _neutral()
    phrase = _target_phrase(grant)
    if grant.op == UNDO:
        return _page(
            "Undo unsubscribe",
            _paragraph(f"Turn email back on for {phrase}?") + _button("Undo", token) + _settings_link(settings_url),
        )
    title = f"Unsubscribe from {phrase}" if grant.action != KIND else f"Stop {phrase}"
    detail = (
        "You will stop getting email about it. Notifications still reach your inbox."
        if grant.action != KIND
        else "You will stop getting these emails in this account. Notifications still reach your inbox."
    )
    return _page(title, _paragraph(detail) + _button("Unsubscribe", token) + _settings_link(settings_url))


@router.post(
    UNSUBSCRIBE_PATH,
    response_class=HTMLResponse,
    summary="Apply an email unsubscribe",
    responses={400: {"description": "The link is expired, tampered with or no longer valid."}},
)
def apply_unsubscribe(
    repositories: Annotated[Repositories, Depends(get_repositories)],
    token: TokenQuery = "",
) -> HTMLResponse:
    """Apply one footer link at once, as an RFC 8058 one-click request or the confirmation button does.

    The request body is ignored, so a mail client's `List-Unsubscribe=One-Click`
    form and the page's own empty form behave the same. Applying a stop twice is
    not an error, and the second answer simply offers no Undo.
    """
    try:
        grant, user, settings_url = _verified(repositories, token)
    except _Refused:
        return _neutral()
    phrase = _target_phrase(grant)
    if grant.op == UNDO:
        _undo(repositories, grant, user)
        _log.info("email unsubscribe undone", extra={"action": grant.action, "workspace_id": grant.workspace_id})
        return _page(
            "Email turned back on",
            _paragraph(f"You will get email for {phrase} again.") + _settings_link(settings_url),
        )
    restore = _stop(repositories, grant, user)
    _log.info(
        "email unsubscribe applied",
        extra={"action": grant.action, "workspace_id": grant.workspace_id, "changed": restore is not None},
    )
    body = _paragraph(f"You will no longer get email for {phrase}.")
    if restore is not None:
        undo = mint_unsubscribe_token(
            user_id=grant.user_id,
            workspace_id=grant.workspace_id,
            action=grant.action,
            target=grant.target,
            op=UNDO,
            label=grant.label,
            restore=restore,
        )
        body += _button("Undo", undo)
    return _page("You are unsubscribed", body + _settings_link(settings_url))
