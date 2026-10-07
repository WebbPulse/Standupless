"""Response schemas for insights, shared by the insights route and the MCP tool.

Held in `common` because the integrations image may not import another domain's
code, and the MCP tool must answer exactly the body the route answers.
"""

from __future__ import annotations

from typing import Literal, Optional, get_args

from pydantic import BaseModel, Field

InsightDimension = Literal[
    "status",
    "status_category",
    "assignee",
    "creator",
    "priority",
    "label",
    "project",
    "cycle",
    "estimate",
]
"""What a breakdown can group issues by."""

InsightMeasure = Literal["count", "points"]
"""What each bar measures: how many issues, or the sum of their estimates in points."""

INSIGHT_DIMENSIONS: tuple[str, ...] = get_args(InsightDimension)

INSIGHT_MEASURES: tuple[str, ...] = get_args(InsightMeasure)

INSIGHTS_ROW_CAP = 2000
"""The most issues one breakdown reads before it answers with `truncated` set.

Insights are computed in the handler from the same per-team index reads the list
uses, so the cap is what bounds one request's read cost and memory.
"""


class InsightBucket(BaseModel):
    """One bar or bar segment: a value of the dimension and what it measures.

    `key` is the raw value, an id or an enum, and null for the unset bucket such
    as unassigned. `label` is its display name, resolved on the server so a reader
    without the workspace's lookups can still show it.
    """

    key: Optional[str] = None
    label: str
    color: Optional[str] = None
    value: int = 0
    issue_count: int = 0


class InsightGroup(InsightBucket):
    """One bar of a breakdown, split by the segment dimension when one was asked for."""

    segments: list[InsightBucket] = Field(default_factory=list)


class InsightsRead(BaseModel):
    """A breakdown of the issues one scope and filter select, grouped by one dimension.

    `total` and `issue_count` count each issue once. A label breakdown counts an
    issue under every label it carries, so its bars can sum past the total.
    `truncated` is set when the scope held more than `row_cap` issues, and the
    figures then cover only the issues read.
    """

    team_ids: list[str]
    view_id: Optional[str] = None
    group_by: InsightDimension
    segment_by: Optional[InsightDimension] = None
    measure: InsightMeasure
    total: int
    issue_count: int
    groups: list[InsightGroup]
    truncated: bool = False
    row_cap: int = INSIGHTS_ROW_CAP
