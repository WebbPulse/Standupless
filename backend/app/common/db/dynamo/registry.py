"""One name per repository, and the table each one owns.

Entries are factories, never instances, so importing this catalogue constructs
no repository and reaches no DynamoDB client. `table` is the `TableSpec.suffix`.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Tuple


@dataclass(frozen=True)
class RepositorySpec:
    """Where a repository's class lives, and which table it owns.

    `module` and `class_name` are strings so reading this catalogue costs no
    import; `build()` is the only thing that imports.
    """

    name: str
    module: str
    class_name: str
    table: str

    def build(self, *, read_only: bool = False) -> Any:
        """Import the defining module and construct the repository.

        `read_only` injects a package repository that refuses writes, which is how
        a domain's `read_repositories` behave the way its `read_tables` grant does.
        """
        module = importlib.import_module(f"app.common.db.dynamo.{self.module}")
        cls = getattr(module, self.class_name)
        if not read_only:
            return cls()
        from app.common.db.dynamo.base import read_only_repository

        return cls(repository=read_only_repository(self.table))


def _spec(name: str, module: str, class_name: str, table: str) -> Tuple[str, RepositorySpec]:
    """Build one catalogue entry keyed by its repository name."""
    return name, RepositorySpec(name=name, module=module, class_name=class_name, table=table)


REPOSITORY_SPECS: Dict[str, RepositorySpec] = dict(
    [
        _spec("users", "users", "UserRepository", "users"),
        _spec("workspaces", "workspaces", "WorkspaceRepository", "workspaces"),
        _spec("memberships", "memberships", "MembershipRepository", "memberships"),
        _spec("invites", "invites", "InviteRepository", "invites"),
        _spec("projects", "projects", "ProjectRepository", "projects"),
        _spec("project_config", "project_config", "ProjectConfigRepository", "project_config"),
        _spec("counters", "counters", "CounterRepository", "counters"),
        _spec("issues", "issues", "IssueRepository", "issues"),
        _spec("relations", "relations", "RelationRepository", "relations"),
        _spec("activity", "activity", "ActivityRepository", "activity"),
        _spec("views", "views", "ViewRepository", "views"),
        _spec("inbox", "inbox", "InboxRepository", "inbox"),
        _spec("search_index", "search_index", "SearchIndexRepository", "search_index"),
        _spec("comments", "comments", "CommentRepository", "comments"),
        _spec("reactions", "reactions", "ReactionRepository", "reactions"),
        _spec("attachments", "attachments", "AttachmentRepository", "attachments"),
        _spec("planning", "planning", "PlanningRepository", "planning"),
        _spec("github", "github", "GithubRepository", "github"),
        _spec("idempotency", "idempotency", "IdempotencyRepository", "idempotency"),
    ]
)

ALL_REPOSITORY_NAMES: Tuple[str, ...] = tuple(REPOSITORY_SPECS)


def tables_for(repositories: Iterable[str]) -> Tuple[str, ...]:
    """The table suffixes these repositories reach, sorted and deduplicated.

    Read by the `Domain` descriptor so the domain's declared data surface and the
    Terraform IAM policy cannot disagree.
    """
    return tuple(sorted({REPOSITORY_SPECS[name].table for name in repositories}))
