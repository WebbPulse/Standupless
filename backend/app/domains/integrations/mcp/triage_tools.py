"""Triage tools: a team's waiting issues, the per-team counts, working one issue, and the team switch.

Each runs `app.common.issue_triage`, the path the triage routes run, so an agent
accepts, declines, closes as duplicate or snoozes exactly as a person does.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.common import issue_triage
from app.common.api.schemas.issues import TriageAccept, TriageDecline, TriageDuplicate, TriageSnooze
from app.common.api.schemas.teams import TriageSettingsUpdate
from app.common.db.dynamo.team_config import TriageSettings
from app.common.issue_keys import current
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
    string,
    summary_json,
    team_ref,
)
from app.domains.integrations.mcp.transport import ToolError

TRIAGE_ACTIONS = ("accept", "decline", "duplicate", "snooze")


def triage_settings_json(settings: TriageSettings) -> dict[str, Any]:
    """A team's triage switch as the tools answer it."""
    return {"enabled": settings.enabled}


def _answer(call: ToolCall, issue: Any) -> dict[str, Any]:
    """One worked issue under its current key, with its status name."""
    row = call.repositories.team_config.get_status(call.context.workspace_id, issue.team_id, issue.status_id)
    return issue_json(current(call.repositories.teams, issue), status_name=row.name if row is not None else "")


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
    return {"issues": [summary_json(issue) for issue in rows], "next_cursor": next_cursor}


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


def _triage_issue(call: ToolCall) -> Any:
    """Work one waiting issue: accept, decline, close as duplicate or snooze it."""
    issue = issue_ref(call, call.require("issue_id"))
    action = call.require("action")
    repositories, context = call.repositories, call.context
    if action == "accept":
        payload = TriageAccept.model_validate(given_arguments(call, ("status_id",)))
        return _answer(call, issue_triage.accept(repositories, context, issue.issue_id, payload))
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
    """Turn a team's triage inbox on or off."""
    team = admin_team(call)
    payload = TriageSettingsUpdate.model_validate(given_arguments(call, ("enabled",)))
    saved = issue_triage.update_triage_settings(call.repositories, call.context.workspace_id, team.team_id, payload)
    return {"team_id": team.team_id, **triage_settings_json(saved)}


TRIAGE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_triage_issues",
        description=(
            "Issues waiting in a team's triage inbox, newest filed first: those filed by guests, people "
            "outside the team or workspace keys while the team has triage on. Snoozed issues are left out "
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
            "status. decline moves it to the cancelled status, keeping an optional reason in its history. "
            "duplicate closes it as a duplicate of duplicate_of_id. snooze hides it until `until` (ISO 8601, "
            "1 minute to 90 days out), or null to bring it back. Needs team membership."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string("The waiting issue: id or key such as ENG-12"),
                "action": enum(TRIAGE_ACTIONS, "What to do with the issue"),
                "status_id": string("accept: the status to accept into"),
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
            "Turn a team's triage inbox on or off. While on, issues filed by guests, people outside the team "
            "and workspace keys wait in triage until accepted. Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {"team_id": string(TEAM_ARGUMENT), "enabled": boolean("Whether the triage inbox is on")},
            required=("team_id", "enabled"),
        ),
        handler=_update_triage_settings,
        idempotent=True,
    ),
)
