"""Adding, changing, removing and testing a team's channel destinations.

The REST routes and the MCP tools both call these, so the allowlist, the sealing and
the re-enable rule hold the same whichever surface a team admin uses. Each takes an
already authorized team: deciding who may manage a team's channels is the caller's.
Adding, changing and removing one are recorded in the workspace audit log here, with
the URL's masked tail and never the URL.
"""

from __future__ import annotations

from typing import Any

from webbpulse.dynamodb import ConditionFailed
from webbpulse.events.webhooks import WebhookSender

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext
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


def _discord_target(
    repositories: Repositories, workspace_id: str, discord_channel_id: str, name: str
) -> dict[str, str]:
    """The fields of a destination that posts through the workspace's Discord App."""
    installation = repositories.github.discord.get(workspace_id)
    if installation is None:
        raise ChannelError("DISCORD_NOT_INSTALLED", "Add the Discord App to this workspace first.")
    cleaned = name.strip().lstrip("#")
    return {
        "transport": "discord_app",
        "discord_channel_id": discord_channel_id,
        "discord_guild_id": installation.guild_id,
        "url_hint": f"#{cleaned}" if cleaned else discord_channel_id,
    }


def _audit_fields(destination: ChannelDestination) -> dict[str, Any]:
    """What the audit log keeps about a destination: where it posts, which events, and whether it is on."""
    return {
        "provider": destination.provider,
        "transport": destination.transport,
        "destination": destination.url_hint,
        "label": destination.label,
        "events": list(destination.events),
        "enabled": destination.enabled,
    }


def _record(
    repositories: Repositories,
    context: AuthzContext,
    event: str,
    destination: ChannelDestination,
    *,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
) -> None:
    """Record one channel change with the destination as the target and its team beside it."""
    audit.record(
        repositories,
        context,
        event,
        target_type="channel",
        target_id=destination.channel_id,
        target_label=destination.label or destination.url_hint,
        before={"team_id": destination.team_id, **before} if before is not None else None,
        after={"team_id": destination.team_id, **after} if after is not None else None,
    )


def get(repositories: Repositories, workspace_id: str, team_id: str, channel_id: str) -> ChannelDestination:
    """One destination of this team, or `ChannelNotFound`."""
    destination = repositories.github.channels.get(workspace_id, channel_id)
    if destination is None or destination.team_id != team_id:
        raise ChannelNotFound(channel_id)
    return destination


def list_for_team(repositories: Repositories, workspace_id: str, team_id: str) -> list[ChannelRead]:
    """A team's destinations, oldest first."""
    return [read(row) for row in repositories.github.channels.list(workspace_id, team_id)]


def create(repositories: Repositories, context: AuthzContext, team_id: str, payload: ChannelCreate) -> ChannelRead:
    """Add one destination to a team, posting by webhook or through the installed Slack or Discord App."""
    workspace_id = context.workspace_id
    user_id = context.user_id
    url = ""
    provider: ChannelProvider = "discord" if payload.discord_channel_id is not None else "slack"
    by_webhook = payload.slack_channel_id is None and payload.discord_channel_id is None
    if by_webhook:
        url, provider = _classified(payload.url or "")
    if len(repositories.github.channels.list(workspace_id, team_id)) >= MAX_CHANNELS_PER_TEAM:
        raise ChannelError("LIMIT_REACHED", f"A team can post to at most {MAX_CHANNELS_PER_TEAM} channels.")
    channel_id = new_channel_id()
    now = utc_now()
    if payload.slack_channel_id is not None:
        target: dict[str, str] = _slack_target(
            repositories, workspace_id, payload.slack_channel_id, payload.slack_channel_name
        )
    elif payload.discord_channel_id is not None:
        target = _discord_target(repositories, workspace_id, payload.discord_channel_id, payload.discord_channel_name)
    else:
        target = _sealed(workspace_id, channel_id, url)
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
    _record(repositories, context, "channel.created", destination, after=_audit_fields(destination))
    return read(destination)


def update(
    repositories: Repositories, context: AuthzContext, team_id: str, channel_id: str, payload: ChannelUpdate
) -> ChannelRead:
    """Change one destination, re-sealing a replaced URL and clearing an auto-disable on re-enable."""
    workspace_id = context.workspace_id
    current = get(repositories, workspace_id, team_id, channel_id)
    changes = payload.model_dump(exclude_unset=True)
    attributes: dict[str, object] = {}
    if changes.get("url") is not None:
        if current.transport == "slack_app":
            raise ChannelError("SLACK_APP_CHANNEL", "This channel posts through the Slack App and has no webhook URL.")
        if current.transport == "discord_app":
            raise ChannelError(
                "DISCORD_APP_CHANNEL", "This channel posts through the Discord App and has no webhook URL."
            )
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
    before, after = _audit_fields(current), _audit_fields(updated)
    changed = sorted(name for name in after if before[name] != after[name])
    if "url_ciphertext" in attributes:
        changed = sorted({*changed, "destination"})
    if changed:
        _record(
            repositories,
            context,
            "channel.updated",
            updated,
            before={name: before[name] for name in changed},
            after={name: after[name] for name in changed},
        )
    return read(updated)


def delete(repositories: Repositories, context: AuthzContext, team_id: str, channel_id: str) -> None:
    """Remove one destination and its delivery log."""
    destination = get(repositories, context.workspace_id, team_id, channel_id)
    repositories.github.channels.delete(context.workspace_id, channel_id)
    _record(repositories, context, "channel.deleted", destination, before=_audit_fields(destination))


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
