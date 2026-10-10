"""Turning off the channel destinations that post through an App that is gone.

Once a workspace loses its Slack or Discord install, every destination that posts
as that bot can no longer post, so each is disabled with a reason the settings page
shows, exactly as a webhook that answered 410 would be.
"""

from __future__ import annotations

from app.common.api.dependencies.repositories import Repositories


def turn_off(repositories: Repositories, workspace_id: str, transport: str, reason: str, *, notify: bool) -> int:
    """Disable every enabled destination of one transport, answering how many were turned off."""
    from app.domains.integrations.channels.delivery import notify_disabled

    store = repositories.github.channels
    turned_off = 0
    for destination in store.list(workspace_id):
        if destination.transport != transport or not destination.enabled:
            continue
        if store.disable(workspace_id, destination.channel_id, reason=reason, status=410):
            turned_off += 1
            if notify:
                notify_disabled(repositories, destination)
    return turned_off
