"""Label list and create, and the label group rules, shared by the label routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a label an agent creates must be the same row a team admin's is.

A label group is a label with `is_group` set, holding the labels that name it in
`parent_id`, as in Linear. Groups nest one level, a group and its children share
a scope, and an issue carries at most one label of each group.

A label name is unique, ignoring case, among the labels a team sees in the same
place: the top level, or one group. A team sees its own labels, its parent
team's and every workspace label, so a workspace label's name is checked against
every team and a parent team's against each of its sub-teams.
"""

from __future__ import annotations

from typing import Iterable, Mapping, Sequence

from fastapi import HTTPException, status

from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.teams import LabelCreate
from app.common.db.dynamo.team_config import TEAM_SCOPE, WORKSPACE_SCOPE, Label, label_key, new_config_id
from app.common.issue_rules import unprocessable
from app.common.sub_teams import family

GITHUB_LABEL_MAX = 50
"""The longest label name GitHub accepts."""

GROUP_IN_GROUP = "A label group cannot sit inside another group."

NOT_A_GROUP = "No such label group: {parent_id}"

DUPLICATE_NAME = "A label named {name} already exists{where}. Use that label or choose another name."

GROUP_CONFLICT = (
    "{count} {label} and another label of the {group} group. "
    "An issue can carry one label from a group, so change those issues first."
)


def ordered_labels(
    repositories: Repositories, workspace_id: str, team_id: str, *, include_hidden: bool = False
) -> list[Label]:
    """Every effective label of one team in case-insensitive name order, hidden ones last and only when asked for."""
    rows = repositories.team_config.list_labels(workspace_id, team_id, include_hidden=include_hidden)
    return sorted(rows, key=lambda row: (row.hidden, row.name.lower()))


def team_group(repositories: Repositories, workspace_id: str, team_id: str, parent_id: str) -> Label:
    """The team's own label group a team label may go in, or a 422."""
    row = repositories.team_config.get_label(workspace_id, team_id, parent_id)
    if row is None or not row.is_group or row.scope != TEAM_SCOPE:
        raise unprocessable(NOT_A_GROUP.format(parent_id=parent_id))
    return row


def workspace_group(repositories: Repositories, workspace_id: str, parent_id: str) -> Label:
    """The workspace label group a workspace label may go in, or a 422."""
    row = repositories.team_config.get_workspace_label(workspace_id, parent_id)
    if row is None or not row.is_group:
        raise unprocessable(NOT_A_GROUP.format(parent_id=parent_id))
    return row


def create_label(repositories: Repositories, workspace_id: str, team_id: str, payload: LabelCreate) -> Label:
    """Add a label or a label group to one team, in one of the team's own groups when `parent_id` names one.

    The caller has already been held to team admin, by the route's dependency or
    by the tool, because the label set is a team setting every issue draws on.
    """
    if payload.parent_id is not None:
        if payload.is_group:
            raise unprocessable(GROUP_IN_GROUP)
        team_group(repositories, workspace_id, team_id, payload.parent_id)
    team_ids = family(repositories, workspace_id, team_id)
    check_unique_name(repositories, workspace_id, team_ids, payload.name, payload.parent_id)
    label_id = new_config_id()
    return repositories.team_config.create_label(
        Label(
            workspace_id=workspace_id,
            config_key=label_key(team_id, label_id),
            team_id=team_id,
            label_id=label_id,
            name=payload.name,
            color=payload.color,
            is_group=payload.is_group,
            parent_id=payload.parent_id,
        )
    )


def name_key(name: str) -> str:
    """A label name as uniqueness compares it: trimmed and case folded."""
    return name.strip().casefold()


def check_unique_name(
    repositories: Repositories,
    workspace_id: str,
    team_ids: Iterable[str],
    name: str,
    parent_id: str | None,
    *,
    exclude_label_id: str | None = None,
) -> None:
    """Refuse with a 409 a label name another label already holds in the same place.

    Every workspace label and every label the named teams see is compared, hidden
    ones and team renames of inherited ones included, so no team ends up with two
    labels it cannot tell apart. Existing duplicates are left as they are: only a
    write that sets a name or a group is checked.
    """
    wanted = name_key(name)
    rows = list(repositories.team_config.list_workspace_labels(workspace_id))
    for team_id in dict.fromkeys(team_ids):
        rows.extend(repositories.team_config.list_labels(workspace_id, team_id, include_hidden=True))
    for row in rows:
        if row.label_id == exclude_label_id or (row.parent_id or None) != (parent_id or None):
            continue
        if name_key(row.name) != wanted:
            continue
        local = row.team_id and (row.scope != WORKSPACE_SCOPE or row.inherited_name)
        owner = _owning_team(repositories, workspace_id, row)
        where = f" in the {_team_name(repositories, workspace_id, owner)} team" if local else " in the workspace"
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "CONFLICT",
                "message": DUPLICATE_NAME.format(name=row.name, where=where),
                "details": {"label_id": row.label_id, "name": row.name, "scope": row.scope},
            },
        )


def _owning_team(repositories: Repositories, workspace_id: str, row: Label) -> str:
    """The team a label read through a team belongs to: the parent for one a sub-team inherits."""
    if row.scope == TEAM_SCOPE or row.inherited_name:
        return row.team_id
    return repositories.team_config.get_parent_id(workspace_id, row.team_id) or row.team_id


def _team_name(repositories: Repositories, workspace_id: str, team_id: str) -> str:
    """A team's display name for a refusal, or a stand-in when it is gone."""
    team = repositories.teams.get(workspace_id, team_id)
    return team.name if team is not None else "other"


def _issues_phrase(count: int) -> str:
    """A count of issues as the subject of "carry"."""
    return "1 issue carries" if count == 1 else f"{count} issues carry"


def check_move_into_group(
    repositories: Repositories, workspace_id: str, team_ids: Iterable[str], label: Label, group: Label
) -> None:
    """Refuse with a 409 a move into `group` that would leave an issue carrying two of its labels.

    Linear refuses the same move, because otherwise the one-label rule would hold
    for new writes only and every later label edit of those issues would fail.
    """
    count = 0
    for team_id in dict.fromkeys(team_ids):
        siblings = {
            row.label_id
            for row in repositories.team_config.list_labels(workspace_id, team_id)
            if row.parent_id == group.label_id and row.label_id != label.label_id
        }
        if not siblings:
            continue
        for issue in repositories.issues.iter_with_label(workspace_id, team_id, label.label_id):
            if siblings.intersection(issue.label_ids):
                count += 1
    if count:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "CONFLICT",
                "message": GROUP_CONFLICT.format(count=_issues_phrase(count), label=label.name, group=group.name),
                "details": {"issue_count": count},
            },
        )


def ungroup_children(repositories: Repositories, workspace_id: str, group: Label) -> None:
    """Take every label out of a group being deleted, so its children stay as plain labels, as in Linear."""
    if group.scope == WORKSPACE_SCOPE:
        for row in repositories.team_config.list_workspace_labels(workspace_id):
            if row.parent_id == group.label_id:
                repositories.team_config.update_workspace_label(workspace_id, row.label_id, clear=("parent_id",))
        return
    for row in repositories.team_config.list_labels(workspace_id, group.team_id):
        if row.parent_id == group.label_id and row.scope == TEAM_SCOPE:
            repositories.team_config.update_label(workspace_id, group.team_id, row.label_id, clear=("parent_id",))


def label_path(label: Label, by_id: Mapping[str, Label]) -> str:
    """A label's name prefixed with its group's, `Group/Child`, or its bare name outside a group."""
    group = by_id.get(label.parent_id) if label.parent_id else None
    return f"{group.name}/{label.name}" if group is not None else label.name


def github_label_names(labels: Sequence[Label]) -> dict[str, str]:
    """The GitHub name of every label that can sit on an issue, keyed by label id.

    A grouped label is `Group/Child`, the scoped label convention GitHub projects
    already use, so two groups' children of the same name stay apart. A path past
    GitHub's 50 character limit falls back to the bare child name. Groups are left
    out because no issue carries one.
    """
    by_id = {label.label_id: label for label in labels}
    names: dict[str, str] = {}
    for label in labels:
        if label.is_group:
            continue
        path = label_path(label, by_id)
        names[label.label_id] = path if len(path) <= GITHUB_LABEL_MAX else label.name
    return names


def one_per_group(labels: Sequence[Label], label_ids: Iterable[str]) -> list[str]:
    """The label ids with groups dropped and only the first label of each group kept."""
    by_id = {label.label_id: label for label in labels}
    kept: list[str] = []
    seen: set[str] = set()
    for label_id in dict.fromkeys(label_ids):
        row = by_id.get(label_id)
        if row is None or row.is_group:
            continue
        if row.parent_id:
            if row.parent_id in seen:
                continue
            seen.add(row.parent_id)
        kept.append(label_id)
    return kept


def replace_group_siblings(labels: Sequence[Label], kept: Sequence[str], added: Sequence[str]) -> list[str]:
    """`kept` plus `added`, where an added grouped label replaces the label of its group already kept.

    This is how picking a second label of a group behaves in Linear: it swaps
    rather than failing, which is what a bulk add of one label wants.
    """
    by_id = {label.label_id: label for label in labels}
    groups = {row.parent_id for label_id in added if (row := by_id.get(label_id)) is not None and row.parent_id}
    remaining = [
        label_id
        for label_id in kept
        if label_id in added or (row := by_id.get(label_id)) is None or row.parent_id not in groups
    ]
    return remaining + [label_id for label_id in added if label_id not in remaining]
