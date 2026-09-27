"""The `standupless` CLI driven against the deployed stage with a real API key.

The CLI is a separate package in `cli/`, so its unit tests mock the API. This module
is what proves the two meet: the run mints a short lived user API key for its own
workspace, then runs the installed console script as a subprocess, the way a software
engineer runs it from a script: resolving the key's workspace, listing teams, the issue
lifecycle and a branch name.

It also covers the API key routes themselves. Minting a key per run used to be why they
sat in the coverage allowlist; the key here expires in a day, lives in a workspace the
run schedules for deletion, and is revoked inside the test so the revoke is counted.

The CLI runs under `uv run --project ../cli`, which builds its own environment from
`cli/uv.lock`. Both e2e workflows check out the whole repository and put uv on the
path, so nothing extra is installed into the e2e group.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
from webbpulse.e2e import worker_id

WRITES = pytest.mark.e2e_writes

CLI_PROJECT = Path(__file__).resolve().parents[2] / "cli"
SCOPES = ["issues:read", "issues:write", "comments:write", "teams:read", "views:read"]


@pytest.fixture(scope="session")
def cli_workspace(api: Any, e2e_env: Any, request: pytest.FixtureRequest) -> Any:
    """A workspace and team this run owns, scheduled for deletion afterwards.

    Named with the worker id because a slug is unique across every tenant and session
    fixtures are per worker under xdist.
    """
    worker = worker_id(request.config)
    prefix = e2e_env.resource_prefix if worker == "master" else f"{e2e_env.resource_prefix}{worker}-"
    body = {"name": f"{prefix}cli", "slug": f"{prefix}cli".replace("_", "-")[-40:].strip("-")}
    response = api.post("/api/workspaces", json=body)
    if response.status_code not in (200, 201):
        pytest.fail(f"creating the CLI workspace answered {response.status_code}: {response.text[:400]}")
    workspace = dict(response.json())
    teams = f"/api/workspaces/{workspace['id']}/teams"
    team = api.post(teams, json={"name": f"{prefix}cli-team", "key_prefix": "CLI"})
    if team.status_code not in (200, 201):
        pytest.fail(f"creating the CLI team answered {team.status_code}: {team.text[:400]}")
    workspace["team"] = dict(team.json())
    yield workspace
    api.delete(f"{teams}/{workspace['team']['id']}")
    api.post(f"/api/workspaces/{workspace['id']}/deletion", json={"confirm_name": workspace["name"]})


def _cli(env: dict[str, str], *args: str, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    """Run one CLI command and fail with its output when it exits non-zero."""
    uv = shutil.which("uv")
    assert uv, "uv is not on the path, and the CLI runs through `uv run --project cli`."
    result = subprocess.run(
        [uv, "run", "--quiet", "--locked", "--project", str(CLI_PROJECT), "standupless", *args],
        input=stdin,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert result.returncode == 0, f"standupless {' '.join(args)} exited {result.returncode}: {result.stderr[-2000:]}"
    return result


@WRITES
def test_the_cli_runs_the_issue_lifecycle_with_an_api_key(
    api: Any, e2e_env: Any, gate_headers: Any, cli_workspace: Any, tmp_path: Path
) -> None:
    """Mint a key, log in with it, and create, view, comment on, branch and close an issue."""
    keys = f"/api/workspaces/{cli_workspace['id']}/api-keys"
    minted = api.post(keys, json={"name": "e2e cli", "scopes": SCOPES, "kind": "user", "expires_in_days": 1})
    assert minted.status_code == 201, f"minting a user API key answered {minted.status_code}: {minted.text[:400]}"
    key = minted.json()
    try:
        env = {
            name: value
            for name, value in os.environ.items()
            if not name.startswith(("STANDUPLESS_", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"))
        }
        env.update(
            {
                "XDG_CONFIG_HOME": str(tmp_path),
                "PYTHON_KEYRING_BACKEND": "keyring.backends.fail.Keyring",
                "STANDUPLESS_BASE_URL": e2e_env.api_base_url,
                "STANDUPLESS_API_KEY": key["secret"],
                "STANDUPLESS_EXTRA_HEADERS": json.dumps(dict(gate_headers)),
                "NO_COLOR": "1",
                "COLUMNS": "200",
            }
        )

        status = json.loads(_cli(env, "auth", "status", "--json").stdout)
        assert status["workspace"]["id"] == cli_workspace["id"], (
            f"the CLI resolved the key to {status['workspace']}, not the workspace it was minted in"
        )
        env["STANDUPLESS_WORKSPACE"] = cli_workspace["id"]

        teams = json.loads(_cli(env, "team", "list", "--json").stdout)
        assert [team["key_prefix"] for team in teams] == ["CLI"]

        created = json.loads(
            _cli(
                env,
                "issue",
                "create",
                "--team",
                "CLI",
                "--title",
                "Fix the login page",
                "-F",
                "-",
                "--priority",
                "high",
                "--json",
                stdin="Filed from the CLI e2e.",
            ).stdout
        )
        issue_key = created["key"]
        assert issue_key.startswith("CLI-")
        assert created["priority"] == "high"

        _cli(env, "issue", "comment", issue_key, "-b", "Commented from the CLI.")
        viewed = json.loads(_cli(env, "issue", "view", issue_key, "--comments", "--json").stdout)
        assert viewed["body"] == "Filed from the CLI e2e."
        assert [comment["body"] for comment in viewed["comments"]] == ["Commented from the CLI."]

        listed = json.loads(_cli(env, "issue", "list", "--team", "CLI", "--json").stdout)
        assert issue_key in [issue["key"] for issue in listed]

        branch = _cli(env, "issue", "branch", issue_key).stdout.strip()
        assert branch == f"{issue_key.lower()}-fix-the-login-page"

        closed = json.loads(_cli(env, "issue", "close", issue_key, "--json").stdout)
        statuses = api.get(f"/api/workspaces/{cli_workspace['id']}/teams/{cli_workspace['team']['id']}/statuses")
        categories = {status["id"]: status["category"] for status in statuses.json()["statuses"]}
        assert categories[closed["status_id"]] == "completed"

        still_open = json.loads(_cli(env, "issue", "list", "--team", "CLI", "--json").stdout)
        assert issue_key not in [issue["key"] for issue in still_open]

        listed_keys = api.get(keys)
        assert listed_keys.status_code == 200
        assert key["key_id"] in [row["key_id"] for row in listed_keys.json()["api_keys"]]
    finally:
        revoked = api.delete(f"{keys}/{key['key_id']}")
    assert revoked.status_code == 204, f"revoking the CLI key answered {revoked.status_code}: {revoked.text[:400]}"
