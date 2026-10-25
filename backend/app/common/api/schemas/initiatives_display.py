"""The initiatives list arrangement an account saves, read back the same way on every device."""

from __future__ import annotations

from typing import Any, Literal, Mapping, Optional, get_args

from pydantic import BaseModel, field_validator

InitiativesOrderField = Literal["target", "name", "progress", "created", "updated"]

InitiativesCompletedField = Literal["show", "hide"]

INITIATIVES_COLUMNS: tuple[str, ...] = ("health", "owner", "projects", "target", "progress")
"""Every property the initiatives list can show beside the name, in the order it draws them."""

DEFAULT_INITIATIVES_COLUMNS = ",".join(INITIATIVES_COLUMNS)
"""The properties a list that was never arranged shows."""


def _ordered_columns(value: Any) -> str:
    """The known columns `value` names, comma separated in the list's order, refusing an unknown one."""
    if isinstance(value, str):
        tokens = [token.strip() for token in value.split(",") if token.strip()]
    elif isinstance(value, (list, tuple)):
        tokens = [str(token).strip() for token in value if str(token).strip()]
    else:
        raise ValueError("columns must be a comma separated text or a list of column names")
    unknown = sorted(set(tokens) - set(INITIATIVES_COLUMNS))
    if unknown:
        raise ValueError(f"Unknown initiatives list columns: {', '.join(unknown)}")
    return ",".join(column for column in INITIATIVES_COLUMNS if column in tokens)


class InitiativesDisplay(BaseModel):
    """How the person arranges the workspace initiatives list.

    `order` sorts the initiatives inside each status group, sub-initiatives
    staying under their parent. `completed` shows or hides the completed group.
    `columns` names the properties shown beside the name, comma separated in the
    list's own order, and empty shows the name alone.
    """

    order: InitiativesOrderField = "target"
    completed: InitiativesCompletedField = "show"
    columns: str = DEFAULT_INITIATIVES_COLUMNS

    @field_validator("columns", mode="before")
    @classmethod
    def _known_columns(cls, value: Any) -> str:
        """Refuse a column the list does not draw, and store the rest in the list's order."""
        return _ordered_columns(value)


INITIATIVES_DISPLAY_FIELDS: dict[str, tuple[str, ...]] = {
    "order": get_args(InitiativesOrderField),
    "completed": get_args(InitiativesCompletedField),
}
"""The choices each stored single choice field may still hold; `columns` is a set instead."""


def stored_initiatives_display(stored: Optional[Mapping[str, Any]]) -> InitiativesDisplay:
    """A stored initiatives display, each field the default once its choice is retired or missing."""
    defaults = InitiativesDisplay().model_dump()
    values = stored or {}
    chosen: dict[str, Any] = {
        field: str(values.get(field, "")) if str(values.get(field, "")) in allowed else defaults[field]
        for field, allowed in INITIATIVES_DISPLAY_FIELDS.items()
    }
    held = values.get("columns")
    if held is None:
        chosen["columns"] = defaults["columns"]
    else:
        tokens = [token.strip() for token in str(held).split(",")]
        chosen["columns"] = ",".join(column for column in INITIATIVES_COLUMNS if column in tokens)
    return InitiativesDisplay.model_validate(chosen)
