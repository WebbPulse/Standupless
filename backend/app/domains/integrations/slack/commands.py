"""The slash command, the "Create issue" message shortcut and the form they both open.

Every action runs as the Standupless member behind the Slack user, resolved by
`people.context_for`, so the teams offered and the issue written are exactly what
that person could do in the web app. Replies are ephemeral: only the person who
asked sees them. An issue is answered with the Standupless card rather than a bare
link, and Slack's own link preview is turned off on those replies, because the issue
page is behind sign in and its preview would only ever be the site's landing card.
The form preselects the team whose notifications the channel already carries.
An issue created from a message is paired with that message's thread, so the two
keep their discussion in step through `threads`. `ask` and the "Submit a request"
shortcut open a team's request form instead, built by `requests`, and the create
form offers the same forms so a message can be filed through one.
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
from app.common.issue_privacy import can_see_issue
from app.common.issue_writes import create_issue
from app.domains.integrations.channels.messages import clip, slack_escape
from app.domains.integrations.chat import issues as chat_issues
from app.domains.integrations.slack import install, people, threads
from app.domains.integrations.slack import requests as request_forms
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

UNRECOGNISED_MAX = 60


def ephemeral(text: str, blocks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """A reply only the person who asked sees, with Slack's link previews off."""
    reply: dict[str, Any] = {"response_type": "ephemeral", "text": text, "unfurl_links": False, "unfurl_media": False}
    if blocks:
        reply["blocks"] = blocks
    return reply


def help_text(command: str) -> str:
    """What the command can do, named the way this environment's App spells it."""
    name = command or "/standupless"
    return (
        f"`{name} show ABC-12` or `{name} ABC-12` shows an issue.\n"
        f"`{name} create Fix the login redirect` opens the form to create an issue.\n"
        f"`{name} ask` opens a team's request form, as does the *Submit a request* shortcut.\n"
        "The *Create issue* shortcut on any message files it as an issue."
    )


def unrecognised(command: str, what: str, *, as_key: bool = False) -> dict[str, Any]:
    """The reply to input the command cannot read: what it did not recognise, then the help."""
    if not what:
        return ephemeral(f"Name the issue to show, such as `show ABC-12`.\n{help_text(command)}")
    shown = slack_escape(clip(what, UNRECOGNISED_MAX)).replace("`", "'")
    kind = " as an issue key" if as_key else ""
    return ephemeral(f"Didn't recognise `{shown}`{kind}.\n{help_text(command)}")


def writable_teams(repositories: Repositories, context: AuthzContext) -> list[tuple[str, str]]:
    """The teams this person may create issues in, as `(team id, label)` pairs."""
    teams = chat_issues.writable_teams(repositories, context)
    return [(team_id, f"{name} ({prefix})") for team_id, name, prefix in teams][:MAX_TEAM_OPTIONS]


def _option(team_id: str, label: str) -> dict[str, Any]:
    """One team in the form's picker."""
    return {"text": {"type": "plain_text", "text": label[:75]}, "value": team_id}


def create_view(
    teams: list[tuple[str, str]],
    *,
    title: str = "",
    description: str = "",
    permalink: str = "",
    team_id: str = "",
    channel_id: str = "",
    thread_ts: str = "",
    forms: list[request_forms.TeamForms] | None = None,
) -> dict:
    """The modal that creates an issue, prefilled from a command or a message.

    The team picker starts on `team_id` when it is one of the offered teams, and on
    the only team when there is just one. A message's channel and thread ride in
    the private metadata, so the submission can pair the issue with that thread.
    When any team offers request forms, a last, optional picker lets the person
    answer one of them instead, which the submission swaps in; the team picker is
    then optional too, since a form names its own team, and a plain create still
    has to pick one.
    """
    metadata: dict[str, str] = {"permalink": permalink}
    if channel_id and thread_ts:
        metadata.update({"channel_id": channel_id, "thread_ts": thread_ts})
    options = [_option(option_id, label) for option_id, label in teams]
    team_select: dict[str, Any] = {"type": "static_select", "action_id": TEAM_BLOCK, "options": options}
    preselected = [option for option in options if option["value"] == team_id] if team_id else []
    if preselected:
        team_select["initial_option"] = preselected[0]
    elif len(options) == 1:
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
        "private_metadata": json.dumps(metadata)[:3000],
        "blocks": [
            {
                "type": "input",
                "block_id": TEAM_BLOCK,
                "label": {"type": "plain_text", "text": "Team"},
                "element": team_select,
                **({"optional": True} if forms else {}),
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
            *([request_forms.picker_block(forms, optional=True)] if forms else []),
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


def _channel_team(repositories: Repositories, context: AuthzContext, channel_id: str) -> str:
    """The team the channel posts notifications for, when the person may create issues in it."""
    return chat_issues.channel_team(repositories, context, slack_channel_ids=(channel_id,))


def _show(repositories: Repositories, context: AuthzContext, key: str) -> dict[str, Any]:
    """The card of one issue the member can see, or a reply saying there is none."""
    wanted = key.upper()
    issue = issue_by_key(repositories, context.workspace_id, wanted)
    if issue is None or not can_see_issue(repositories, context, issue):
        return ephemeral(f"No issue {slack_escape(wanted)} that you can see.")
    blocks = issue_blocks(repositories, issue)
    summary = chat_issues.summarize(repositories, issue)
    return ephemeral(f"{summary.key} {clip(summary.title, 150)}", blocks)


def slash_command(repositories: Repositories, installation: SlackInstallation, form: Mapping[str, str]) -> dict:
    """Answer one `/standupless` invocation.

    `show KEY` and a bare `KEY` both show an issue, matching the Discord App's
    `show`, `ask` opens a request form, and anything else that is not `create` or
    `help` names what was not recognised before the help, rather than silently
    answering the help alone.
    """
    command = form.get("command", "")
    text = " ".join(form.get("text", "").split())
    if not text or text.lower() == "help":
        return ephemeral(help_text(command))
    verb, _, rest = text.partition(" ")
    if verb.lower() == "ask":
        reply = request_forms.ask_command(repositories, installation, form, rest)
        return ephemeral(reply) if reply else {}
    if verb.lower() == "show":
        key = rest
        if split_key(key) is None:
            return unrecognised(command, key, as_key=True)
    elif verb.lower() == "create" or split_key(text) is not None:
        key = text
    else:
        return unrecognised(command, text)
    context = _context(repositories, installation, form.get("user_id", ""))
    if context is None:
        return ephemeral(NOT_LINKED)
    if verb.lower() != "create":
        return _show(repositories, context, key)
    teams = writable_teams(repositories, context)
    if not teams:
        return ephemeral(NO_TEAMS)
    team_id = _channel_team(repositories, context, form.get("channel_id", ""))
    forms = request_forms.slack_forms(repositories, context)
    view = create_view(teams, title=rest, team_id=team_id, forms=forms)
    if not _open(installation, form.get("trigger_id", ""), view):
        return ephemeral("Slack could not open the form. Try again.")
    return {}


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
    return chat_issues.title_from(text)


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
    channel_id = str(channel.get("id", "")) if isinstance(channel, Mapping) else ""
    message_ts = str(message.get("ts", "")) if isinstance(message, Mapping) else ""
    thread_ts = str(message.get("thread_ts", "") or "") if isinstance(message, Mapping) else ""
    permalink = _permalink(installation, channel_id, message_ts)
    view = create_view(
        teams,
        title=_title_from(text),
        description=text,
        permalink=permalink,
        team_id=_channel_team(repositories, context, channel_id),
        channel_id=channel_id,
        thread_ts=thread_ts or message_ts,
        forms=request_forms.slack_forms(repositories, context),
    )
    _open(installation, str(payload.get("trigger_id", "")), view)
    return {}


def _value(values: Mapping[str, Any], block: str) -> Mapping[str, Any]:
    """The submitted state of one input block."""
    state = values.get(block) or {}
    element = state.get(block) if isinstance(state, Mapping) else None
    return element if isinstance(element, Mapping) else {}


def _errors(errors: Mapping[str, str]) -> dict[str, Any]:
    """Keep the form open with a message under each named block."""
    return {"response_action": "errors", "errors": dict(errors)}


def _created_view(blocks: list[dict[str, Any]]) -> dict[str, Any]:
    """The modal shown once the issue exists, carrying its card."""
    return {
        "type": "modal",
        "title": {"type": "plain_text", "text": "Issue created"},
        "close": {"type": "plain_text", "text": "Done"},
        "blocks": blocks,
    }


def submit_create(repositories: Repositories, installation: SlackInstallation, payload: Mapping[str, Any]) -> dict:
    """Create the issue the form describes, as the person who submitted it.

    A form opened from a message pairs the new issue with the message's thread.
    The pairing is best effort: an issue whose thread Slack would not reply in is
    still created, and simply is not synced. Picking a request form creates
    nothing yet: the modal becomes that form, carrying what was typed and the
    message it came from.
    """
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
    chosen_form = request_forms.selected(values, request_forms.FORM_BLOCK, request_forms.FORM_BLOCK)
    if chosen_form:
        carried = {str(key): str(value) for key, value in metadata.items()} if isinstance(metadata, Mapping) else {}
        return request_forms.continue_from_create(
            repositories, context, chosen_form, title=title, description=description, metadata=carried
        )
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
    _log.info("Created an issue from Slack.", extra={"event": "integrations.slack.issue_created"})
    if isinstance(metadata, Mapping):
        threads.pair(
            repositories,
            installation,
            context,
            issue,
            channel_id=str(metadata.get("channel_id", "") or ""),
            thread_ts=str(metadata.get("thread_ts", "") or ""),
            permalink=permalink,
        )
    return {"response_action": "update", "view": _created_view(issue_blocks(repositories, issue))}


def interaction(repositories: Repositories, installation: SlackInstallation, payload: Mapping[str, Any]) -> dict:
    """Route one interactivity payload to its handler, ignoring kinds the App never asked for."""
    kind = payload.get("type")
    if kind == "message_action" and payload.get("callback_id") == SHORTCUT_CALLBACK:
        return message_shortcut(repositories, installation, payload)
    if kind == "shortcut" and payload.get("callback_id") == request_forms.GLOBAL_CALLBACK:
        return request_forms.global_shortcut(repositories, installation, payload)
    view = payload.get("view") or {}
    callback = view.get("callback_id") if kind == "view_submission" and isinstance(view, Mapping) else None
    if callback == CREATE_CALLBACK:
        return submit_create(repositories, installation, payload)
    if callback == request_forms.PICK_CALLBACK:
        return request_forms.submit_pick(repositories, installation, payload)
    if callback == request_forms.FORM_CALLBACK:
        return request_forms.submit_form(repositories, installation, payload)
    return {}
