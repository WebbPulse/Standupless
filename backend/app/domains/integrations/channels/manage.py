"""Adding, changing, removing and testing a team's channel destinations.

The REST routes and the MCP tools both call these, so the allowlist, the sealing and
the re-enable rule hold the same whichever surface a team admin uses. Each takes an
already authorized team: deciding who may manage a team's channels is the caller's.
"""

from __future__ import annotations

from webbpulse.dynamodb import ConditionFailed
from webbpulse.events.webhooks import WebhookSender

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.channels import ChannelDestination, ChannelProvider, channel_key, new_channel_id
from app.domains.integrations.channels import delivery
from app.domains.integrations.channels.urls import ChannelKeyMissing, ChannelUrlRejected, classify, sealed_fields
from app.domains.integrations.outbound.payloads import Links
from app.domains.integrations.schemas.channels import ChannelCreate, ChannelRead, ChannelTestRead, ChannelUpdate

MAX_CHANNELS_PER_TEAM = 20
"""A generous abuse ceiling: one message fans out to every destination of a team."""

AUTO_DISABLE_FIELDS = ("disabled_reason", "disabled_at")


class ChannelError(Exception):
    """A request the caller can fix, with the error code and message to answer it with."""

    def __init__(self, code: str, message: str) -> None:
        """Carry the code and the message."""
        super().__init__(message)
        self.code = code
        self.message = message


class ChannelNotFound(Exception):
    """No destination by that id on that team."""


class ChannelUnavailable(Exception):
    """This environment cannot seal or open channel URLs."""


def read(destination: ChannelDestination) -> ChannelRead:
    """The public view of one destination, which never includes the URL."""
    return ChannelRead.model_validate(destination.model_dump())


def _classified(url: str) -> tuple[str, ChannelProvider]:
    """The cleaned URL and its provider, or a `ChannelError` for one off the allowlist."""
    try:
        accepted = classify(url)
    except ChannelUrlRejected as exc:
        raise ChannelError("UNSAFE_URL", str(exc)) from exc
    return accepted.url, accepted.provider


def _sealed(workspace_id: str, channel_id: str, url: str) -> dict[str, str]:
    """The sealed URL fields, or `ChannelUnavailable` when the environment has no key."""
    try:
        return sealed_fields(workspace_id, channel_id, url)
    except ChannelKeyMissing as exc:
        raise ChannelUnavailable(str(exc)) from exc


def _slack_target(repositories: Repositories, workspace_id: str, slack_channel_id: str, name: str) -> dict[str, str]:
    """The fields of a destination that posts through the workspace's Slack App."""
    installation = repositories.github.slack.get(workspace_id)
    if installation is None:
        raise ChannelError("SLACK_NOT_INSTALLED", "Add the Slack App to this workspace first.")
    cleaned = name.strip().lstrip("#")
    return {
        "transport": "slack_app",
        "slack_channel_id": slack_channel_id,
        "slack_team_id": installation.slack_team_id,
        "url_hint": f"#{cleaned}" if cleaned else slack_channel_id,
    }


def get(repositories: Repositories, workspace_id: str, team_id: str, channel_id: str) -> ChannelDestination:
    """One destination of this team, or `ChannelNotFound`."""
    destination = repositories.github.channels.get(workspace_id, channel_id)
    if destination is None or destination.team_id != team_id:
        raise ChannelNotFound(channel_id)
    return destination


def list_for_team(repositories: Repositories, workspace_id: str, team_id: str) -> list[ChannelRead]:
    """A team's destinations, oldest first."""
    return [read(row) for row in repositories.github.channels.list(workspace_id, team_id)]


def create(
    repositories: Repositories, workspace_id: str, team_id: str, user_id: str, payload: ChannelCreate
) -> ChannelRead:
    """Add one destination to a team, posting by webhook or through the installed Slack App."""
    url = ""
    provider: ChannelProvider = "slack"
    if payload.slack_channel_id is None:
        url, provider = _classified(payload.url or "")
    if len(repositories.github.channels.list(workspace_id, team_id)) >= MAX_CHANNELS_PER_TEAM:
        raise ChannelError("LIMIT_REACHED", f"A team can post to at most {MAX_CHANNELS_PER_TEAM} channels.")
    channel_id = new_channel_id()
    now = utc_now()
    if payload.slack_channel_id is None:
        target: dict[str, str] = _sealed(workspace_id, channel_id, url)
    else:
        target = _slack_target(repositories, workspace_id, payload.slack_channel_id, payload.slack_channel_name)
    destination = ChannelDestination(
        workspace_id=workspace_id,
        github_key=channel_key(channel_id),
        channel_id=channel_id,
        team_id=team_id,
        provider=provider,
        label=payload.label,
        events=list(payload.events),
        enabled=payload.enabled,
        created_by=user_id,
        created_at=now,
        updated_at=now,
    ).model_copy(update=target)
    try:
        repositories.github.channels.create(destination)
    except ConditionFailed as exc:
        raise ChannelError("CONFLICT", "Try again.") from exc
    return read(destination)


def update(
    repositories: Repositories, workspace_id: str, team_id: str, channel_id: str, payload: ChannelUpdate
) -> ChannelRead:
    """Change one destination, re-sealing a replaced URL and clearing an auto-disable on re-enable."""
    current = get(repositories, workspace_id, team_id, channel_id)
    changes = payload.model_dump(exclude_unset=True)
    attributes: dict[str, object] = {}
    if changes.get("url") is not None:
        if current.transport == "slack_app":
            raise ChannelError("SLACK_APP_CHANNEL", "This channel posts through the Slack App and has no webhook URL.")
        url, provider = _classified(str(changes["url"]))
        attributes.update(_sealed(workspace_id, channel_id, url), provider=provider)
    if changes.get("label") is not None:
        attributes["label"] = changes["label"]
    if changes.get("events") is not None:
        attributes["events"] = list(changes["events"])
    if changes.get("enabled") is not None:
        attributes["enabled"] = bool(changes["enabled"])
    store = repositories.github.channels
    updated = store.update(workspace_id, channel_id, **attributes) if attributes else current
    if updated is not None and changes.get("enabled") is True and current.disabled_reason:
        updated = store.clear(workspace_id, channel_id, *AUTO_DISABLE_FIELDS)
    if updated is None:
        raise ChannelNotFound(channel_id)
    return read(updated)


def delete(repositories: Repositories, workspace_id: str, team_id: str, channel_id: str) -> None:
    """Remove one destination and its delivery log."""
    get(repositories, workspace_id, team_id, channel_id)
    repositories.github.channels.delete(workspace_id, channel_id)


def send_test_message(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    channel_id: str,
    user_id: str,
    *,
    sender: WebhookSender | None = None,
) -> ChannelTestRead:
    """Post a test message to one destination now and say what came back."""
    destination = get(repositories, workspace_id, team_id, channel_id)
    team = repositories.teams.get(workspace_id, team_id)
    user = repositories.users.get(user_id) if user_id else None
    message = delivery.build_test_message(
        destination,
        (user.display_name if user is not None else "") or "A team admin",
        team.name if team is not None else "this team",
        Links(repositories, workspace_id).team_settings(team_id),
    )
    response = delivery.send_test(repositories, destination, message, sender=sender)
    return ChannelTestRead(
        delivered=response.delivered, status_code=response.status_code, error=delivery.describe_error(response)
    )
