"""Triage tools: a team's waiting issues, the per-team counts, working one issue, and the team switch.

Each runs `app.common.issue_triage`, the path the triage routes run, so an agent
accepts, declines, closes as duplicate or snoozes exactly as a person does.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.common import issue_triage
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import TriageAccept, TriageDecline, TriageDuplicate, TriageSnooze
from app.common.api.schemas.teams import TriageSettingsRead, TriageSettingsUpdate
from app.common.db.dynamo.team_config import TriageSettings
from app.common.triage_rules import rule_warnings
from app.domains.integrations.mcp.team_tools import TEAM_ARGUMENT, admin_team, boolean, given_arguments
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    enum,
    issue_json,
    issue_ref,
    limit,
    nullable,
    object_schema,
    page_properties,
    priority_hints,
    project_id_ref,
    string,
    string_list,
    summary_json,
    team_id_ref,
    team_ref,
    user_ref,
)
from app.domains.integrations.mcp.transport import ToolError

TRIAGE_ACTIONS = ("accept", "decline", "duplicate", "snooze")

RESPONSIBILITY_ACTIONS = ("notify", "assign")

PRIORITIES = ("none", "urgent", "high", "medium", "low")


RULE_SOURCES = ("web", "form", "mcp", "cli", "api", "github", "system")

SET_PRIORITIES = ("urgent", "high", "medium", "low")


def triage_settings_json(repositories: Repositories, settings: TriageSettings) -> dict[str, Any]:
    """A team's triage settings as the tools answer them, each rule with any warning that holds it off."""
    read = TriageSettingsRead.from_row(settings, rule_warnings(repositories, settings))
    return {
        "enabled": read.enabled,
        "responsible_user_ids": list(read.responsible_user_ids),
        "responsibility_action": read.responsibility_action,
        "require_priority": read.require_priority,
        "rules": [rule.model_dump(mode="json") for rule in read.rules],
    }


def _rule_argument(call: ToolCall, value: Any) -> dict[str, Any]:
    """One rule argument with its people, project and team references resolved to ids."""
    if not isinstance(value, dict):
        raise ToolError("each rule must be an object")
    rule = dict(value)
    rule_filter = dict(rule.get("filter") or {})
    creators = rule_filter.get("creator_ids")
    if isinstance(creators, list):
        rule_filter["creator_ids"] = [user_ref(call, person) for person in creators]
    actions = dict(rule.get("actions") or {})
    if actions.get("assignee_id"):
        actions["assignee_id"] = user_ref(call, actions["assignee_id"])
    if actions.get("project_id"):
        actions["project_id"] = project_id_ref(call, actions["project_id"])
    if actions.get("team_id"):
        actions["team_id"] = team_id_ref(call, actions["team_id"])
    return {**rule, "filter": rule_filter, "actions": actions}


def _answer(call: ToolCall, issue: Any) -> dict[str, Any]:
    """One worked issue under its current key, with its status name."""
    row = call.repositories.team_config.get_status(call.context.workspace_id, issue.team_id, issue.status_id)
    return issue_json(call.repositories.teams, issue, status_name=row.name if row is not None else "")


def _list_triage(call: ToolCall) -> Any:
    """One page of a team's triage inbox, newest filed first."""
    team = team_ref(call, call.require("team_id"))
    snoozed = call.optional("snoozed", False)
    if not isinstance(snoozed, bool):
        raise ToolError("snoozed must be true or false")
    rows, next_cursor = issue_triage.list_triage(
        call.repositories,
        call.context,
        team.team_id,
        snoozed=snoozed,
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
    )
    return {"issues": [summary_json(call.repositories.teams, issue) for issue in rows], "next_cursor": next_cursor}


def _triage_summary(call: ToolCall) -> Any:
    """Each visible team with triage on and how many issues wait in it."""
    return {"teams": [row.model_dump() for row in issue_triage.triage_summary(call.repositories, call.context)]}


def _until(value: Any) -> Any:
    """The snooze moment as a datetime, or null to bring the issue back."""
    if value is None:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError as exc:
        raise ToolError("until must be an ISO 8601 date and time, such as 2026-10-10T09:00:00Z") from exc


def _accept_status(call: ToolCall, team_id: str, reference: str) -> str:
    """The status an accept names, by id or by one exact name, else as given so the refusal lists the team's."""
    rows = call.repositories.team_config.list_statuses(call.context.workspace_id, team_id)
    if any(row.status_id == reference for row in rows):
        return reference
    folded = reference.strip().casefold()
    named = [row for row in rows if not row.hidden and row.name.casefold() == folded]
    return named[0].status_id if len(named) == 1 else reference


def _triage_issue(call: ToolCall) -> Any:
    """Work one waiting issue: accept, decline, close as duplicate or snooze it."""
    issue = issue_ref(call, call.require("issue_id"))
    action = call.require("action")
    repositories, context = call.repositories, call.context
    if action == "accept":
        arguments = given_arguments(call, ("status_id", "comment", "priority"))
        if arguments.get("status_id") is not None:
            arguments["status_id"] = _accept_status(call, issue.team_id, str(arguments["status_id"]))
        payload = TriageAccept.model_validate(arguments)
        accepted = issue_triage.accept(repositories, context, issue.issue_id, payload)
        return {**_answer(call, accepted), "hints": priority_hints(accepted)}
    if action == "decline":
        payload_decline = TriageDecline.model_validate(given_arguments(call, ("reason",)))
        return _answer(call, issue_triage.decline(repositories, context, issue.issue_id, payload_decline))
    if action == "duplicate":
        target = issue_ref(call, call.require("duplicate_of_id"))
        payload_duplicate = TriageDuplicate(duplicate_of_id=target.issue_id)
        return _answer(call, issue_triage.mark_duplicate(repositories, context, issue.issue_id, payload_duplicate))
    if action == "snooze":
        if not call.present("until"):
            raise ToolError("until is required to snooze; null brings the issue back")
        payload_snooze = TriageSnooze(until=_until(call.arguments.get("until")))
        return _answer(call, issue_triage.snooze(repositories, context, issue.issue_id, payload_snooze))
    raise ToolError(f"action must be one of {', '.join(TRIAGE_ACTIONS)}")


def _update_triage_settings(call: ToolCall) -> Any:
    """Change a team's triage settings: the switch, who is on duty, the require-priority rule and the rules list."""
    team = admin_team(call)
    arguments = given_arguments(call, ("enabled", "responsibility_action", "require_priority"))
    if "responsible_user_ids" in call.arguments:
        people = call.arguments["responsible_user_ids"]
        if not isinstance(people, list):
            raise ToolError("responsible_user_ids must be a list of people")
        arguments["responsible_user_ids"] = [user_ref(call, person) for person in people]
    if "rules" in call.arguments:
        rules = call.arguments["rules"]
        if not isinstance(rules, list):
            raise ToolError("rules must be a list of rules")
        arguments["rules"] = [_rule_argument(call, rule) for rule in rules]
    payload = TriageSettingsUpdate.model_validate(arguments)
    saved = issue_triage.update_triage_settings(call.repositories, call.context, team, payload)
    return {"team_id": team.team_id, **triage_settings_json(call.repositories, saved)}


TRIAGE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_triage_issues",
        description=(
            "Issues waiting in a team's triage inbox, newest filed first: new issues filed with no status while "
            "the team has triage on, and every one from a guest, someone outside the team or a workspace key. "
            "Snoozed issues are left out "
            "until their time passes; snoozed=true lists only them."
        ),
        scopes=("issues:read",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "snoozed": boolean("List only snoozed issues"),
                **page_properties(),
            },
            required=("team_id",),
        ),
        handler=_list_triage,
    ),
    Tool(
        name="get_triage_summary",
        description="Each visible team with triage on and how many issues wait in its inbox, snoozed ones aside.",
        scopes=("issues:read",),
        schema=object_schema({}),
        handler=_triage_summary,
    ),
    Tool(
        name="triage_issue",
        description=(
            "Work one issue in triage. accept moves it into the team, in status_id or the first unstarted "
            "status, setting an optional priority and posting an optional comment as the caller; a team that "
            "requires a priority refuses an accept that leaves the issue with none, and an accept answer "
            "carries hints, naming a priority still unset so it can be set next. decline moves it to the "
            "cancelled status, keeping an optional reason in its history. "
            "duplicate closes it as a duplicate of duplicate_of_id. snooze hides it until `until` (ISO 8601, "
            "1 minute to 90 days out), or null to bring it back. Needs team membership."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string("The waiting issue: id or key such as ENG-12"),
                "action": enum(TRIAGE_ACTIONS, "What to do with the issue"),
                "status_id": string("accept: the status to accept into, by id or name"),
                "comment": string("accept: a comment posted on the issue as you, beside the accept"),
                "priority": enum(PRIORITIES, "accept: the priority the issue takes as it is accepted"),
                "reason": string("decline: why, kept in the issue's history"),
                "duplicate_of_id": string("duplicate: the issue this one duplicates, id or key"),
                "until": nullable("snooze: when the issue returns to the inbox, or null to bring it back now"),
            },
            required=("issue_id", "action"),
        ),
        handler=_triage_issue,
    ),
    Tool(
        name="update_team_triage_settings",
        description=(
            "Change a team's triage settings; only the fields sent change. enabled turns the inbox on or off. "
            "While on, every new issue that names no status waits in triage "
            "until accepted, including a team member's; issues filed by guests, people outside the team and "
            "workspace keys always do. A member's sub-issue or an issue given a real status skips it. "
            "responsible_user_ids puts members on triage duty: with responsibility_action notify each gets a "
            "New in triage notification when an issue enters the inbox, with assign an unassigned issue goes to "
            "the one holding the fewest waiting issues. require_priority refuses an accept until the issue has "
            "a priority. rules replaces the team's ordered triage rules whole: read the current list from "
            "get_team, then send it back with rules added, edited, reordered or left out to delete them; a rule "
            "sent with its rule_id keeps it, one without is new. Each rule runs on every issue entering triage "
            "in order; the first whose filter matches applies its actions and stops unless continue_after is "
            "true. A filter matches when every field given holds: any of label_ids, any of priorities, any of "
            "creator_ids, any of sources, and text found in the title or description. Actions add labels, set "
            "priority, assignee or project, or move the issue to team_id, which ends the run. A rule whose "
            "target was deleted reads enabled false with a warning. Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "enabled": boolean("Whether the triage inbox is on"),
                "responsible_user_ids": string_list(
                    "The members on triage duty, by id, email or me; an empty list takes everyone off"
                ),
                "responsibility_action": enum(
                    RESPONSIBILITY_ACTIONS, "notify tells everyone on duty, assign gives the issue to one of them"
                ),
                "require_priority": boolean("Whether accepting from triage needs a priority other than none"),
                "rules": {
                    "type": "array",
                    "description": "The team's whole ordered list of triage rules, replacing the stored one",
                    "items": object_schema(
                        {
                            "rule_id": string("The id of a stored rule to keep; leave out for a new rule"),
                            "name": string("The rule's name, shown in each issue's history when it applies"),
                            "enabled": boolean("Whether the rule runs; defaults to true"),
                            "continue_after": boolean("Whether later rules still run after this one applies"),
                            "filter": object_schema(
                                {
                                    "label_ids": string_list("Match an issue carrying any of these label ids"),
                                    "priorities": {
                                        "type": "array",
                                        "items": {"type": "string", "enum": list(PRIORITIES)},
                                        "description": "Match an issue with any of these priorities",
                                    },
                                    "creator_ids": string_list("Match an issue filed by any of these people"),
                                    "sources": {
                                        "type": "array",
                                        "items": {"type": "string", "enum": list(RULE_SOURCES)},
                                        "description": "Match an issue filed from any of these places",
                                    },
                                    "text": string("Match an issue whose title or description contains this"),
                                }
                            ),
                            "actions": object_schema(
                                {
                                    "add_label_ids": string_list("Labels to add, by id"),
                                    "priority": enum(SET_PRIORITIES, "The priority to set"),
                                    "assignee_id": string("The person to assign, by id, email or me"),
                                    "project_id": string("The project to put the issue in, by id or name"),
                                    "team_id": string("The team to move the issue to, by id, key or name"),
                                }
                            ),
                        },
                        required=("name", "actions"),
                    ),
                },
            },
            required=("team_id",),
        ),
        handler=_update_triage_settings,
        idempotent=True,
    ),
)
