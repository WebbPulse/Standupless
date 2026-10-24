"""Where one member's personal notifications are sent as chat direct messages.

A chat route says which Slack (and later Discord) user one member of one
workspace is, so the notify consumer can hold a direct message for them and the
dispatch consumer knows whom to send it to. It is written by the integrations API
when the member links their chat account, read by the notify consumer on every
notification it writes, and marked broken by the dispatch consumer when the chat
side refuses a message.

The rows live in the `inbox` table under `chatroute#<workspace>#<user>`, a
partition no inbox read can name, because all three functions already hold a
grant on that table and the purges already delete one person's inbox rows there.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from boto3.dynamodb.conditions import Key
from pydantic import BaseModel
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import as_item, utc_now

ChatProvider = Literal["slack", "discord"]

CHAT_PROVIDERS: tuple[str, ...] = ("slack", "discord")

ROUTE_PREFIX = "chatroute#"


def route_partition(workspace_id: str, user_id: str) -> str:
    """The partition one member's chat routes in one workspace live under."""
    return f"{ROUTE_PREFIX}{workspace_id}#{user_id}"


class ChatRoute(BaseModel):
    """One member's linked chat account for one provider.

    `external_team_id` is the Slack team (or Discord guild) the link was made
    against, so a reinstall into a different team cannot deliver to a stranger.
    `broken_at` is set when the provider refused a message for a reason a retry
    cannot fix, and stops delivery until the member links again.
    """

    workspace_id: str
    user_id: str
    provider: ChatProvider
    external_user_id: str
    external_team_id: str = ""
    linked_at: datetime
    broken_at: datetime | None = None
    broken_reason: str = ""

    @property
    def active(self) -> bool:
        """Whether messages should still be sent along this route."""
        return self.broken_at is None


class ChatRouteStore:
    """Reads and writes chat routes in the `inbox` table."""

    def __init__(self, repository: Repository) -> None:
        """Share the `inbox` table's package repository."""
        self._repository = repository

    def get(self, workspace_id: str, user_id: str, provider: str) -> ChatRoute | None:
        """One member's route for one provider, or `None`."""
        if not workspace_id or not user_id:
            return None
        item = self._repository.get({"ws_user": route_partition(workspace_id, user_id), "notification_id": provider})
        return ChatRoute.model_validate(dict(item)) if item is not None else None

    def list(self, workspace_id: str, user_id: str) -> list[ChatRoute]:
        """Every route one member has in one workspace."""
        if not workspace_id or not user_id:
            return []
        page = self._repository.query(
            Key("ws_user").eq(route_partition(workspace_id, user_id)), limit=len(CHAT_PROVIDERS) + 1
        )
        return [ChatRoute.model_validate(dict(item)) for item in page.items]

    def active(self, workspace_id: str, user_id: str) -> list[ChatRoute]:
        """The routes one member's direct messages should go out on."""
        return [route for route in self.list(workspace_id, user_id) if route.active]

    def put(self, route: ChatRoute) -> ChatRoute:
        """Store a route, replacing any earlier one for the same provider and clearing a break."""
        self._repository.put(
            as_item(
                route,
                ws_user=route_partition(route.workspace_id, route.user_id),
                notification_id=route.provider,
            )
        )
        return route

    def mark_broken(self, workspace_id: str, user_id: str, provider: str, reason: str) -> bool:
        """Stop delivery on one route, answering whether there was a route to stop."""
        route = self.get(workspace_id, user_id, provider)
        if route is None:
            return False
        if route.broken_at is not None:
            return True
        self.put(route.model_copy(update={"broken_at": utc_now(), "broken_reason": reason[:120]}))
        return True

    def delete(self, workspace_id: str, user_id: str, provider: str) -> bool:
        """Remove one route, answering whether it was there."""
        if self.get(workspace_id, user_id, provider) is None:
            return False
        self._repository.delete({"ws_user": route_partition(workspace_id, user_id), "notification_id": provider})
        return True

    def delete_all(self, workspace_id: str, user_id: str) -> int:
        """Delete every route of one member in one workspace, for the purges."""
        routes = self.list(workspace_id, user_id)
        if not routes:
            return 0
        return self._repository.delete_many(
            [{"ws_user": route_partition(workspace_id, user_id), "notification_id": route.provider} for route in routes]
        )
