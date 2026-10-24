"""Where a team member's new issue lands, with the team's triage switch off and on.

The unit tests pin every create path in process. This module proves the deployed
shape: a team member files an issue with no status and it lands in the team's
first status while triage is off, and in the triage inbox once it is on, while
an issue that names a real status files straight into it.

Turning triage on needs the Standard plan, which only the comp grant script can
give a workspace without Stripe behind it, so this runs on the local stack alone.
Every deployed stage skips it.
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
        pytest.skip("turning triage on needs the comp grant script, which runs on the local stack only")


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
            "Triage e2e",
        ],
        cwd=BACKEND_DIRECTORY,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, f"the comp grant failed: {result.stdout[-400:]} {result.stderr[-400:]}"


@pytest.fixture
def triage_workspace(
    api: Any, e2e_env: Any, local_stack: None, schedule_workspace_deletion: Any
) -> Iterator[dict[str, Any]]:
    """A Standard workspace this run owns, scheduled for deletion afterwards."""
    del local_stack
    suffix = secrets.token_hex(4)
    slug = f"{e2e_env.resource_prefix}triage-{suffix}".replace("_", "-")[-40:].strip("-")
    created = api.post("/api/workspaces", json={"name": f"{e2e_env.resource_prefix}triage", "slug": slug})
    assert created.status_code in (200, 201), f"creating the workspace answered {created.status_code}"
    workspace = dict(created.json())
    _grant_standard(workspace["slug"])
    yield workspace
    schedule_workspace_deletion(workspace["id"])


def _file(api: Any, workspace_id: str, team_id: str, title: str, **fields: Any) -> dict[str, Any]:
    """File one issue as the signed in team member, failing on a refusal."""
    response = api.post(f"/api/workspaces/{workspace_id}/issues", json={"team_id": team_id, "title": title, **fields})
    assert response.status_code == 201, response.text[:400]
    return dict(response.json())


def _switch(api: Any, workspace_id: str, team_id: str, enabled: bool) -> None:
    """Flip the team's triage switch, failing on a refusal."""
    response = api.patch(f"/api/workspaces/{workspace_id}/teams/{team_id}/triage-settings", json={"enabled": enabled})
    assert response.status_code == 200, response.text[:400]
    assert response.json()["enabled"] is enabled


@WRITES
def test_a_members_new_issue_follows_the_triage_switch(api: Any, triage_workspace: dict[str, Any]) -> None:
    """Off, a new issue lands in the first status; on, it waits in triage unless it names a status."""
    workspace_id = triage_workspace["id"]
    team = api.post(f"/api/workspaces/{workspace_id}/teams", json={"name": "Triage e2e", "key_prefix": "TRI"})
    assert team.status_code in (200, 201), team.text[:400]
    team_id = team.json()["id"]
    statuses = api.get(f"/api/workspaces/{workspace_id}/teams/{team_id}/statuses")
    assert statuses.status_code == 200, statuses.text[:400]
    body = statuses.json()
    rows = body if isinstance(body, list) else body.get("statuses") or body.get("items") or []
    started = next(row["id"] for row in rows if row["category"] == "started")

    off = _file(api, workspace_id, team_id, "Filed while off")
    _switch(api, workspace_id, team_id, True)
    on = _file(api, workspace_id, team_id, "Filed while on")
    placed = _file(api, workspace_id, team_id, "Filed into a status", status_id=started)
    _switch(api, workspace_id, team_id, False)
    after = _file(api, workspace_id, team_id, "Filed after")

    assert off["in_triage"] is False
    assert on["in_triage"] is True
    assert placed["in_triage"] is False and placed["status_id"] == started
    assert after["in_triage"] is False and after["status_id"] == off["status_id"]
    waiting = api.get(f"/api/workspaces/{workspace_id}/issues/triage", params={"team_id": team_id})
    assert waiting.status_code == 200, waiting.text[:400]
    assert [row["id"] for row in waiting.json()["issues"]] == [on["id"]]
