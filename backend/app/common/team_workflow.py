"""Status and label writes: the workflow columns and tags a team's issues use.

Shared by the status and label routes and the MCP tools, because the integrations
image may not import another domain's code and a status or label an agent edits
must obey the same rules a team admin's does. The caller has already been held to
team admin for team writes and overrides, and to workspace admin for workspace
statuses and labels.

A workspace status or label is inherited by every team. A team route never edits
one: it answers 409 and the team changes it through its override, which hides it
or renames it in that team only.

As in Linear, a status with issues in it is never deleted or hidden out from
under them: a delete names a replacement the issues move to, and a hide waits
until the column is empty. A deleted label is stripped off the issues carrying it,
and a deleted label group leaves its children in place as plain labels.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.teams import LabelCreate, LabelUpdate, OverrideUpdate, StatusCreate, StatusUpdate
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import (
    STATUS_APPEARANCE_FIELDS,
    WORKSPACE_SCOPE,
    Label,
    Override,
    Status,
    new_config_id,
    override_key,
    status_key,
    workspace_label_key,
    workspace_status_key,
)
from app.common.issue_rules import unprocessable
from app.common.labels import GROUP_IN_GROUP, check_move_into_group, team_group, ungroup_children, workspace_group
from app.common.status_appearance import icon_fits

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

LAST_OF_CATEGORY = "{team} must keep one status in each category it uses"

LAST_VISIBLE = "{team} must keep one visible status in each category it uses"

STATUS_HAS_ISSUES = "{count} in this status. Choose a status to move them to."

HIDDEN_HAS_ISSUES = "{count} in this status in {team}. Move them to another status before hiding it."

REPLACEMENT_HIDDEN = "{team} hides the replacement status. Choose one every team with issues here can see."

INHERITED_STATUS = {
    "error_code": "CONFLICT",
    "message": "This status comes from the workspace. Change it in the workspace, or hide or rename it for the team.",
}

INHERITED_LABEL = {
    "error_code": "CONFLICT",
    "message": "This label comes from the workspace. Change it in the workspace, or hide or rename it for the team.",
}

NOT_INHERITED = {
    "error_code": "CONFLICT",
    "message": "Only a status or label inherited from the workspace can be hidden or renamed for a team.",
}


def _not_found() -> HTTPException:
    """The 404 every missing status, label or override answers."""
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def _conflict(detail: dict[str, Any]) -> HTTPException:
    """A 409 carrying one of the conflict envelopes above."""
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _category_conflict(
    repositories: Repositories, workspace_id: str, team_id: str, template: str, row: Status
) -> HTTPException:
    """A 409 naming the team a category guard protects, with its id and the category in `details`."""
    team = repositories.teams.get(workspace_id, team_id)
    name = f"The {team.name} team" if team is not None else "A team"
    return _conflict(
        {
            "error_code": "CONFLICT",
            "message": template.format(team=name),
            "details": {
                "team_id": team_id,
                "team_name": team.name if team is not None else None,
                "category": row.category,
            },
        }
    )


def _team_name(repositories: Repositories, workspace_id: str, team_id: str) -> str | None:
    """A team's display name, or None when it was deleted in between."""
    team = repositories.teams.get(workspace_id, team_id)
    return team.name if team is not None else None


def _issues_phrase(count: int) -> str:
    """A count of issues as a sentence subject."""
    return "1 issue is" if count == 1 else f"{count} issues are"


def _team_count(repositories: Repositories, workspace_id: str, team_id: str, count: int) -> dict[str, Any]:
    """One team's share of the issues a refusal counts."""
    return {"team_id": team_id, "team_name": _team_name(repositories, workspace_id, team_id), "issue_count": count}


def _has_issues(repositories: Repositories, workspace_id: str, moves: list[tuple[str, list[Issue]]]) -> HTTPException:
    """The 409 a delete answers when issues are in the status and no replacement was named."""
    total = sum(len(issues) for _, issues in moves)
    return _conflict(
        {
            "error_code": "CONFLICT",
            "message": STATUS_HAS_ISSUES.format(count=_issues_phrase(total)),
            "details": {
                "issue_count": total,
                "teams": [_team_count(repositories, workspace_id, team_id, len(issues)) for team_id, issues in moves],
            },
        }
    )


def _move_issues(
    repositories: Repositories, issues: list[Issue], status_id: str, actor_id: str, source: str | None = None
) -> None:
    """Put every issue in `status_id`, recording the move in each issue's history as a patch would."""
    now = utc_now()
    rows = []
    for issue in issues:
        repositories.issues.replace(
            issue.model_copy(
                update={"status_id": status_id, "updated_at": now, "updated_by": actor_id, "updated_source": source}
            )
        )
        rows.append(
            build_activity(
                issue.workspace_id,
                issue.team_id,
                issue.issue_id,
                actor_id,
                "field_changed",
                field="status_id",
                from_value=issue.status_id,
                to_value=status_id,
                source=source,
            )
        )
    repositories.activity.record_many(rows)


def _strip_label(repositories: Repositories, workspace_id: str, team_id: str, label_id: str) -> None:
    """Take a deleted label off every issue of one team carrying it, recording no history.

    Linear drops a deleted label from its issues silently, and a dangling id would
    otherwise make every later label patch that resends the list a 422.
    """
    for issue in repositories.issues.iter_with_label(workspace_id, team_id, label_id):
        kept = [other for other in issue.label_ids if other != label_id]
        repositories.issues.replace(issue.model_copy(update={"label_ids": kept}))


def ordered_statuses(
    repositories: Repositories, workspace_id: str, team_id: str, *, include_hidden: bool = False
) -> list[Status]:
    """Every effective status of one team in board order, hidden ones last and only when asked for."""
    rows = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=include_hidden)
    return sorted(rows, key=lambda row: (row.hidden, row.position, row.name))


def create_status(repositories: Repositories, workspace_id: str, team_id: str, payload: StatusCreate) -> Status:
    """Add a status, defaulting its position to the end of the list."""
    position = payload.position
    if position is None:
        existing = repositories.team_config.list_statuses(workspace_id, team_id)
        position = max((row.position for row in existing), default=-1) + 1

    status_id = new_config_id()
    return repositories.team_config.create_status(
        Status(
            workspace_id=workspace_id,
            config_key=status_key(team_id, status_id),
            team_id=team_id,
            status_id=status_id,
            name=payload.name,
            category=payload.category,
            position=position,
            color=payload.color,
            icon=payload.icon,
        )
    )


def update_status(
    repositories: Repositories, workspace_id: str, team_id: str, status_id: str, payload: StatusUpdate
) -> Status:
    """Rename, recategorise, recolor or move a status, or 404.

    An explicit null color or icon removes it so the status falls back to its
    category default. An icon from another category is a 422. Moving a status to
    a category its stored icon does not fit drops that icon rather than refusing
    the move, because the admin asked for the category, not about the icon.
    """
    given = payload.model_dump(exclude_unset=True)
    attributes = {name: value for name, value in given.items() if value is not None}
    clear = [name for name in STATUS_APPEARANCE_FIELDS if name in given and given[name] is None]

    existing = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if existing is None:
        raise _not_found()
    if existing.scope == WORKSPACE_SCOPE:
        raise _conflict(INHERITED_STATUS)
    _fit_icon(existing, attributes, clear)
    if not attributes and not clear:
        return existing
    updated = repositories.team_config.update_status(workspace_id, team_id, status_id, clear=clear, **attributes)
    if updated is None:
        raise _not_found()
    return updated


def _fit_icon(existing: Status, attributes: dict[str, Any], clear: list[str]) -> None:
    """Refuse an icon from another category, and drop a stored icon a category move no longer fits."""
    category = attributes.get("category", existing.category)
    icon = attributes.get("icon")
    if icon is not None and not icon_fits(category, icon):
        raise unprocessable(f"icon {icon} does not fit the {category} category")
    if icon is None and "icon" not in clear and not icon_fits(category, existing.icon):
        clear.append("icon")


def delete_status(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    status_id: str,
    *,
    actor_id: str,
    source: str | None = None,
    replacement_status_id: str | None = None,
) -> None:
    """Delete a team status, moving its issues to `replacement_status_id`.

    The board renders a column per category, so removing the last visible status
    of one is a 409. A status still holding issues, archived ones included, is a
    409 counting them unless a replacement is named, as Linear asks where they
    go. The replacement must be another status the team can see, or it is a 422.
    An inherited status is a 409: the team hides it.
    """
    existing = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if existing is None:
        raise _not_found()
    if existing.scope == WORKSPACE_SCOPE:
        raise _conflict(INHERITED_STATUS)
    if replacement_status_id is not None:
        if replacement_status_id == status_id:
            raise unprocessable("replacement_status_id must be a different status")
        target = repositories.team_config.get_status(workspace_id, team_id, replacement_status_id)
        if target is None:
            raise unprocessable(f"No such status: {replacement_status_id}")
        if target.hidden:
            raise unprocessable("replacement_status_id must be a status the team can see")
    if not _visible_siblings(repositories, workspace_id, team_id, existing):
        raise _category_conflict(repositories, workspace_id, team_id, LAST_OF_CATEGORY, existing)
    issues = repositories.issues.iter_for_status(workspace_id, team_id, status_id, include_archived=True)
    if issues and replacement_status_id is None:
        raise _has_issues(repositories, workspace_id, [(team_id, issues)])
    if replacement_status_id is not None:
        _move_issues(repositories, issues, replacement_status_id, actor_id, source)
    repositories.team_config.delete_status(workspace_id, team_id, status_id)


def _visible_siblings(repositories: Repositories, workspace_id: str, team_id: str, row: Status) -> list[Status]:
    """The team's other visible statuses in the same category as `row`."""
    return [
        other
        for other in repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
        if other.category == row.category and other.status_id != row.status_id
    ]


def update_label(
    repositories: Repositories, workspace_id: str, team_id: str, label_id: str, payload: LabelUpdate
) -> Label:
    """Rename, recolour, group or ungroup a team label, or 404, or 409 for an inherited one."""
    existing = repositories.team_config.get_label(workspace_id, team_id, label_id)
    if existing is None:
        raise _not_found()
    if existing.scope == WORKSPACE_SCOPE:
        raise _conflict(INHERITED_LABEL)
    attributes, clear = _label_patch(payload, existing)
    if "parent_id" in attributes:
        group = team_group(repositories, workspace_id, team_id, attributes["parent_id"])
        check_move_into_group(repositories, workspace_id, [team_id], existing, group)
    if not attributes and not clear:
        return existing
    updated = repositories.team_config.update_label(workspace_id, team_id, label_id, clear=clear, **attributes)
    if updated is None:
        raise _not_found()
    return updated


def _label_patch(payload: LabelUpdate, existing: Label) -> tuple[dict[str, Any], list[str]]:
    """The attributes a label patch sets and the ones it removes, a null `parent_id` ungrouping the label.

    A move into the group the label is already in is no change, and a group is
    refused a parent with a 422 because groups nest one level.
    """
    given = payload.model_dump(exclude_unset=True)
    attributes = {name: value for name, value in given.items() if value is not None}
    clear = ["parent_id"] if "parent_id" in given and given["parent_id"] is None and existing.parent_id else []
    if attributes.get("parent_id") == existing.parent_id:
        attributes.pop("parent_id", None)
    if "parent_id" in attributes and existing.is_group:
        raise unprocessable(GROUP_IN_GROUP)
    return attributes, clear


def delete_label(repositories: Repositories, workspace_id: str, team_id: str, label_id: str) -> None:
    """Delete a team label and take it off the team's issues; an inherited one is a 409, a missing one a no-op."""
    existing = repositories.team_config.get_label(workspace_id, team_id, label_id)
    if existing is None:
        return
    if existing.scope == WORKSPACE_SCOPE:
        raise _conflict(INHERITED_LABEL)
    if existing.is_group:
        ungroup_children(repositories, workspace_id, existing)
    repositories.team_config.delete_label(workspace_id, team_id, label_id)
    _strip_label(repositories, workspace_id, team_id, label_id)


def ordered_workspace_labels(repositories: Repositories, workspace_id: str) -> list[Label]:
    """Every workspace label, in case-insensitive name order."""
    return repositories.team_config.list_workspace_labels(workspace_id)


def ordered_workspace_statuses(repositories: Repositories, workspace_id: str) -> list[Status]:
    """Every workspace status, in board order."""
    rows = repositories.team_config.list_workspace_statuses(workspace_id)
    return sorted(rows, key=lambda row: (row.position, row.name))


def create_workspace_status(repositories: Repositories, workspace_id: str, payload: StatusCreate) -> Status:
    """Add a workspace status every team inherits, defaulting its position to the end."""
    position = payload.position
    if position is None:
        existing = repositories.team_config.list_workspace_statuses(workspace_id)
        position = max((row.position for row in existing), default=-1) + 1
    status_id = new_config_id()
    return repositories.team_config.create_status(
        Status(
            workspace_id=workspace_id,
            config_key=workspace_status_key(status_id),
            status_id=status_id,
            name=payload.name,
            category=payload.category,
            position=position,
            color=payload.color,
            icon=payload.icon,
            scope=WORKSPACE_SCOPE,
        )
    )


def update_workspace_status(
    repositories: Repositories, workspace_id: str, status_id: str, payload: StatusUpdate
) -> Status:
    """Rename, recategorise, recolor or move a workspace status, with the team rules for icons, or 404."""
    given = payload.model_dump(exclude_unset=True)
    attributes = {name: value for name, value in given.items() if value is not None}
    clear = [name for name in STATUS_APPEARANCE_FIELDS if name in given and given[name] is None]
    existing = repositories.team_config.get_workspace_status(workspace_id, status_id)
    if existing is None:
        raise _not_found()
    _fit_icon(existing, attributes, clear)
    if not attributes and not clear:
        return existing
    updated = repositories.team_config.update_workspace_status(workspace_id, status_id, clear=clear, **attributes)
    if updated is None:
        raise _not_found()
    return updated


def _team_ids(repositories: Repositories, workspace_id: str) -> list[str]:
    """Every live team of the workspace, the teams a workspace record reaches."""
    return [team.team_id for team in repositories.teams.list_for_workspace(workspace_id, limit=1000)]


def delete_workspace_status(
    repositories: Repositories,
    workspace_id: str,
    status_id: str,
    *,
    actor_id: str,
    source: str | None = None,
    replacement_status_id: str | None = None,
) -> None:
    """Delete a workspace status, moving every team's issues in it to `replacement_status_id`.

    Every inheriting team is checked before anything moves. Losing a team's last
    visible status of the category is a 409 naming the team, issues with no
    replacement named are a 409 counting them per team, and a replacement that a
    team with issues here hides is a 409 naming that team. The replacement must be
    another workspace status, so it exists in every team, or it is a 422. Every
    team's override of the deleted status goes too.
    """
    existing = repositories.team_config.get_workspace_status(workspace_id, status_id)
    if existing is None:
        raise _not_found()
    if replacement_status_id is not None:
        if replacement_status_id == status_id:
            raise unprocessable("replacement_status_id must be a different status")
        if repositories.team_config.get_workspace_status(workspace_id, replacement_status_id) is None:
            raise unprocessable(f"No such workspace status: {replacement_status_id}")
    team_ids = _team_ids(repositories, workspace_id)
    moves: list[tuple[str, list[Issue]]] = []
    for team_id in team_ids:
        row = repositories.team_config.get_status(workspace_id, team_id, status_id)
        if row is None:
            continue
        if not row.hidden and not _visible_siblings(repositories, workspace_id, team_id, row):
            raise _category_conflict(repositories, workspace_id, team_id, LAST_OF_CATEGORY, row)
        issues = repositories.issues.iter_for_status(workspace_id, team_id, status_id, include_archived=True)
        if issues:
            moves.append((team_id, issues))
    if moves and replacement_status_id is None:
        raise _has_issues(repositories, workspace_id, moves)
    if replacement_status_id is not None:
        for team_id, _ in moves:
            target = repositories.team_config.get_status(workspace_id, team_id, replacement_status_id)
            if target is None or target.hidden:
                name = _team_name(repositories, workspace_id, team_id)
                raise _conflict(
                    {
                        "error_code": "CONFLICT",
                        "message": REPLACEMENT_HIDDEN.format(team=f"The {name} team" if name else "A team"),
                        "details": {"team_id": team_id, "team_name": name},
                    }
                )
        for _, issues in moves:
            _move_issues(repositories, issues, replacement_status_id, actor_id, source)
    repositories.team_config.delete_workspace_status(workspace_id, status_id)
    repositories.team_config.delete_overrides_of(workspace_id, team_ids, "status", status_id)


def create_workspace_label(repositories: Repositories, workspace_id: str, payload: LabelCreate) -> Label:
    """Add a workspace label or label group every team inherits, in a workspace group when `parent_id` names one."""
    if payload.parent_id is not None:
        if payload.is_group:
            raise unprocessable(GROUP_IN_GROUP)
        workspace_group(repositories, workspace_id, payload.parent_id)
    label_id = new_config_id()
    return repositories.team_config.create_label(
        Label(
            workspace_id=workspace_id,
            config_key=workspace_label_key(label_id),
            label_id=label_id,
            name=payload.name,
            color=payload.color,
            is_group=payload.is_group,
            parent_id=payload.parent_id,
            scope=WORKSPACE_SCOPE,
        )
    )


def update_workspace_label(repositories: Repositories, workspace_id: str, label_id: str, payload: LabelUpdate) -> Label:
    """Rename, recolour, group or ungroup a workspace label, or 404.

    A move into a group is checked against every team's issues, since every team
    inherits both the label and the group.
    """
    existing = repositories.team_config.get_workspace_label(workspace_id, label_id)
    if existing is None:
        raise _not_found()
    attributes, clear = _label_patch(payload, existing)
    if "parent_id" in attributes:
        group = workspace_group(repositories, workspace_id, attributes["parent_id"])
        check_move_into_group(repositories, workspace_id, _team_ids(repositories, workspace_id), existing, group)
    if not attributes and not clear:
        return existing
    updated = repositories.team_config.update_workspace_label(workspace_id, label_id, clear=clear, **attributes)
    if updated is None:
        raise _not_found()
    return updated


def delete_workspace_label(repositories: Repositories, workspace_id: str, label_id: str) -> None:
    """Delete a workspace label, every team's override of it, and the label on every team's issues."""
    existing = repositories.team_config.get_workspace_label(workspace_id, label_id)
    if existing is None:
        return
    if existing.is_group:
        ungroup_children(repositories, workspace_id, existing)
    team_ids = _team_ids(repositories, workspace_id)
    repositories.team_config.delete_workspace_label(workspace_id, label_id)
    repositories.team_config.delete_overrides_of(workspace_id, team_ids, "label", label_id)
    for team_id in team_ids:
        _strip_label(repositories, workspace_id, team_id, label_id)


def set_status_override(
    repositories: Repositories, workspace_id: str, team_id: str, status_id: str, payload: OverrideUpdate
) -> Status:
    """Hide, show, rename or clear the rename of an inherited status in one team.

    Hiding the team's last visible status of a category is a 409, for the same
    reason deleting it is, and so is hiding one live issues are still in, which
    would leave them in a column the team no longer shows. The 409 counts them so
    the admin knows what to move first, as Linear asks.
    """
    existing = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if existing is None:
        raise _not_found()
    if existing.scope != WORKSPACE_SCOPE:
        raise _conflict(NOT_INHERITED)
    override = _next_override(repositories, workspace_id, team_id, "status", status_id, payload)
    if override.hidden and not existing.hidden:
        if not _visible_siblings(repositories, workspace_id, team_id, existing):
            raise _category_conflict(repositories, workspace_id, team_id, LAST_VISIBLE, existing)
        live = repositories.issues.iter_for_status(workspace_id, team_id, status_id, include_archived=False)
        if live:
            name = _team_name(repositories, workspace_id, team_id)
            raise _conflict(
                {
                    "error_code": "CONFLICT",
                    "message": HIDDEN_HAS_ISSUES.format(
                        count=_issues_phrase(len(live)), team=f"the {name} team" if name else "this team"
                    ),
                    "details": {"issue_count": len(live), "team_id": team_id, "team_name": name},
                }
            )
    _store_override(repositories, override)
    return _resolved(repositories.team_config.get_status(workspace_id, team_id, status_id))


def set_label_override(
    repositories: Repositories, workspace_id: str, team_id: str, label_id: str, payload: OverrideUpdate
) -> Label:
    """Hide, show, rename or clear the rename of an inherited label in one team."""
    existing = repositories.team_config.get_label(workspace_id, team_id, label_id)
    if existing is None:
        raise _not_found()
    if existing.scope != WORKSPACE_SCOPE:
        raise _conflict(NOT_INHERITED)
    _store_override(repositories, _next_override(repositories, workspace_id, team_id, "label", label_id, payload))
    return _resolved(repositories.team_config.get_label(workspace_id, team_id, label_id))


def clear_status_override(repositories: Repositories, workspace_id: str, team_id: str, status_id: str) -> Status:
    """Show an inherited status again under its workspace name."""
    existing = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if existing is None:
        raise _not_found()
    if existing.scope != WORKSPACE_SCOPE:
        raise _conflict(NOT_INHERITED)
    repositories.team_config.delete_override(workspace_id, team_id, "status", status_id)
    return _resolved(repositories.team_config.get_status(workspace_id, team_id, status_id))


def clear_label_override(repositories: Repositories, workspace_id: str, team_id: str, label_id: str) -> Label:
    """Show an inherited label again under its workspace name."""
    existing = repositories.team_config.get_label(workspace_id, team_id, label_id)
    if existing is None:
        raise _not_found()
    if existing.scope != WORKSPACE_SCOPE:
        raise _conflict(NOT_INHERITED)
    repositories.team_config.delete_override(workspace_id, team_id, "label", label_id)
    return _resolved(repositories.team_config.get_label(workspace_id, team_id, label_id))


def _next_override(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    target: str,
    target_id: str,
    payload: OverrideUpdate,
) -> Override:
    """The override a patch leaves: the stored one with the given fields applied, an explicit null name clearing it."""
    current = repositories.team_config.get_override(workspace_id, team_id, target, target_id) or Override(
        workspace_id=workspace_id,
        config_key=override_key(team_id, target, target_id),
        team_id=team_id,
        target=target,
        target_id=target_id,
    )
    given = payload.model_dump(exclude_unset=True)
    update: dict[str, Any] = {}
    if given.get("hidden") is not None:
        update["hidden"] = given["hidden"]
    if "name" in given:
        update["name"] = given["name"] or None
    return current.model_copy(update=update)


def _store_override(repositories: Repositories, override: Override) -> None:
    """Write an override, or remove it when it no longer changes anything."""
    if override.hidden or override.name:
        repositories.team_config.put_override(override)
        return
    repositories.team_config.delete_override(
        override.workspace_id, override.team_id, override.target, override.target_id
    )


def _resolved(row: Any) -> Any:
    """A row read back after a write, or a 404 when it vanished in between."""
    if row is None:
        raise _not_found()
    return row
