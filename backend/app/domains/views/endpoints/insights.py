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
from app.common.issue_key_lists import issue_ids_for_keys

router = APIRouter()

Values = Annotated[Optional[list[str]], Query()]
"""A repeatable query parameter: `k=a&k=b` is any of `a` or `b`."""


@router.get("/{workspace_id}/views/insights", response_model=InsightsRead)
def get_insights(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[Optional[str], Query()] = None,
    include_sub_teams: Annotated[bool, Query()] = False,
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
    subscriber_id: Values = None,
    subscriber_id_not: Values = None,
    label_id: Values = None,
    label_id_not: Values = None,
    label_id_all: Values = None,
    parent_id: Values = None,
    parent_id_not: Values = None,
    has_sub_issues: Annotated[Optional[bool], Query()] = None,
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
    issue_id: Values = None,
    key: Values = None,
    created_after: Annotated[Optional[str], Query()] = None,
    created_before: Annotated[Optional[str], Query()] = None,
    updated_after: Annotated[Optional[str], Query()] = None,
    updated_before: Annotated[Optional[str], Query()] = None,
    completed_after: Annotated[Optional[str], Query()] = None,
    completed_before: Annotated[Optional[str], Query()] = None,
    cycle_added: Values = None,
    cycle_added_not: Values = None,
    cycle_added_after: Annotated[Optional[str], Query()] = None,
    cycle_added_before: Annotated[Optional[str], Query()] = None,
    content: Annotated[Optional[str], Query(max_length=200)] = None,
    content_not: Annotated[Optional[str], Query(max_length=200)] = None,
    q: Annotated[Optional[str], Query()] = None,
    is_blocked: Annotated[Optional[bool], Query()] = None,
    is_blocking: Annotated[Optional[bool], Query()] = None,
    has_relation: Values = None,
    customer_id: Values = None,
    customer_id_not: Values = None,
    customer_status_id: Values = None,
    customer_status_id_not: Values = None,
    customer_tier_id: Values = None,
    customer_tier_id_not: Values = None,
    customer_revenue_min: Annotated[Optional[int], Query(ge=0)] = None,
    customer_revenue_max: Annotated[Optional[int], Query(ge=0)] = None,
    customer_size_min: Annotated[Optional[int], Query(ge=0)] = None,
    customer_size_max: Annotated[Optional[int], Query(ge=0)] = None,
    customer_request_count_min: Annotated[Optional[int], Query(ge=0)] = None,
    customer_request_count_max: Annotated[Optional[int], Query(ge=0)] = None,
    customer_important: Annotated[Optional[bool], Query()] = None,
    release_id: Values = None,
    release_id_not: Values = None,
    match: Annotated[Optional[str], Query()] = None,
    groups: Annotated[Optional[str], Query(max_length=8000)] = None,
    include_archived: Annotated[bool, Query()] = False,
    archived_only: Annotated[bool, Query()] = False,
) -> InsightsRead:
    """Issue count, estimate points or a time measure grouped by one dimension, optionally segmented by a second.

    Takes the issue list's filters with the same meaning. With `view_id` the saved
    view's team and live filter apply as well, ANDed with any filter sent. With
    neither a team nor a view, every team the caller can see is counted. A scope
    holding more than `row_cap` issues answers over the issues read with
    `truncated` set rather than reading without bound. A time measure, one of
    `cycle_time`, `lead_time`, `triage_time` or `issue_age`, counts only the issues
    it applies to and answers duration percentiles in hours and one point per issue.
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
        include_sub_teams=include_sub_teams,
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
            "label_id_all": label_id_all,
            "parent_id": parent_id,
            "parent_id_not": parent_id_not,
            "has_sub_issues": has_sub_issues,
            "subscriber_id_not": subscriber_id_not,
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
            "issue_id": issue_ids_for_keys(repositories, context, issue_id, key),
            "created_after": created_after,
            "created_before": created_before,
            "updated_after": updated_after,
            "updated_before": updated_before,
            "completed_after": completed_after,
            "completed_before": completed_before,
            "cycle_added": cycle_added,
            "cycle_added_not": cycle_added_not,
            "cycle_added_after": cycle_added_after,
            "cycle_added_before": cycle_added_before,
            "content": content,
            "content_not": content_not,
            "q": q,
            "include_archived": include_archived,
            "archived_only": archived_only,
            "is_blocked": is_blocked,
            "is_blocking": is_blocking,
            "has_relation": has_relation,
            "customer_id": customer_id,
            "customer_id_not": customer_id_not,
            "customer_status_id": customer_status_id,
            "customer_status_id_not": customer_status_id_not,
            "customer_tier_id": customer_tier_id,
            "customer_tier_id_not": customer_tier_id_not,
            "customer_revenue_min": customer_revenue_min,
            "customer_revenue_max": customer_revenue_max,
            "customer_size_min": customer_size_min,
            "customer_size_max": customer_size_max,
            "customer_request_count_min": customer_request_count_min,
            "customer_request_count_max": customer_request_count_max,
            "customer_important": customer_important,
            "release_id": release_id,
            "release_id_not": release_id_not,
            "match": match,
            "groups": groups,
        },
    )
