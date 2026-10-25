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
    "team",
]
"""What a breakdown can group issues by."""

InsightMeasure = Literal["count", "points", "cycle_time", "lead_time", "triage_time", "issue_age"]
"""What a breakdown measures: how many issues, their estimate points, or how long each took.

`cycle_time` runs from started to completed over completed issues that were
started, `lead_time` from created to completed over completed issues,
`triage_time` from entering triage to leaving it over triaged issues, and
`issue_age` from created to now over every issue the filter keeps.
"""

INSIGHT_DIMENSIONS: tuple[str, ...] = get_args(InsightDimension)

INSIGHT_MEASURES: tuple[str, ...] = get_args(InsightMeasure)

TIME_MEASURES: frozenset[str] = frozenset({"cycle_time", "lead_time", "triage_time", "issue_age"})
"""Measures that answer a duration per issue, with percentiles and points, rather than a sum."""

INSIGHTS_ROW_CAP = 2000
"""The most issues one breakdown reads before it answers with `truncated` set.

Insights are computed in the handler from the same per-team index reads the list
uses, so the cap is what bounds one request's read cost and memory.
"""


class InsightDurations(BaseModel):
    """Summary statistics of a set of durations, in hours.

    Percentiles interpolate linearly between the two nearest ranks. Every figure
    is null when the set is empty.
    """

    count: int = 0
    average: Optional[float] = None
    p25: Optional[float] = None
    p50: Optional[float] = None
    p75: Optional[float] = None
    p95: Optional[float] = None
    minimum: Optional[float] = None
    maximum: Optional[float] = None


class InsightPoint(BaseModel):
    """One issue's duration under a time measure, placed in its bucket and segment.

    `group` is the bucket key the issue falls in, null for the unset bucket. A label
    breakdown answers one point per label the issue carries. `segment` is the
    issue's first value of the segment dimension, when one was asked for.
    """

    issue_id: str
    key: str
    title: str
    group: Optional[str] = None
    segment: Optional[str] = None
    hours: float


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
    durations: Optional[InsightDurations] = None


class InsightGroup(InsightBucket):
    """One bar of a breakdown, split by the segment dimension when one was asked for."""

    segments: list[InsightBucket] = Field(default_factory=list)


class InsightsRead(BaseModel):
    """A breakdown of the issues one scope and filter select, grouped by one dimension.

    `total` and `issue_count` count each issue once. A label breakdown counts an
    issue under every label it carries, so its bars can sum past the total.
    `truncated` is set when the scope held more than `row_cap` issues, and the
    figures then cover only the issues read. Under a time measure `value` is the
    number of issues measured, each bucket carries `durations`, and `durations`
    and `points` cover the whole set; both are null and empty otherwise.
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
    durations: Optional[InsightDurations] = None
    points: list[InsightPoint] = Field(default_factory=list)
