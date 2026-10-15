"""Restoring a private agent profile onto this machine.

A profile stores each file under one of three roots with a path relative to it, so
the same profile lands correctly on any machine: `home` is the home directory,
`project` is the project checkout, and `memory` is Claude Code's memory folder for
that project, whose name Claude Code derives from the checkout's absolute path.
Nothing is written outside its root, and nothing that differs is overwritten
without the person seeing the diff first.
"""

from __future__ import annotations

import difflib
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

ROOTS = ("home", "project", "memory")


class RestoreError(Exception):
    """A profile file that cannot be placed safely on this machine."""


def memory_dir(home: Path, project: Path) -> Path:
    """Claude Code's memory folder for a project checkout.

    Claude Code names a project's folder under `~/.claude/projects` by its absolute
    path with every character other than a letter, digit or hyphen turned into a hyphen.
    """
    slug = re.sub(r"[^A-Za-z0-9-]", "-", str(project.resolve()))
    return home / ".claude" / "projects" / slug / "memory"


def root_dirs(home: Path, project: Path) -> dict[str, Path]:
    """Where each root is on this machine."""
    return {"home": home, "project": project.resolve(), "memory": memory_dir(home, project)}


def target(roots: Mapping[str, Path], root: str, path: str) -> Path:
    """The local file for one profile entry, refusing any path that would leave its root."""
    if root not in roots:
        raise RestoreError(f"{root}:{path} names an unknown root; expected one of {', '.join(ROOTS)}.")
    relative = PurePosixPath(path)
    if not path or relative.is_absolute() or ".." in relative.parts or "\\" in path or path.startswith("~"):
        raise RestoreError(f"{root}:{path} is not a path inside its root.")
    base = roots[root].resolve()
    resolved = (base / Path(*relative.parts)).resolve()
    if resolved != base and base not in resolved.parents:
        raise RestoreError(f"{root}:{path} resolves outside {base}.")
    return resolved


@dataclass(frozen=True)
class Change:
    """One file of the profile against what is on disk now."""

    root: str
    path: str
    target: Path
    content: str
    current: str | None

    @property
    def kind(self) -> str:
        """new, changed or same."""
        if self.current is None:
            return "new"
        return "same" if self.current == self.content else "changed"

    def diff(self) -> str:
        """A unified diff from the file on disk to the profile's copy."""
        return "".join(
            difflib.unified_diff(
                (self.current or "").splitlines(keepends=True),
                self.content.splitlines(keepends=True),
                fromfile=f"{self.target} (on disk)",
                tofile=f"{self.root}:{self.path} (profile)",
            )
        )


def plan(files: Iterable[Mapping[str, Any]], roots: Mapping[str, Path]) -> list[Change]:
    """Every profile file with its local target and current content, refusing unsafe paths up front."""
    changes: list[Change] = []
    for item in files:
        root, path, content = str(item["root"]), str(item["path"]), str(item["content"])
        local = target(roots, root, path)
        if local.is_dir():
            raise RestoreError(f"{root}:{path} is a directory at {local}.")
        current = local.read_text(encoding="utf-8", errors="replace") if local.exists() else None
        changes.append(Change(root=root, path=path, target=local, content=content, current=current))
    return changes


def write(change: Change) -> None:
    """Write one file, creating its folders."""
    change.target.parent.mkdir(parents=True, exist_ok=True)
    change.target.write_text(change.content, encoding="utf-8")
