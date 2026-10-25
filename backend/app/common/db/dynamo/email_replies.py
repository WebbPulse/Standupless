"""The reply addresses issue notification emails carry, held in the `inbox` table.

Each single-issue notification email names a `reply-<token>@<intake domain>`
Reply-To address. The token is an HMAC over who the email went to and what it
was about, and this row is what the token resolves back to: the workspace, the
issue, the recipient and, for a comment notification, the comment a reply
threads under. The row is keyed by a digest of the token, never the token
itself, so a table read reveals no address that would post a comment.

The rows live under `emailreply#<digest>`, a partition no inbox read can name,
because the notify consumer that mints them and the email consumer that reads
them both already hold a grant on that table. The table's TTL drops a row once
its token has expired.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import as_item

REPLY_PREFIX = "emailreply#"

REPLY_SORT_KEY = "token"


def reply_partition(token_digest: str) -> str:
    """The partition one reply token's row lives under."""
    return f"{REPLY_PREFIX}{token_digest}"


class EmailReplyToken(BaseModel):
    """What one reply address stands for, and until when it is honoured."""

    workspace_id: str
    issue_id: str
    user_id: str
    comment_id: str = ""
    valid_until: datetime


class EmailReplyStore:
    """Reads and writes reply token rows in the `inbox` table."""

    def __init__(self, repository: Repository) -> None:
        """Share the `inbox` table's package repository."""
        self._repository = repository

    def get(self, token_digest: str) -> EmailReplyToken | None:
        """The row one token digest names, or `None`."""
        if not token_digest:
            return None
        item = self._repository.get({"ws_user": reply_partition(token_digest), "notification_id": REPLY_SORT_KEY})
        return EmailReplyToken.model_validate(dict(item)) if item is not None else None

    def put(self, token_digest: str, token: EmailReplyToken) -> EmailReplyToken:
        """Store or refresh one token's row, with the table TTL set to its expiry."""
        self._repository.put(
            as_item(
                token,
                ws_user=reply_partition(token_digest),
                notification_id=REPLY_SORT_KEY,
                expires_at=int(token.valid_until.timestamp()),
            )
        )
        return token
