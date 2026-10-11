"""Issue templates: their reads and writes, and filling a new issue from one.

Held in `common` because the template routes live in the teams domain while the
issues domain applies a template on create, and the MCP tools in the
integrations image do both. A team offers its own templates, its parent team's
when the caller can see the parent, and the workspace's. A template is held
strictly to the rows it names when it is saved, and applied leniently: a status,
label or person removed since is dropped rather than failing the create, because
a template outlives the rows it names.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import IssueCreate
from app.common.api.schemas.templates import TemplateCreate, TemplateSettingsUpdate, TemplateUpdate
from app.common.db.dynamo.team_config import new_config_id
from app.common.db.dynamo.team_templates import (
    TEMPLATE_FIELDS,
    IssueTemplate,
    TemplateSettings,
    template_key,
    template_settings_key,
)
from app.common.db.dynamo.teams import Team
from app.common.issue_rules import (
    check_assignee,
    check_cycle,
    check_estimate,
    check_labels,
    check_project,
    check_project_milestone,
    check_status,
    not_found,
    require_team_admin,
    require_team_member,
    require_team_reader,
    unprocessable,
)

LIST_FIELDS: tuple[str, ...] = ("label_ids",)
"""The template fields a null clears to empty rather than to `None`."""


def conflict(message: str) -> HTTPException:
    """A 409 carrying the product's error envelope."""
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"error_code": "CONFLICT", "message": message})


def _team(repositories: Repositories, workspace_id: str, team_id: str) -> Team:
    """One team row, or a 404."""
    team = repositories.teams.get(workspace_id, team_id)
    if team is None:
        raise not_found()
    return team


def visible_parent_id(repositories: Repositories, context: AuthzContext, team_id: str) -> Optional[str]:
    """The parent team whose templates one team offers this caller, or `None`.

    A private parent the caller is outside offers nothing, so a sub-team member
    never reads a template of a team they cannot open.
    """
    parent_id = repositories.team_config.get_parent_id(context.workspace_id, team_id)
    if parent_id is None or not context.can_see_team(parent_id):
        return None
    return parent_id


def team_templates(repositories: Repositories, context: AuthzContext, team_id: str) -> list[IssueTemplate]:
    """Every template one team offers the caller: its own, its parent's, then the workspace's."""
    require_team_reader(repositories, context, team_id)
    workspace_id = context.workspace_id
    rows = repositories.team_config.list_team_templates(workspace_id, team_id)
    parent_id = visible_parent_id(repositories, context, team_id)
    if parent_id is not None:
        rows += repositories.team_config.list_team_templates(workspace_id, parent_id)
    return rows + repositories.team_config.list_workspace_templates(workspace_id)


def effective_default(
    repositories: Repositories, context: AuthzContext, team_id: str, offered: list[IssueTemplate]
) -> Optional[str]:
    """The template one team's create dialog opens with: its own default, else its parent's.

    A default naming a template since deleted, or one this caller is not offered,
    reads as none, so the answer is always one of `offered`.
    """
    ids = {row.template_id for row in offered}
    candidates = [team_id]
    parent_id = visible_parent_id(repositories, context, team_id)
    if parent_id is not None:
        candidates.append(parent_id)
    for candidate in candidates:
        settings = repositories.team_config.get_template_settings(context.workspace_id, candidate)
        if settings is not None and settings.default_template_id:
            return settings.default_template_id if settings.default_template_id in ids else None
    return None


def list_team_templates(
    repositories: Repositories, context: AuthzContext, team_id: str
) -> tuple[list[IssueTemplate], Optional[str]]:
    """Every template one team offers the caller, and the one its dialog opens with."""
    rows = team_templates(repositories, context, team_id)
    return rows, effective_default(repositories, context, team_id, rows)


def list_workspace_templates(repositories: Repositories, context: AuthzContext) -> list[IssueTemplate]:
    """Every workspace template, which every team offers."""
    return repositories.team_config.list_workspace_templates(context.workspace_id)


def _check_workspace_labels(repositories: Repositories, workspace_id: str, label_ids: list[str]) -> list[str]:
    """Hold labels to the workspace's own, never a group and one per group, or raise a 422."""
    groups: set[str] = set()
    for label_id in label_ids:
        row = repositories.team_config.get_workspace_label(workspace_id, label_id)
        if row is None:
            raise unprocessable(f"No such workspace label: {label_id}")
        if row.is_group:
            raise unprocessable(f"{row.name} is a label group. Choose one of its labels instead.")
        if row.parent_id:
            if row.parent_id in groups:
                raise unprocessable("A template can carry one label from each group.")
            groups.add(row.parent_id)
    return label_ids


def _check_team_fields(
    repositories: Repositories, workspace_id: str, team: Team, fields: dict[str, Any], merged: IssueTemplate
) -> dict[str, Any]:
    """Hold the fields a team template saves to the rows that team sees, or raise a 422."""
    team_id = team.team_id
    checked = dict(fields)
    if checked.get("status_id"):
        check_status(repositories, workspace_id, team_id, checked["status_id"])
    if checked.get("label_ids"):
        checked["label_ids"] = check_labels(repositories, workspace_id, team_id, checked["label_ids"])
    if "estimate" in checked:
        checked["estimate"] = check_estimate(checked["estimate"], team)
    if checked.get("assignee_id"):
        check_assignee(repositories, workspace_id, team_id, checked["assignee_id"])
    if checked.get("cycle_id"):
        check_cycle(repositories, workspace_id, team_id, checked["cycle_id"])
    if checked.get("project_id"):
        check_project(repositories, workspace_id, team_id, checked["project_id"])
    return _check_milestone(repositories, workspace_id, checked, merged)


def _check_milestone(
    repositories: Repositories, workspace_id: str, checked: dict[str, Any], merged: IssueTemplate
) -> dict[str, Any]:
    """Hold a milestone sent to the template's project, and drop a kept one a new project leaves behind."""
    if "project_milestone_id" in checked:
        checked["project_milestone_id"] = check_project_milestone(
            repositories, workspace_id, merged.project_id, merged.project_milestone_id
        )
    elif "project_id" in checked and merged.project_milestone_id:
        checked["project_milestone_id"] = _lenient(
            check_project_milestone, repositories, workspace_id, merged.project_id, merged.project_milestone_id
        )
    return checked


def _check_workspace_fields(
    repositories: Repositories, workspace_id: str, fields: dict[str, Any], merged: IssueTemplate
) -> dict[str, Any]:
    """Hold the fields a workspace template saves to workspace rows, or raise a 422.

    A cycle belongs to one team, so a template every team offers cannot name one.
    An estimate is held to each team's scale only when it is applied.
    """
    checked = dict(fields)
    if checked.get("cycle_id"):
        raise unprocessable("A cycle belongs to one team, so a workspace template cannot set one")
    if (
        checked.get("status_id")
        and repositories.team_config.get_workspace_status(workspace_id, checked["status_id"]) is None
    ):
        raise unprocessable(f"No such workspace status: {checked['status_id']}")
    if checked.get("label_ids"):
        checked["label_ids"] = _check_workspace_labels(repositories, workspace_id, checked["label_ids"])
    if "estimate" in checked:
        checked["estimate"] = (checked["estimate"] or "").strip() or None
    if checked.get("assignee_id") and repositories.memberships.get(workspace_id, checked["assignee_id"]) is None:
        raise unprocessable("The assignee is not a member of this workspace")
    if checked.get("project_id") and repositories.planning.get_project(workspace_id, checked["project_id"]) is None:
        raise unprocessable(f"No such project: {checked['project_id']}")
    return _check_milestone(repositories, workspace_id, checked, merged)


def _check_fields(
    repositories: Repositories, workspace_id: str, team: Optional[Team], fields: dict[str, Any], merged: IssueTemplate
) -> dict[str, Any]:
    """Hold a template's fields to its team's rows, or the workspace's when it has no team."""
    if team is None:
        return _check_workspace_fields(repositories, workspace_id, fields, merged)
    return _check_team_fields(repositories, workspace_id, team, fields, merged)


def _next_position(repositories: Repositories, workspace_id: str, team_id: Optional[str]) -> int:
    """The position after a scope's last template, so a new one lands at the end."""
    if team_id:
        rows = repositories.team_config.list_team_templates(workspace_id, team_id)
    else:
        rows = repositories.team_config.list_workspace_templates(workspace_id)
    return max((row.position for row in rows), default=-1) + 1


def _create(
    repositories: Repositories, context: AuthzContext, team: Optional[Team], payload: TemplateCreate
) -> IssueTemplate:
    """Save a new template on a team, or on the workspace when `team` is `None`."""
    workspace_id = context.workspace_id
    team_id = team.team_id if team is not None else None
    template_id = new_config_id()
    fields = payload.model_dump(exclude_unset=True)
    draft = IssueTemplate.model_validate(
        {
            **payload.model_dump(exclude={"position"}),
            "workspace_id": workspace_id,
            "config_key": template_key(team_id, template_id),
            "template_id": template_id,
            "team_id": team_id,
            "position": payload.position
            if payload.position is not None
            else _next_position(repositories, workspace_id, team_id),
            "created_by": context.user_id,
        }
    )
    checked = _check_fields(repositories, workspace_id, team, fields, draft)
    template = draft.model_copy(update={name: checked[name] for name in TEMPLATE_FIELDS if name in checked})
    try:
        return repositories.team_config.create_template(template)
    except ConditionFailed as exc:
        raise conflict("That template already exists") from exc


def _update(
    repositories: Repositories,
    context: AuthzContext,
    team: Optional[Team],
    template_id: str,
    payload: TemplateUpdate,
) -> IssueTemplate:
    """Patch one template: only the fields sent change, and null clears one."""
    workspace_id = context.workspace_id
    team_id = team.team_id if team is not None else None
    existing = repositories.team_config.get_template(workspace_id, team_id, template_id)
    if existing is None:
        raise not_found()
    fields = payload.model_dump(exclude_unset=True)
    for name in ("name", "position"):
        if name in fields and fields[name] is None:
            raise unprocessable(f"{name} must not be null")
    for name in LIST_FIELDS:
        if name in fields and fields[name] is None:
            fields[name] = []
    merged = existing.model_copy(update=fields)
    checked = _check_fields(repositories, workspace_id, team, fields, merged)
    stored = repositories.team_config.replace_template(existing.model_copy(update=checked))
    if stored is None:
        raise not_found()
    return stored


def create_team_template(
    repositories: Repositories, context: AuthzContext, team_id: str, payload: TemplateCreate
) -> IssueTemplate:
    """Save a new template on one team the caller may write in."""
    require_team_member(repositories, context, team_id)
    return _create(repositories, context, _team(repositories, context.workspace_id, team_id), payload)


def update_team_template(
    repositories: Repositories, context: AuthzContext, team_id: str, template_id: str, payload: TemplateUpdate
) -> IssueTemplate:
    """Patch one template of a team the caller may write in."""
    require_team_member(repositories, context, team_id)
    return _update(repositories, context, _team(repositories, context.workspace_id, team_id), template_id, payload)


def delete_team_template(repositories: Repositories, context: AuthzContext, team_id: str, template_id: str) -> None:
    """Delete one template of a team the caller may write in, or 404."""
    require_team_member(repositories, context, team_id)
    if not repositories.team_config.delete_template(context.workspace_id, team_id, template_id):
        raise not_found()


def create_workspace_template(
    repositories: Repositories, context: AuthzContext, payload: TemplateCreate
) -> IssueTemplate:
    """Save a new workspace template; the caller's admin role is the route's check."""
    return _create(repositories, context, None, payload)


def update_workspace_template(
    repositories: Repositories, context: AuthzContext, template_id: str, payload: TemplateUpdate
) -> IssueTemplate:
    """Patch one workspace template; the caller's admin role is the route's check."""
    return _update(repositories, context, None, template_id, payload)


def delete_workspace_template(repositories: Repositories, context: AuthzContext, template_id: str) -> None:
    """Delete one workspace template, or 404."""
    if not repositories.team_config.delete_template(context.workspace_id, None, template_id):
        raise not_found()


def template_settings(
    repositories: Repositories, context: AuthzContext, team_id: str
) -> tuple[TemplateSettings, Optional[str]]:
    """One team's saved template settings and the default its dialog opens with."""
    _, effective = list_team_templates(repositories, context, team_id)
    stored = repositories.team_config.get_template_settings(context.workspace_id, team_id)
    if stored is None:
        stored = TemplateSettings(
            workspace_id=context.workspace_id, config_key=template_settings_key(team_id), team_id=team_id
        )
    return stored, effective


def update_template_settings(
    repositories: Repositories, context: AuthzContext, team_id: str, payload: TemplateSettingsUpdate
) -> tuple[TemplateSettings, Optional[str]]:
    """Set or clear one team's default template, held to team admin and to a template the team offers."""
    require_team_admin(repositories, context, team_id)
    wanted = (payload.default_template_id or "").strip() or None
    if wanted is not None:
        offered = {row.template_id for row in team_templates(repositories, context, team_id)}
        if wanted not in offered:
            raise unprocessable(f"No such template: {wanted}")
    stored = repositories.team_config.put_template_settings(
        TemplateSettings(
            workspace_id=context.workspace_id,
            config_key=template_settings_key(team_id),
            team_id=team_id,
            default_template_id=wanted,
        )
    )
    rows = team_templates(repositories, context, team_id)
    return stored, effective_default(repositories, context, team_id, rows)


def find_template(
    repositories: Repositories, context: AuthzContext, team_id: str, template_id: str
) -> Optional[IssueTemplate]:
    """One template a team offers the caller, its own, its parent's or the workspace's, or `None`."""
    workspace_id = context.workspace_id
    own = repositories.team_config.get_template(workspace_id, team_id, template_id)
    if own is not None:
        return own
    parent_id = visible_parent_id(repositories, context, team_id)
    if parent_id is not None:
        inherited = repositories.team_config.get_template(workspace_id, parent_id, template_id)
        if inherited is not None:
            return inherited
    return repositories.team_config.get_template(workspace_id, None, template_id)


def _lenient(check: Callable[..., Any], *args: Any) -> Any:
    """The value a strict check answers, or `None` when it refuses."""
    try:
        return check(*args)
    except HTTPException:
        return None


def _kept_labels(repositories: Repositories, workspace_id: str, team_id: str, label_ids: list[str]) -> list[str]:
    """The template's labels the team still accepts together, in order."""
    kept: list[str] = []
    for label_id in label_ids:
        if _lenient(check_labels, repositories, workspace_id, team_id, [*kept, label_id]) is not None:
            kept.append(label_id)
    return kept


def template_values(
    repositories: Repositories, workspace_id: str, team: Team, template: IssueTemplate
) -> dict[str, Any]:
    """The issue fields a template fills in one team, with anything that team no longer accepts dropped."""
    team_id = team.team_id
    values: dict[str, Any] = {}
    if template.title:
        values["title"] = template.title
    if template.body is not None:
        values["body"] = template.body
    if template.priority:
        values["priority"] = template.priority
    if template.status_id and _lenient(check_status, repositories, workspace_id, team_id, template.status_id):
        values["status_id"] = template.status_id
    if template.label_ids:
        values["label_ids"] = _kept_labels(repositories, workspace_id, team_id, template.label_ids)
    if template.assignee_id:
        values["assignee_id"] = _lenient(check_assignee, repositories, workspace_id, team_id, template.assignee_id)
    if template.estimate:
        values["estimate"] = _lenient(check_estimate, template.estimate, team)
    if template.cycle_id:
        values["cycle_id"] = _lenient(check_cycle, repositories, workspace_id, team_id, template.cycle_id)
    if template.project_id:
        project_id = _lenient(check_project, repositories, workspace_id, team_id, template.project_id)
        values["project_id"] = project_id
        if project_id and template.project_milestone_id:
            values["project_milestone_id"] = _lenient(
                check_project_milestone, repositories, workspace_id, project_id, template.project_milestone_id
            )
    return {name: value for name, value in values.items() if value is not None}


def apply_template(repositories: Repositories, context: AuthzContext, payload: IssueCreate) -> IssueCreate:
    """The create filled from its template wherever it left a field unset.

    A create without `template_id` passes through untouched. A template the
    team does not offer the caller is a 422 naming it, and a create still without
    a title once the template is applied is a 422 too.
    """
    if payload.template_id:
        team = _team(repositories, context.workspace_id, payload.team_id)
        template = find_template(repositories, context, payload.team_id, payload.template_id)
        if template is None:
            raise unprocessable(f"No such template: {payload.template_id}")
        values = template_values(repositories, context.workspace_id, team, template)
        given = {name for name in payload.model_fields_set if name != "title"}
        filled = {name: value for name, value in values.items() if name not in given}
        if payload.title:
            filled.pop("title", None)
        payload = payload.model_copy(update=filled)
    if not payload.title:
        raise unprocessable("title must not be blank")
    return payload
