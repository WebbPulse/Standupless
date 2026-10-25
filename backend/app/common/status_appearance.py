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


PALETTE_HEX: dict[str, str] = {
    "gray": "#8b919c",
    "red": "#e5484d",
    "orange": "#f0712c",
    "amber": "#e59a12",
    "yellow": "#c9a90a",
    "lime": "#76a91c",
    "green": "#2f9e62",
    "teal": "#12a594",
    "cyan": "#0797b9",
    "blue": "#3b7cf0",
    "indigo": "#5e6ad2",
    "violet": "#8b5cd6",
    "purple": "#b04fc0",
    "pink": "#d6409f",
}
"""Each palette color as the interface draws it, to match a color brought from another tool."""


def nearest_color(value: Optional[str]) -> Optional[str]:
    """The palette color closest to a `#rrggbb` value, or `None` when the value is not one."""
    text = str(value or "").strip().lstrip("#")
    if len(text) != 6:
        return None
    try:
        red, green, blue = (int(text[index : index + 2], 16) for index in (0, 2, 4))
    except ValueError:
        return None

    def distance(name: str) -> int:
        """How far one palette color is from the value."""
        hex_value = PALETTE_HEX[name].lstrip("#")
        r, g, b = (int(hex_value[index : index + 2], 16) for index in (0, 2, 4))
        return (r - red) ** 2 + (g - green) ** 2 + (b - blue) ** 2

    return min(STATUS_COLORS, key=distance)
