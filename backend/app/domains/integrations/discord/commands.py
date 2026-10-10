"""The `/standupless` command, the "Create issue" message command and the form it opens.

Every action runs as the Standupless member a Discord person is linked to, resolved
by `people.context_for`, so the teams offered and the issue written are exactly
what that person could do in the web app. A person not linked yet is answered with
their own consent link. Replies are ephemeral and mention nobody.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from fastapi import HTTPException
from pydantic import ValidationError

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import TITLE_MAX, IssueCreate
from app.common.db.dynamo.discord import DiscordInstallation
from app.common.issue_keys import display_key
from app.common.issue_writes import create_issue
from app.domains.integrations.channels.messages import clip, discord_escape
from app.domains.integrations.chat import issues as chat_issues
from app.domains.integrations.discord import people
from app.domains.integrations.outbound.payloads import Links

_log = logging.getLogger(__name__)

PING = 1
APPLICATION_COMMAND = 2
MESSAGE_COMPONENT = 3
AUTOCOMPLETE = 4
MODAL_SUBMIT = 5

PONG = 1
CHANNEL_MESSAGE = 4
AUTOCOMPLETE_RESULT = 8
MODAL = 9

EPHEMERAL = 1 << 6

CHAT_INPUT = 1
MESSAGE_COMMAND = 3

SUB_COMMAND = 1
STRING_OPTION = 3

GUILD_CONTEXT = 0
GUILD_INSTALL = 0

COMMAND_NAME = "standupless"

MESSAGE_COMMAND_NAME = "Create issue"

CREATE_PREFIX = "create"

TEAM_INPUT = "team"

TITLE_INPUT = "title"

DESCRIPTION_INPUT = "description"

DESCRIPTION_MAX = 4000

MAX_CHOICES = 25

KEY_MAX = 24

NOT_LINKED = (
    "Your Discord account is not linked to a member of this Standupless workspace yet. "
    "Link it with the same confirmed email address you use in Standupless: {url}"
)

UNKNOWN_PERSON = "Discord did not say who you are, so Standupless cannot act for you."

NO_TEAMS = "You are not a member of any team you can create issues in."

COMMANDS: tuple[dict[str, Any], ...] = (
    {
        "name": COMMAND_NAME,
        "type": CHAT_INPUT,
        "description": "Show and create Standupless issues",
        "contexts": [GUILD_CONTEXT],
        "integration_types": [GUILD_INSTALL],
        "options": [
            {"type": SUB_COMMAND, "name": "help", "description": "What the Standupless commands can do"},
            {
                "type": SUB_COMMAND,
                "name": "show",
                "description": "Show an issue by its key",
                "options": [
                    {
                        "type": STRING_OPTION,
                        "name": "key",
                        "description": "The issue key, such as ABC-12",
                        "required": True,
                        "max_length": KEY_MAX,
                    },
                ],
            },
            {
                "type": SUB_COMMAND,
                "name": "create",
                "description": "Create an issue",
                "options": [
                    {
                        "type": STRING_OPTION,
                        "name": "title",
                        "description": "The issue title",
                        "required": True,
                        "max_length": TITLE_MAX,
                    },
                    {
                        "type": STRING_OPTION,
                        "name": "team",
                        "description": "The team to create it in",
                        "required": False,
                        "autocomplete": True,
                    },
                    {
                        "type": STRING_OPTION,
                        "name": "description",
                        "description": "More detail",
                        "required": False,
                        "max_length": DESCRIPTION_MAX,
                    },
                ],
            },
        ],
    },
    {
        "name": MESSAGE_COMMAND_NAME,
        "type": MESSAGE_COMMAND,
        "contexts": [GUILD_CONTEXT],
        "integration_types": [GUILD_INSTALL],
    },
)
"""The commands registered for the App, the same in every environment and mirrored in `discord/commands.json`."""

HELP_TEXT = (
    "`/standupless show ABC-12` shows an issue.\n"
    "`/standupless create` creates an issue in one of your teams.\n"
    "**Create issue** in a message's Apps menu files that message as an issue."
)


def ephemeral(content: str, embeds: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """A reply only the person who asked sees, which can mention nobody."""
    data: dict[str, Any] = {"content": content, "flags": EPHEMERAL, "allowed_mentions": {"parse": []}}
    if embeds:
        data["embeds"] = embeds
    return {"type": CHANNEL_MESSAGE, "data": data}


def _user_id(payload: Mapping[str, Any]) -> str:
    """The Discord id of the person who acted, from the server member or the user."""
    member = payload.get("member") or {}
    user = member.get("user") if isinstance(member, Mapping) else None
    if not isinstance(user, Mapping):
        user = payload.get("user") or {}
    return str(user.get("id", "")) if isinstance(user, Mapping) else ""


def _context(
    repositories: Repositories,
    installation: DiscordInstallation,
    discord_user_id: str,
) -> AuthzContext | None:
    """The member behind a Discord person, or `None` when there is none."""
    try:
        return people.context_for(repositories, installation, discord_user_id)
    except people.NotLinked:
        return None


def _not_linked(installation: DiscordInstallation, discord_user_id: str) -> dict[str, Any]:
    """The reply to a person who is not linked, carrying their own consent link."""
    if not discord_user_id:
        return ephemeral(UNKNOWN_PERSON)
    return ephemeral(NOT_LINKED.format(url=people.link_url(installation, discord_user_id)))


def _options(data: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """The subcommand used and its option values, with the focused option marked under `_focused`."""
    for option in data.get("options") or []:
        if not isinstance(option, Mapping) or option.get("type") != SUB_COMMAND:
            continue
        values: dict[str, Any] = {}
        for value in option.get("options") or []:
            if isinstance(value, Mapping) and value.get("name"):
                values[str(value["name"])] = value.get("value")
                if value.get("focused"):
                    values["_focused"] = str(value["name"])
        return str(option.get("name", "")), values
    return "", {}


def issue_embed(summary: chat_issues.IssueSummary) -> dict[str, Any]:
    """The card one issue shows as: key and title linking to it, then team, status and assignee."""
    return {
        "title": clip(f"{summary.key} {summary.title}", 256),
        "url": summary.url,
        "description": discord_escape(" · ".join(summary.details)),
        "color": 0x5E6AD2,
    }


def _team_choices(teams: list[tuple[str, str, str]]) -> list[tuple[str, str]]:
    """Each writable team as a `(team id, label)` pair."""
    return [(team_id, clip(f"{name} ({prefix})", 100)) for team_id, name, prefix in teams]


def _pick_team(teams: list[tuple[str, str, str]], wanted: str) -> str:
    """The team a person named by id, key prefix or name, the only team when they named none, or `""`."""
    text = wanted.strip()
    if not text:
        return teams[0][0] if len(teams) == 1 else ""
    for team_id, name, prefix in teams:
        if text == team_id or text.upper() == prefix.upper() or text.lower() == name.lower():
            return team_id
    return ""


def _create(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    title: str,
    description: str,
) -> dict[str, Any]:
    """Create one issue as the member, answering the reply that links to it or says why not."""
    try:
        payload = IssueCreate(team_id=team_id, title=" ".join(title.split()), body=description.strip() or None)
    except ValidationError:
        return ephemeral(f"A title is 1 to {TITLE_MAX} characters.")
    try:
        issue = create_issue(repositories, context, payload)
    except HTTPException:
        return ephemeral("You cannot create issues in this team.")
    key = display_key(repositories.teams, context.workspace_id, issue.team_id, issue.key)
    url = Links(repositories, context.workspace_id).issue(key)
    _log.info("Created an issue from Discord.", extra={"event": "integrations.discord.issue_created"})
    return ephemeral(f"Created [{key}]({url}).")


def _teams_hint(teams: list[tuple[str, str, str]]) -> str:
    """The reply naming the teams a person can pick from."""
    names = ", ".join(f"{discord_escape(name)} ({prefix})" for _, name, prefix in teams[:MAX_CHOICES])
    return f"Pick a team with the `team` option: {names}."


def _show(repositories: Repositories, context: AuthzContext, key: str) -> dict[str, Any]:
    """The card of one issue the member can see, or a reply saying there is none."""
    wanted = " ".join(key.split()).upper()
    issue = chat_issues.issue_by_key(repositories, context.workspace_id, wanted)
    if issue is None or not context.can_see_team(issue.team_id):
        return ephemeral(f"No issue {discord_escape(wanted[:KEY_MAX])} that you can see.")
    return ephemeral("", [issue_embed(chat_issues.summarize(repositories, issue))])


def slash_command(
    repositories: Repositories,
    installation: DiscordInstallation,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    """Answer one `/standupless` invocation."""
    data = payload.get("data") or {}
    subcommand, values = _options(data if isinstance(data, Mapping) else {})
    if subcommand not in ("show", "create"):
        return ephemeral(HELP_TEXT)
    discord_user_id = _user_id(payload)
    context = _context(repositories, installation, discord_user_id)
    if context is None:
        return _not_linked(installation, discord_user_id)
    if subcommand == "show":
        return _show(repositories, context, str(values.get("key") or ""))
    teams = chat_issues.writable_teams(repositories, context)
    if not teams:
        return ephemeral(NO_TEAMS)
    team_id = _pick_team(teams, str(values.get("team") or ""))
    if not team_id:
        return ephemeral(_teams_hint(teams))
    return _create(repositories, context, team_id, str(values.get("title") or ""), str(values.get("description") or ""))


def autocomplete(
    repositories: Repositories,
    installation: DiscordInstallation,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    """The teams matching what a person typed in the `team` option, at most 25."""
    data = payload.get("data") or {}
    _, values = _options(data if isinstance(data, Mapping) else {})
    choices: list[dict[str, str]] = []
    context = _context(repositories, installation, _user_id(payload))
    if context is not None and values.get("_focused") == TEAM_INPUT:
        typed = str(values.get(TEAM_INPUT) or "").strip().lower()
        for team_id, label in _team_choices(chat_issues.writable_teams(repositories, context)):
            if not typed or typed in label.lower():
                choices.append({"name": label, "value": team_id})
    return {"type": AUTOCOMPLETE_RESULT, "data": {"choices": choices[:MAX_CHOICES]}}


def _text_input(custom_id: str, label: str, *, style: int, value: str, required: bool, max_length: int) -> dict:
    """One text field of the create issue form, in its own row."""
    field: dict[str, Any] = {
        "type": 4,
        "custom_id": custom_id,
        "label": label,
        "style": style,
        "required": required,
        "max_length": max_length,
    }
    if value:
        field["value"] = value[:max_length]
    return {"type": 1, "components": [field]}


def create_modal(teams: list[tuple[str, str, str]], channel_id: str, message_id: str, text: str) -> dict[str, Any]:
    """The form that files one message as an issue, prefilled from it."""
    only = teams[0][2] if len(teams) == 1 else ""
    team_field = _text_input(TEAM_INPUT, "Team key", style=1, value=only, required=True, max_length=10)
    if not only:
        team_field["components"][0]["placeholder"] = clip(", ".join(prefix for _, _, prefix in teams), 100)
    return {
        "type": MODAL,
        "data": {
            "custom_id": f"{CREATE_PREFIX}:{channel_id}:{message_id}"[:100],
            "title": "Create issue",
            "components": [
                team_field,
                _text_input(
                    TITLE_INPUT,
                    "Title",
                    style=1,
                    value=chat_issues.title_from(text),
                    required=True,
                    max_length=TITLE_MAX,
                ),
                _text_input(
                    DESCRIPTION_INPUT,
                    "Description",
                    style=2,
                    value=text,
                    required=False,
                    max_length=DESCRIPTION_MAX,
                ),
            ],
        },
    }


def message_command(
    repositories: Repositories,
    installation: DiscordInstallation,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    """Open the create issue form prefilled from the message the command was used on."""
    discord_user_id = _user_id(payload)
    context = _context(repositories, installation, discord_user_id)
    if context is None:
        return _not_linked(installation, discord_user_id)
    teams = chat_issues.writable_teams(repositories, context)
    if not teams:
        return ephemeral(NO_TEAMS)
    data = payload.get("data") or {}
    target_id = str(data.get("target_id", "")) if isinstance(data, Mapping) else ""
    resolved = (data.get("resolved") or {}) if isinstance(data, Mapping) else {}
    messages = (resolved.get("messages") or {}) if isinstance(resolved, Mapping) else {}
    message = messages.get(target_id) if isinstance(messages, Mapping) else None
    text = str(message.get("content", "")) if isinstance(message, Mapping) else ""
    channel_id = str(payload.get("channel_id", ""))
    if not channel_id and isinstance(message, Mapping):
        channel_id = str(message.get("channel_id", ""))
    return create_modal(teams, channel_id, target_id, text)


def _submitted(data: Mapping[str, Any]) -> dict[str, str]:
    """The submitted value of each field of a form, by its id."""
    values: dict[str, str] = {}
    for row in data.get("components") or []:
        for field in (row.get("components") or []) if isinstance(row, Mapping) else []:
            if isinstance(field, Mapping) and field.get("custom_id"):
                values[str(field["custom_id"])] = str(field.get("value") or "")
    return values


def _message_link(guild_id: str, custom_id: str) -> str:
    """The link to the message a form was opened from, or `""` when the form names none."""
    _, channel_id, message_id = (custom_id.split(":") + ["", ""])[:3]
    if not (guild_id.isdigit() and channel_id.isdigit() and message_id.isdigit()):
        return ""
    return f"https://discord.com/channels/{guild_id}/{channel_id}/{message_id}"


def submit_create(
    repositories: Repositories,
    installation: DiscordInstallation,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    """Create the issue the form describes, as the person who submitted it."""
    discord_user_id = _user_id(payload)
    context = _context(repositories, installation, discord_user_id)
    if context is None:
        return _not_linked(installation, discord_user_id)
    data = payload.get("data") or {}
    if not isinstance(data, Mapping):
        return ephemeral(HELP_TEXT)
    values = _submitted(data)
    teams = chat_issues.writable_teams(repositories, context)
    team_id = _pick_team(teams, values.get(TEAM_INPUT, "")) if teams else ""
    if not team_id:
        return ephemeral(_teams_hint(teams) if teams else NO_TEAMS)
    description = values.get(DESCRIPTION_INPUT, "").strip()
    link = _message_link(installation.guild_id, str(data.get("custom_id", "")))
    if link:
        description = f"{description}\n\nFrom Discord: {link}".strip()
    return _create(repositories, context, team_id, values.get(TITLE_INPUT, ""), description)


def interaction(
    repositories: Repositories,
    installation: DiscordInstallation,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    """Route one interaction to its handler, answering help for kinds the App never registered."""
    kind = payload.get("type")
    data = payload.get("data") or {}
    if not isinstance(data, Mapping):
        return ephemeral(HELP_TEXT)
    if kind == APPLICATION_COMMAND and data.get("type") == MESSAGE_COMMAND:
        return message_command(repositories, installation, payload)
    if kind == APPLICATION_COMMAND:
        return slash_command(repositories, installation, payload)
    if kind == AUTOCOMPLETE:
        return autocomplete(repositories, installation, payload)
    if kind == MODAL_SUBMIT and str(data.get("custom_id", "")).startswith(f"{CREATE_PREFIX}:"):
        return submit_create(repositories, installation, payload)
    return ephemeral(HELP_TEXT)
