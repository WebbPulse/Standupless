"""A team's ordered triage rules: saving them, explaining a broken one and running them on an issue.

Held in `common` because issue creation, patches, moves and the MCP tools in
the integrations image all run them. Rules run in their saved order on every
issue that enters a team's triage inbox. The first rule whose filter matches
applies its actions, and later rules run only while each applied rule asks to
continue. A rule that moves the issue to another team ends the run there, so the
target team's own rules never bounce it back. Every applied rule writes one
activity row naming it, recorded as Standupless rather than whoever filed the
issue, followed by a row for each field it changed.
"""

from __future__ import annotations

import logging
from typing import Optional, Sequence

from fastapi import HTTPException
from webbpulse.dynamodb import ConditionFailed, new_ulid

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.teams import TriageRuleBody
from app.common.db.dynamo.activity import Activity, build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue, IssueWriteConflict
from app.common.db.dynamo.team_config import (
    TriageRule,
    TriageRuleActions,
    TriageRuleFilter,
    TriageSettings,
)
from app.common.issue_rules import (
    changed_fields,
    check_assignee,
    check_labels,
    check_project,
    subscribe_touched,
    triage_on,
    unprocessable,
)
from app.common.labels import replace_group_siblings
from app.common.sla import apply_sla

logger = logging.getLogger(__name__)

RULE_ACTOR = "system"
"""The actor a triage rule's changes are recorded under, shown as Standupless."""

RULE_FIELD = "triage_rule"
"""The activity field an applied triage rule is recorded under."""

RULE_FIELDS: tuple[str, ...] = ("label_ids", "priority", "assignee_id", "project_id", "project_milestone_id")
"""The issue fields a triage rule can change, recorded after the rule's own row."""

FORM_SOURCE = "form"
"""The source an issue filed through a form template matches."""


def rule_problem(repositories: Repositories, workspace_id: str, team_id: str, rule: TriageRule) -> Optional[str]:
    """Why a rule can no longer run, such as a deleted label, project, user or team, or `None` when it can."""
    for label_id in rule.filter.label_ids:
        if repositories.team_config.get_label(workspace_id, team_id, label_id) is None:
            return "A label this rule filters on was deleted"
    actions = rule.actions
    checks = (
        (actions.add_label_ids, lambda: check_labels(repositories, workspace_id, team_id, actions.add_label_ids)),
        (actions.assignee_id, lambda: check_assignee(repositories, workspace_id, team_id, actions.assignee_id)),
        (actions.project_id, lambda: check_project(repositories, workspace_id, team_id, actions.project_id)),
    )
    for wanted, check in checks:
        if not wanted:
            continue
        try:
            check()
        except HTTPException as exc:
            return _detail(exc)
    if actions.team_id:
        if actions.team_id == team_id:
            return "A rule cannot move issues to their own team"
        if repositories.teams.get(workspace_id, actions.team_id) is None:
            return "The team this rule moves issues to was deleted"
    return None


def _detail(exc: HTTPException) -> str:
    """The message an `HTTPException` carried, as plain text."""
    detail = exc.detail
    message = detail.get("message") if isinstance(detail, dict) else detail
    return str(message)


def rule_warnings(repositories: Repositories, settings: TriageSettings) -> dict[str, str]:
    """Each rule that can no longer run, keyed by rule id, with the reason it is off."""
    found: dict[str, str] = {}
    for rule in settings.rules:
        problem = rule_problem(repositories, settings.workspace_id, settings.team_id, rule)
        if problem is not None:
            found[rule.rule_id] = problem
    return found


def saved_rules(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    current: Sequence[TriageRule],
    bodies: Sequence[TriageRuleBody],
) -> list[TriageRule]:
    """The rules a settings patch saves, in the order sent, each checked against the team.

    A rule sent without an id, or with one the team does not hold, is new. A rule
    sent back exactly as stored is kept even when its target was deleted since,
    so a team can still reorder or delete around a broken rule, which reads as
    off with its warning. Any other rule must point at labels, a user, a project
    and a team that exist, or the patch is refused with nothing saved.
    """
    stored = {rule.rule_id: rule for rule in current}
    rules: list[TriageRule] = []
    for body in bodies:
        rule_id = body.rule_id if body.rule_id in stored else new_ulid()
        rule = TriageRule(
            rule_id=rule_id,
            name=body.name,
            enabled=body.enabled,
            continue_after=body.continue_after,
            filter=TriageRuleFilter.model_validate(body.filter.model_dump()),
            actions=TriageRuleActions.model_validate(body.actions.model_dump()),
        )
        if rule_id in {row.rule_id for row in rules}:
            raise unprocessable("Each triage rule may appear once")
        before = stored.get(rule_id)
        unchanged = before is not None and before.model_dump(exclude={"enabled"}) == rule.model_dump(
            exclude={"enabled"}
        )
        problem = rule_problem(repositories, workspace_id, team_id, rule)
        if problem is not None and not unchanged:
            raise unprocessable(f"Triage rule {rule.name}: {problem}")
        rules.append(rule.model_copy(update={"enabled": False}) if problem is not None else rule)
    return rules


def issue_origin(context: AuthzContext, *, from_form: bool = False) -> str:
    """Where an issue came from, as a triage rule's source filter reads it."""
    return FORM_SOURCE if from_form else context.source


def matches(rule_filter: TriageRuleFilter, issue: Issue, origin: str) -> bool:
    """Whether an issue matches every condition one filter sets."""
    if rule_filter.label_ids and not set(rule_filter.label_ids) & set(issue.label_ids):
        return False
    if rule_filter.priorities and (issue.priority or "none") not in rule_filter.priorities:
        return False
    if rule_filter.creator_ids and issue.created_by not in rule_filter.creator_ids:
        return False
    if rule_filter.sources and origin not in rule_filter.sources:
        return False
    if rule_filter.text:
        needle = rule_filter.text.casefold()
        if needle not in (issue.title or "").casefold() and needle not in (issue.body or "").casefold():
            return False
    return True


def _applied(repositories: Repositories, issue: Issue, actions: TriageRuleActions) -> Issue:
    """The issue with one rule's label, priority, assignee and project actions applied."""
    update: dict[str, object] = {}
    if actions.add_label_ids:
        rows = [
            row
            for label_id in dict.fromkeys([*issue.label_ids, *actions.add_label_ids])
            if (row := repositories.team_config.get_label(issue.workspace_id, issue.team_id, label_id)) is not None
        ]
        update["label_ids"] = replace_group_siblings(rows, issue.label_ids, actions.add_label_ids)
    if actions.priority:
        update["priority"] = actions.priority
    if actions.assignee_id:
        update["assignee_id"] = actions.assignee_id
    if actions.project_id and actions.project_id != issue.project_id:
        update["project_id"] = actions.project_id
        update["project_milestone_id"] = None
    return issue.model_copy(deep=True, update=update) if update else issue


def _rule_rows(issue: Issue, rules: Sequence[TriageRule], before: Issue, after: Issue) -> list[Activity]:
    """One row per applied rule naming it, then one per field the rules changed."""
    rows = [
        build_activity(
            issue.workspace_id,
            issue.team_id,
            issue.issue_id,
            RULE_ACTOR,
            "field_changed",
            actor_kind="system",
            field=RULE_FIELD,
            to_value={"id": rule.rule_id, "name": rule.name},
            source="system",
        )
        for rule in rules
    ]
    rows.extend(
        build_activity(
            issue.workspace_id,
            issue.team_id,
            issue.issue_id,
            RULE_ACTOR,
            "field_changed",
            actor_kind="system",
            field=field,
            from_value=old,
            to_value=new,
            source="system",
        )
        for field, old, new in changed_fields(before, after, RULE_FIELDS)
    )
    return rows


def run_triage_rules(
    repositories: Repositories,
    context: AuthzContext,
    issue: Issue,
    *,
    origin: Optional[str] = None,
    children: Optional[Sequence[Issue]] = None,
) -> tuple[Issue, list[Issue]]:
    """Run an issue's team triage rules on it, answering the issue and its sub-issues as they now stand.

    Only an issue waiting in triage on a team with triage on is touched. A rule
    whose target was deleted is skipped. A rule that moves the issue does so after
    every applied rule's other actions, taking `children` along when given and
    the stored sub-issues otherwise. A write that loses a race leaves the issue
    as it was rather than failing the change that brought it into triage.
    """
    kids = list(children) if children is not None else None
    if not issue.in_triage:
        return issue, kids or []
    workspace_id = issue.workspace_id
    settings = repositories.team_config.get_triage_settings(workspace_id, issue.team_id)
    if settings is None or not settings.enabled or not settings.rules:
        return issue, kids or []
    source = origin or context.source
    current = issue
    applied: list[TriageRule] = []
    move_to: Optional[str] = None
    for rule in settings.rules:
        if not rule.enabled or not matches(rule.filter, current, source):
            continue
        if rule_problem(repositories, workspace_id, issue.team_id, rule) is not None:
            continue
        current = _applied(repositories, current, rule.actions)
        applied.append(rule)
        if rule.actions.team_id:
            move_to = rule.actions.team_id
            break
        if not rule.continue_after:
            break
    if not applied:
        return issue, kids or []
    try:
        stored = _store(repositories, issue, current, applied)
        if move_to is None:
            return stored, kids or []
        return _move(repositories, context, stored, move_to, kids)
    except (IssueWriteConflict, ConditionFailed, HTTPException):
        logger.warning("triage rules skipped for issue %s", issue.issue_id, exc_info=True)
        return issue, kids or []


def _store(repositories: Repositories, before: Issue, after: Issue, rules: Sequence[TriageRule]) -> Issue:
    """Write the issue the applied rules produced and record each rule and change."""
    if changed_fields(before, after, RULE_FIELDS):
        after = after.model_copy(update={"updated_at": utc_now(), "updated_by": RULE_ACTOR, "updated_source": "system"})
        apply_sla(repositories, before, after)
        stored = repositories.issues.replace(after)
        subscribe_touched(repositories, stored, before)
    else:
        stored = before
    repositories.activity.record_many(_rule_rows(stored, rules, before, stored))
    return stored


def _move(
    repositories: Repositories, context: AuthzContext, issue: Issue, team_id: str, children: Optional[list[Issue]]
) -> tuple[Issue, list[Issue]]:
    """Move an issue a rule sent elsewhere, landing in the target's triage when it has triage on."""
    from app.common.issue_move import move_for_rule

    target = repositories.teams.get(issue.workspace_id, team_id)
    if target is None:
        return issue, children or []
    in_triage = triage_on(repositories, issue.workspace_id, team_id)
    return move_for_rule(repositories, context, issue, target, children, in_triage=in_triage, actor_id=RULE_ACTOR)
