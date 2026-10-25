"""A team view shared publicly reads anonymously through the real edge.

A view or filter link is the public roadmap, a Standard feature, which only the
comp grant script can give a workspace without Stripe behind it, so this runs on
the local stack alone, like triage. Every deployed stage proves the Free refusal
in `e2e/test_product_flows.py` instead.
"""

from __future__ import annotations

import secrets
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

WRITES = pytest.mark.e2e_writes

BACKEND_DIRECTORY = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def local_stack(e2e_env: Any) -> None:
    """Skip every case outside the writable local stack."""
    if e2e_env.environment != "local" or e2e_env.read_only:
        pytest.skip("a public view link needs the comp grant script, which runs on the local stack only")


def _grant_standard(slug: str) -> None:
    """Hold the workspace on the Standard plan through the comp grant script, with no Stripe behind it."""
    result = subprocess.run(
        [
            sys.executable,
            "scripts/grant_comp_plan.py",
            "--stage",
            "e2e-local",
            "--workspace",
            slug,
            "--plan",
            "standard",
            "--reason",
            "View share e2e",
        ],
        cwd=BACKEND_DIRECTORY,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, f"the comp grant failed: {result.stdout[-400:]} {result.stderr[-400:]}"


@pytest.fixture
def standard_workspace(
    api: Any, e2e_env: Any, local_stack: None, schedule_workspace_deletion: Any
) -> Iterator[dict[str, Any]]:
    """A Standard workspace this run owns, scheduled for deletion afterwards."""
    del local_stack
    suffix = secrets.token_hex(4)
    slug = f"{e2e_env.resource_prefix}share-{suffix}".replace("_", "-")[-40:].strip("-")
    created = api.post("/api/workspaces", json={"name": f"{e2e_env.resource_prefix}share", "slug": slug})
    assert created.status_code in (200, 201), f"creating the workspace answered {created.status_code}"
    workspace = dict(created.json())
    _grant_standard(workspace["slug"])
    yield workspace
    schedule_workspace_deletion(workspace["id"])


@WRITES
def test_a_view_share_lists_its_issues_anonymously(api: Any, anon: Any, standard_workspace: dict[str, Any]) -> None:
    """A team view link lists the view's issues as summaries, refuses the issue route and stops on revoke."""
    workspace_id = standard_workspace["id"]
    team = api.post(f"/api/workspaces/{workspace_id}/teams", json={"name": "Share e2e", "key_prefix": "SHV"})
    assert team.status_code in (200, 201), team.text[:400]
    team_id = team.json()["id"]
    issue = api.post(f"/api/workspaces/{workspace_id}/issues", json={"team_id": team_id, "title": "On the roadmap"})
    assert issue.status_code == 201, issue.text[:400]

    view = api.post(
        f"/api/workspaces/{workspace_id}/views",
        json={
            "name": "Public roadmap",
            "kind": "list",
            "team_id": team_id,
            "filter": {"team_id": team_id},
            "sort": "updated_desc",
        },
    )
    assert view.status_code == 201, view.text[:400]
    view_id = view.json().get("view_id") or view.json()["id"]

    path = f"/api/workspaces/{workspace_id}/share-links"
    link = api.post(path, json={"target_type": "view", "target_id": view_id})
    assert link.status_code == 201, link.text[:400]
    token = link.json()["token"]

    heading = anon.get(f"/api/shared/{token}")
    assert heading.status_code == 200, heading.text[:400]
    assert heading.json()["target_type"] == "view"

    page = anon.get(f"/api/shared/{token}/view")
    assert page.status_code == 200, page.text[:400]
    rows = page.json()["issues"]
    assert "On the roadmap" in [row["title"] for row in rows]
    assert all(not {"id", "issue_id", "team_id"} & set(row) for row in rows)
    assert anon.get(f"/api/shared/{token}/issue").status_code == 404

    revoked = api.delete(f"{path}/{link.json()['token_hash']}")
    assert revoked.status_code == 204, revoked.text[:400]
    assert anon.get(f"/api/shared/{token}/view").status_code == 404
