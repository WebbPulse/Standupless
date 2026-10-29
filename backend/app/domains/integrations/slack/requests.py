"""Request forms in Slack: a team's form template answered in a modal and filed into its triage.

A form template a team marks `in_slack` is offered here, the way Linear Asks offers
its templates. The "Submit a request" global shortcut and `/standupless ask` open a
picker of every such form across the teams the person can write, grouped by team,
and the "Create issue" message shortcut offers the same picker inside its own form,
so a message can prefill a request. Picking a form swaps the modal for one built
from the template's questions: short and long text inputs, a select of its options
and a checkbox, each required where the template says so.

Submitting files the issue through `create_issue` with the template and its
answers, exactly as the web app's create dialog does, so the answers are held,
rendered and mapped by the same code and the issue lands in the team's triage. The
requester then gets a direct message naming the issue, and the issue is paired with
the thread it came from, or with that direct message, so replies on either side
stay in step through `threads`. Nothing here reads the text to decide anything.

A team that takes private asks adds a "Private" option to its forms, checked to
start with when the ask began in a direct message with the bot. A private ask is
read only by its requester and the team's members, and it pairs only with the
direct message or private channel it came from, else with the requester's direct
message, so its thread replies and status posts never reach a public channel.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from fastapi import HTTPException
from pydantic import ValidationError

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import TITLE_MAX, IssueCreate
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.slack import SlackInstallation
from app.common.db.dynamo.team_templates import FormFieldBlueprint, IssueTemplate
from app.common.issue_forms import SHORT_TEXT_MAX, check_answers
from app.common.issue_templates import team_templates
from app.common.issue_writes import create_issue
from app.domains.integrations.channels.messages import clip, slack_escape
from app.domains.integrations.chat import issues as chat_issues
from app.domains.integrations.slack import install, people, threads
from app.domains.integrations.slack.api import SlackError
from app.domains.integrations.slack.unfurls import issue_blocks

_log = logging.getLogger(__name__)

GLOBAL_CALLBACK = "submit_request"
"""The callback id of the "Submit a request" global shortcut in the manifest."""

PICK_CALLBACK = "standupless_pick_request"
"""The modal that picks which form to answer."""

FORM_CALLBACK = "standupless_request_form"
"""The modal that answers one form."""

FORM_BLOCK = "request_form"
"""The block, and its element, that picks a form."""

TITLE_BLOCK = "request_title"

DESCRIPTION_BLOCK = "request_description"

PRIVATE_BLOCK = "request_private"
"""The checkbox, offered only by a team that takes private asks, that files the ask as private."""

FIELD_PREFIX = "field:"
"""What each question's block id starts with, ahead of the field's key."""

FIELD_ACTION = "answer"

CHECKED = "checked"

LONG_TEXT_MAX = 3000
"""The longest text Slack's input takes, which also bounds a long answer and the description."""

TEXT_MAX = 75
"""The longest plain text an option, a group label or a modal title shows."""

HINT_MAX = 2000

MAX_GROUPS = 100

MAX_OPTIONS = 100

METADATA_MAX = 3000

PREFILL_TITLE_MAX = 500

NO_FORMS = "No team you can write offers a request form in Slack yet. A team admin turns one on in its templates."

NOT_LINKED = (
    "Your Slack account is not linked to a member of this Standupless workspace. "
    "Use the same confirmed email address in Slack and in Standupless."
)


@dataclass(frozen=True)
class TeamForms:
    """The Slack forms one team offers: its id, the label its group shows, the templates, and whether asks may be private."""

    team_id: str
    label: str
    templates: tuple[IssueTemplate, ...]
    allows_private: bool = False


def _context(repositories: Repositories, installation: SlackInstallation, slack_user_id: str) -> AuthzContext | None:
    """The member behind a Slack user, or `None` when there is none."""
    try:
        return people.context_for(repositories, installation, slack_user_id)
    except people.NotLinked:
        return None


def offered(template: IssueTemplate) -> bool:
    """Whether a template is a form its team offers in Slack."""
    return bool(template.form_fields) and template.in_slack


def slack_forms(repositories: Repositories, context: AuthzContext) -> list[TeamForms]:
    """Every form offered in Slack across the teams this person may create issues in, team by team.

    A team's own forms come first, then its parent's and the workspace's, the order
    its create dialog lists them in, and a team offering none is left out.
    """
    found: list[TeamForms] = []
    for team_id, name, prefix in chat_issues.writable_teams(repositories, context)[:MAX_GROUPS]:
        try:
            rows = team_templates(repositories, context, team_id)
        except HTTPException:
            continue
        seen: set[str] = set()
        forms: list[IssueTemplate] = []
        for row in rows:
            if offered(row) and row.template_id not in seen:
                seen.add(row.template_id)
                forms.append(row)
        if forms:
            found.append(
                TeamForms(
                    team_id=team_id,
                    label=f"{name} ({prefix})",
                    templates=tuple(forms[:MAX_OPTIONS]),
                    allows_private=repositories.github.slack_status.allows_private_asks(context.workspace_id, team_id),
                )
            )
    return found


def form_value(team_id: str, template_id: str) -> str:
    """The option value naming one form of one team."""
    return f"{team_id}:{template_id}"


def split_value(value: str) -> tuple[str, str]:
    """The team and template an option value names, or two empty strings."""
    team_id, _, template_id = value.partition(":")
    return (team_id, template_id) if team_id and template_id else ("", "")


def find_form(forms: list[TeamForms], value: str) -> tuple[TeamForms, IssueTemplate] | None:
    """The team and form an option value names, when this person is still offered it."""
    team_id, template_id = split_value(value)
    for group in forms:
        if group.team_id != team_id:
            continue
        for template in group.templates:
            if template.template_id == template_id:
                return group, template
    return None


def _plain(text: str, limit: int = TEXT_MAX) -> dict[str, Any]:
    """A plain text object Slack accepts, never empty."""
    return {"type": "plain_text", "text": clip(text, limit) or "Untitled"}


def picker_element(forms: list[TeamForms]) -> dict[str, Any]:
    """The select that picks a form, grouped by team when there is more than one team."""
    element: dict[str, Any] = {"type": "static_select", "action_id": FORM_BLOCK, "placeholder": _plain("Pick a form")}
    if len(forms) == 1:
        group = forms[0]
        element["options"] = [
            {"text": _plain(row.name), "value": form_value(group.team_id, row.template_id)} for row in group.templates
        ]
        return element
    element["option_groups"] = [
        {
            "label": _plain(group.label),
            "options": [
                {"text": _plain(row.name), "value": form_value(group.team_id, row.template_id)}
                for row in group.templates
            ],
        }
        for group in forms
    ]
    return element


def picker_block(forms: list[TeamForms], *, optional: bool) -> dict[str, Any]:
    """The input block that picks a form, optional where it sits inside the create issue form."""
    block: dict[str, Any] = {
        "type": "input",
        "block_id": FORM_BLOCK,
        "label": _plain("Request form"),
        "element": picker_element(forms),
    }
    if optional:
        block["optional"] = True
        block["hint"] = _plain("Pick a form to answer its questions next; the request files into its team.", 150)
    return block


def _metadata(values: Mapping[str, str]) -> str:
    """Private metadata carrying only the values that are set, within Slack's limit."""
    kept = {key: value for key, value in values.items() if value}
    encoded = json.dumps(kept)
    if len(encoded) > METADATA_MAX:
        kept.pop("title", None)
        encoded = json.dumps(kept)
    return encoded[:METADATA_MAX]


def read_metadata(view: Mapping[str, Any]) -> dict[str, str]:
    """A view's private metadata as a flat map of strings, empty when it does not read."""
    try:
        metadata = json.loads(str(view.get("private_metadata") or "{}"))
    except ValueError:
        return {}
    if not isinstance(metadata, Mapping):
        return {}
    return {str(key): str(value) for key, value in metadata.items() if isinstance(value, str)}


def picker_view(forms: list[TeamForms], *, title: str = "", origin: str = "") -> dict[str, Any]:
    """The modal that picks which form to answer, carrying a title typed with the command and where it was typed."""
    return {
        "type": "modal",
        "callback_id": PICK_CALLBACK,
        "title": _plain("Submit a request", 24),
        "submit": _plain("Next"),
        "close": _plain("Cancel"),
        "private_metadata": _metadata({"title": clip(title, PREFILL_TITLE_MAX), "origin": origin}),
        "blocks": [picker_block(forms, optional=False)],
    }


def notice_view(text: str) -> dict[str, Any]:
    """A modal that only says something, for a shortcut that has no reply to post to."""
    return {
        "type": "modal",
        "title": _plain("Submit a request", 24),
        "close": _plain("Close"),
        "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": slack_escape(text)}}],
    }


def field_block_id(field: FormFieldBlueprint) -> str:
    """The block id one question's input sits in."""
    return f"{FIELD_PREFIX}{field.key}"


def field_element(field: FormFieldBlueprint) -> dict[str, Any]:
    """The Block Kit element that answers one question.

    A select's options carry their position rather than their text, since an
    option's text can be longer than a Slack option value takes.
    """
    if field.type == "select":
        return {
            "type": "static_select",
            "action_id": FIELD_ACTION,
            "placeholder": _plain("Choose one"),
            "options": [
                {"text": _plain(option.value), "value": str(index)}
                for index, option in enumerate(field.options[:MAX_OPTIONS])
            ],
        }
    if field.type == "checkbox":
        return {
            "type": "checkboxes",
            "action_id": FIELD_ACTION,
            "options": [{"text": _plain(field.label), "value": CHECKED}],
        }
    if field.type == "long_text":
        return {"type": "plain_text_input", "action_id": FIELD_ACTION, "multiline": True, "max_length": LONG_TEXT_MAX}
    return {"type": "plain_text_input", "action_id": FIELD_ACTION, "max_length": SHORT_TEXT_MAX}


def field_block(field: FormFieldBlueprint) -> dict[str, Any]:
    """The input block of one question, optional unless the template requires it."""
    block: dict[str, Any] = {
        "type": "input",
        "block_id": field_block_id(field),
        "label": _plain(field.label, HINT_MAX),
        "element": field_element(field),
        "optional": not field.required,
    }
    if field.description:
        block["hint"] = _plain(field.description, HINT_MAX)
    return block


def from_direct_message(channel_id: str) -> bool:
    """Whether a Slack conversation id names a direct message, where an ask starts out private."""
    return channel_id.startswith("D")


def private_block(*, checked: bool) -> dict[str, Any]:
    """The checkbox that files an ask as private, checked to start with when it came from a direct message."""
    option = {
        "text": _plain("Private"),
        "description": _plain("Only you and the team's members can see it.", 150),
        "value": CHECKED,
    }
    element: dict[str, Any] = {"type": "checkboxes", "action_id": PRIVATE_BLOCK, "options": [option]}
    if checked:
        element["initial_options"] = [option]
    return {
        "type": "input",
        "block_id": PRIVATE_BLOCK,
        "optional": True,
        "label": _plain("Visibility"),
        "element": element,
    }


def form_view(
    group: TeamForms,
    template: IssueTemplate,
    *,
    title: str = "",
    description: str = "",
    permalink: str = "",
    channel_id: str = "",
    thread_ts: str = "",
    origin: str = "",
) -> dict[str, Any]:
    """The modal that answers one form: a title, each question in order, an optional description, then privacy.

    The title starts from what the person typed or the message's first line, else
    the template's own title. The team, the template, any message the form came
    from and the conversation it was opened in ride in the private metadata. The
    "Private" option shows only when the team takes private asks.
    """
    origin = origin or channel_id
    title_input: dict[str, Any] = {"type": "plain_text_input", "action_id": TITLE_BLOCK, "max_length": TITLE_MAX}
    starting_title = title or template.title or ""
    if starting_title:
        title_input["initial_value"] = starting_title[:TITLE_MAX]
    description_input: dict[str, Any] = {
        "type": "plain_text_input",
        "action_id": DESCRIPTION_BLOCK,
        "multiline": True,
        "max_length": LONG_TEXT_MAX,
    }
    if description:
        description_input["initial_value"] = description[:LONG_TEXT_MAX]
    metadata = {
        "team_id": group.team_id,
        "template_id": template.template_id,
        "permalink": permalink,
        "channel_id": channel_id if thread_ts else "",
        "thread_ts": thread_ts if channel_id else "",
        "origin": origin,
    }
    heading = f"*{slack_escape(clip(template.name, 150))}* for {slack_escape(group.label)}"
    blocks: list[dict[str, Any]] = [
        {"type": "context", "elements": [{"type": "mrkdwn", "text": heading}]},
        {"type": "input", "block_id": TITLE_BLOCK, "label": _plain("Title"), "element": title_input},
        *(field_block(field) for field in template.form_fields),
        {
            "type": "input",
            "block_id": DESCRIPTION_BLOCK,
            "optional": True,
            "label": _plain("Anything else"),
            "element": description_input,
        },
    ]
    if group.allows_private:
        blocks.append(private_block(checked=from_direct_message(origin)))
    return {
        "type": "modal",
        "callback_id": FORM_CALLBACK,
        "title": _plain(template.name, 24),
        "submit": _plain("Submit"),
        "close": _plain("Cancel"),
        "private_metadata": _metadata(metadata),
        "blocks": blocks,
    }


def state_values(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    """The submitted state of a view, block by block."""
    view = payload.get("view") or {}
    if not isinstance(view, Mapping):
        return {}
    state = view.get("state") or {}
    values = state.get("values") if isinstance(state, Mapping) else None
    return values if isinstance(values, Mapping) else {}


def element_state(values: Mapping[str, Any], block_id: str, action_id: str) -> Mapping[str, Any]:
    """The submitted state of one element of one block."""
    block = values.get(block_id) or {}
    element = block.get(action_id) if isinstance(block, Mapping) else None
    return element if isinstance(element, Mapping) else {}


def selected(values: Mapping[str, Any], block_id: str, action_id: str) -> str:
    """The value of the option chosen in one select, or an empty string."""
    option = element_state(values, block_id, action_id).get("selected_option") or {}
    return str(option.get("value", "")) if isinstance(option, Mapping) else ""


def text(values: Mapping[str, Any], block_id: str, action_id: str) -> str:
    """The text typed into one input, or an empty string."""
    return str(element_state(values, block_id, action_id).get("value") or "")


def checked(values: Mapping[str, Any], block_id: str) -> bool:
    """Whether the single checkbox in one block was ticked."""
    chosen = element_state(values, block_id, block_id).get("selected_options") or []
    return isinstance(chosen, list) and any(
        isinstance(option, Mapping) and option.get("value") == CHECKED for option in chosen
    )


def _raw_answer(field: FormFieldBlueprint, values: Mapping[str, Any]) -> Optional[str | bool]:
    """One question's answer as the modal sent it, before it is held to the field."""
    block_id = field_block_id(field)
    if field.type == "checkbox":
        chosen = element_state(values, block_id, FIELD_ACTION).get("selected_options") or []
        return isinstance(chosen, list) and any(
            isinstance(option, Mapping) and option.get("value") == CHECKED for option in chosen
        )
    if field.type == "select":
        index = selected(values, block_id, FIELD_ACTION)
        if not index.isdigit() or int(index) >= len(field.options):
            return None
        return field.options[int(index)].value
    answer = text(values, block_id, FIELD_ACTION).strip()
    return answer or None


def _message(error: HTTPException) -> str:
    """The message a 422 carries, for showing under the input it is about."""
    detail = error.detail
    if isinstance(detail, Mapping):
        return str(detail.get("message") or "Check this answer.")
    return str(detail or "Check this answer.")


def parse_answers(template: IssueTemplate, values: Mapping[str, Any]) -> tuple[dict[str, str | bool], dict[str, str]]:
    """Every question's answer by key and an error by block for each the form's rules refuse.

    Each answer is held on its own by the same check the create applies, so the
    modal names every problem at once under the question it is about.
    """
    answers: dict[str, str | bool] = {}
    errors: dict[str, str] = {}
    for field in template.form_fields:
        answer = _raw_answer(field, values)
        try:
            check_answers([field], {field.key: answer})
        except HTTPException as error:
            errors[field_block_id(field)] = _message(error)
            continue
        if answer is not None:
            answers[field.key] = answer
    return answers, errors


def errors_reply(errors: Mapping[str, str]) -> dict[str, Any]:
    """Keep the modal open with a message under each named block."""
    return {"response_action": "errors", "errors": dict(errors)}


def open_view(installation: SlackInstallation, trigger_id: str, view: Mapping[str, Any]) -> bool:
    """Open a modal for the person who triggered it, reporting whether Slack showed it."""
    try:
        install.call(installation, "views.open", {"trigger_id": trigger_id, "view": dict(view)})
    except (SlackError, install.BotUnavailable) as error:
        _log.info(
            "Slack refused to open a request form.",
            extra={"event": "integrations.slack.request_view_failed", "reason": getattr(error, "code", "unreadable")},
        )
        return False
    return True


def start_view(forms: list[TeamForms], *, title: str = "", origin: str = "") -> dict[str, Any]:
    """The first modal a request opens with: the only form straight away, else the picker."""
    if len(forms) == 1 and len(forms[0].templates) == 1:
        return form_view(forms[0], forms[0].templates[0], title=title, origin=origin)
    return picker_view(forms, title=title, origin=origin)


def ask_command(
    repositories: Repositories, installation: SlackInstallation, form: Mapping[str, str], title: str
) -> str:
    """Open the request picker for `/standupless ask`, answering the text to reply with, or `""` when it opened."""
    context = _context(repositories, installation, form.get("user_id", ""))
    if context is None:
        return NOT_LINKED
    forms = slack_forms(repositories, context)
    if not forms:
        return NO_FORMS
    if not open_view(
        installation, form.get("trigger_id", ""), start_view(forms, title=title, origin=form.get("channel_id", ""))
    ):
        return "Slack could not open the form. Try again."
    return ""


def global_shortcut(repositories: Repositories, installation: SlackInstallation, payload: Mapping[str, Any]) -> dict:
    """Open the request picker from the "Submit a request" shortcut, or a modal saying why not."""
    user = payload.get("user") or {}
    context = _context(repositories, installation, str(user.get("id", "")) if isinstance(user, Mapping) else "")
    trigger_id = str(payload.get("trigger_id", ""))
    if context is None:
        open_view(installation, trigger_id, notice_view(NOT_LINKED))
        return {}
    forms = slack_forms(repositories, context)
    open_view(installation, trigger_id, start_view(forms) if forms else notice_view(NO_FORMS))
    return {}


def _submitter(
    repositories: Repositories, installation: SlackInstallation, payload: Mapping[str, Any]
) -> tuple[str, AuthzContext | None]:
    """The Slack user who submitted a view, and the member behind them."""
    user = payload.get("user") or {}
    slack_user_id = str(user.get("id", "")) if isinstance(user, Mapping) else ""
    return slack_user_id, _context(repositories, installation, slack_user_id)


def submit_pick(repositories: Repositories, installation: SlackInstallation, payload: Mapping[str, Any]) -> dict:
    """Swap the picker for the form it picked."""
    _, context = _submitter(repositories, installation, payload)
    if context is None:
        return errors_reply({FORM_BLOCK: NOT_LINKED})
    found = find_form(slack_forms(repositories, context), selected(state_values(payload), FORM_BLOCK, FORM_BLOCK))
    if found is None:
        return errors_reply({FORM_BLOCK: "Pick a form you can file."})
    view = payload.get("view") or {}
    metadata = read_metadata(view) if isinstance(view, Mapping) else {}
    group, template = found
    view = form_view(group, template, title=metadata.get("title", ""), origin=metadata.get("origin", ""))
    return {"response_action": "update", "view": view}


def continue_from_create(
    repositories: Repositories,
    context: AuthzContext,
    value: str,
    *,
    title: str,
    description: str,
    metadata: Mapping[str, str],
) -> dict:
    """Swap the create issue form for the request form picked in it, carrying what was typed."""
    found = find_form(slack_forms(repositories, context), value)
    if found is None:
        return errors_reply({FORM_BLOCK: "Pick a form you can file."})
    group, template = found
    view = form_view(
        group,
        template,
        title=title,
        description=description,
        permalink=metadata.get("permalink", ""),
        channel_id=metadata.get("channel_id", ""),
        thread_ts=metadata.get("thread_ts", ""),
        origin=metadata.get("origin", "") or metadata.get("channel_id", ""),
    )
    return {"response_action": "update", "view": view}


def _filed_view(blocks: list[dict[str, Any]]) -> dict[str, Any]:
    """The modal shown once the request is filed, carrying its card."""
    return {
        "type": "modal",
        "title": _plain("Request filed", 24),
        "close": _plain("Done"),
        "blocks": blocks,
    }


def _confirm(
    repositories: Repositories, installation: SlackInstallation, slack_user_id: str, issue: Issue, team_label: str
) -> tuple[str, str]:
    """Send the requester a direct message naming the filed issue, answering its channel and `ts`.

    Both come back empty when Slack refused the message, and then nothing is paired with it.
    """
    summary = chat_issues.summarize(repositories, issue)
    label = slack_escape(clip(f"{summary.key} {summary.title}", 150))
    named = f"<{summary.url}|{label}>" if summary.url else f"*{label}*"
    message = f"Your request {named} is filed in {slack_escape(team_label)} triage."
    try:
        answer = install.call(
            installation,
            "chat.postMessage",
            {"channel": slack_user_id, "text": message, "unfurl_links": False, "unfurl_media": False},
        )
    except (SlackError, install.BotUnavailable) as error:
        _log.info(
            "Slack refused the request confirmation.",
            extra={
                "event": "integrations.slack.request_confirm_failed",
                "reason": getattr(error, "code", "unreadable"),
            },
        )
        return "", ""
    return str(answer.get("channel", "") or ""), str(answer.get("ts", "") or "")


def _create(
    context: AuthzContext,
    repositories: Repositories,
    team_id: str,
    template: IssueTemplate,
    title: str,
    description: str,
    answers: dict[str, str | bool],
    *,
    private: bool = False,
) -> Issue | dict:
    """File the issue through the shared create path, or the reply that keeps the form open."""
    fields: dict[str, Any] = {
        "team_id": team_id,
        "template_id": template.template_id,
        "title": title,
        "form_answers": answers,
    }
    if description:
        fields["body"] = description
    try:
        payload = IssueCreate(**fields)
    except ValidationError:
        return errors_reply({TITLE_BLOCK: f"A title is 1 to {TITLE_MAX} characters."})
    try:
        return create_issue(repositories, context, payload, private=private)
    except HTTPException as error:
        if error.status_code == 422:
            return errors_reply({DESCRIPTION_BLOCK: _message(error)})
        return errors_reply({TITLE_BLOCK: "You cannot file requests in this team."})


def submit_form(repositories: Repositories, installation: SlackInstallation, payload: Mapping[str, Any]) -> dict:
    """File the request the form describes, as the person who submitted it.

    The form and its team are checked again, since either may have changed since
    the modal opened. The confirmation and the pairing are best effort: a request
    Slack would not confirm is still filed, and simply is not synced. A private
    ask pairs with the thread it came from only when that is a direct message or
    a private channel, and otherwise with the requester's direct message.
    """
    slack_user_id, context = _submitter(repositories, installation, payload)
    if context is None:
        return errors_reply({TITLE_BLOCK: NOT_LINKED})
    view = payload.get("view") or {}
    metadata = read_metadata(view) if isinstance(view, Mapping) else {}
    found = find_form(
        slack_forms(repositories, context), form_value(metadata.get("team_id", ""), metadata.get("template_id", ""))
    )
    if found is None:
        return errors_reply({TITLE_BLOCK: "This form is no longer offered in Slack."})
    group, template = found
    values = state_values(payload)
    title = " ".join(text(values, TITLE_BLOCK, TITLE_BLOCK).split())
    description = text(values, DESCRIPTION_BLOCK, DESCRIPTION_BLOCK).strip()
    permalink = metadata.get("permalink", "")
    if permalink.startswith("https://"):
        description = f"{description}\n\nFrom Slack: {permalink}".strip()
    answers, errors = parse_answers(template, values)
    if not title:
        errors[TITLE_BLOCK] = f"A title is 1 to {TITLE_MAX} characters."
    if errors:
        return errors_reply(errors)
    private = group.allows_private and checked(values, PRIVATE_BLOCK)
    created = _create(context, repositories, group.team_id, template, title, description, answers, private=private)
    if isinstance(created, dict):
        return created
    issue = created
    _log.info("Filed a request form from Slack.", extra={"event": "integrations.slack.request_filed"})
    dm_channel, dm_ts = _confirm(repositories, installation, slack_user_id, issue, group.label)
    channel_id, thread_ts = metadata.get("channel_id", ""), metadata.get("thread_ts", "")
    if not (channel_id and thread_ts):
        channel_id, thread_ts = dm_channel, dm_ts
    elif private and not threads.is_private_conversation(installation, channel_id):
        channel_id, thread_ts = dm_channel, dm_ts
    threads.pair(
        repositories,
        installation,
        context,
        issue,
        channel_id=channel_id,
        thread_ts=thread_ts,
        permalink=permalink,
    )
    return {"response_action": "update", "view": _filed_view(issue_blocks(repositories, issue))}
