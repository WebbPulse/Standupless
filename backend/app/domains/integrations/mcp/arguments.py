"""The one check every tool call's arguments pass before its handler runs.

A schema that declares `additionalProperties: false` is a promise only a client may
keep, and an agent that sends `description` where the field is `body` used to get
a success with the value silently dropped. This module keeps the promise on the
server: an unknown argument is refused, a missing required one is named, and every
problem in a call is reported in one answer, so an agent fixes its call once rather
than once per field.

It is also where an issue key stands in for an issue id. A tool whose schema takes
`issue_id` takes `issue_key` too, and `target_issue_id` takes `target_issue_key`,
so an agent holding the key a person wrote need not look up the id first. The
alternative is folded into the canonical name here, so no handler reads it.
"""

from __future__ import annotations

import difflib
from typing import Any, Mapping

from app.domains.integrations.mcp.transport import ToolError

ALTERNATIVES: dict[str, str] = {"issue_id": "issue_key", "target_issue_id": "target_issue_key"}
"""Each id argument mapped to the key argument a caller may name instead."""

ALTERNATIVE_DESCRIPTIONS: dict[str, str] = {
    "issue_key": "The issue's key, such as ABC-123, instead of issue_id",
    "target_issue_key": "The other issue's key, such as ABC-123, instead of target_issue_id",
}
"""How a schema describes each key argument it gains."""

SYNONYMS: dict[str, tuple[str, ...]] = {
    "description": ("body",),
    "content": ("body",),
    "text": ("body",),
    "comment": ("body",),
    "name": ("title",),
    "summary": ("title",),
    "relation": ("type",),
    "kind": ("type",),
    "related_issue_id": ("target_issue_id",),
    "related_issue_key": ("target_issue_key",),
    "target_id": ("target_issue_id",),
    "target_key": ("target_issue_key",),
    "key": ("issue_key",),
    "id": ("issue_id",),
    "assignee": ("assignee_id",),
    "assignee_email": ("assignee_id",),
    "labels": ("label_ids",),
    "parent": ("parent_id",),
    "parent_key": ("parent_id",),
    "parent_issue_id": ("parent_id",),
    "milestone_id": ("project_milestone_id",),
    "team": ("team_id",),
    "team_key": ("team_id",),
}
"""Names agents reach for, each mapped to the arguments it most likely means, in order."""


def with_alternatives(properties: Mapping[str, Any]) -> dict[str, Any]:
    """The properties with a key argument added beside every id argument that has one."""
    widened = dict(properties)
    for name, alternative in ALTERNATIVES.items():
        if name in widened and alternative not in widened:
            widened[alternative] = {"type": "string", "description": ALTERNATIVE_DESCRIPTIONS[alternative]}
    return widened


def client_schema(schema: Mapping[str, Any]) -> dict[str, Any]:
    """A tool's schema as `tools/list` advertises it.

    A required id with a key alternative is dropped from `required`, because either
    satisfies it and JSON Schema can only say so with a top-level `anyOf`, which
    several clients refuse. The check here enforces the pair instead.
    """
    rendered = dict(schema)
    properties = rendered.get("properties") or {}
    required = [name for name in rendered.get("required", ()) if ALTERNATIVES.get(name) not in properties]
    if required:
        rendered["required"] = required
    else:
        rendered.pop("required", None)
    return rendered


def suggestion(name: str, known: Mapping[str, Any]) -> str | None:
    """The declared argument an unknown one most likely meant, or `None`.

    Tried in order: a known synonym, the name with `_id` or `_ids` added or
    dropped, a declared argument the name ends with, such as `type` for
    `relation_type`, then the closest spelling.
    """
    folded = name.strip().lower()
    for candidate in SYNONYMS.get(folded, ()):
        if candidate in known:
            return candidate
    stems = (f"{folded}_id", f"{folded}_ids", folded.removesuffix("_ids"), folded.removesuffix("_id"))
    for candidate in stems:
        if candidate != folded and candidate in known:
            return candidate
    tails = [candidate for candidate in known if folded.endswith(f"_{candidate}")]
    if tails:
        return max(tails, key=len)
    close = difflib.get_close_matches(folded, list(known), n=1, cutoff=0.75)
    return close[0] if close else None


def _missing(arguments: Mapping[str, Any], name: str) -> bool:
    """Whether an argument is absent, null or a blank string."""
    value = arguments.get(name)
    return value is None or (isinstance(value, str) and not value.strip())


def check_arguments(tool_name: str, schema: Mapping[str, Any], arguments: Mapping[str, Any]) -> dict[str, Any]:
    """The call's arguments, checked against the tool's schema and keys folded into ids.

    Raises one `ToolError` listing every unknown argument, with the declared one it
    most likely meant, and every missing required argument, with its key
    alternative where it has one, followed by the arguments the tool takes.
    """
    known: Mapping[str, Any] = schema.get("properties") or {}
    problems: list[str] = []

    for name in arguments:
        if name in known:
            continue
        hint = suggestion(name, known)
        problems.append(f"unknown argument {name}" + (f" (did you mean {hint}?)" if hint else ""))

    for name, alternative in ALTERNATIVES.items():
        if alternative in known and not _missing(arguments, name) and not _missing(arguments, alternative):
            problems.append(f"name either {name} or {alternative}, not both")

    for name in schema.get("required", ()):
        if not _missing(arguments, name):
            continue
        alternative = ALTERNATIVES.get(name)
        if alternative is not None and alternative in known:
            if _missing(arguments, alternative):
                problems.append(f"missing argument: name either {name} or {alternative}")
            continue
        problems.append(f"missing required argument {name}")

    if problems:
        raise ToolError(f"Invalid arguments for {tool_name}: {'; '.join(problems)}. It takes: {', '.join(known)}.")

    folded = dict(arguments)
    for name, alternative in ALTERNATIVES.items():
        if alternative in known and alternative in folded:
            value = folded.pop(alternative)
            if not _missing({alternative: value}, alternative):
                folded[name] = value
    return folded
