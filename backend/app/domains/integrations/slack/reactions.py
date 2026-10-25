"""Emoji reaction intake: a reaction with a team's chosen emoji files the message as an issue.

A team picks one emoji and the channels it listens in. When someone reacts to a
message in one of those channels with that emoji, the message becomes an issue in
the team, in triage when the team triages, with the message text and a link back.
The new issue is paired with the message's thread through `threads.pair`, so the
bot answers in the thread with the issue link and the thread's replies sync with
the issue's comments from then on.

The issue is written as the person who reacted when they are a member who can
create issues in the team, and otherwise as the admin who turned intake on, the
same fallback email intake uses, so a reaction from someone without a Standupless
account still files the message. Every message is claimed once per team before
anything is written, so a second reaction, a second person reacting or a
redelivered event files nothing more. Nothing here calls a model: the title is the
message's first line.
"""

from __future__ import annotations

import logging
import re
from dataclasses import replace
from typing import Any, Mapping, Optional

from fastapi import HTTPException
from pydantic import ValidationError

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import IssueCreate
from app.common.change_source import SLACK
from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.slack import SlackInstallation
from app.common.db.dynamo.slack_intake import SlackReactionClaim, SlackReactionIntake, reaction_key
from app.common.issue_rules import triage_on
from app.common.issue_writes import create_issue
from app.common.recurring_issues import creator_context
from app.domains.integrations.chat import issues as chat_issues
from app.domains.integrations.slack import install, people, threads
from app.domains.integrations.slack.api import SlackError

_log = logging.getLogger(__name__)

FALLBACK_TITLE = "Message from Slack"

REQUIRED_SCOPE = "reactions:read"

_EMOJI = re.compile(r"^[a-z0-9_+\-']{1,100}$")

_SKIN_TONE = re.compile(r"::skin-tone-\d$")


def normalize_emoji(value: str) -> str:
    """An emoji name the way Slack names it in a reaction: no colons, lowercase, no skin tone."""
    name = value.strip().strip(":").strip().lower()
    return _SKIN_TONE.sub("", name)


def valid_emoji(name: str) -> bool:
    """Whether a normalized name is one Slack could send as a reaction."""
    return bool(_EMOJI.fullmatch(name))


def wanted(event: Mapping[str, Any]) -> bool:
    """Whether a `reaction_added` event is on a message at all, before any table is read."""
    item = event.get("item") or {}
    if not isinstance(item, Mapping) or item.get("type") != "message":
        return False
    return bool(item.get("channel")) and bool(item.get("ts")) and bool(event.get("reaction"))


def _matching(
    repositories: Repositories, installation: SlackInstallation, emoji: str, channel_id: str
) -> list[SlackReactionIntake]:
    """The teams that file messages reacted to with this emoji in this channel of this Slack workspace."""
    return [
        intake
        for intake in repositories.github.slack_intake.list_workspace(installation.workspace_id)
        if intake.emoji == emoji
        and channel_id in intake.channel_ids
        and intake.slack_team_id == installation.slack_team_id
    ]


def _message(installation: SlackInstallation, channel_id: str, message_ts: str) -> Optional[Mapping[str, Any]]:
    """The reacted message as Slack describes it, or `None` when Slack will not say."""
    try:
        answer = install.call(
            installation, "reactions.get", {"channel": channel_id, "timestamp": message_ts, "full": "true"}
        )
    except (SlackError, install.BotUnavailable):
        return None
    message = answer.get("message")
    return message if isinstance(message, Mapping) else None


def _permalink(installation: SlackInstallation, channel_id: str, message_ts: str) -> str:
    """The link to the message, or an empty string when Slack will not give one."""
    try:
        answer = install.call(installation, "chat.getPermalink", {"channel": channel_id, "message_ts": message_ts})
    except (SlackError, install.BotUnavailable):
        return ""
    link = str(answer.get("permalink", ""))
    return link if link.startswith("https://") else ""


def _reactor(
    repositories: Repositories, installation: SlackInstallation, slack_user_id: str, team_id: str
) -> Optional[AuthzContext]:
    """The member who reacted, when they can create issues in the team."""
    try:
        context = people.context_for(repositories, installation, slack_user_id)
    except people.NotLinked:
        return None
    if team_id not in {team for team, _, _ in chat_issues.writable_teams(repositories, context)}:
        return None
    return context


def _creator(
    repositories: Repositories, installation: SlackInstallation, intake: SlackReactionIntake, slack_user_id: str
) -> Optional[AuthzContext]:
    """Who the issue is written as: the reactor when they can, otherwise the admin who turned intake on."""
    context = _reactor(repositories, installation, slack_user_id, intake.team_id)
    if context is None:
        context = creator_context(repositories, installation.workspace_id, intake.enabled_by)
    return replace(context, source=SLACK) if context is not None else None


def _body(text: str, permalink: str) -> str:
    """The issue description: the message as Markdown, then the link back, held to the body cap."""
    tail = f"\n\nFrom Slack: {permalink}" if permalink else ""
    room = ISSUE_BODY_MAX_BYTES - len(tail.encode("utf-8")) - 16
    encoded = text.encode("utf-8")
    if len(encoded) > room:
        text = encoded[:room].decode("utf-8", errors="ignore").rstrip() + "\n\n…"
    return f"{text}{tail}".strip()


def _file(
    repositories: Repositories,
    installation: SlackInstallation,
    intake: SlackReactionIntake,
    *,
    slack_user_id: str,
    channel_id: str,
    message: Mapping[str, Any],
) -> Optional[Issue]:
    """Write one issue from one message into one team, answering it or `None` when nobody may write it."""
    context = _creator(repositories, installation, intake, slack_user_id)
    if context is None:
        _dropped("creator_gone")
        return None
    message_ts = str(message.get("ts", ""))
    raw = str(message.get("text", "") or "")
    text = threads.from_slack(raw, installation) if raw else ""
    permalink = _permalink(installation, channel_id, message_ts)
    try:
        payload = IssueCreate(
            team_id=intake.team_id,
            title=chat_issues.title_from(text) or FALLBACK_TITLE,
            body=_body(text, permalink) or None,
            triage=triage_on(repositories, installation.workspace_id, intake.team_id),
        )
    except ValidationError:
        _dropped("unreadable")
        return None
    issue = create_issue(repositories, context, payload)
    _log.info("Filed a Slack message from an emoji reaction.", extra={"event": "integrations.slack.reaction_filed"})
    threads.pair(
        repositories,
        installation,
        context,
        issue,
        channel_id=channel_id,
        thread_ts=str(message.get("thread_ts") or message_ts),
        permalink=permalink,
    )
    return issue


def _dropped(reason: str) -> None:
    """Log a reaction that matched a team but filed nothing, and why."""
    _log.info(
        "Dropped a Slack reaction that matched a team's intake.",
        extra={"event": "integrations.slack.reaction_dropped", "reason": reason},
    )


def receive(repositories: Repositories, installation: SlackInstallation, event: Mapping[str, Any]) -> int:
    """File a reacted message into every team it matches, answering how many issues were written.

    A reaction by the App itself is ignored, and so is a message already filed into
    a team. The claim is dropped again when the issue could not be written, so a
    later reaction can try once more.
    """
    if not wanted(event):
        return 0
    slack_user_id = str(event.get("user", ""))
    if not slack_user_id or slack_user_id == installation.bot_user_id:
        return 0
    item = event.get("item") or {}
    channel_id = str(item.get("channel", ""))
    message_ts = str(item.get("ts", ""))
    emoji = normalize_emoji(str(event.get("reaction", "")))
    intakes = _matching(repositories, installation, emoji, channel_id)
    if not intakes:
        return 0
    store = repositories.github.slack_intake
    workspace_id = installation.workspace_id
    message: Optional[Mapping[str, Any]] = None
    filed = 0
    for intake in intakes:
        claim = SlackReactionClaim(
            workspace_id=workspace_id,
            github_key=reaction_key(channel_id, message_ts, intake.team_id),
            team_id=intake.team_id,
            channel_id=channel_id,
            message_ts=message_ts,
        )
        if not store.claim(claim):
            continue
        try:
            if message is None:
                message = _message(installation, channel_id, message_ts)
            if message is None:
                _dropped("message_unreadable")
                store.release(workspace_id, claim.github_key)
                continue
            issue = _file(
                repositories,
                installation,
                intake,
                slack_user_id=slack_user_id,
                channel_id=channel_id,
                message={**message, "ts": str(message.get("ts") or message_ts)},
            )
        except HTTPException:
            store.release(workspace_id, claim.github_key)
            _dropped("refused")
            continue
        except Exception:
            store.release(workspace_id, claim.github_key)
            raise
        if issue is None:
            store.release(workspace_id, claim.github_key)
            continue
        store.mark_filed(claim, issue.issue_id)
        filed += 1
    return filed


def needs_reinstall(installation: Optional[SlackInstallation]) -> bool:
    """Whether an installation predates the scope reactions need, so Slack must be reconnected first."""
    if installation is None or not installation.scopes:
        return False
    return REQUIRED_SCOPE not in installation.scopes
