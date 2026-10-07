"""What one channel notification says, rendered natively for Slack and for Discord.

Slack gets Block Kit: a section whose bold link names the issue or project, the line
saying what happened, and a context line with the actor, plus a plain `text`
fallback for notifications and old clients. Discord gets one embed with the same
parts in its title, URL, description and author.

Every value that came from a person is escaped for the provider it is going to, so a
title cannot open a link, ping a channel or break the layout: Slack's `&`, `<` and
`>` are entity encoded, which is all its mrkdwn parses, and Discord's Markdown is
backslash escaped with `allowed_mentions` emptied so nothing in an embed pings.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

HEALTH_COLORS: dict[str, int] = {"on_track": 0x2DA44E, "at_risk": 0xD29922, "off_track": 0xCF222E}

EVENT_COLORS: dict[str, int] = {
    "issue_created": 0x5E6AD2,
    "issue_status_changed": 0x8B949E,
    "issue_completed": 0x2DA44E,
    "issue_assigned": 0x5E6AD2,
    "comment_created": 0x8B949E,
    "project_update_posted": 0x5E6AD2,
    "project_update_due": 0xD29922,
    "test": 0x5E6AD2,
}

TITLE_LIMIT = 200

DETAIL_LIMIT = 500

_DISCORD_SPECIAL = re.compile(r"([\\`*_~|>#\[\]()<@:-])")


@dataclass(frozen=True, slots=True)
class ChannelMessage:
    """The provider neutral content of one notification."""

    event: str
    subject: str
    url: str
    summary: str
    actor: str = ""
    key: str = ""
    detail: str = ""
    color: int | None = None
    at: datetime | None = None
    fields: tuple[tuple[str, str], ...] = field(default_factory=tuple)


def clip(text: str, limit: int) -> str:
    """One line of at most `limit` characters, with an ellipsis where it was cut."""
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


def excerpt(text: str, limit: int = DETAIL_LIMIT) -> str:
    """A body cut to `limit` characters, keeping its line breaks."""
    stripped = text.strip()
    return stripped if len(stripped) <= limit else stripped[: limit - 1].rstrip() + "…"


def slack_escape(text: str) -> str:
    """Text Slack's mrkdwn shows literally: the three characters it parses, entity encoded."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def discord_escape(text: str) -> str:
    """Text Discord's Markdown shows literally, every formatting character backslash escaped."""
    return _DISCORD_SPECIAL.sub(r"\\\1", text)


def _heading(message: ChannelMessage) -> str:
    """The issue key and title, or the project name, on one line."""
    subject = clip(message.subject, TITLE_LIMIT)
    return f"{message.key} {subject}" if message.key else subject


def slack_body(message: ChannelMessage) -> dict[str, Any]:
    """A Slack incoming webhook body in Block Kit, with a plain text fallback."""
    heading = slack_escape(_heading(message))
    link = f"<{message.url}|{heading}>" if message.url else heading
    lines = [f"*{link}*", slack_escape(message.summary)]
    blocks: list[dict[str, Any]] = [{"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(lines)}}]
    if message.detail:
        quoted = "\n".join(f">{line}" for line in slack_escape(message.detail).splitlines() or [""])
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": quoted}})
    if message.fields:
        blocks.append(
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"*{slack_escape(name)}*\n{slack_escape(value)}"}
                    for name, value in message.fields[:10]
                ],
            }
        )
    if message.actor:
        blocks.append(
            {"type": "context", "elements": [{"type": "mrkdwn", "text": f"by {slack_escape(message.actor)}"}]}
        )
    fallback = f"{_heading(message)}: {message.summary}"
    return {"text": slack_escape(clip(fallback, 300)), "blocks": blocks, "unfurl_links": False}


def discord_body(message: ChannelMessage) -> dict[str, Any]:
    """A Discord webhook body with one embed, which can mention nobody."""
    embed: dict[str, Any] = {
        "title": clip(_heading(message), 256),
        "description": discord_escape(message.summary),
        "color": message.color if message.color is not None else EVENT_COLORS.get(message.event, 0x5E6AD2),
    }
    if message.url:
        embed["url"] = message.url
    if message.detail:
        embed["description"] += "\n\n" + "\n".join(
            f"> {line}" for line in discord_escape(message.detail).splitlines() or [""]
        )
    if message.fields:
        embed["fields"] = [
            {"name": clip(name, 256), "value": clip(discord_escape(value), 1024) or "-", "inline": True}
            for name, value in message.fields[:10]
        ]
    if message.actor:
        embed["author"] = {"name": clip(message.actor, 256)}
    if message.at is not None:
        embed["timestamp"] = message.at.isoformat()
    return {"embeds": [embed], "allowed_mentions": {"parse": []}}


def render(provider: str, message: ChannelMessage) -> str:
    """The exact JSON text posted to a destination of `provider`."""
    body = slack_body(message) if provider == "slack" else discord_body(message)
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False)
