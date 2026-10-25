"""Recording when a workspace member was last active, cheaply and never in a request's way.

Authorization has just read the caller's membership row on every request, so the
throttle is decided against that row in memory: a stamp still inside
`ACTIVITY_INTERVAL` costs nothing, and a stale one costs one conditional update
whose condition holds the throttle against concurrent requests. A function whose
grant on `memberships` is read only skips the write rather than attempt it, and
any failure is logged and swallowed, because a missed stamp is worth less than a
failed request.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.memberships import ACTIVITY_INTERVAL, Membership

logger = logging.getLogger(__name__)


def is_fresh(last_active_at: datetime | None, *, now: datetime | None = None) -> bool:
    """Whether a stamp is recent enough that a request need not write another."""
    if last_active_at is None:
        return False
    return (now or utc_now()) - last_active_at < ACTIVITY_INTERVAL


def record_activity(repositories: Any, membership: Membership, *, now: datetime | None = None) -> bool:
    """Stamp `membership` as active now when its stamp is stale, answering whether a write landed."""
    if is_fresh(membership.last_active_at, now=now):
        return False
    try:
        if repositories.is_read_only("memberships"):
            return False
        return bool(repositories.memberships.touch_last_active(membership.workspace_id, membership.user_id, now=now))
    except Exception:
        logger.warning("could not record member activity", exc_info=True)
        return False
