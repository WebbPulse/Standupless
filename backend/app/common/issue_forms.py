"""Form templates: an issue template whose questions an issue filed from it answers.

A form is an issue template with `form_fields`. Saving one holds each select
option's label to the rows the template's scope sees, as its default labels are.
Filing from one holds the answers to the questions, strictly, because they are
typed by the person filing: an unknown key, a wrong type, an option the field
does not offer or a required field left blank is a 422 naming it. The answers
land in the body as a definition list ahead of any description, a chosen
option's label joins the issue's labels and its priority replaces the issue's,
and the issue is sent to the team's triage, where it waits when triage is on.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import IssueCreate
from app.common.api.schemas.templates import FormField
from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.team_templates import FormFieldBlueprint, IssueTemplate
from app.common.db.dynamo.teams import Team
from app.common.issue_rules import check_labels, unprocessable

SHORT_TEXT_MAX = 500
"""The longest answer a short text field takes."""

NO_ANSWER = "No answer"
"""What the body shows under an optional question left blank."""


def check_form_labels(
    repositories: Repositories,
    workspace_id: str,
    team: Optional[Team],
    fields: list[FormField],
    check_workspace: Callable[[Repositories, str, list[str]], list[str]],
) -> list[FormFieldBlueprint]:
    """Hold each option's label to the team's labels, or the workspace's with no team, or raise a 422."""
    for field in fields:
        for option in field.options:
            if option.label_id is None:
                continue
            if team is None:
                check_workspace(repositories, workspace_id, [option.label_id])
            else:
                check_labels(repositories, workspace_id, team.team_id, [option.label_id])
    return [FormFieldBlueprint.model_validate(field.model_dump()) for field in fields]


def _text(field: FormFieldBlueprint, value: Any) -> Optional[str]:
    """A text answer stripped, `None` when blank, or a 422 for a value that is not text."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise unprocessable(f"{field.label} takes text")
    answer = value.strip()
    if field.type == "short_text":
        if "\n" in answer:
            raise unprocessable(f"{field.label} takes one line")
        if len(answer) > SHORT_TEXT_MAX:
            raise unprocessable(f"{field.label} must be at most {SHORT_TEXT_MAX} characters")
    return answer or None


def _answer(field: FormFieldBlueprint, value: Any) -> Optional[str | bool]:
    """One field's answer held to its type and its options, `None` when left blank."""
    if field.type == "checkbox":
        if value is None:
            return None
        if not isinstance(value, bool):
            raise unprocessable(f"{field.label} takes true or false")
        return value
    answer = _text(field, value)
    if field.type == "select" and answer is not None:
        offered = {option.value.casefold(): option.value for option in field.options}
        if answer.casefold() not in offered:
            raise unprocessable(f"{answer} is not an option of {field.label}")
        return offered[answer.casefold()]
    return answer


def check_answers(fields: list[FormFieldBlueprint], answers: dict[str, Any]) -> dict[str, Optional[str | bool]]:
    """Every field's answer by key, held strictly, or a 422 naming the first problem."""
    known = {field.key for field in fields}
    for key in answers:
        if key not in known:
            raise unprocessable(f"No such form field: {key}")
    held: dict[str, Optional[str | bool]] = {}
    for field in fields:
        answer = _answer(field, answers.get(field.key))
        if field.required and (answer is None or answer is False):
            verb = "must be checked" if field.type == "checkbox" else "is required"
            raise unprocessable(f"{field.label} {verb}")
        held[field.key] = answer
    return held


def _shown(answer: Optional[str | bool]) -> str:
    """How one answer reads in the body."""
    if answer is None:
        return f"_{NO_ANSWER}_"
    if isinstance(answer, bool):
        return "Yes" if answer else "No"
    return answer


def render_answers(fields: list[FormFieldBlueprint], answers: dict[str, Optional[str | bool]]) -> str:
    """The answers as a Markdown definition list: each question in bold, its answer beneath."""
    return "\n\n".join(f"**{field.label}**\n\n{_shown(answers.get(field.key))}" for field in fields)


def _mapped(
    fields: list[FormFieldBlueprint], answers: dict[str, Optional[str | bool]]
) -> tuple[list[str], Optional[str]]:
    """The labels and the last priority the chosen select options put on the issue."""
    label_ids: list[str] = []
    priority: Optional[str] = None
    for field in fields:
        if field.type != "select":
            continue
        chosen = next((option for option in field.options if option.value == answers.get(field.key)), None)
        if chosen is None:
            continue
        if chosen.label_id and chosen.label_id not in label_ids:
            label_ids.append(chosen.label_id)
        if chosen.priority:
            priority = chosen.priority
    return label_ids, priority


def apply_form(
    repositories: Repositories,
    workspace_id: str,
    team: Team,
    template: IssueTemplate,
    payload: IssueCreate,
    kept_labels: Callable[[Repositories, str, str, list[str]], list[str]],
) -> IssueCreate:
    """The create with a form's answers rendered into its body, mapped onto it and sent to triage.

    A chosen option's label leads the issue's labels, so it wins over a label of
    the same group, and one the team no longer offers is dropped as a template's
    own label would be.
    """
    answers = check_answers(template.form_fields, payload.form_answers or {})
    rendered = render_answers(template.form_fields, answers)
    description = (payload.body or "").strip()
    body = f"{rendered}\n\n{description}" if description else rendered
    if len(body.encode("utf-8")) > ISSUE_BODY_MAX_BYTES:
        raise unprocessable(f"The answers and description must be at most {ISSUE_BODY_MAX_BYTES} bytes")
    label_ids, priority = _mapped(template.form_fields, answers)
    update: dict[str, Any] = {"body": body, "triage": True}
    if label_ids:
        update["label_ids"] = kept_labels(
            repositories, workspace_id, team.team_id, list(dict.fromkeys([*label_ids, *payload.label_ids]))
        )
    if priority:
        update["priority"] = priority
    return payload.model_copy(update=update)
