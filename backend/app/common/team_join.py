"""What a team joining a parent team does with the statuses and labels it already has.

A sub-team sees its own rows beside its parent's, so a team joining with a status
or label the parent already has would show two it cannot tell apart. Labels are
checked before anything is written: a plain top-level label sharing its name with
one of the parent's own visible labels folds into it, and any other clash, with a
group, a hidden label, a renamed workspace label or a sibling sub-team's label,
refuses the join with a 409 naming the team's labels to change first. Once the
team has joined, each of its own statuses with the name and category of one of
the parent's own moves its issues there and is deleted, and the team's pull
request rules and auto-close status follow it, so the team runs on the parent's
workflow as a team created under it would.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from fastapi import HTTPException, status

from app.common import team_workflow
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import TEAM_SCOPE, WORKSPACE_SCOPE, Label
from app.common.labels import name_key
from app.common.sub_teams import sub_team_ids

LABEL_CLASH = (
    "This team has labels named like ones the {parent} team or its sub-teams already use: {names}. "
    "Rename or delete them in this team first."
)


@dataclass(frozen=True)
class LabelMerge:
    """One of the joining team's labels and the parent's label of the same name it folds into."""

    label_id: str
    into_id: str


def _place(row: Label, rows: Sequence[Label]) -> tuple[str, str]:
    """Where a label's name must be unique, as its group's name and its own, both case folded."""
    group = next((other.name for other in rows if other.label_id == row.parent_id), "") if row.parent_id else ""
    return (name_key(group), name_key(row.name))


def plan_label_merges(
    repositories: Repositories, workspace_id: str, team_id: str, parent_team_id: str
) -> list[LabelMerge]:
    """The labels the team folds into its new parent's, or a 409 naming those that cannot fold.

    The team's side is its own labels and the workspace labels it renamed; the
    other side is every label the parent sees and the own labels of the parent's
    other sub-teams.
    """
    config = repositories.team_config
    current = config.list_labels(workspace_id, team_id, include_hidden=True)
    renamed = {row.target_id for row in config.list_overrides(workspace_id, team_id, "label") if row.name}
    mine = [
        row for row in current if row.scope == TEAM_SCOPE or (row.scope == WORKSPACE_SCOPE and row.label_id in renamed)
    ]
    if not mine:
        return []
    parents = config.list_labels(workspace_id, parent_team_id, include_hidden=True)
    taken: dict[tuple[str, str], tuple[Label, bool]] = {}
    for sibling in sub_team_ids(repositories, workspace_id, parent_team_id):
        if sibling == team_id:
            continue
        rows = config.list_labels(workspace_id, sibling, include_hidden=True)
        for row in rows:
            if row.scope == TEAM_SCOPE:
                taken.setdefault(_place(row, rows), (row, False))
    for row in parents:
        taken[_place(row, parents)] = (row, True)
    merges: list[LabelMerge] = []
    clashes: list[str] = []
    for row in mine:
        found = taken.get(_place(row, current))
        if found is None or found[0].label_id == row.label_id:
            continue
        other, from_parent = found
        if from_parent and _foldable(row, other):
            merges.append(LabelMerge(label_id=row.label_id, into_id=other.label_id))
        else:
            clashes.append(row.name)
    if clashes:
        parent = repositories.teams.get(workspace_id, parent_team_id)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "CONFLICT",
                "message": LABEL_CLASH.format(
                    parent=parent.name if parent is not None else "parent", names=", ".join(sorted(clashes))
                ),
                "details": {"names": sorted(clashes)},
            },
        )
    return merges


def _foldable(row: Label, other: Label) -> bool:
    """Whether a team label can fold into a parent label: both plain, top level, the parent's own and visible."""
    return (
        row.scope == TEAM_SCOPE
        and other.scope == TEAM_SCOPE
        and not other.hidden
        and not row.is_group
        and not other.is_group
        and not row.parent_id
        and not other.parent_id
    )


def merge_labels(repositories: Repositories, workspace_id: str, team_id: str, merges: Sequence[LabelMerge]) -> None:
    """Put the parent's label on every issue of the team carrying its folded twin, then delete the twin."""
    for merge in merges:
        for issue in repositories.issues.iter_with_label(workspace_id, team_id, merge.label_id):
            repositories.issues.replace_with(issue, lambda current, merge=merge: _relabelled(current, merge))
        repositories.team_config.delete_label(workspace_id, team_id, merge.label_id)


def _relabelled(issue: Issue, merge: LabelMerge) -> Issue | None:
    """The issue carrying the parent's label in place of the team's, or `None` once it carries neither."""
    if merge.label_id not in issue.label_ids:
        return None
    swapped = [merge.into_id if label_id == merge.label_id else label_id for label_id in issue.label_ids]
    return issue.model_copy(update={"label_ids": list(dict.fromkeys(swapped))})


def merge_statuses(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    parent_team_id: str,
    *,
    actor_id: str,
    source: str | None,
) -> dict[str, str]:
    """Fold the team's own statuses into the parent's of the same name and category, answering old id to new.

    Each fold is a status delete naming the parent's status as the replacement,
    so the issues move with their history as a delete records it.
    """
    config = repositories.team_config
    parents = {
        (name_key(row.name), row.category): row.status_id
        for row in config.list_statuses(workspace_id, parent_team_id, include_hidden=False)
        if row.scope == TEAM_SCOPE
    }
    moved: dict[str, str] = {}
    for row in config.list_statuses(workspace_id, team_id, include_hidden=True):
        into = parents.get((name_key(row.name), row.category))
        if row.scope != TEAM_SCOPE or into is None:
            continue
        team_workflow.delete_status(
            repositories,
            workspace_id,
            team_id,
            row.status_id,
            actor_id=actor_id,
            source=source,
            replacement_status_id=into,
        )
        moved[row.status_id] = into
    if moved:
        _follow_statuses(repositories, workspace_id, team_id, moved)
    return moved


def _follow_statuses(repositories: Repositories, workspace_id: str, team_id: str, moved: dict[str, str]) -> None:
    """Point the team's pull request rules and auto-close status at the statuses their old ones folded into."""
    config = repositories.team_config
    for rule in config.list_transitions(workspace_id, team_id):
        if rule.status_id in moved:
            config.update_transition(workspace_id, team_id, rule.transition_id, status_id=moved[rule.status_id])
    settings = config.get_auto_close_settings(workspace_id, team_id)
    into = moved.get(settings.status_id or "") if settings is not None else None
    if settings is not None and into is not None:
        config.put_auto_close_settings(settings.model_copy(update={"status_id": into}))
