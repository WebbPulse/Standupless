"""The repository bundle a process serves its routes from.

Each bundle declares the repositories its domain carries and builds them lazily,
so a process imports only the data layer its own routes touch. Asking for a
repository outside the set raises rather than reaching a table the function has
no IAM grant on.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any, Dict, Iterable, Optional, Tuple

from app.common.db.dynamo.registry import ALL_REPOSITORY_NAMES, REPOSITORY_SPECS

if TYPE_CHECKING:  # pragma: no cover
    from app.common.db.dynamo.activity import ActivityRepository
    from app.common.db.dynamo.counters import CounterRepository
    from app.common.db.dynamo.idempotency import IdempotencyRepository
    from app.common.db.dynamo.invites import InviteRepository
    from app.common.db.dynamo.issues import IssueRepository
    from app.common.db.dynamo.memberships import MembershipRepository
    from app.common.db.dynamo.project_config import ProjectConfigRepository
    from app.common.db.dynamo.projects import ProjectRepository
    from app.common.db.dynamo.relations import RelationRepository
    from app.common.db.dynamo.users import UserRepository
    from app.common.db.dynamo.workspaces import WorkspaceRepository


class RepositoryNotInBundle(AttributeError):
    """A route asked for a repository its own domain does not carry.

    Subclasses AttributeError so getattr and hasattr keep their usual behaviour.
    """

    def __init__(self, bundle_name: str, repository: str) -> None:
        """Build the message naming the bundle, repository and table."""
        spec = REPOSITORY_SPECS.get(repository)
        if spec is None:
            message = f"{bundle_name!r} has no repository {repository!r}, and neither does any domain"
        else:
            message = (
                f"{bundle_name!r} does not carry the {repository!r} repository, "
                f"which owns the {spec.table!r} table. Either the route belongs to "
                f"another domain, or {bundle_name!r} needs {repository!r} added to "
                f"its `repositories` tuple in app/common/composition/domains.py and "
                f"the matching IAM grant in Terraform."
            )
        super().__init__(message)
        self.bundle_name = bundle_name
        self.repository = repository
        self.table = spec.table if spec is not None else None


class RepositoryBundle:
    """The repositories one process may use, built on first access.

    Attribute access is the whole interface: `repos.workspaces.list_for_user(...)`.
    """

    __slots__ = ("_name", "_names", "_built", "_lock")

    def __init__(self, names: Iterable[str], *, name: str = "all") -> None:
        """Record the declared repository names, rejecting unknown ones."""
        declared = tuple(dict.fromkeys(names))
        unknown = sorted(set(declared) - set(REPOSITORY_SPECS))
        if unknown:
            raise ValueError(f"{name!r} declares unknown repositories: {', '.join(unknown)}")
        self._name = name
        self._names = declared
        self._built: Dict[str, Any] = {}
        self._lock = threading.Lock()

    @property
    def bundle_name(self) -> str:
        """The name of this bundle, used in error messages."""
        return self._name

    @property
    def repository_names(self) -> Tuple[str, ...]:
        """The repositories this bundle carries, in declaration order."""
        return self._names

    @property
    def tables(self) -> Tuple[str, ...]:
        """The table suffixes this bundle can reach, sorted.

        This is the function's data surface, and it is what a Terraform IAM
        policy for the domain has to cover.
        """
        return tuple(sorted({REPOSITORY_SPECS[name].table for name in self._names}))

    def __getattr__(self, item: str) -> Any:
        """Return a declared repository, building it on first access."""
        if item not in self._names:
            raise RepositoryNotInBundle(self._name, item)
        try:
            return self._built[item]
        except KeyError:
            pass
        with self._lock:
            if item not in self._built:
                self._built[item] = REPOSITORY_SPECS[item].build()
            return self._built[item]

    def __dir__(self) -> "list[str]":
        """List the declared repositories alongside the normal attributes."""
        return sorted(set(super().__dir__()) | set(self._names))

    def __repr__(self) -> str:
        """Summarise the bundle's name and how many repositories are built."""
        built = sorted(self._built)
        return f"<RepositoryBundle {self._name!r} carries={len(self._names)} built={built}>"

    if TYPE_CHECKING:  # pragma: no cover
        users: "UserRepository"
        workspaces: "WorkspaceRepository"
        memberships: "MembershipRepository"
        invites: "InviteRepository"
        projects: "ProjectRepository"
        project_config: "ProjectConfigRepository"
        counters: "CounterRepository"
        issues: "IssueRepository"
        relations: "RelationRepository"
        activity: "ActivityRepository"
        idempotency: "IdempotencyRepository"


Repositories = RepositoryBundle


_default: Optional[RepositoryBundle] = None
_default_lock = threading.Lock()


def build_bundle(names: Iterable[str], *, name: str = "all") -> RepositoryBundle:
    """A bundle carrying exactly `names`, building nothing yet."""
    return RepositoryBundle(names, name=name)


def get_repositories() -> RepositoryBundle:
    """The process default bundle, carrying every repository.

    This is the dependency the routes name, but a route serving a request almost
    never reaches this body: `bind_repositories` overrides it per application
    with the bundle that application's domains declared.
    """
    global _default
    if _default is None:
        with _default_lock:
            if _default is None:
                _default = RepositoryBundle(ALL_REPOSITORY_NAMES, name="all")
    return _default


def bind_repositories(app: "Any", bundle: RepositoryBundle) -> RepositoryBundle:
    """Make `app` resolve `Depends(get_repositories)` to `bundle`.

    Per application rather than per process, which is why this is a dependency
    override and not a module-level global.
    """
    app.dependency_overrides[get_repositories] = lambda: bundle
    return bundle


def reset_default_repositories() -> None:
    """Drop the memoised process default. For tests that assert laziness."""
    global _default
    with _default_lock:
        _default = None


__all__ = [
    "ALL_REPOSITORY_NAMES",
    "RepositoryBundle",
    "RepositoryNotInBundle",
    "Repositories",
    "bind_repositories",
    "build_bundle",
    "get_repositories",
    "reset_default_repositories",
]
