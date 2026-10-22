"""The sub-initiative tree of a workspace, built from each initiative's `parent_initiative_id`.

A parent is held on the child row alone, so the tree is rebuilt from one read
of the workspace's initiatives rather than kept in step on both sides. Every
walk carries a visited set, so a cycle that slipped in through a race reads as a
cut branch rather than a loop that never ends.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional

from app.common.db.dynamo.planning import Initiative

MAX_INITIATIVE_DEPTH = 5
"""The most levels one chain of initiatives may run to, the root counted as the first."""


@dataclass
class InitiativeTree:
    """A workspace's initiatives keyed by id, with each one's direct children."""

    rows: dict[str, Initiative]
    children: dict[str, list[str]] = field(default_factory=dict)

    @classmethod
    def build(cls, initiatives: Iterable[Initiative]) -> "InitiativeTree":
        """Index the initiatives and group each under a parent that exists."""
        rows = {row.initiative_id: row for row in initiatives}
        children: dict[str, list[str]] = {}
        for row in rows.values():
            parent = row.parent_initiative_id
            if parent and parent in rows and parent != row.initiative_id:
                children.setdefault(parent, []).append(row.initiative_id)
        return cls(rows=rows, children=children)

    def parent_of(self, initiative_id: str) -> Optional[str]:
        """The parent an initiative points at, when that parent still exists."""
        row = self.rows.get(initiative_id)
        if row is None or not row.parent_initiative_id or row.parent_initiative_id not in self.rows:
            return None
        return row.parent_initiative_id

    def ancestors(self, initiative_id: str) -> list[Initiative]:
        """The chain of parents above an initiative, root first."""
        chain: list[Initiative] = []
        seen = {initiative_id}
        current = self.parent_of(initiative_id)
        while current is not None and current not in seen:
            seen.add(current)
            chain.append(self.rows[current])
            current = self.parent_of(current)
        chain.reverse()
        return chain

    def descendants(self, initiative_id: str) -> list[str]:
        """Every initiative below one, nearest first, never the initiative itself."""
        found: list[str] = []
        seen = {initiative_id}
        frontier = [initiative_id]
        while frontier:
            next_frontier: list[str] = []
            for node in frontier:
                for child in self.children.get(node, []):
                    if child not in seen:
                        seen.add(child)
                        found.append(child)
                        next_frontier.append(child)
            frontier = next_frontier
        return found

    def subtree(self, initiative_id: str) -> list[str]:
        """An initiative and every initiative below it."""
        return [initiative_id, *self.descendants(initiative_id)]

    def height(self, initiative_id: str) -> int:
        """How many levels an initiative's subtree spans, itself counted as one."""
        levels = 0
        seen = {initiative_id}
        frontier = [initiative_id]
        while frontier:
            levels += 1
            next_frontier: list[str] = []
            for node in frontier:
                for child in self.children.get(node, []):
                    if child not in seen:
                        seen.add(child)
                        next_frontier.append(child)
            frontier = next_frontier
        return levels

    def depth(self, initiative_id: str) -> int:
        """Which level an initiative sits on, a root being the first."""
        return len(self.ancestors(initiative_id)) + 1

    def refusal(self, initiative_id: Optional[str], parent_id: str) -> Optional[str]:
        """Why an initiative may not sit under a parent, or `None` when it may.

        `initiative_id` is `None` for an initiative not yet created, which has no
        subtree of its own to carry under the parent.
        """
        if parent_id not in self.rows:
            return f"No such initiative: {parent_id}"
        if initiative_id is not None:
            if parent_id == initiative_id:
                return "An initiative cannot be its own parent"
            if parent_id in self.descendants(initiative_id):
                return "An initiative cannot sit under one of its own sub-initiatives"
        carried = self.height(initiative_id) if initiative_id is not None and initiative_id in self.rows else 1
        if self.depth(parent_id) + carried > MAX_INITIATIVE_DEPTH:
            return f"Initiatives nest at most {MAX_INITIATIVE_DEPTH} levels deep"
        return None
