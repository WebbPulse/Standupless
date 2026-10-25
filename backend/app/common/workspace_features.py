"""The areas an admin can turn off for a workspace, and the one refusal every write path shares.

An area that is off keeps every row it holds. Reads stay open so an export or
an integration built on them keeps working, and turning the area back on
restores it as it was. Writes are refused with a 403 carrying
`FEATURE_DISABLED` and the area in `details`, from REST and MCP alike.

REST routes are matched by their path template, so a route added under an
area's path is gated without being listed: a segment starting `initiative` is
initiatives, `customer` is customers, `release` is releases, `documents` is
documents and `pulse` or `follow` is Pulse. An MCP write tool needs the area of
the module defining it, as the tool registry records, and a write tool naming a
`document_id` or an `initiative_id` also needs that area.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional

from fastapi import HTTPException, status

from app.common.db.dynamo.workspaces import Workspace, WorkspaceFeature

FEATURE_DISABLED = "FEATURE_DISABLED"

FEATURE_NAMES: Mapping[WorkspaceFeature, str] = {
    WorkspaceFeature.INITIATIVES: "Initiatives",
    WorkspaceFeature.CUSTOMERS: "Customers",
    WorkspaceFeature.RELEASES: "Releases",
    WorkspaceFeature.DOCUMENTS: "Documents",
    WorkspaceFeature.PULSE: "Pulse",
}

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

_SEGMENT_PREFIXES: tuple[tuple[str, WorkspaceFeature], ...] = (
    ("initiative", WorkspaceFeature.INITIATIVES),
    ("customer", WorkspaceFeature.CUSTOMERS),
    ("release", WorkspaceFeature.RELEASES),
    ("pulse", WorkspaceFeature.PULSE),
)

_SEGMENT_EXACT: Mapping[str, WorkspaceFeature] = {
    "documents": WorkspaceFeature.DOCUMENTS,
    "follow": WorkspaceFeature.PULSE,
}

_ARGUMENT_FEATURES: Mapping[str, WorkspaceFeature] = {
    "document_id": WorkspaceFeature.DOCUMENTS,
    "initiative_id": WorkspaceFeature.INITIATIVES,
}


def features_for_route(method: str, route_path: Optional[str]) -> tuple[WorkspaceFeature, ...]:
    """The areas a write to this route template touches, empty for a read or a route outside every area."""
    if method.upper() in SAFE_METHODS or not route_path:
        return ()
    found: list[WorkspaceFeature] = []
    for segment in route_path.split("/"):
        if not segment or segment.startswith("{"):
            continue
        feature = _SEGMENT_EXACT.get(segment)
        if feature is None:
            feature = next((area for prefix, area in _SEGMENT_PREFIXES if segment.startswith(prefix)), None)
        if feature is not None and feature not in found:
            found.append(feature)
    return tuple(found)


def features_for_tool(feature: WorkspaceFeature | None, arguments: Mapping[str, Any]) -> tuple[WorkspaceFeature, ...]:
    """The areas a write tool touches: its own area, if it has one, and the area of any document or initiative it names."""
    found: list[WorkspaceFeature] = [feature] if feature is not None else []
    for argument, area in _ARGUMENT_FEATURES.items():
        if arguments.get(argument) and area not in found:
            found.append(area)
    return tuple(found)


def disabled_feature(
    workspace: Workspace | None, features: Iterable[WorkspaceFeature | str]
) -> WorkspaceFeature | None:
    """The first of `features` the workspace has turned off, or `None` when every one is on."""
    if workspace is None:
        return None
    for feature in features:
        if not workspace.feature_enabled(feature):
            return WorkspaceFeature(feature)
    return None


def feature_disabled_error(feature: WorkspaceFeature) -> HTTPException:
    """The 403 a write to an area that is off answers."""
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error_code": FEATURE_DISABLED,
            "message": (
                f"{FEATURE_NAMES[feature]} is turned off for this workspace. "
                "An admin can turn it back on in Settings, Features."
            ),
            "details": {"feature": feature.value},
        },
    )


def refuse_if_disabled(repositories: Any, workspace_id: str, *features: WorkspaceFeature | str) -> None:
    """Raise the 403 when any of `features` is off, reading the workspace row only when there is one to check.

    A bundle without the workspaces table checks nothing, so a function that
    never writes an area never has to read the row.
    """
    if not features or "workspaces" not in getattr(repositories, "repository_names", ("workspaces",)):
        return
    off = disabled_feature(repositories.workspaces.get(workspace_id), features)
    if off is not None:
        raise feature_disabled_error(off)
