"""The slash command, the "Create issue" message shortcut and the form they both open.

Every action runs as the Standupless member behind the Slack user, resolved by
`people.context_for`, so the teams offered and the issue written are exactly what
that person could do in the web app. Replies are ephemeral: only the person who
asked sees them.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Mapping

from fastapi import HTTPException
from pydantic import ValidationError

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import TITLE_MAX, IssueCreate
from app.common.db.dynamo.slack import SlackInstallation
from app.common.issue_keys import display_key
from app.common.issue_rules import team_role
from app.common.issue_writes import create_issue
from app.domains.integrations.channels.messages import slack_escape
from app.domains.integrations.outbound.payloads import Links
from app.domains.integrations.slack import install, people
from app.domains.integrations.slack.api import SlackError, respond
from app.domains.integrations.slack.unfurls import issue_blocks, issue_by_key, split_key

_log = logging.getLogger(__name__)

CREATE_CALLBACK = "standupless_create_issue"

SHORTCUT_CALLBACK = "create_issue"

TEAM_BLOCK = "team"

TITLE_BLOCK = "title"

DESCRIPTION_BLOCK = "description"

DESCRIPTION_MAX = 3000

MAX_TEAM_OPTIONS = 100

NOT_LINKED = (
    "Your Slack account is not linked to a member of this Standupless workspace. "
    "Use the same confirmed email address in Slack and in Standupless."
)

NO_TEAMS = "You are not a member of any team you can create issues in."


def ephemeral(text: str, blocks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """A reply only the person who asked sees."""
    reply: dict[str, Any] = {"response_type": "ephemeral", "text": text}
    if blocks:
        reply["blocks"] = blocks
    return reply


def help_text(command: str) -> str:
    """What the command can do, named the way this environment's App spells it."""
    name = command or "/standupless"
    return (
        f"`{name} ABC-12` shows an issue.\n"
        f"`{name} create Fix the login redirect` opens the form to create an issue.\n"
        "The *Create issue* shortcut on any message files it as an issue."
    )


def writable_teams(repositories: Repositories, context: AuthzContext) -> list[tuple[str, str]]:
    """The teams this person may create issues in, as `(team id, label)` pairs."""
    teams = repositories.teams.list_for_workspace(context.workspace_id)
    offered: list[tuple[str, str]] = []
    for team in teams:
        if not context.can_see_team(team.team_id):
            continue
        if team_role(repositories, context, team.team_id) is None:
            continue
        offered.append((team.team_id, f"{team.name} ({team.key_prefix})"))
    return offered[:MAX_TEAM_OPTIONS]


def _option(team_id: str, label: str) -> dict[str, Any]:
    """One team in the form's picker."""
    return {"text": {"type": "plain_text", "text": label[:75]}, "value": team_id}


def create_view(teams: list[tuple[str, str]], *, title: str = "", description: str = "", permalink: str = "") -> dict:
    """The modal that creates an issue, prefilled from a command or a message."""
    options = [_option(team_id, label) for team_id, label in teams]
    team_select: dict[str, Any] = {"type": "static_select", "action_id": TEAM_BLOCK, "options": options}
    if len(options) == 1:
        team_select["initial_option"] = options[0]
    title_input: dict[str, Any] = {"type": "plain_text_input", "action_id": TITLE_BLOCK, "max_length": TITLE_MAX}
    if title:
        title_input["initial_value"] = title[:TITLE_MAX]
    description_input: dict[str, Any] = {
        "type": "plain_text_input",
        "action_id": DESCRIPTION_BLOCK,
        "multiline": True,
        "max_length": DESCRIPTION_MAX,
    }
    if description:
        description_input["initial_value"] = description[:DESCRIPTION_MAX]
    return {
        "type": "modal",
        "callback_id": CREATE_CALLBACK,
        "title": {"type": "plain_text", "text": "Create issue"},
        "submit": {"type": "plain_text", "text": "Create"},
        "close": {"type": "plain_text", "text": "Cancel"},
        "private_metadata": json.dumps({"permalink": permalink})[:3000],
        "blocks": [
            {
                "type": "input",
                "block_id": TEAM_BLOCK,
                "label": {"type": "plain_text", "text": "Team"},
                "element": team_select,
            },
            {
                "type": "input",
                "block_id": TITLE_BLOCK,
                "label": {"type": "plain_text", "text": "Title"},
                "element": title_input,
            },
            {
                "type": "input",
                "block_id": DESCRIPTION_BLOCK,
                "optional": True,
                "label": {"type": "plain_text", "text": "Description"},
                "element": description_input,
            },
        ],
    }


def _open(installation: SlackInstallation, trigger_id: str, view: Mapping[str, Any]) -> bool:
    """Open a modal for the person who triggered it, reporting whether Slack showed it."""
    try:
        install.call(installation, "views.open", {"trigger_id": trigger_id, "view": dict(view)})
    except (SlackError, install.BotUnavailable) as error:
        _log.info(
            "Slack refused to open the create issue form.",
            extra={"event": "integrations.slack.view_failed", "reason": getattr(error, "code", "unreadable")},
        )
        return False
    return True


def _context(repositories: Repositories, installation: SlackInstallation, slack_user_id: str) -> AuthzContext | None:
    """The member behind a Slack user, or `None` when there is none."""
    try:
        return people.context_for(repositories, installation, slack_user_id)
    except people.NotLinked:
        return None


def slash_command(repositories: Repositories, installation: SlackInstallation, form: Mapping[str, str]) -> dict:
    """Answer one `/standupless` invocation."""
    command = form.get("command", "")
    text = " ".join(form.get("text", "").split())
    if not text or text.lower() == "help":
        return ephemeral(help_text(command))
    context = _context(repositories, installation, form.get("user_id", ""))
    if context is None:
        return ephemeral(NOT_LINKED)
    verb, _, rest = text.partition(" ")
    if verb.lower() == "create":
        teams = writable_teams(repositories, context)
        if not teams:
            return ephemeral(NO_TEAMS)
        if not _open(installation, form.get("trigger_id", ""), create_view(teams, title=rest)):
            return ephemeral("Slack could not open the form. Try again.")
        return {}
    if split_key(text) is not None:
        issue = issue_by_key(repositories, context.workspace_id, text)
        if issue is None or not context.can_see_team(issue.team_id):
            return ephemeral(f"No issue {slack_escape(text.upper())} that you can see.")
        return ephemeral(text.upper(), issue_blocks(repositories, issue))
    return ephemeral(help_text(command))


def _permalink(installation: SlackInstallation, channel_id: str, message_ts: str) -> str:
    """The link to a message, or an empty string when Slack will not give one."""
    if not channel_id or not message_ts:
        return ""
    try:
        answer = install.call(installation, "chat.getPermalink", {"channel": channel_id, "message_ts": message_ts})
    except (SlackError, install.BotUnavailable):
        return ""
    return str(answer.get("permalink", ""))


def _title_from(text: str) -> str:
    """A title from a message: its first non empty line, cut to the title limit."""
    for line in text.splitlines():
        stripped = " ".join(line.split())
        if stripped:
            return stripped[:TITLE_MAX]
    return ""


def message_shortcut(repositories: Repositories, installation: SlackInstallation, payload: Mapping[str, Any]) -> dict:
    """Open the create issue form prefilled from the message the shortcut was used on."""
    user = payload.get("user") or {}
    context = _context(repositories, installation, str(user.get("id", "")) if isinstance(user, Mapping) else "")
    response_url = str(payload.get("response_url", ""))
    if context is None:
        respond(response_url, ephemeral(NOT_LINKED))
        return {}
    teams = writable_teams(repositories, context)
    if not teams:
        respond(response_url, ephemeral(NO_TEAMS))
        return {}
    message = payload.get("message") or {}
    channel = payload.get("channel") or {}
    text = str(message.get("text", "")) if isinstance(message, Mapping) else ""
    permalink = _permalink(
        installation,
        str(channel.get("id", "")) if isinstance(channel, Mapping) else "",
        str(message.get("ts", "")) if isinstance(message, Mapping) else "",
    )
    _open(
        installation,
        str(payload.get("trigger_id", "")),
        create_view(teams, title=_title_from(text), description=text, permalink=permalink),
    )
    return {}


def _value(values: Mapping[str, Any], block: str) -> Mapping[str, Any]:
    """The submitted state of one input block."""
    state = values.get(block) or {}
    element = state.get(block) if isinstance(state, Mapping) else None
    return element if isinstance(element, Mapping) else {}


def _errors(errors: Mapping[str, str]) -> dict[str, Any]:
    """Keep the form open with a message under each named block."""
    return {"response_action": "errors", "errors": dict(errors)}


def _created_view(key: str, url: str) -> dict[str, Any]:
    """The modal shown once the issue exists, linking to it."""
    return {
        "type": "modal",
        "title": {"type": "plain_text", "text": "Issue created"},
        "close": {"type": "plain_text", "text": "Done"},
        "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": f"Created <{url}|{slack_escape(key)}>."}}],
    }


def submit_create(repositories: Repositories, installation: SlackInstallation, payload: Mapping[str, Any]) -> dict:
    """Create the issue the form describes, as the person who submitted it."""
    user = payload.get("user") or {}
    context = _context(repositories, installation, str(user.get("id", "")) if isinstance(user, Mapping) else "")
    if context is None:
        return _errors({TITLE_BLOCK: NOT_LINKED})
    view = payload.get("view") or {}
    values = ((view.get("state") or {}).get("values") or {}) if isinstance(view, Mapping) else {}
    team_id = str((_value(values, TEAM_BLOCK).get("selected_option") or {}).get("value", ""))
    title = " ".join(str(_value(values, TITLE_BLOCK).get("value") or "").split())
    description = str(_value(values, DESCRIPTION_BLOCK).get("value") or "").strip()
    try:
        metadata = json.loads(str(view.get("private_metadata") or "{}")) if isinstance(view, Mapping) else {}
    except ValueError:
        metadata = {}
    permalink = str(metadata.get("permalink", "")) if isinstance(metadata, Mapping) else ""
    if permalink.startswith("https://"):
        description = f"{description}\n\nFrom Slack: {permalink}".strip()
    if team_id not in {team for team, _ in writable_teams(repositories, context)}:
        return _errors({TEAM_BLOCK: "Pick a team you can create issues in."})
    try:
        payload_in = IssueCreate(team_id=team_id, title=title, body=description or None)
    except ValidationError:
        return _errors({TITLE_BLOCK: f"A title is 1 to {TITLE_MAX} characters."})
    try:
        issue = create_issue(repositories, context, payload_in)
    except HTTPException:
        return _errors({TEAM_BLOCK: "You cannot create issues in this team."})
    key = display_key(repositories.teams, context.workspace_id, issue.team_id, issue.key)
    url = Links(repositories, context.workspace_id).issue(key)
    _log.info("Created an issue from Slack.", extra={"event": "integrations.slack.issue_created"})
    return {"response_action": "update", "view": _created_view(key, url)}


def interaction(repositories: Repositories, installation: SlackInstallation, payload: Mapping[str, Any]) -> dict:
    """Route one interactivity payload to its handler, ignoring kinds the App never asked for."""
    kind = payload.get("type")
    if kind == "message_action" and payload.get("callback_id") == SHORTCUT_CALLBACK:
        return message_shortcut(repositories, installation, payload)
    view = payload.get("view") or {}
    if kind == "view_submission" and isinstance(view, Mapping) and view.get("callback_id") == CREATE_CALLBACK:
        return submit_create(repositories, installation, payload)
    return {}
