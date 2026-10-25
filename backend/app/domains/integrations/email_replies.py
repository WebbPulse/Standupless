"""Posting a comment by replying to an issue notification email.

A single-issue notification email carries a `reply-<token>@<intake domain>`
Reply-To, minted by the notify consumer. A reply lands in the intake bucket like
any intake mail and is routed here before intake addresses are resolved. It is
posted as a comment by the member the email went to only when the token is
genuine and unexpired, the sender is that member's own verified address, and the
member can still see the issue's team. A reply to a comment notification threads
under that comment's thread.

The comment goes through the same write path as one posted in the app, with the
change source set to email, so notifications, webhooks and GitHub thread sync all
follow from the comments stream as they always do. Quoted history and signatures
are stripped by fixed rules, attachments are dropped, and a reply with nothing
left after stripping posts nothing.

A refused reply posts nothing. A genuine token whose sender matches but which
has expired, or whose member lost access, earns at most one short notice a day
to that member's own verified address, sent from the no-reply address. A forged
token or a mismatched sender earns nothing, so a spoofed From can never be made
the target of a notice, and mail a machine sent is never answered.
"""

from __future__ import annotations

import logging
import re
from dataclasses import replace
from typing import Optional

from fastapi import HTTPException
from webbpulse.email_layout import Paragraph

from app.common.api.dependencies.repositories import Repositories
from app.common.change_source import EMAIL
from app.common.comment_writes import create_comment
from app.common.core.config import settings
from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.comments import Comment
from app.common.db.dynamo.email_replies import EmailReplyToken
from app.common.email import deliver
from app.common.email.brand import render
from app.common.email_replies import is_expired, resolve_reply_token
from app.common.recurring_issues import creator_context
from app.domains.integrations.intake_mail import IntakeMail, message_key

_log = logging.getLogger(__name__)

REPLY_SCOPE = "email-reply"
"""The idempotency scope a posted reply's Message-ID is claimed under."""

NOTICE_SCOPE = "email-reply-notice"
"""The idempotency scope that holds a member to one refusal notice a day."""

MESSAGE_TTL_SECONDS = 90 * 24 * 60 * 60
"""How long a posted reply's Message-ID is remembered, for redeliveries."""

NOTICE_TTL_SECONDS = 24 * 60 * 60
"""How long after one refusal notice before a member can be sent another."""

_MOBILE_SIGNATURE = re.compile(r"^\s*(sent from my |get outlook for )", re.IGNORECASE)


def _dropped(reason: str) -> None:
    """Log one refused reply by reason alone, never by who sent it."""
    _log.info("An email reply was not posted.", extra={"event": "email_reply.dropped", "reason": reason})


def reply_body(mail: IntakeMail) -> str:
    """The new text of a reply, with a trailing mobile signature dropped and held under the body cap.

    `mail.body` already stops above the quoted history and any `-- ` signature.
    """
    lines = mail.body.split("\n")
    while lines and (not lines[-1].strip() or _MOBILE_SIGNATURE.match(lines[-1])):
        lines.pop()
    text = "\n".join(lines).strip()
    encoded = text.encode("utf-8")
    if len(encoded) <= ISSUE_BODY_MAX_BYTES:
        return text
    return encoded[: ISSUE_BODY_MAX_BYTES - 16].decode("utf-8", errors="ignore").rstrip() + "\n\n…"


def _thread_root(repositories: Repositories, row: EmailReplyToken) -> Optional[str]:
    """The root comment a reply threads under, or `None` for a top level comment.

    A notification about a reply names the reply, and replies are one level deep,
    so the reply's own root is where the new comment goes. A comment deleted since
    leaves the reply at the top level rather than refusing it.
    """
    if not row.comment_id:
        return None
    comment = repositories.comments.get(row.workspace_id, row.issue_id, row.comment_id)
    if comment is None:
        return None
    return comment.parent_comment_id or comment.comment_id


def handle_reply(repositories: Repositories, mail: IntakeMail, token: str) -> Optional[Comment]:
    """Post one reply as a comment, answering it, or `None` when the reply is refused or empty."""
    row = resolve_reply_token(repositories.inbox.email_replies, token)
    if row is None:
        _dropped("unknown_token")
        return None
    user = repositories.users.get(row.user_id)
    if user is None or user.disabled or user.is_deleted or not user.email_verified:
        _dropped("member_gone")
        return None
    if not mail.sender_address or mail.sender_address != user.email_lower:
        _dropped("sender_mismatch")
        return None
    if is_expired(row):
        _dropped("expired")
        _notify_refused(repositories, mail, row, user.email_lower, "expired")
        return None

    context = creator_context(repositories, row.workspace_id, row.user_id)
    issue = repositories.issues.get(row.workspace_id, row.issue_id)
    if context is None or issue is None or not context.can_see_team(issue.team_id):
        _dropped("no_access")
        _notify_refused(repositories, mail, row, user.email_lower, "no_access")
        return None

    body = reply_body(mail)
    if not body:
        _dropped("empty")
        return None

    claims = repositories.idempotency
    key = message_key(mail.message_id)
    if not claims.claim(row.workspace_id, REPLY_SCOPE, key, ttl_seconds=MESSAGE_TTL_SECONDS):
        _dropped("duplicate")
        return None
    try:
        comment = create_comment(
            repositories,
            replace(context, source=EMAIL),
            row.issue_id,
            body,
            parent_comment_id=_thread_root(repositories, row),
        )
    except HTTPException as exc:
        _log.info(
            "An email reply was refused by the comment path.",
            extra={"event": "email_reply.refused", "status_code": exc.status_code},
        )
        _notify_refused(repositories, mail, row, user.email_lower, "no_access")
        return None
    except Exception:
        claims.release(row.workspace_id, REPLY_SCOPE, key)
        raise
    _log.info(
        "An email reply was posted.",
        extra={"event": "email_reply.posted", "issue_id": row.issue_id, "comment_id": comment.comment_id},
    )
    return comment


_NOTICES = {
    "expired": "The address you replied to has expired, so your reply was not added to the issue.",
    "no_access": "You no longer have access to this issue, so your reply was not added to it.",
}


def _notify_refused(repositories: Repositories, mail: IntakeMail, row: EmailReplyToken, to: str, reason: str) -> None:
    """Send the member one short notice that their reply was not posted, at most once a day, never to a machine."""
    if mail.automated:
        return
    if not repositories.idempotency.claim(
        row.workspace_id, NOTICE_SCOPE, message_key(row.user_id), ttl_seconds=NOTICE_TTL_SECONDS
    ):
        return
    message = render(
        to=to,
        subject=f"Your reply was not posted to {settings.PROJECT_NAME}",
        blocks=[
            Paragraph(_NOTICES.get(reason, _NOTICES["no_access"])),
            Paragraph(f"Open the issue in {settings.PROJECT_NAME} to comment there."),
        ],
        tags={"purpose": "notification", "kind": "email_reply_refused"},
    )
    deliver(message, event="integrations.email_reply.refused")
