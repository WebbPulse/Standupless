"""How a workflow status looks: the curated color palette and the icon variants.

Both are plain optional fields on a status row, so a later workspace-level status
can carry the same two fields and a team override can replace either one. A row
without them renders from its category alone, which is how every row written
before these fields existed keeps looking as it did.

Colors are palette names rather than hex values so the interface can pick a tone
that reads in both light and dark themes. Icons are grouped by category because a
check on a started status, or a pie on a finished one, would say something false
about where the issue is.
"""

from __future__ import annotations

from typing import Literal, Optional, get_args

StatusColor = Literal[
    "gray",
    "red",
    "orange",
    "amber",
    "yellow",
    "lime",
    "green",
    "teal",
    "cyan",
    "blue",
    "indigo",
    "violet",
    "purple",
    "pink",
]

StatusIcon = Literal[
    "dashed",
    "dotted",
    "question",
    "circle",
    "circle_dot",
    "progress",
    "quarter",
    "half",
    "three_quarters",
    "paused",
    "blocked",
    "check",
    "check_outline",
    "cross",
    "cross_outline",
    "duplicate",
]

STATUS_COLORS: tuple[str, ...] = get_args(StatusColor)
"""Every color a status may carry, in the order the picker shows them."""

STATUS_ICONS: tuple[str, ...] = get_args(StatusIcon)
"""Every icon variant a status may carry, across all categories."""

ICONS_BY_CATEGORY: dict[str, tuple[str, ...]] = {
    "backlog": ("dashed", "dotted", "question"),
    "unstarted": ("circle", "circle_dot"),
    "started": ("progress", "quarter", "half", "three_quarters", "paused", "blocked"),
    "completed": ("check", "check_outline"),
    "cancelled": ("cross", "cross_outline", "duplicate"),
}
"""The icon variants each category allows, its default first.

`progress` is the started default and means the fill follows the status's rank
among the team's started statuses, so In Progress, In Review and On Staging read as
increasing progress with no setup.
"""


def icon_fits(category: str, icon: Optional[str]) -> bool:
    """Whether an icon may sit on a status of this category, a missing icon always may."""
    return icon is None or icon in ICONS_BY_CATEGORY.get(category, ())


def check_icon(category: str, icon: Optional[str]) -> None:
    """Refuse an icon that belongs to another category, naming the ones that fit."""
    if not icon_fits(category, icon):
        allowed = ", ".join(ICONS_BY_CATEGORY.get(category, ()))
        raise ValueError(f"icon {icon} does not fit the {category} category; use one of {allowed}")
