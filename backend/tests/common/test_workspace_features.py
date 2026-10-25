"""Which areas a route template or an MCP write tool touches.

The REST gate matches path templates rather than a hand-kept list, so these pin
that every area's routes are matched, that reads never are, and that routes
outside every area stay ungated.
"""

from __future__ import annotations

import pytest

from app.common.db.dynamo.workspaces import WorkspaceFeature
from app.common.workspace_features import features_for_route, features_for_tool

F = WorkspaceFeature


@pytest.mark.parametrize(
    ("method", "path", "expected"),
    [
        ("POST", "/{workspace_id}/initiatives", (F.INITIATIVES,)),
        ("PATCH", "/{workspace_id}/initiatives/{initiative_id}/updates/{update_id}", (F.INITIATIVES,)),
        ("POST", "/{workspace_id}/customers", (F.CUSTOMERS,)),
        ("POST", "/{workspace_id}/issues/{issue_id}/customer-requests", (F.CUSTOMERS,)),
        ("POST", "/{workspace_id}/teams/{team_id}/releases", (F.RELEASES,)),
        ("PUT", "/{workspace_id}/teams/{team_id}/release-pipeline", (F.RELEASES,)),
        ("POST", "/{workspace_id}/teams/{team_id}/documents", (F.DOCUMENTS,)),
        ("POST", "/{workspace_id}/documents/{document_id}/comments", (F.DOCUMENTS,)),
        ("POST", "/{workspace_id}/initiatives/{initiative_id}/documents", (F.INITIATIVES, F.DOCUMENTS)),
        ("POST", "/{workspace_id}/pulse/read", (F.PULSE,)),
        ("PUT", "/{workspace_id}/projects/{project_id}/follow", (F.PULSE,)),
        ("PUT", "/{workspace_id}/initiatives/{initiative_id}/follow", (F.INITIATIVES, F.PULSE)),
        ("GET", "/{workspace_id}/customers", ()),
        ("GET", "/{workspace_id}/pulse", ()),
        ("POST", "/{workspace_id}/projects", ()),
        ("PATCH", "/{workspace_id}", ()),
        ("POST", "/{workspace_id}/issues", ()),
    ],
)
def test_a_route_maps_to_its_areas(method: str, path: str, expected: tuple[WorkspaceFeature, ...]) -> None:
    """A write names every area its template touches, and a read names none."""
    assert features_for_route(method, path) == expected


def test_a_tool_needs_its_own_area_and_any_it_names() -> None:
    """A tool's area comes first, then documents or initiatives for the ids it carries."""
    assert features_for_tool(F.CUSTOMERS, {}) == (F.CUSTOMERS,)
    assert features_for_tool(None, {"document_id": "D1", "body": "Hi"}) == (F.DOCUMENTS,)
    assert features_for_tool(None, {"initiative_id": "I1"}) == (F.INITIATIVES,)
    assert features_for_tool(None, {"initiative_id": None, "name": "Launch"}) == ()
