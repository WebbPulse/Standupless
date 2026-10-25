"""Request forms in Slack: the picker, the modal built from a form template, and filing it.

Slack is faked at `api.call` as in `test_slack.py`, with a post answered by the
direct message channel and a `ts` the way Slack answers one, so the confirmation
and the pairing it carries can be followed. Forms are stored straight on the
team, and each request arrives through the signed interactivity and command
routes a deployed function serves.
"""

from __future__ import annotations

import json
from typing import Any, Iterator, Mapping

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.slack import SlackInstallation
from app.common.db.dynamo.team_config import default_triage_settings
from app.common.db.dynamo.team_templates import (
    FormFieldBlueprint,
    FormOptionBlueprint,
    IssueTemplate,
    template_key,
)
from app.domains.integrations.slack import api, commands, install
from app.domains.integrations.slack import requests as request_forms
from tests.domains.helpers import OWNER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE
from tests.domains.integrations.test_slack import SLACK_TEAM, FakeSlack, _answer, _command, _interaction

FORM = "01JB0000000000000000FORM01"

SECOND_FORM = "01JB0000000000000000FORM02"

HIDDEN_FORM = "01JB0000000000000000FORM03"

PLAIN = "01JB0000000000000000PLAIN1"

DM_CHANNEL = "D0DIRECT"

FIELDS = [
    FormFieldBlueprint(key="happened", label="What happened?", type="long_text", required=True),
    FormFieldBlueprint(key="browser", label="Browser", type="short_text", description="Name and version"),
    FormFieldBlueprint(
        key="severity",
        label="Severity",
        type="select",
        required=True,
        options=[FormOptionBlueprint(value="Blocker", priority="urgent"), FormOptionBlueprint(value="Minor")],
    ),
    FormFieldBlueprint(key="repro", label="Can you reproduce it?", type="checkbox"),
]


class RequestSlack(FakeSlack):
    """The shared Slack fake, answering a post with its channel, a direct message's resolved, and a `ts`."""

    def __init__(self) -> None:
        """Start numbering posted messages from one."""
        super().__init__()
        self.posted = 0

    def call(self, method: str, token: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Answer `chat.postMessage` the way Slack does, and defer every other method."""
        body = dict(payload or {})
        if method == "chat.postMessage" and method not in self.errors:
            self.calls.append((method, token, body))
            self.posted += 1
            channel = str(body.get("channel", ""))
            return {
                "ok": True,
                "channel": DM_CHANNEL if channel.startswith("U") else channel,
                "ts": f"1800000000.{self.posted:06d}",
            }
        return super().call(method, token, payload)


@pytest.fixture
def slack(monkeypatch: pytest.MonkeyPatch) -> RequestSlack:
    """A configured Slack App with every call faked."""
    monkeypatch.setenv("SLACK_CLIENT_ID", "1111.2222")
    monkeypatch.setenv("SLACK_CLIENT_SECRET", "a-test-slack-client-secret")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "a-test-slack-signing-secret")
    fake = RequestSlack()
    monkeypatch.setattr(api, "call", fake.call)
    monkeypatch.setattr(commands, "respond", lambda url, payload: True)
    return fake


@pytest.fixture
def installed(repositories: Any, workspace: str, github_env: None, slack: RequestSlack) -> SlackInstallation:
    """The Slack App installed in the test workspace."""
    return install.bind(repositories, WORKSPACE, OWNER, _answer())


@pytest.fixture
def slack_client(client: TestClient, installed: SlackInstallation) -> Iterator[TestClient]:
    """The integrations client with the Slack App installed and Slack faked."""
    yield client


def _template(
    repositories: Any,
    template_id: str,
    *,
    team_id: str = TEAM,
    name: str = "Bug report",
    in_slack: bool = True,
    fields: list[FormFieldBlueprint] | None = None,
) -> IssueTemplate:
    """Store one team issue template, a form offered in Slack unless told otherwise."""
    return repositories.team_config.create_template(
        IssueTemplate(
            workspace_id=WORKSPACE,
            config_key=template_key(team_id, template_id),
            template_id=template_id,
            team_id=team_id,
            name=name,
            title="Bug: ",
            form_fields=FIELDS if fields is None else fields,
            in_slack=in_slack,
        )
    )


@pytest.fixture
def form(repositories: Any, workspace: str) -> IssueTemplate:
    """The bug report form on `TEAM`, offered in Slack, with the team's triage inbox on."""
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    repositories.team_config.put_triage_settings(
        default_triage_settings(WORKSPACE, TEAM).model_copy(update={"enabled": True})
    )
    return _template(repositories, FORM)


def _group(template: IssueTemplate) -> request_forms.TeamForms:
    """One team's forms holding just this template."""
    return request_forms.TeamForms(team_id=TEAM, label="Engineering (ABC)", templates=(template,))


def _blocks(view: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """A view's input blocks by block id."""
    return {block["block_id"]: block for block in view["blocks"] if block.get("block_id")}


def _values(
    *,
    title: str = "Checkout fails",
    happened: str | None = "It spins forever",
    browser: str | None = None,
    severity: str | None = "0",
    repro: bool = False,
    description: str = "",
) -> dict[str, Any]:
    """The submitted state of the bug report form."""
    values: dict[str, Any] = {
        request_forms.TITLE_BLOCK: {request_forms.TITLE_BLOCK: {"value": title}},
        request_forms.DESCRIPTION_BLOCK: {request_forms.DESCRIPTION_BLOCK: {"value": description or None}},
        "field:happened": {request_forms.FIELD_ACTION: {"value": happened}},
        "field:browser": {request_forms.FIELD_ACTION: {"value": browser}},
        "field:severity": {
            request_forms.FIELD_ACTION: {"selected_option": {"value": severity} if severity is not None else None}
        },
        "field:repro": {
            request_forms.FIELD_ACTION: {
                "selected_options": [{"value": request_forms.CHECKED}] if repro else [],
            }
        },
    }
    return values


def _form_submission(
    values: Mapping[str, Any],
    *,
    user: str = "UOWNER",
    team_id: str = TEAM,
    template_id: str = FORM,
    metadata: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """The `view_submission` payload of a request form."""
    carried = {"team_id": team_id, "template_id": template_id, **(metadata or {})}
    return {
        "type": "view_submission",
        "team": {"id": SLACK_TEAM},
        "user": {"id": user},
        "view": {
            "callback_id": request_forms.FORM_CALLBACK,
            "private_metadata": json.dumps(carried),
            "state": {"values": dict(values)},
        },
    }


def _global_shortcut(user: str = "UOWNER") -> dict[str, Any]:
    """The payload of the "Submit a request" global shortcut."""
    return {
        "type": "shortcut",
        "callback_id": request_forms.GLOBAL_CALLBACK,
        "team": {"id": SLACK_TEAM},
        "user": {"id": user},
        "trigger_id": "trigger-9",
    }


def _created(repositories: Any, title: str) -> Issue:
    """The one issue in the team with this title."""
    rows = [row for row in repositories.issues.list_for_team(WORKSPACE, TEAM).items if row.get("title") == title]
    assert len(rows) == 1
    issue = repositories.issues.get(WORKSPACE, str(rows[0]["issue_id"]))
    assert issue is not None
    return issue


def test_the_form_modal_asks_each_question_with_its_own_input() -> None:
    """Text, long text, a select and a checkbox each get their input, required where the form says."""
    template = IssueTemplate(
        workspace_id=WORKSPACE,
        config_key=template_key(TEAM, FORM),
        template_id=FORM,
        team_id=TEAM,
        name="Bug report",
        title="Bug: ",
        form_fields=FIELDS,
        in_slack=True,
    )
    view = request_forms.form_view(_group(template))
    assert view["callback_id"] == request_forms.FORM_CALLBACK
    blocks = _blocks(view)
    assert list(blocks) == [
        request_forms.TITLE_BLOCK,
        "field:happened",
        "field:browser",
        "field:severity",
        "field:repro",
        request_forms.DESCRIPTION_BLOCK,
    ]
    assert blocks[request_forms.TITLE_BLOCK]["element"]["initial_value"] == "Bug: "
    happened = blocks["field:happened"]
    assert happened["optional"] is False and happened["element"]["multiline"] is True
    browser = blocks["field:browser"]
    assert browser["optional"] is True and browser["hint"]["text"] == "Name and version"
    assert "multiline" not in browser["element"]
    severity = blocks["field:severity"]["element"]
    assert severity["type"] == "static_select"
    assert [(row["text"]["text"], row["value"]) for row in severity["options"]] == [("Blocker", "0"), ("Minor", "1")]
    repro = blocks["field:repro"]["element"]
    assert repro["type"] == "checkboxes" and repro["options"][0]["value"] == request_forms.CHECKED
    assert json.loads(view["private_metadata"]) == {"team_id": TEAM, "template_id": FORM}

    from_message = request_forms.form_view(
        _group(template), title="Typed", channel_id="C0ENG", thread_ts="1.2", permalink="https://acme.slack.com/p1"
    )
    assert _blocks(from_message)[request_forms.TITLE_BLOCK]["element"]["initial_value"] == "Typed"
    assert json.loads(from_message["private_metadata"])["thread_ts"] == "1.2"


def test_answers_are_parsed_and_each_problem_is_named_under_its_question() -> None:
    """A select maps back to its option, a checkbox to a boolean, and every refusal lands on its block."""
    template = IssueTemplate(
        workspace_id=WORKSPACE,
        config_key=template_key(TEAM, FORM),
        template_id=FORM,
        team_id=TEAM,
        name="Bug report",
        form_fields=FIELDS,
    )
    answers, errors = request_forms.parse_answers(template, _values(browser="Firefox 130", repro=True))
    assert errors == {}
    assert answers == {"happened": "It spins forever", "browser": "Firefox 130", "severity": "Blocker", "repro": True}

    answers, errors = request_forms.parse_answers(template, _values(happened="  ", severity=None))
    assert set(errors) == {"field:happened", "field:severity"}
    assert "required" in errors["field:happened"]
    assert answers == {"repro": False}

    _, errors = request_forms.parse_answers(template, _values(severity="7"))
    assert set(errors) == {"field:severity"}


def test_only_forms_offered_in_slack_in_teams_the_person_can_write_are_listed(
    repositories: Any, workspace: str, installed: SlackInstallation, form: IssueTemplate
) -> None:
    """A plain template, a form kept out of Slack and a team the person cannot write are all left out."""
    from app.domains.integrations.slack import people

    _template(repositories, SECOND_FORM, name="Access request", in_slack=False)
    _template(repositories, PLAIN, name="Plain", fields=[])
    _template(repositories, HIDDEN_FORM, team_id=OTHER_TEAM, name="Other team form")

    guest = people.context_for(repositories, installed, "UGUEST")
    listed = request_forms.slack_forms(repositories, guest)
    assert [(group.team_id, [row.template_id for row in group.templates]) for group in listed] == [(TEAM, [FORM])]

    owner = people.context_for(repositories, installed, "UOWNER")
    teams = {
        group.team_id: [row.template_id for row in group.templates]
        for group in request_forms.slack_forms(repositories, owner)
    }
    assert teams == {TEAM: [FORM], OTHER_TEAM: [HIDDEN_FORM]}


def test_the_global_shortcut_opens_the_only_form_or_a_picker_or_says_why_not(
    slack_client: TestClient, repositories: Any, slack: RequestSlack, form: IssueTemplate
) -> None:
    """One form opens straight away, several open the picker grouped by team, and nobody linked hears why."""
    assert _interaction(slack_client, _global_shortcut(user="UGUEST")).status_code == 200
    assert slack.last("views.open")["view"]["callback_id"] == request_forms.FORM_CALLBACK

    _template(repositories, HIDDEN_FORM, team_id=OTHER_TEAM, name="Other team form")
    _interaction(slack_client, _global_shortcut())
    picker = slack.last("views.open")["view"]
    assert picker["callback_id"] == request_forms.PICK_CALLBACK
    groups = picker["blocks"][0]["element"]["option_groups"]
    assert [option["value"] for group in groups for option in group["options"]] == [
        request_forms.form_value(TEAM, FORM),
        request_forms.form_value(OTHER_TEAM, HIDDEN_FORM),
    ]

    _interaction(slack_client, _global_shortcut(user="USTRANGER"))
    notice = slack.last("views.open")["view"]
    assert "callback_id" not in notice and "not linked" in json.dumps(notice)


def test_ask_opens_the_picker_and_says_so_when_no_team_offers_a_form(
    slack_client: TestClient, repositories: Any, slack: RequestSlack, workspace: str
) -> None:
    """`ask` with no form offered answers in the channel; with one, the form opens with the typed title."""
    reply = _command(slack_client, "ask").json()
    assert reply["text"] == request_forms.NO_FORMS

    _template(repositories, FORM)
    assert _command(slack_client, "ask Checkout is broken").status_code == 200
    view = slack.last("views.open")["view"]
    assert view["callback_id"] == request_forms.FORM_CALLBACK
    assert _blocks(view)[request_forms.TITLE_BLOCK]["element"]["initial_value"] == "Checkout is broken"

    assert "ask" in _command(slack_client, "help").json()["text"]


def test_picking_a_form_swaps_the_picker_for_it(
    slack_client: TestClient, repositories: Any, form: IssueTemplate
) -> None:
    """The picker's choice becomes the form, carrying the title typed with the command."""
    payload = {
        "type": "view_submission",
        "team": {"id": SLACK_TEAM},
        "user": {"id": "UOWNER"},
        "view": {
            "callback_id": request_forms.PICK_CALLBACK,
            "private_metadata": json.dumps({"title": "From the command"}),
            "state": {
                "values": {
                    request_forms.FORM_BLOCK: {
                        request_forms.FORM_BLOCK: {"selected_option": {"value": request_forms.form_value(TEAM, FORM)}}
                    }
                }
            },
        },
    }
    reply = _interaction(slack_client, payload).json()
    assert reply["response_action"] == "update"
    assert reply["view"]["callback_id"] == request_forms.FORM_CALLBACK
    assert _blocks(reply["view"])[request_forms.TITLE_BLOCK]["element"]["initial_value"] == "From the command"

    payload["view"]["state"]["values"][request_forms.FORM_BLOCK][request_forms.FORM_BLOCK]["selected_option"] = {
        "value": request_forms.form_value(OTHER_TEAM, FORM)
    }
    refused = _interaction(slack_client, payload).json()
    assert refused["response_action"] == "errors" and request_forms.FORM_BLOCK in refused["errors"]


def test_submitting_a_form_files_it_into_triage_confirms_by_direct_message_and_syncs_that_thread(
    slack_client: TestClient, repositories: Any, slack: RequestSlack, form: IssueTemplate
) -> None:
    """The answers become the body, the issue waits in triage, and the confirmation thread is paired."""
    values = _values(browser="Firefox 130", repro=True, description="Seen on the pricing page")
    reply = _interaction(slack_client, _form_submission(values)).json()
    assert reply["response_action"] == "update"
    assert "Checkout fails" in json.dumps(reply["view"]["blocks"])

    issue = _created(repositories, "Checkout fails")
    assert issue.created_by == OWNER
    assert issue.in_triage is True
    assert issue.priority == "urgent"
    body = issue.body or ""
    for text in ("What happened?", "It spins forever", "Firefox 130", "Blocker", "Seen on the pricing page"):
        assert text in body

    posts = [body for method, _, body in slack.calls if method == "chat.postMessage"]
    confirmation, pairing = posts
    assert confirmation["channel"] == "UOWNER"
    assert "ABC-" in confirmation["text"] and "triage" in confirmation["text"]
    assert pairing["channel"] == DM_CHANNEL and pairing["thread_ts"] == "1800000000.000001"

    links = [
        link for link in repositories.github.slack_threads.list_links(WORKSPACE) if link.issue_id == issue.issue_id
    ]
    assert [(link.channel_id, link.thread_ts) for link in links] == [(DM_CHANNEL, "1800000000.000001")]


def test_a_form_missing_required_answers_stays_open_and_files_nothing(
    slack_client: TestClient, repositories: Any, form: IssueTemplate
) -> None:
    """Every required question left blank, and a blank title, are named at once."""
    reply = _interaction(slack_client, _form_submission(_values(title=" ", happened=None, severity=None))).json()
    assert reply["response_action"] == "errors"
    assert set(reply["errors"]) == {request_forms.TITLE_BLOCK, "field:happened", "field:severity"}
    assert repositories.issues.list_for_team(WORKSPACE, TEAM).items == []


def test_a_form_no_longer_offered_or_a_person_not_linked_is_refused(
    slack_client: TestClient, repositories: Any, form: IssueTemplate
) -> None:
    """A form taken out of Slack since the modal opened, and a stranger, both keep the modal open."""
    _template(repositories, SECOND_FORM, name="Access request", in_slack=False)
    withdrawn = _interaction(slack_client, _form_submission(_values(), template_id=SECOND_FORM)).json()
    assert withdrawn["response_action"] == "errors"

    stranger = _interaction(slack_client, _form_submission(_values(), user="USTRANGER")).json()
    assert stranger["errors"][request_forms.TITLE_BLOCK] == request_forms.NOT_LINKED
    assert repositories.issues.list_for_team(WORKSPACE, TEAM).items == []


def test_the_message_shortcut_can_file_the_message_through_a_form_paired_with_its_thread(
    slack_client: TestClient, repositories: Any, slack: RequestSlack, form: IssueTemplate
) -> None:
    """The create form offers the forms, picking one carries the message over, and filing pairs its thread."""
    shortcut = {
        "type": "message_action",
        "callback_id": commands.SHORTCUT_CALLBACK,
        "team": {"id": SLACK_TEAM},
        "user": {"id": "UOWNER"},
        "trigger_id": "trigger-2",
        "response_url": "https://hooks.slack.com/actions/T0/1/x",
        "channel": {"id": "C0ENG"},
        "message": {"text": "Checkout fails on Safari\nSeen twice today", "ts": "1700000000.000100"},
    }
    _interaction(slack_client, shortcut)
    create = slack.last("views.open")["view"]
    assert create["blocks"][0]["optional"] is True
    picker = create["blocks"][-1]
    assert picker["block_id"] == request_forms.FORM_BLOCK and picker["optional"] is True

    values = {
        commands.TEAM_BLOCK: {commands.TEAM_BLOCK: {"selected_option": None}},
        commands.TITLE_BLOCK: {commands.TITLE_BLOCK: {"value": "Checkout fails on Safari"}},
        commands.DESCRIPTION_BLOCK: {commands.DESCRIPTION_BLOCK: {"value": "Seen twice today"}},
        request_forms.FORM_BLOCK: {
            request_forms.FORM_BLOCK: {"selected_option": {"value": request_forms.form_value(TEAM, FORM)}}
        },
    }
    switched = _interaction(
        slack_client,
        {
            "type": "view_submission",
            "team": {"id": SLACK_TEAM},
            "user": {"id": "UOWNER"},
            "view": {
                "callback_id": commands.CREATE_CALLBACK,
                "private_metadata": create["private_metadata"],
                "state": {"values": values},
            },
        },
    ).json()
    assert switched["response_action"] == "update"
    view = switched["view"]
    blocks = _blocks(view)
    assert blocks[request_forms.TITLE_BLOCK]["element"]["initial_value"] == "Checkout fails on Safari"
    assert blocks[request_forms.DESCRIPTION_BLOCK]["element"]["initial_value"] == "Seen twice today"
    metadata = json.loads(view["private_metadata"])
    assert metadata["channel_id"] == "C0ENG" and metadata["thread_ts"] == "1700000000.000100"
    assert repositories.issues.list_for_team(WORKSPACE, TEAM).items == []

    submitted = _form_submission(
        _values(title="Checkout fails on Safari", description="Seen twice today"),
        metadata={key: value for key, value in metadata.items() if key not in ("team_id", "template_id")},
    )
    assert _interaction(slack_client, submitted).json()["response_action"] == "update"
    issue = _created(repositories, "Checkout fails on Safari")
    assert metadata["permalink"] in (issue.body or "")
    links = [
        link for link in repositories.github.slack_threads.list_links(WORKSPACE) if link.issue_id == issue.issue_id
    ]
    assert [(link.channel_id, link.thread_ts) for link in links] == [("C0ENG", "1700000000.000100")]


def test_the_create_form_still_needs_a_team_when_no_form_is_picked(
    slack_client: TestClient, form: IssueTemplate
) -> None:
    """With forms offered the team picker is optional, so a plain create without one is refused."""
    payload = {
        "type": "view_submission",
        "team": {"id": SLACK_TEAM},
        "user": {"id": "UOWNER"},
        "view": {
            "callback_id": commands.CREATE_CALLBACK,
            "private_metadata": "{}",
            "state": {
                "values": {
                    commands.TEAM_BLOCK: {commands.TEAM_BLOCK: {"selected_option": None}},
                    commands.TITLE_BLOCK: {commands.TITLE_BLOCK: {"value": "No team"}},
                }
            },
        },
    }
    reply = _interaction(slack_client, payload).json()
    assert reply["response_action"] == "errors" and commands.TEAM_BLOCK in reply["errors"]
