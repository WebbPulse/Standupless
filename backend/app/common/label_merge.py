"""Merging one label into another: every issue, saved view and template naming it names the other instead.

Shared by the team and workspace label routes and the MCP tools, because the
integrations image may not import another domain's code and a merge an agent runs
must leave the same rows a team admin's does. The caller has already been held to
team admin for a team merge and to workspace admin for a workspace one.

As in Linear, both labels share a scope: two labels of one team, or two workspace
labels. Groups are never merged, only the labels inside them. When the label kept
sits in a group, an issue that carried another label of that group swaps it for
the kept one, which is how picking a second label of a group behaves anywhere
else.

A merge must reach every issue of a large team, so the issues are read a page at a
time and the work stops on a time budget, well inside the API's own timeout. The
progress lives in a merge record written before the first issue moves, and each
issue's rewrite is a no-op once it no longer carries the merged label, so calling
the merge again resumes it. The merged label is deleted last, after the record is
marked complete, and a call made after that answers the finished result again
rather than a 404.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Iterable, Sequence

from fastapi import HTTPException, status

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.teams import LabelMergeRead, LabelRead
from app.common.db.dynamo.activity import Activity, build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import (
    PARENT_SCOPE,
    TEAM_SCOPE,
    Label,
    LabelMergeRecord,
    label_merge_key,
)
from app.common.db.dynamo.team_templates import IssueTemplate
from app.common.issue_rules import unprocessable
from app.common.sub_teams import family

MERGE_BUDGET_SECONDS = 20.0
"""How long one merge call rewrites issues before answering, well inside the API's 30 second timeout."""

ACTIVITY_BATCH = 25
"""How many issue history rows are written together while a merge runs."""

LABEL_FILTER_KEYS: tuple[str, ...] = ("label_id", "label_id_not")
"""The saved view filter keys that name labels."""

SAME_LABEL = "Choose a different label to merge into."

GROUP_MERGE = "A label group cannot be merged. Merge the labels inside it instead."

OTHER_SCOPE = "Both labels must belong to {where}. Choose a label of {where} to merge into."

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

INHERITED_LABEL = {
    "error_code": "CONFLICT",
    "message": "This label is inherited from {where}. Merge it in {where}'s label settings.",
}

ALREADY_MERGED = {
    "error_code": "CONFLICT",
    "message": "This label was already merged into another label.",
}


@dataclass(frozen=True)
class MergeOutcome:
    """What one merge call reached: the merge record so far and the label kept."""

    record: LabelMergeRecord
    target: Label


@dataclass(frozen=True)
class _Scope:
    """Where a merge runs: the label owner, the teams whose issues carry the labels, and their templates."""

    team_id: str | None
    issue_team_ids: list[str]
    template_teams: list[str | None]
    siblings: frozenset[str]
    override_team_ids: list[str]


def _not_found() -> HTTPException:
    """The 404 a missing label answers."""
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def _conflict(detail: dict[str, Any]) -> HTTPException:
    """A 409 carrying one of the conflict envelopes above."""
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def merge_team_label(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    label_id: str,
    target_label_id: str,
    *,
    budget: float | None = None,
) -> MergeOutcome:
    """Fold one of a team's own labels into another of its own labels, on the team and its sub-teams.

    A label the team inherits is a 409 naming where to merge it, a target outside
    the team's own labels a 422, and a group on either side a 422.
    """
    workspace_id = context.workspace_id
    replay = _replayed(repositories, workspace_id, team_id, label_id, target_label_id)
    if replay is not None:
        return replay
    source = repositories.team_config.get_label(workspace_id, team_id, label_id)
    if source is None:
        raise _not_found()
    if source.scope != TEAM_SCOPE:
        where = "the parent team" if source.scope == PARENT_SCOPE else "the workspace"
        raise _conflict({**INHERITED_LABEL, "message": INHERITED_LABEL["message"].format(where=where)})
    target = repositories.team_config.get_label(workspace_id, team_id, target_label_id)
    if target is None:
        raise _not_found()
    if target.scope != TEAM_SCOPE:
        raise unprocessable(OTHER_SCOPE.format(where="this team"))
    _check_pair(source, target)
    team_ids = family(repositories, workspace_id, team_id)
    rows = repositories.team_config.list_labels(workspace_id, team_id)
    scope = _Scope(
        team_id=team_id,
        issue_team_ids=team_ids,
        template_teams=list(team_ids),
        siblings=_siblings(rows, target),
        override_team_ids=team_ids[1:],
    )
    return _merge(repositories, context, scope, source, target, budget)


def merge_workspace_label(
    repositories: Repositories,
    context: AuthzContext,
    label_id: str,
    target_label_id: str,
    *,
    budget: float | None = None,
) -> MergeOutcome:
    """Fold one workspace label into another, on every team's issues, views and templates.

    A target that is not a workspace label is a 404, and a group on either side a 422.
    """
    workspace_id = context.workspace_id
    replay = _replayed(repositories, workspace_id, None, label_id, target_label_id)
    if replay is not None:
        return replay
    source = repositories.team_config.get_workspace_label(workspace_id, label_id)
    if source is None:
        raise _not_found()
    target = repositories.team_config.get_workspace_label(workspace_id, target_label_id)
    if target is None:
        raise _not_found()
    _check_pair(source, target)
    team_ids = [team.team_id for team in repositories.teams.list_for_workspace(workspace_id, limit=1000)]
    rows = repositories.team_config.list_workspace_labels(workspace_id)
    scope = _Scope(
        team_id=None,
        issue_team_ids=team_ids,
        template_teams=[None, *team_ids],
        siblings=_siblings(rows, target),
        override_team_ids=team_ids,
    )
    return _merge(repositories, context, scope, source, target, budget)


def merge_read(outcome: MergeOutcome) -> LabelMergeRead:
    """The response shape of one merge call, shared by the routes and the MCP tools."""
    record = outcome.record
    return LabelMergeRead(
        source_label_id=record.source_label_id,
        source_name=record.source_name,
        target=LabelRead.from_row(outcome.target),
        issues_updated=record.issues_updated,
        views_updated=record.views_updated,
        templates_updated=record.templates_updated,
        complete=record.complete,
    )


def _check_pair(source: Label, target: Label) -> None:
    """Refuse with a 422 merging a label into itself or merging a group either way."""
    if source.label_id == target.label_id:
        raise unprocessable(SAME_LABEL)
    if source.is_group or target.is_group:
        raise unprocessable(GROUP_MERGE)


def _siblings(rows: Sequence[Label], target: Label) -> frozenset[str]:
    """The other labels of the kept label's group, which an issue gives up when it takes the kept label."""
    if not target.parent_id:
        return frozenset()
    return frozenset(
        row.label_id for row in rows if row.parent_id == target.parent_id and row.label_id != target.label_id
    )


def _replayed(
    repositories: Repositories, workspace_id: str, team_id: str | None, label_id: str, target_label_id: str
) -> MergeOutcome | None:
    """The finished result of a merge already done, or `None` when the label still stands.

    A merged label is gone, so a retry would otherwise be a 404. A retry naming a
    different target is a 409, because the label already folded elsewhere.
    """
    record = repositories.team_config.get_label_merge(workspace_id, team_id, label_id)
    if record is None or not record.complete:
        return None
    still_there = (
        repositories.team_config.get_label(workspace_id, team_id, label_id)
        if team_id
        else repositories.team_config.get_workspace_label(workspace_id, label_id)
    )
    if still_there is not None:
        return None
    if record.target_label_id != target_label_id:
        raise _conflict(ALREADY_MERGED)
    target = (
        repositories.team_config.get_label(workspace_id, team_id, target_label_id)
        if team_id
        else repositories.team_config.get_workspace_label(workspace_id, target_label_id)
    )
    if target is None:
        raise _not_found()
    return MergeOutcome(record=record, target=target)


def _merge(
    repositories: Repositories,
    context: AuthzContext,
    scope: _Scope,
    source: Label,
    target: Label,
    budget: float | None,
) -> MergeOutcome:
    """Run or resume one merge until it finishes or the time budget runs out, moving one issue at least."""
    deadline = time.monotonic() + (MERGE_BUDGET_SECONDS if budget is None else budget)
    workspace_id = context.workspace_id
    record = repositories.team_config.get_label_merge(workspace_id, scope.team_id, source.label_id)
    if record is None or record.target_label_id != target.label_id:
        record = repositories.team_config.put_label_merge(
            LabelMergeRecord(
                workspace_id=workspace_id,
                config_key=label_merge_key(scope.team_id, source.label_id),
                source_label_id=source.label_id,
                source_name=source.name,
                target_label_id=target.label_id,
                team_id=scope.team_id,
            )
        )
    moved, finished = _rewrite_issues(repositories, context, scope, source.label_id, target.label_id, deadline)
    record = record.model_copy(update={"issues_updated": record.issues_updated + moved})
    if not finished:
        record = repositories.team_config.put_label_merge(record)
        return MergeOutcome(record=record, target=target)
    views = _repoint_views(repositories, workspace_id, source.label_id, target.label_id)
    templates = _repoint_templates(repositories, workspace_id, scope, source.label_id, target.label_id)
    record = repositories.team_config.put_label_merge(
        record.model_copy(
            update={
                "views_updated": record.views_updated + views,
                "templates_updated": record.templates_updated + templates,
                "complete": True,
            }
        )
    )
    repositories.team_config.delete_overrides_of(workspace_id, scope.override_team_ids, "label", source.label_id)
    if scope.team_id:
        repositories.team_config.delete_label(workspace_id, scope.team_id, source.label_id)
    else:
        repositories.team_config.delete_workspace_label(workspace_id, source.label_id)
    audit.record(
        repositories,
        context,
        "label.merged",
        target_type="label",
        target_id=target.label_id,
        target_label=target.name,
        before={
            "label_id": source.label_id,
            "name": source.name,
            **({"team_id": scope.team_id} if scope.team_id else {}),
        },
        after={
            "label_id": target.label_id,
            "name": target.name,
            "issues_updated": record.issues_updated,
            "views_updated": record.views_updated,
            "templates_updated": record.templates_updated,
        },
    )
    return MergeOutcome(record=record, target=target)


def merged_labels(
    label_ids: Iterable[str], source_id: str, target_id: str, siblings: frozenset[str] = frozenset()
) -> list[str]:
    """`label_ids` with the merged label swapped for the kept one in place, once, and its group siblings dropped."""
    swapped = [target_id if label_id == source_id else label_id for label_id in label_ids]
    return [label_id for label_id in dict.fromkeys(swapped) if label_id not in siblings]


def _rewrite_issues(
    repositories: Repositories,
    context: AuthzContext,
    scope: _Scope,
    source_id: str,
    target_id: str,
    deadline: float,
) -> tuple[int, bool]:
    """Move every issue carrying the merged label onto the kept one, answering how many moved and whether all did."""
    moved = 0
    rows: list[Activity] = []
    finished = True
    now = utc_now()
    change = _issue_change(source_id, target_id, scope.siblings, context, now)
    for team_id in scope.issue_team_ids:
        for issue in repositories.issues.iter_with_label_lazily(context.workspace_id, team_id, source_id):
            stored = repositories.issues.replace_with(issue, change)
            if stored is not None:
                moved += 1
                rows.append(_history(context, issue, stored))
            if len(rows) >= ACTIVITY_BATCH:
                repositories.activity.record_many(rows)
                rows = []
            if time.monotonic() >= deadline:
                finished = False
                break
        if not finished:
            break
    if rows:
        repositories.activity.record_many(rows)
    return moved, finished


def _issue_change(
    source_id: str, target_id: str, siblings: frozenset[str], context: AuthzContext, now: datetime
) -> Callable[[Issue], Issue | None]:
    """The rewrite one issue gets, re-run on a fresh read after a concurrent write, `None` once it is done."""

    def change(current: Issue) -> Issue | None:
        """The issue carrying the kept label in place of the merged one, or `None` when it no longer carries it."""
        if source_id not in current.label_ids:
            return None
        return current.model_copy(
            update={
                "label_ids": merged_labels(current.label_ids, source_id, target_id, siblings),
                "updated_at": now,
                "updated_by": context.user_id,
                "updated_source": context.source,
            }
        )

    return change


def _history(context: AuthzContext, before: Issue, after: Issue) -> Activity:
    """The issue history row a merge leaves, the same label change a patch records."""
    return build_activity(
        context.workspace_id,
        after.team_id,
        after.issue_id,
        context.user_id,
        "field_changed",
        field="label_ids",
        from_value=list(before.label_ids),
        to_value=list(after.label_ids),
        source=context.source,
    )


def _repointed_filter(value: Any, source_id: str, target_id: str) -> Any:
    """One stored label filter value naming the kept label in place of the merged one."""
    if isinstance(value, str):
        return target_id if value == source_id else value
    if isinstance(value, list):
        return list(dict.fromkeys(target_id if entry == source_id else entry for entry in value))
    return value


def _repoint_views(repositories: Repositories, workspace_id: str, source_id: str, target_id: str) -> int:
    """Point every saved view filtering on the merged label at the kept one, answering how many changed."""
    changed = 0
    for view in list(repositories.views.iter_all(workspace_id)):
        updated = dict(view.filter)
        for key in LABEL_FILTER_KEYS:
            if key in updated:
                updated[key] = _repointed_filter(updated[key], source_id, target_id)
        if updated == view.filter:
            continue
        if repositories.views.update(workspace_id, view.view_key, filter=updated) is not None:
            changed += 1
    return changed


def _repoint_templates(
    repositories: Repositories, workspace_id: str, scope: _Scope, source_id: str, target_id: str
) -> int:
    """Swap the merged label for the kept one on every template in scope, answering how many changed."""
    changed = 0
    for team_id in scope.template_teams:
        templates: list[IssueTemplate] = (
            repositories.team_config.list_team_templates(workspace_id, team_id, limit=1000)
            if team_id
            else repositories.team_config.list_workspace_templates(workspace_id, limit=1000)
        )
        for template in templates:
            if source_id not in template.label_ids:
                continue
            labels = merged_labels(template.label_ids, source_id, target_id, scope.siblings)
            if repositories.team_config.replace_template(template.model_copy(update={"label_ids": labels})) is not None:
                changed += 1
    return changed
