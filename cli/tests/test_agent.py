"""`standupless agent`: restoring a private agent profile onto a fresh machine."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import respx
from typer.testing import CliRunner

from standupless_cli import agent
from tests.conftest import invoke

pytestmark = pytest.mark.usefixtures("logged_in")

PROFILE = "/api/users/me/agent-profiles/laptop"


def snapshot(files: list[dict[str, str]], version: int = 3) -> dict[str, Any]:
    """A profile version as the API answers it."""
    return {
        "name": "laptop",
        "version": version,
        "latest_version": 3,
        "created_at": "2026-10-14T00:00:00Z",
        "sha256": "0" * 64,
        "roots": {"home": "~", "project": ".", "memory": "memory"},
        "files": files,
    }


FILES = [
    {"root": "home", "path": ".claude/CLAUDE.md", "content": "# Global rules\nnew line\n"},
    {"root": "project", "path": "CLAUDE.local.md", "content": "project notes\n"},
    {"root": "memory", "path": "MEMORY.md", "content": "- [Rule](rule.md)\n"},
]


@pytest.fixture
def machine(tmp_path: Path) -> tuple[Path, Path]:
    """A home folder holding an older global CLAUDE.md, and an empty project checkout."""
    home = tmp_path / "home"
    project = tmp_path / "work" / "My.Repo"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "CLAUDE.md").write_text("# Global rules\nold line\n")
    project.mkdir(parents=True)
    return home, project


def pull(runner: CliRunner, machine: tuple[Path, Path], *extra: str, input: str | None = None) -> Any:
    """Run `agent pull laptop` against the temporary machine."""
    home, project = machine
    return invoke(
        runner, "agent", "pull", "laptop", "--home", str(home), "--project", str(project), *extra, input=input
    )


def test_memory_maps_to_claude_codes_folder_for_the_checkout(tmp_path: Path) -> None:
    project = tmp_path / "a b" / "Web.Pulse"
    project.mkdir(parents=True)

    folder = agent.memory_dir(tmp_path, project)

    assert folder.parent.parent == tmp_path / ".claude" / "projects"
    assert folder.parent.name.endswith("-a-b-Web-Pulse")
    assert folder.name == "memory"


@pytest.mark.parametrize("path", ["../escape.md", "/etc/passwd", "~/x", "a/../../b", ""])
def test_a_path_leaving_its_root_is_refused(tmp_path: Path, path: str) -> None:
    with pytest.raises(agent.RestoreError):
        agent.target({"home": tmp_path}, "home", path)


def test_pull_shows_the_diff_and_writes_after_a_yes(
    runner: CliRunner, api: respx.MockRouter, machine: tuple[Path, Path]
) -> None:
    home, project = machine
    route = api.get(PROFILE).respond(json=snapshot(FILES))

    result = pull(runner, machine, input="y\n")

    assert result.exit_code == 0, result.output
    assert "-old line" in result.stdout and "+new line" in result.stdout
    assert (home / ".claude" / "CLAUDE.md").read_text().endswith("new line\n")
    assert (project / "CLAUDE.local.md").read_text() == "project notes\n"
    assert (agent.memory_dir(home, project) / "MEMORY.md").read_text() == "- [Rule](rule.md)\n"
    assert "version" not in route.calls.last.request.url.params


def test_declining_writes_nothing(runner: CliRunner, api: respx.MockRouter, machine: tuple[Path, Path]) -> None:
    home, project = machine
    api.get(PROFILE).respond(json=snapshot(FILES))

    result = pull(runner, machine, input="n\n")

    assert result.exit_code == 1
    assert (home / ".claude" / "CLAUDE.md").read_text().endswith("old line\n")
    assert not (project / "CLAUDE.local.md").exists()


def test_a_dry_run_writes_nothing(runner: CliRunner, api: respx.MockRouter, machine: tuple[Path, Path]) -> None:
    home, _ = machine
    api.get(PROFILE).respond(json=snapshot(FILES))

    result = pull(runner, machine, "--dry-run")

    assert result.exit_code == 0, result.output
    assert "+new line" in result.stdout
    assert (home / ".claude" / "CLAUDE.md").read_text().endswith("old line\n")


def test_an_older_version_is_asked_for_by_number(
    runner: CliRunner, api: respx.MockRouter, machine: tuple[Path, Path]
) -> None:
    home, _ = machine
    route = api.get(PROFILE).respond(json=snapshot(FILES[:1], version=1))

    result = pull(runner, machine, "--version", "1", "--yes")

    assert result.exit_code == 0, result.output
    assert route.calls.last.request.url.params["version"] == "1"
    assert (home / ".claude" / "CLAUDE.md").read_text().endswith("new line\n")


def test_an_unchanged_machine_is_up_to_date(
    runner: CliRunner, api: respx.MockRouter, machine: tuple[Path, Path]
) -> None:
    home, _ = machine
    api.get(PROFILE).respond(json=snapshot([{**FILES[0], "content": "# Global rules\nold line\n"}]))

    result = pull(runner, machine)

    assert result.exit_code == 0, result.output
    assert "up to date" in result.stderr


def test_an_unsafe_path_from_the_server_writes_nothing(
    runner: CliRunner, api: respx.MockRouter, machine: tuple[Path, Path]
) -> None:
    home, _ = machine
    api.get(PROFILE).respond(json=snapshot([FILES[1], {"root": "home", "path": "../outside.md", "content": "x"}]))

    result = pull(runner, machine, "--yes")

    assert result.exit_code == 1
    assert "not a path inside its root" in result.stderr
    assert not (home.parent / "outside.md").exists()


def test_list_and_versions_print_tables(runner: CliRunner, api: respx.MockRouter) -> None:
    api.get("/api/users/me/agent-profiles").respond(
        json={
            "max_profiles": 50,
            "versions_kept": 10,
            "profiles": [
                {
                    "name": "laptop",
                    "latest_version": 3,
                    "file_count": 4,
                    "total_bytes": 900,
                    "created_at": "x",
                    "updated_at": "2026-10-14T00:00:00Z",
                }
            ],
        }
    )
    api.get(f"{PROFILE}/versions").respond(
        json={
            "name": "laptop",
            "latest_version": 3,
            "versions_kept": 10,
            "versions": [
                {
                    "version": 3,
                    "created_at": "2026-10-14T00:00:00Z",
                    "source": "mcp",
                    "file_count": 4,
                    "total_bytes": 900,
                    "sha256": "0" * 64,
                    "latest": True,
                    "note": "added skills",
                }
            ],
        }
    )

    listed = invoke(runner, "agent", "list")
    versions = invoke(runner, "agent", "versions", "laptop")

    assert listed.exit_code == 0, listed.output
    assert "laptop" in listed.stdout
    assert versions.exit_code == 0, versions.output
    assert "added skills" in versions.stdout
