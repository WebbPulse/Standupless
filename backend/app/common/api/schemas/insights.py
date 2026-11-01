"""Response schemas for insights, shared by the insights route and the MCP tool.

Held in `common` because the integrations image may not import another domain's
code, and the MCP tool must answer exactly the body the route answers.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping, Optional, get_args

from pydantic import BaseModel, ConfigDict, Field, model_validator

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

InsightsLayout = Literal["both", "chart", "table"]
"""What the view insights panel draws: the chart and the table, or one of them."""

INSIGHTS_LAYOUTS: tuple[str, ...] = get_args(InsightsLayout)

TIME_MEASURES: frozenset[str] = frozenset({"cycle_time", "lead_time", "triage_time", "issue_age"})
"""Measures that answer a duration per issue, with percentiles and points, rather than a sum."""

INSIGHTS_ROW_CAP = 2000
"""The most issues one breakdown reads before it answers with `truncated` set.

Insights are computed in the handler from the same per-team index reads the list
uses, so the cap is what bounds one request's read cost and memory.
"""


class InsightsDisplay(BaseModel):
    """The view insights panel a list opens with for every viewer without picks of their own.

    Saved on a view or as a team's display default. A null `measure`, `group_by`
    or `layout` keeps the panel's built-in choice, and a null `segment_by` draws
    no segments.
    """

    model_config = ConfigDict(extra="forbid")

    measure: Optional[InsightMeasure] = None
    group_by: Optional[InsightDimension] = None
    segment_by: Optional[InsightDimension] = None
    layout: Optional[InsightsLayout] = None

    @model_validator(mode="after")
    def _segment_differs(self) -> "InsightsDisplay":
        """Refuse a segment repeating the slice, which the panel could not draw."""
        if self.segment_by is not None and self.segment_by == self.group_by:
            raise ValueError("segment_by must differ from group_by")
        return self

    def as_row(self) -> dict[str, str]:
        """The stored shape of this configuration, holding only the fields it sets."""
        return self.model_dump(exclude_none=True)


def stored_insights_display(stored: Optional[Mapping[str, Any]]) -> Optional[InsightsDisplay]:
    """A stored panel configuration, each field dropped once its choice is retired, null when none is left.

    Read leniently so retiring a measure or a dimension never breaks a view that
    saved it, the same way a stored projects arrangement reads.
    """
    allowed: dict[str, tuple[str, ...]] = {
        "measure": INSIGHT_MEASURES,
        "group_by": INSIGHT_DIMENSIONS,
        "segment_by": INSIGHT_DIMENSIONS,
        "layout": INSIGHTS_LAYOUTS,
    }
    kept = {field: (stored or {}).get(field) for field in allowed}
    kept = {field: value for field, value in kept.items() if value in allowed[field]}
    if kept.get("segment_by") == kept.get("group_by"):
        kept.pop("segment_by", None)
    return InsightsDisplay.model_validate(kept) if kept else None


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
    `segment_totals` measures each segment across every issue, counting an issue
    once per segment value however many groups it falls in, so an across all row
    need not add up bars that can double count.
    """

    team_ids: list[str]
    view_id: Optional[str] = None
    group_by: InsightDimension
    segment_by: Optional[InsightDimension] = None
    measure: InsightMeasure
    total: int
    issue_count: int
    groups: list[InsightGroup]
    segment_totals: list[InsightBucket] = Field(default_factory=list)
    truncated: bool = False
    row_cap: int = INSIGHTS_ROW_CAP
    durations: Optional[InsightDurations] = None
    points: list[InsightPoint] = Field(default_factory=list)
