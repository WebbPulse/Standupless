"""The job that carries one recipient's batch of notifications to their chat direct messages.

The notify consumer in the views image decides what a member should hear and
renders it to plain lines, but it neither imports the integrations domain nor
holds the Slack installation, so it queues this job on the dispatch queue. The
integrations dispatch consumer reads the member's chat route and the bot, escapes
the lines for the provider and sends one message. The contract lives here
because both images import it.
"""

from __future__ import annotations

from typing import Any, Callable

from pydantic import BaseModel, Field
from webbpulse.events import EventEnvelope, enqueue

from app.common.core.config import settings

CHAT_DIGEST_JOB = "chat.digest"
"""The dispatch job kind that sends one batch of notifications as a chat direct message."""

CHAT_DIGEST_LINE_LIMIT = 30
"""How many notification lines one message lists before it points at the inbox for the rest."""

CHAT_KINDS: frozenset[str] = frozenset(
    {
        "assigned",
        "mentioned",
        "commented",
        "status_changed",
        "subscribed",
        "project_update",
        "project_update_due",
        "initiative_update_due",
        "due_soon",
        "overdue",
        "sla_at_risk",
        "sla_breached",
        "reminder",
    }
)
"""The notification kinds a chat direct message carries.

The standup digest is a digest already and stays in the inbox and email, and a
GitHub review request is in app only.
"""


class ChatDigestGroup(BaseModel):
    """The notifications about one issue, project or initiative, under its link."""

    label: str
    url: str
    lines: list[str] = Field(default_factory=list)


class ChatDigest(BaseModel):
    """One window of one recipient's notifications, ready for a provider to render."""

    workspace_id: str
    recipient_id: str
    window: int
    workspace_name: str = ""
    inbox_url: str = ""
    groups: list[ChatDigestGroup] = Field(default_factory=list)
    more: int = 0

    @property
    def job_id(self) -> str:
        """The id one window's job is sent under, so a job delivered twice is sent once."""
        return f"{self.recipient_id}#{self.window}"

    @property
    def line_count(self) -> int:
        """How many notification lines the message lists."""
        return sum(len(group.lines) for group in self.groups)


def queue_chat_digest(digest: ChatDigest, *, send: Callable[..., Any] | None = None) -> bool:
    """Queue one chat digest on the dispatch queue, answering whether a job was queued.

    Nothing is queued in an environment without the dispatch queue.
    """
    if not settings.WEBHOOK_DISPATCH_QUEUE_URL:
        return False
    (send or enqueue)(
        settings.WEBHOOK_DISPATCH_QUEUE_URL,
        EventEnvelope(
            name=CHAT_DIGEST_JOB,
            payload={"kind": CHAT_DIGEST_JOB, **digest.model_dump(mode="json")},
            scope=digest.workspace_id,
        ),
    )
    return True
