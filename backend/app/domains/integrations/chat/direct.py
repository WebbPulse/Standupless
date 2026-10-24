"""The dispatch job that sends one member's batch of notifications to their chat direct messages.

The views image queues a rendered batch; this module reads it back and hands it to
each provider the member linked. Slack is the only provider so far, and a job that
will not parse is dropped with a warning rather than retried, because a retry can
never make it parse.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from pydantic import ValidationError

from app.common.api.dependencies.repositories import Repositories
from app.common.chat_digests import ChatDigest

_log = logging.getLogger(__name__)


def send_digest(repositories: Repositories, job: Mapping[str, Any]) -> int:
    """Send one queued batch on every route the member has, answering how many posts landed."""
    from app.domains.integrations.slack import direct as slack_direct

    try:
        digest = ChatDigest.model_validate({key: value for key, value in job.items() if key != "kind"})
    except ValidationError:
        _log.warning("Dropped a chat digest job that would not parse.", extra={"event": "integrations.chat.malformed"})
        return 0
    if not digest.groups:
        return 0
    return int(slack_direct.send(repositories, digest))
