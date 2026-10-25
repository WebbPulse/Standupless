"""Copy a team's settings onto a team being created, as Linear's "Copy settings from an existing team" does.

The new team starts with the source's workflow statuses in their order and
categories, its labels and label groups, its issue, project and document
templates with their sub-issues and the template defaults, its pull request
status rules, its estimate scale, and its cycle, triage, SLA, auto-archive,
auto-close, parent and sub-issue auto-close and display settings. Members,
issues, cycles, projects, the GitHub repository link and webhooks stay behind.

A source's own rows and the rows it takes from a parent become the new team's
own rows under fresh ids, and every copied reference to one is rewritten to the
new id. What it hides or renames of the workspace statuses and labels, which
every team inherits live, is copied as the new team's own override. A reference
to a cycle, project or milestone is dropped, since those are not copied, and
triage duty starts empty because only the creator is a member.

The list rows are written before the create's transaction, under the new team
id, so the per-team settings rows can ride in the transaction with the team row
and the transaction stays well under its item limit. `discard` removes the list
rows again when the create fails, so a failure leaves no half-made team.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.team_config import (
    STATUS_CATEGORIES,
    TEAM_SCOPE,
    WORKSPACE_SCOPE,
    Label,
    Override,
    Status,
    Transition,
    archive_settings_key,
    auto_close_settings_key,
    cycle_settings_key,
    display_defaults_key,
    label_key,
    new_config_id,
    override_key,
    parent_auto_close_settings_key,
    sla_settings_key,
    status_key,
    transition_key,
    triage_settings_key,
)
from app.common.db.dynamo.team_templates import (
    IssueBlueprint,
    IssueTemplate,
    template_key,
    template_settings_key,
)
from app.common.db.dynamo.teams import Team

ESTIMATE_FIELDS: tuple[str, ...] = (
    "estimate_scale",
    "estimate_extended",
    "estimate_allow_zero",
    "estimate_count_unestimated",
)
"""The team row fields a copy takes from the source."""

TEMPLATE_KINDS: tuple[str, ...] = ("issue_template", "project_template", "document_template")
"""Every kind of team template a copy carries."""


@dataclass
class TeamCopy:
    """What creating a team from another team's settings writes.

    `rows` are written before the create's transaction and `settings` ride in
    it. `categories` are the status categories the copied workflow covers, so
    the create seeds defaults only for the rest. `estimates` go on the team row.
    """

    workspace_id: str
    team_id: str
    estimates: dict[str, Any]
    statuses: list[Status] = field(default_factory=list)
    labels: list[Label] = field(default_factory=list)
    overrides: list[Override] = field(default_factory=list)
    transitions: list[Transition] = field(default_factory=list)
    templates: list[IssueTemplate] = field(default_factory=list)
    settings: list[Any] = field(default_factory=list)
    categories: set[str] = field(default_factory=set)

    def missing_categories(self) -> list[str]:
        """The status categories the copied workflow leaves uncovered."""
        return [category for category in STATUS_CATEGORIES if category not in self.categories]


def plan(repositories: Repositories, source: Team, team_id: str, user_id: str) -> TeamCopy:
    """Read the source team's settings and build the rows that give `team_id` the same setup."""
    config = repositories.team_config
    workspace_id = source.workspace_id
    copy = TeamCopy(
        workspace_id=workspace_id,
        team_id=team_id,
        estimates={name: getattr(source, name) for name in ESTIMATE_FIELDS},
    )
    status_ids = _copy_statuses(copy, config.list_statuses(workspace_id, source.team_id))
    label_ids = _copy_labels(copy, config.list_labels(workspace_id, source.team_id))
    template_ids = _copy_templates(copy, repositories, source.team_id, status_ids, label_ids)
    _copy_transitions(copy, config.list_transitions(workspace_id, source.team_id), status_ids)
    _copy_settings(copy, repositories, source.team_id, user_id, status_ids, label_ids, template_ids)
    return copy


def write_rows(repositories: Repositories, copy: TeamCopy) -> None:
    """Write the copied statuses, labels, overrides, rules and templates ahead of the create."""
    repositories.team_config.put_copied_rows(
        statuses=copy.statuses,
        labels=copy.labels,
        overrides=copy.overrides,
        transitions=copy.transitions,
        templates=copy.templates,
    )


def settings_actions(repositories: Repositories, copy: TeamCopy) -> list[dict[str, Any]]:
    """The transaction Puts of the copied per-team settings rows."""
    return [repositories.team_config.copied_settings_action(row) for row in copy.settings]


def discard(repositories: Repositories, copy: TeamCopy) -> None:
    """Remove every row a failed create wrote for the copy."""
    repositories.team_config.delete_for_team(copy.workspace_id, copy.team_id)


def _copy_statuses(copy: TeamCopy, rows: list[Status]) -> dict[str, str]:
    """Copy the source's own and parent statuses and its workspace status overrides, answering the id map."""
    mapping: dict[str, str] = {}
    for row in rows:
        if row.scope == WORKSPACE_SCOPE:
            if row.hidden or row.inherited_name:
                copy.overrides.append(
                    _override(copy, "status", row.status_id, row.hidden, row.inherited_name, row.name)
                )
            if not row.hidden:
                copy.categories.add(row.category)
            continue
        if row.hidden:
            continue
        status_id = new_config_id()
        mapping[row.status_id] = status_id
        copy.categories.add(row.category)
        copy.statuses.append(
            row.model_copy(
                update={
                    "config_key": status_key(copy.team_id, status_id),
                    "team_id": copy.team_id,
                    "status_id": status_id,
                    "scope": TEAM_SCOPE,
                    "hidden": False,
                    "inherited_name": None,
                }
            )
        )
    return mapping


def _copy_labels(copy: TeamCopy, rows: list[Label]) -> dict[str, str]:
    """Copy the source's own and parent labels and groups and its workspace label overrides, answering the id map."""
    mapping: dict[str, str] = {}
    for row in rows:
        if row.scope == WORKSPACE_SCOPE:
            if row.hidden or row.inherited_name:
                copy.overrides.append(_override(copy, "label", row.label_id, row.hidden, row.inherited_name, row.name))
            continue
        if not row.hidden:
            mapping[row.label_id] = new_config_id()
    for row in rows:
        if row.label_id not in mapping or row.scope == WORKSPACE_SCOPE:
            continue
        label_id = mapping[row.label_id]
        copy.labels.append(
            row.model_copy(
                update={
                    "config_key": label_key(copy.team_id, label_id),
                    "team_id": copy.team_id,
                    "label_id": label_id,
                    "parent_id": mapping.get(row.parent_id) if row.parent_id else None,
                    "scope": TEAM_SCOPE,
                    "hidden": False,
                    "inherited_name": None,
                }
            )
        )
    return mapping


def _override(
    copy: TeamCopy, target: str, target_id: str, hidden: bool, inherited_name: str | None, name: str
) -> Override:
    """The new team's own override hiding or renaming one workspace row as the source does."""
    return Override(
        workspace_id=copy.workspace_id,
        config_key=override_key(copy.team_id, target, target_id),
        team_id=copy.team_id,
        target=target,
        target_id=target_id,
        hidden=hidden,
        name=name if inherited_name else None,
    )


def _remap(value: str | None, mapping: dict[str, str]) -> str | None:
    """A copied reference to a source row rewritten to the new team's row, any other kept as it is."""
    return mapping.get(value, value) if value else value


def _remap_all(values: list[str], mapping: dict[str, str]) -> list[str]:
    """Every reference in a list rewritten as `_remap` rewrites one."""
    return [mapping.get(value, value) for value in values]


def _blueprint(row: IssueBlueprint, status_ids: dict[str, str], label_ids: dict[str, str]) -> IssueBlueprint:
    """One template issue with its status and labels pointed at the new team's rows."""
    return row.model_copy(
        update={"status_id": _remap(row.status_id, status_ids), "label_ids": _remap_all(row.label_ids, label_ids)}
    )


def _copy_templates(
    copy: TeamCopy, repositories: Repositories, source_id: str, status_ids: dict[str, str], label_ids: dict[str, str]
) -> dict[str, str]:
    """Copy every template the source team keeps itself, answering the id map."""
    mapping: dict[str, str] = {}
    for kind in TEMPLATE_KINDS:
        for row in repositories.team_config.list_team_templates(copy.workspace_id, source_id, kind=kind):
            template_id = new_config_id()
            mapping[row.template_id] = template_id
            update: dict[str, Any] = {
                "config_key": template_key(copy.team_id, template_id),
                "template_id": template_id,
                "team_id": copy.team_id,
                "status_id": _remap(row.status_id, status_ids),
                "label_ids": _remap_all(row.label_ids, label_ids),
                "project_id": None,
                "project_milestone_id": None,
                "cycle_id": None,
                "sub_issues": [_blueprint(issue, status_ids, label_ids) for issue in row.sub_issues],
                "form_fields": [
                    field_row.model_copy(
                        update={
                            "options": [
                                option.model_copy(update={"label_id": _remap(option.label_id, label_ids)})
                                for option in field_row.options
                            ]
                        }
                    )
                    for field_row in row.form_fields
                ],
            }
            if row.project is not None:
                update["project"] = row.project.model_copy(
                    update={"issues": [_blueprint(issue, status_ids, label_ids) for issue in row.project.issues]}
                )
            copy.templates.append(row.model_copy(update=update))
    return mapping


def _copy_transitions(copy: TeamCopy, rows: list[Transition], status_ids: dict[str, str]) -> None:
    """Copy the source's pull request status rules onto the new team's statuses."""
    for row in rows:
        transition_id = new_config_id()
        copy.transitions.append(
            row.model_copy(
                update={
                    "config_key": transition_key(copy.team_id, transition_id),
                    "team_id": copy.team_id,
                    "transition_id": transition_id,
                    "status_id": _remap(row.status_id, status_ids) or row.status_id,
                }
            )
        )


def _copy_settings(
    copy: TeamCopy,
    repositories: Repositories,
    source_id: str,
    user_id: str,
    status_ids: dict[str, str],
    label_ids: dict[str, str],
    template_ids: dict[str, str],
) -> None:
    """Copy each per-team settings row the source saved, its references rewritten."""
    config = repositories.team_config
    workspace_id = copy.workspace_id
    team_id = copy.team_id
    own = {"team_id": team_id}
    cycles = config.get_cycle_settings(workspace_id, source_id)
    if cycles is not None:
        copy.settings.append(cycles.model_copy(update={**own, "config_key": cycle_settings_key(team_id)}))
    archive = config.get_archive_settings(workspace_id, source_id)
    if archive is not None:
        copy.settings.append(archive.model_copy(update={**own, "config_key": archive_settings_key(team_id)}))
    sla = config.get_sla_settings(workspace_id, source_id)
    if sla is not None:
        copy.settings.append(
            sla.model_copy(
                update={
                    **own,
                    "config_key": sla_settings_key(team_id),
                    "paused_status_ids": _remap_all(sla.paused_status_ids, status_ids),
                }
            )
        )
    auto_close = config.get_auto_close_settings(workspace_id, source_id)
    if auto_close is not None:
        copy.settings.append(
            auto_close.model_copy(
                update={
                    **own,
                    "config_key": auto_close_settings_key(team_id),
                    "status_id": _remap(auto_close.status_id, status_ids),
                }
            )
        )
    parent_close = config.get_parent_auto_close_settings(workspace_id, source_id)
    if parent_close is not None:
        copy.settings.append(
            parent_close.model_copy(update={**own, "config_key": parent_auto_close_settings_key(team_id)})
        )
    display = config.get_display_defaults(workspace_id, source_id)
    if display is not None:
        copy.settings.append(
            display.model_copy(update={**own, "config_key": display_defaults_key(team_id), "updated_by": user_id})
        )
    triage = config.get_triage_settings(workspace_id, source_id)
    if triage is not None:
        copy.settings.append(
            triage.model_copy(
                update={
                    **own,
                    "config_key": triage_settings_key(team_id),
                    "responsible_user_ids": [],
                    "rules": [_triage_rule(rule, label_ids) for rule in triage.rules],
                }
            )
        )
    templates = config.get_template_settings(workspace_id, source_id)
    if templates is not None:
        copy.settings.append(
            templates.model_copy(
                update={
                    **own,
                    "config_key": template_settings_key(team_id),
                    "default_template_id": _remap(templates.default_template_id, template_ids),
                    "default_project_template_id": _remap(templates.default_project_template_id, template_ids),
                    "default_document_template_id": _remap(templates.default_document_template_id, template_ids),
                    "default_update_template_id": _remap(templates.default_update_template_id, template_ids),
                }
            )
        )


def _triage_rule(rule: Any, label_ids: dict[str, str]) -> Any:
    """One triage rule with the labels it matches and adds pointed at the new team's labels."""
    return rule.model_copy(
        update={
            "filter": rule.filter.model_copy(update={"label_ids": _remap_all(rule.filter.label_ids, label_ids)}),
            "actions": rule.actions.model_copy(
                update={"add_label_ids": _remap_all(rule.actions.add_label_ids, label_ids)}
            ),
        }
    )
