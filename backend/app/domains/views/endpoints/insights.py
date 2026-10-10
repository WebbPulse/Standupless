"""Insights route: a breakdown of the issues a team, a filter or a saved view selects.

Served under `/views` so the gateway's existing views prefix routes it, and
registered before the saved view routes so `insights` is never read as a view id.
The breakdown itself lives in `app.common.insights`, shared with the MCP tool.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.insights import InsightDimension, InsightMeasure, InsightsRead
from app.common.insights import insights_for

router = APIRouter()

Values = Annotated[Optional[list[str]], Query()]
"""A repeatable query parameter: `k=a&k=b` is any of `a` or `b`."""


@router.get("/{workspace_id}/views/insights", response_model=InsightsRead)
def get_insights(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[Optional[str], Query()] = None,
    view_id: Annotated[Optional[str], Query()] = None,
    group_by: Annotated[InsightDimension, Query()] = "status",
    segment_by: Annotated[Optional[InsightDimension], Query()] = None,
    measure: Annotated[InsightMeasure, Query()] = "count",
    status_id: Values = None,
    status_id_not: Values = None,
    status_category: Values = None,
    status_category_not: Values = None,
    assignee_id: Values = None,
    assignee_id_not: Values = None,
    creator_id: Values = None,
    creator_id_not: Values = None,
    subscriber_id: Annotated[Optional[str], Query()] = None,
    label_id: Values = None,
    label_id_not: Values = None,
    parent_id: Values = None,
    priority: Values = None,
    priority_not: Values = None,
    cycle_id: Values = None,
    cycle_id_not: Values = None,
    project_id: Values = None,
    project_id_not: Values = None,
    project_milestone_id: Values = None,
    project_milestone_id_not: Values = None,
    estimate: Values = None,
    estimate_not: Values = None,
    sla_status: Values = None,
    due_before: Annotated[Optional[str], Query()] = None,
    due_after: Annotated[Optional[str], Query()] = None,
    team_id_in: Values = None,
    team_id_not: Values = None,
    created_after: Annotated[Optional[str], Query()] = None,
    created_before: Annotated[Optional[str], Query()] = None,
    updated_after: Annotated[Optional[str], Query()] = None,
    updated_before: Annotated[Optional[str], Query()] = None,
    q: Annotated[Optional[str], Query()] = None,
    is_blocked: Annotated[Optional[bool], Query()] = None,
    is_blocking: Annotated[Optional[bool], Query()] = None,
    has_relation: Values = None,
    include_archived: Annotated[bool, Query()] = False,
    archived_only: Annotated[bool, Query()] = False,
) -> InsightsRead:
    """Issue count or estimate points grouped by one dimension, optionally segmented by a second.

    Takes the issue list's filters with the same meaning. With `view_id` the saved
    view's team and live filter apply as well, ANDed with any filter sent. With
    neither a team nor a view, every team the caller can see is counted. A scope
    holding more than `row_cap` issues answers over the issues read with
    `truncated` set rather than reading without bound.
    """
    return insights_for(
        repositories,
        context,
        team_id=team_id,
        view_id=view_id,
        subscriber_id=subscriber_id,
        group_by=group_by,
        segment_by=segment_by,
        measure=measure,
        filters={
            "status_id": status_id,
            "status_id_not": status_id_not,
            "status_category": status_category,
            "status_category_not": status_category_not,
            "assignee_id": assignee_id,
            "assignee_id_not": assignee_id_not,
            "creator_id": creator_id,
            "creator_id_not": creator_id_not,
            "label_id": label_id,
            "label_id_not": label_id_not,
            "parent_id": parent_id,
            "priority": priority,
            "priority_not": priority_not,
            "cycle_id": cycle_id,
            "cycle_id_not": cycle_id_not,
            "project_id": project_id,
            "project_id_not": project_id_not,
            "project_milestone_id": project_milestone_id,
            "project_milestone_id_not": project_milestone_id_not,
            "estimate": estimate,
            "estimate_not": estimate_not,
            "sla_status": sla_status,
            "due_before": due_before,
            "due_after": due_after,
            "team_id_in": team_id_in,
            "team_id_not": team_id_not,
            "created_after": created_after,
            "created_before": created_before,
            "updated_after": updated_after,
            "updated_before": updated_before,
            "q": q,
            "include_archived": include_archived,
            "archived_only": archived_only,
            "is_blocked": is_blocked,
            "is_blocking": is_blocking,
            "has_relation": has_relation,
        },
    )
