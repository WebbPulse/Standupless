"""Collapse team statuses and labels every team shares into workspace records.

Before workspace-level workflow existed, every team carried its own copy of the
same defaults and of any label an admin added team by team. This finds, per
workspace, the records identical across every live team (labels on name and
color, statuses on name, color and category), writes one workspace record for
each, points every reference at it and deletes the team copies.

The workspace record reuses the id of the first team's copy, ordered by team id,
so that team's references stay as they are and a rerun finds the same record.
References rewritten: issue status and labels (archived issues too), status and
label activity, saved view filters, filter share links, GitHub transition rules
and the status a pull request link last applied. Team copies are deleted last,
so a run stopped part way is finished by running it again, and a team copy that
already matches a workspace record is folded into it whatever else happened.
Workspaces with fewer than two live teams are left alone.

Every rewritten issue is a MODIFY on the issues stream. The status category is
unchanged, so the rollups are no-ops, but outbound webhooks may deliver an
`issue.updated` per rewritten issue.

Usage, from backend/:
    python scripts/collapse_workspace_workflow.py --stage staging --dry-run
    python scripts/collapse_workspace_workflow.py --stage staging --workspace <workspace_id>

`--dry-run` prints counts only, never names or ids of customer content.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field, fields, replace
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

STATUS_FILTER_KEYS: tuple[str, ...] = ("status_id", "status_id_not")

LABEL_FILTER_KEYS: tuple[str, ...] = ("label_id", "label_id_not")

MIN_TEAMS = 2


@dataclass
class Counts:
    """What one run did, or would do under `--dry-run`, summed over workspaces."""

    workspaces: int = 0
    workspace_statuses: int = 0
    workspace_labels: int = 0
    team_statuses_removed: int = 0
    team_labels_removed: int = 0
    skipped_groups: int = 0
    issues: int = 0
    activity: int = 0
    views: int = 0
    share_links: int = 0
    transitions: int = 0
    issue_links: int = 0

    def add(self, other: "Counts") -> None:
        """Fold another workspace's counts into this total."""
        for item in fields(self):
            setattr(self, item.name, getattr(self, item.name) + getattr(other, item.name))

    def render(self) -> str:
        """One `name=value` line, the only thing a run prints."""
        return " ".join(f"{item.name}={getattr(self, item.name)}" for item in fields(self))


@dataclass
class Plan:
    """One workspace's collapse: records to create, team copies to remove, and the id maps."""

    new_statuses: list[Any] = field(default_factory=list)
    new_labels: list[Any] = field(default_factory=list)
    removed_statuses: list[tuple[str, str]] = field(default_factory=list)
    removed_labels: list[tuple[str, str]] = field(default_factory=list)
    status_map: dict[str, str] = field(default_factory=dict)
    label_map: dict[str, str] = field(default_factory=dict)
    skipped: int = 0
    """Names left as team records in more than one team because their copies differ."""


def _status_match(row: Any) -> tuple[str, str, str]:
    """The fields two statuses must share to be the same record."""
    return (row.name, row.color or "", row.category)


def _label_match(row: Any) -> tuple[str, str]:
    """The fields two labels must share to be the same record."""
    return (row.name, row.color.lower())


def _grouped(
    rows_by_team: Mapping[str, Sequence[Any]], match: Callable[[Any], tuple[str, ...]]
) -> dict[Any, list[Any]]:
    """Team rows keyed by their match fields, in team id order."""
    groups: dict[Any, list[Any]] = {}
    for team_id in sorted(rows_by_team):
        for row in rows_by_team[team_id]:
            groups.setdefault(match(row), []).append(row)
    return groups


def _collapsible(group: list[Any], team_ids: set[str]) -> bool:
    """Whether a group is one copy in every live team, the only shape that becomes a new workspace record."""
    return len(group) == len(team_ids) and {row.team_id for row in group} == team_ids


def _split_names(leftover: Iterable[Any]) -> int:
    """How many names are left as team records in more than one team, the groups a mismatch kept apart."""
    teams_by_name: dict[str, set[str]] = {}
    for row in leftover:
        teams_by_name.setdefault(row.name.casefold(), set()).add(row.team_id)
    return sum(1 for team_ids in teams_by_name.values() if len(team_ids) > 1)


def plan_workspace(repositories: Any, workspace_id: str) -> Plan:
    """Work out one workspace's collapse without writing anything."""
    from app.common.db.dynamo.team_config import (
        TEAM_SCOPE,
        WORKSPACE_SCOPE,
        Label,
        Status,
        workspace_label_key,
        workspace_status_key,
    )

    plan = Plan()
    team_ids = set(repositories.teams.list_team_ids(workspace_id))
    if len(team_ids) < MIN_TEAMS:
        return plan
    config = repositories.team_config
    statuses = {
        team_id: [row for row in config.list_statuses(workspace_id, team_id) if row.scope == TEAM_SCOPE]
        for team_id in team_ids
    }
    labels = {
        team_id: [row for row in config.list_labels(workspace_id, team_id) if row.scope == TEAM_SCOPE]
        for team_id in team_ids
    }
    existing_statuses = {_status_match(row): row for row in config.list_workspace_statuses(workspace_id)}
    existing_status_names = {row.name.casefold() for row in existing_statuses.values()}
    leftover: list[Any] = []
    for key, group in _grouped(statuses, _status_match).items():
        target = existing_statuses.get(key)
        if target is None:
            if not _collapsible(group, team_ids) or key[0].casefold() in existing_status_names:
                leftover.extend(group)
                continue
            first = group[0]
            target = Status(
                workspace_id=workspace_id,
                config_key=workspace_status_key(first.status_id),
                status_id=first.status_id,
                name=first.name,
                category=first.category,
                position=min(row.position for row in group),
                color=first.color,
                icon=first.icon,
                scope=WORKSPACE_SCOPE,
            )
            plan.new_statuses.append(target)
        for row in group:
            plan.removed_statuses.append((row.team_id, row.status_id))
            if row.status_id != target.status_id:
                plan.status_map[row.status_id] = target.status_id
    plan.skipped += _split_names(leftover)
    leftover = []
    existing_labels = {_label_match(row): row for row in config.list_workspace_labels(workspace_id)}
    existing_label_names = {row.name.casefold() for row in existing_labels.values()}
    for key, group in _grouped(labels, _label_match).items():
        target = existing_labels.get(key)
        if target is None:
            if not _collapsible(group, team_ids) or key[0].casefold() in existing_label_names:
                leftover.extend(group)
                continue
            first = group[0]
            target = Label(
                workspace_id=workspace_id,
                config_key=workspace_label_key(first.label_id),
                label_id=first.label_id,
                name=first.name,
                color=first.color,
                scope=WORKSPACE_SCOPE,
            )
            plan.new_labels.append(target)
        for row in group:
            plan.removed_labels.append((row.team_id, row.label_id))
            if row.label_id != target.label_id:
                plan.label_map[row.label_id] = target.label_id
    plan.skipped += _split_names(leftover)
    return plan


def _mapped(value: Any, mapping: Mapping[str, str]) -> Any:
    """A status or label id, or a list of them, with each collapsed id swapped for its workspace id."""
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        out = [mapping.get(entry, entry) if isinstance(entry, str) else entry for entry in value]
        return list(dict.fromkeys(out)) if all(isinstance(entry, str) for entry in out) else out
    return value


def _mapped_filter(value: Mapping[str, Any], plan: Plan) -> dict[str, Any]:
    """A saved or shared filter with its status and label ids rewritten."""
    out = dict(value)
    for key in STATUS_FILTER_KEYS:
        if key in out:
            out[key] = _mapped(out[key], plan.status_map)
    for key in LABEL_FILTER_KEYS:
        if key in out:
            out[key] = _mapped(out[key], plan.label_map)
    return out


def _raw(spec_name: str) -> Any:
    """The package repository over one product table in this environment."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return build_repository(getattr(tables, spec_name))


def _rewrite_issues(repositories: Any, workspace_id: str, plan: Plan, counts: Counts, dry_run: bool) -> list[str]:
    """Point every issue of the workspace, archived ones too, at the workspace records; return every issue id."""
    from boto3.dynamodb.conditions import Key

    from app.common.db.dynamo.issues import as_issue

    issue_ids: list[str] = []
    for item in _raw("ISSUES").iter_query(Key("workspace_id").eq(workspace_id)):
        issue = as_issue(item)
        issue_ids.append(issue.issue_id)
        status_id = plan.status_map.get(issue.status_id, issue.status_id)
        label_ids = _mapped(list(issue.label_ids), plan.label_map)
        if status_id == issue.status_id and label_ids == issue.label_ids:
            continue
        counts.issues += 1
        if not dry_run:
            repositories.issues.replace(issue.model_copy(update={"status_id": status_id, "label_ids": label_ids}))
    return issue_ids


def _rewrite_activity(workspace_id: str, issue_ids: Iterable[str], plan: Plan, counts: Counts, dry_run: bool) -> None:
    """Rewrite the from and to ids of status and label history rows."""
    from boto3.dynamodb.conditions import Key

    from app.common.db.dynamo.activity import ws_issue

    maps = {"status_id": plan.status_map, "label_ids": plan.label_map}
    activity = _raw("ACTIVITY")
    for issue_id in issue_ids:
        for item in activity.iter_query(Key("ws_issue").eq(ws_issue(workspace_id, issue_id))):
            mapping = maps.get(str(item.get("field") or ""))
            if not mapping:
                continue
            before = {"from_value": item.get("from_value"), "to_value": item.get("to_value")}
            after = {name: _mapped(value, mapping) for name, value in before.items()}
            if after == before:
                continue
            counts.activity += 1
            if not dry_run:
                activity.set_attributes({"ws_issue": item["ws_issue"], "activity_id": item["activity_id"]}, after)


def _rewrite_issue_links(
    workspace_id: str, issue_ids: Iterable[str], plan: Plan, counts: Counts, dry_run: bool
) -> None:
    """Rewrite the status a pull request link last applied."""
    from boto3.dynamodb.conditions import Key

    from app.common.db.dynamo.github import LINK_INDEX, ws_issue

    github = _raw("GITHUB")
    for issue_id in issue_ids:
        for item in github.iter_query(Key("ws_issue").eq(ws_issue(workspace_id, issue_id)), index_name=LINK_INDEX):
            applied = item.get("applied_status_id")
            if not isinstance(applied, str) or applied not in plan.status_map:
                continue
            counts.issue_links += 1
            if not dry_run:
                github.set_attributes(
                    {"workspace_id": item["workspace_id"], "github_key": item["github_key"]},
                    {"applied_status_id": plan.status_map[applied]},
                )


def _rewrite_views(workspace_id: str, plan: Plan, counts: Counts, dry_run: bool) -> None:
    """Rewrite saved view filters, list and board alike."""
    from boto3.dynamodb.conditions import Key

    views = _raw("VIEWS")
    for item in views.iter_query(Key("workspace_id").eq(workspace_id)):
        current = item.get("filter")
        if not isinstance(current, Mapping):
            continue
        rewritten = _mapped_filter(current, plan)
        if rewritten == dict(current):
            continue
        counts.views += 1
        if not dry_run:
            views.set_attributes({"workspace_id": workspace_id, "view_key": item["view_key"]}, {"filter": rewritten})


def _rewrite_share_links(repositories: Any, workspace_id: str, plan: Plan, counts: Counts, dry_run: bool) -> None:
    """Rewrite the filter a `filter` share link snapshotted."""
    from app.common.db.dynamo.share_links import CAPABILITY_FILTER

    for record in repositories.share_links.list_for_tenant(workspace_id):
        current = record.capability.get(CAPABILITY_FILTER)
        if not isinstance(current, Mapping):
            continue
        rewritten = _mapped_filter(current, plan)
        if rewritten == dict(current):
            continue
        counts.share_links += 1
        if not dry_run:
            repositories.share_links.put(
                replace(record, capability={**record.capability, CAPABILITY_FILTER: rewritten})
            )


def _rewrite_transitions(repositories: Any, workspace_id: str, plan: Plan, counts: Counts, dry_run: bool) -> None:
    """Rewrite the status each GitHub transition rule moves an issue to."""
    for team_id in repositories.teams.list_team_ids(workspace_id):
        for rule in repositories.team_config.list_transitions(workspace_id, team_id):
            if rule.status_id not in plan.status_map:
                continue
            counts.transitions += 1
            if not dry_run:
                repositories.team_config.update_transition(
                    workspace_id, team_id, rule.transition_id, status_id=plan.status_map[rule.status_id]
                )


def collapse_workspace(repositories: Any, workspace_id: str, *, dry_run: bool = False) -> Counts:
    """Collapse one workspace, or only count what that would do under `dry_run`."""
    from webbpulse.dynamodb import ConditionFailed

    counts = Counts()
    plan = plan_workspace(repositories, workspace_id)
    counts.skipped_groups = plan.skipped
    if not plan.removed_statuses and not plan.removed_labels:
        return counts
    counts.workspaces = 1
    counts.workspace_statuses = len(plan.new_statuses)
    counts.workspace_labels = len(plan.new_labels)
    counts.team_statuses_removed = len(plan.removed_statuses)
    counts.team_labels_removed = len(plan.removed_labels)
    if not dry_run:
        for status in plan.new_statuses:
            try:
                repositories.team_config.create_status(status)
            except ConditionFailed:
                pass
        for label in plan.new_labels:
            try:
                repositories.team_config.create_label(label)
            except ConditionFailed:
                pass
    issue_ids = _rewrite_issues(repositories, workspace_id, plan, counts, dry_run)
    _rewrite_activity(workspace_id, issue_ids, plan, counts, dry_run)
    _rewrite_issue_links(workspace_id, issue_ids, plan, counts, dry_run)
    _rewrite_views(workspace_id, plan, counts, dry_run)
    _rewrite_share_links(repositories, workspace_id, plan, counts, dry_run)
    _rewrite_transitions(repositories, workspace_id, plan, counts, dry_run)
    if not dry_run:
        for team_id, status_id in plan.removed_statuses:
            repositories.team_config.delete_status(workspace_id, team_id, status_id)
        for team_id, label_id in plan.removed_labels:
            repositories.team_config.delete_label(workspace_id, team_id, label_id)
    return counts


def workspace_ids() -> list[str]:
    """Every workspace in this environment, read by a scan of the workspaces table."""
    items = _raw("WORKSPACES").iter_scan()
    return sorted(str(item["id"]) for item in items)


def run(repositories: Any, workspaces: Sequence[str], *, dry_run: bool) -> Counts:
    """Collapse each named workspace, returning the summed counts."""
    total = Counts()
    for workspace_id in workspaces:
        total.add(collapse_workspace(repositories, workspace_id, dry_run=dry_run))
    return total


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Parse the flags, bind the stage's tables and run."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--stage", required=True, help="The environment whose tables to read, such as staging")
    parser.add_argument("--workspace", action="append", default=[], help="Limit the run to this workspace id")
    parser.add_argument("--dry-run", action="store_true", help="Count what would change and write nothing")
    arguments = parser.parse_args(argv)
    os.environ["DYNAMODB_TABLE_PREFIX"] = f"standupless-{arguments.stage}"
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="collapse-workspace-workflow")
    workspaces = arguments.workspace or workspace_ids()
    counts = run(repositories, workspaces, dry_run=arguments.dry_run)
    print(("dry-run " if arguments.dry_run else "") + counts.render())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
