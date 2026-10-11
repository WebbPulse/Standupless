"""MCP tools for recurring issues: a team's schedules that create an issue from a template.

The tools run the same `app.common.recurring_issues` functions as the routes,
so a schedule is held to team membership and to a template the team offers. A
template is named by its id or its name, and weekdays by number or by name.
"""

from __future__ import annotations

from typing import Any

from app.common import recurring_issues
from app.common.api.schemas.recurring import RecurringCreate, RecurringRead, RecurringUpdate
from app.common.db.dynamo.team_recurring import RecurringIssue
from app.domains.integrations.mcp.template_tools import template_ref
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, enum, object_schema, string
from app.domains.integrations.mcp.transport import ToolError

TEAM_ARGUMENT = "Team: id, key such as ENG, or name"

FREQUENCIES: tuple[str, ...] = ("daily", "weekly", "monthly")

WEEKDAY_NAMES: tuple[str, ...] = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")

_RULE_FIELDS: tuple[str, ...] = ("frequency", "interval", "day_of_month", "time", "timezone", "starts_on", "paused")


def _weekday(value: Any) -> int:
    """One weekday as 0 (Monday) to 6, from a number or a name such as `mon` or `Monday`."""
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    text = str(value).strip().casefold()
    if text.isdigit():
        return int(text)
    for index, name in enumerate(WEEKDAY_NAMES):
        if len(text) >= 3 and name.startswith(text):
            return index
    raise ToolError(f"Unknown weekday {value}")


def _fields(call: ToolCall) -> dict[str, Any]:
    """The schedule fields the caller sent, the template and weekdays resolved."""
    fields = {name: call.arguments[name] for name in _RULE_FIELDS if call.optional(name) is not None}
    weekdays = call.optional("weekdays")
    if weekdays is not None:
        fields["weekdays"] = [_weekday(day) for day in weekdays]
    return fields


def _json(call: ToolCall, row: RecurringIssue) -> dict[str, Any]:
    """One schedule as the tools answer it, in the route's response shape."""
    return recurring_issues.read(call.repositories, call.context, row).model_dump(mode="json")


def _one(call: ToolCall, team_id: str) -> RecurringIssue:
    """The schedule named by `recurring_id`, or the not-visible error."""
    return recurring_issues.get_recurring(call.repositories, call.context, team_id, str(call.require("recurring_id")))


def _list(call: ToolCall) -> Any:
    """Every recurring issue of a team and the timezone new ones default to."""
    team_id = str(call.require("team_id"))
    rows, names, zone = recurring_issues.list_recurring(call.repositories, call.context, team_id)
    return {
        "recurring_issues": [
            RecurringRead.from_row(row, names.get(row.template_id), recurring_issues.preview(row)).model_dump(
                mode="json"
            )
            for row in rows
        ],
        "default_timezone": zone,
    }


def _create(call: ToolCall) -> Any:
    """Schedule an issue from one of the team's templates."""
    team_id = str(call.require("team_id"))
    template = template_ref(call, team_id, call.require("template"))
    payload = RecurringCreate.model_validate({**_fields(call), "template_id": template.template_id})
    return _json(call, recurring_issues.create_recurring(call.repositories, call.context, team_id, payload))


def _update(call: ToolCall) -> Any:
    """Change, pause or resume one recurring issue."""
    team_id = str(call.require("team_id"))
    found = _one(call, team_id)
    fields = _fields(call)
    if call.optional("template") is not None:
        fields["template_id"] = template_ref(call, team_id, call.arguments["template"]).template_id
    payload = RecurringUpdate.model_validate(fields)
    updated = recurring_issues.update_recurring(call.repositories, call.context, team_id, found.recurring_id, payload)
    return _json(call, updated)


def _delete(call: ToolCall) -> Any:
    """Delete one recurring issue; issues it already created stay."""
    team_id = str(call.require("team_id"))
    found = _one(call, team_id)
    recurring_issues.delete_recurring(call.repositories, call.context, team_id, found.recurring_id)
    return {"deleted": True, "recurring_id": found.recurring_id}


def _rule_properties() -> dict[str, Any]:
    """The rule arguments a create and an update share."""
    return {
        "frequency": enum(FREQUENCIES, "How often it repeats"),
        "interval": {
            "type": "integer",
            "minimum": 1,
            "maximum": 365,
            "description": "Every N days, weeks or months; 1 by default",
        },
        "weekdays": {
            "type": "array",
            "items": {"type": ["integer", "string"]},
            "description": "For weekly: days to run, 0 (Monday) to 6 or names such as mon, friday",
        },
        "day_of_month": {
            "type": "integer",
            "minimum": 1,
            "maximum": 31,
            "description": "For monthly: the day to run; past a short month's end it runs on the last day",
        },
        "time": string("Local time of day, HH:MM, 09:00 by default; the hourly sweep creates it within the hour"),
        "timezone": string("IANA timezone such as America/New_York; defaults to the team's standup timezone"),
        "starts_on": string("Local date, YYYY-MM-DD, the schedule starts from; today by default"),
        "paused": {"type": "boolean", "description": "Pause (true) or resume (false); resuming never catches up"},
    }


RECURRING_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_recurring_issues",
        description=(
            "The recurring issues of a team: each schedule's template, rule, next run time in UTC and the "
            "runs after it, whether it is paused and why, and the last issue it created."
        ),
        scopes=("teams:read",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT)}, required=("team_id",)),
        handler=_list,
    ),
    Tool(
        name="create_recurring_issue",
        description=(
            "Create an issue from a team's template on a schedule: daily, weekly on chosen weekdays, or monthly "
            "on one day, at a local time in a timezone. The hourly sweep creates each issue as you, within the "
            "hour after its run time; a missed run is caught up once."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "template": string("The template: its id or its name"),
                **_rule_properties(),
            },
            required=("team_id", "template", "frequency"),
        ),
        handler=_create,
    ),
    Tool(
        name="update_recurring_issue",
        description=(
            "Change, pause or resume one recurring issue; only the fields named change. Changing the rule or "
            "resuming sets the next run from now."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "recurring_id": string("The recurring issue id"),
                "template": string("A new template: its id or its name"),
                **_rule_properties(),
            },
            required=("team_id", "recurring_id"),
        ),
        handler=_update,
        idempotent=True,
    ),
    Tool(
        name="delete_recurring_issue",
        description="Permanently delete one recurring issue. Issues it already created stay.",
        scopes=("teams:write",),
        schema=object_schema(
            {"team_id": string(TEAM_ARGUMENT), "recurring_id": string("The recurring issue id")},
            required=("team_id", "recurring_id"),
        ),
        handler=_delete,
        destructive=True,
    ),
)
