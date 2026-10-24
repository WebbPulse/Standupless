"""The dispatch job that sends one member's batch of notifications to their chat direct messages.

The views image queues a rendered batch; this module reads it back and hands it to
each provider the member linked, Slack and Discord. A job that will not parse is
dropped with a warning rather than retried, because a retry can never make it
parse.

Each provider claims the window on its own, so when one raises for a retry the
others still send now, and the redelivered job posts only where it did not land.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Mapping

from pydantic import ValidationError

from app.common.api.dependencies.repositories import Repositories
from app.common.chat_digests import ChatDigest

_log = logging.getLogger(__name__)


def _senders() -> tuple[Callable[[Repositories, ChatDigest], bool], ...]:
    """The send function of every chat provider, in the order they are tried."""
    from app.domains.integrations.discord import direct as discord_direct
    from app.domains.integrations.slack import direct as slack_direct

    return (slack_direct.send, discord_direct.send)


def send_digest(repositories: Repositories, job: Mapping[str, Any]) -> int:
    """Send one queued batch on every route the member has, answering how many posts landed.

    A provider that raises for a retry does not stop the others, and the first such
    error is raised once they have all been tried, so the queue redelivers the job.
    """
    try:
        digest = ChatDigest.model_validate({key: value for key, value in job.items() if key != "kind"})
    except ValidationError:
        _log.warning("Dropped a chat digest job that would not parse.", extra={"event": "integrations.chat.malformed"})
        return 0
    if not digest.groups:
        return 0
    posted = 0
    failure: Exception | None = None
    for send in _senders():
        try:
            posted += int(send(repositories, digest))
        except Exception as error:
            failure = failure or error
    if failure is not None:
        raise failure
    return posted
