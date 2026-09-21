"""The repository bundle a process serves its routes from.

Each bundle declares the repositories its domain carries and builds them lazily,
so a process imports only the data layer its own routes touch. Asking for a
repository outside the set raises rather than reaching a table the function has
no IAM grant on.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any, Dict, FrozenSet, Iterable, Optional, Tuple

from app.common.db.dynamo.registry import ALL_REPOSITORY_NAMES, REPOSITORY_SPECS

if TYPE_CHECKING:  # pragma: no cover
    from app.common.db.dynamo.activity import ActivityRepository
    from app.common.db.dynamo.comments import CommentRepository
    from app.common.db.dynamo.counters import CounterRepository
    from app.common.db.dynamo.github import GithubRepository
    from app.common.db.dynamo.idempotency import IdempotencyRepository
    from app.common.db.dynamo.identity_stores import ApiKeyStoreRepository, ShareTokenStoreRepository
    from app.common.db.dynamo.inbox import InboxRepository
    from app.common.db.dynamo.invites import InviteRepository
    from app.common.db.dynamo.issues import IssueRepository
    from app.common.db.dynamo.memberships import MembershipRepository
    from app.common.db.dynamo.team_config import TeamConfigRepository
    from app.common.db.dynamo.teams import TeamRepository
    from app.common.db.dynamo.relations import RelationRepository
    from app.common.db.dynamo.search_index import SearchIndexRepository
    from app.common.db.dynamo.users import UserRepository
    from app.common.db.dynamo.views import ViewRepository
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
    Names in `read_only` build against a package repository that refuses writes,
    so a route writing a table its function only reads fails here, not in AWS.
    """

    __slots__ = ("_name", "_names", "_read_only", "_shared", "_built", "_lock")

    def __init__(
        self,
        names: Iterable[str],
        *,
        name: str = "all",
        read_only: Iterable[str] = (),
        shared: "RepositoryBundle | None" = None,
    ) -> None:
        """Record the declared repository names, rejecting unknown ones.

        `shared` is another bundle whose writable instances this one reuses,
        which is how a scoped view keeps the fixture's repositories in tests.
        """
        declared = tuple(dict.fromkeys(names))
        unknown = sorted(set(declared) - set(REPOSITORY_SPECS))
        if unknown:
            raise ValueError(f"{name!r} declares unknown repositories: {', '.join(unknown)}")
        read_set = frozenset(read_only)
        undeclared = sorted(read_set - set(declared))
        if undeclared:
            raise ValueError(f"{name!r} marks undeclared repositories read only: {', '.join(undeclared)}")
        self._name = name
        self._names = declared
        self._read_only: FrozenSet[str] = read_set
        self._shared = shared
        self._built: Dict[str, Any] = {}
        self._lock = threading.Lock()

    def scoped(self, names: Iterable[str], *, read_only: Iterable[str] = (), name: str) -> "RepositoryBundle":
        """A view of this bundle carrying only `names`, with `read_only` refusing writes.

        Writable repositories come from this bundle, read-only ones are built
        fresh, and asking for anything else raises as it would in the function.
        """
        wanted = tuple(dict.fromkeys(names))
        missing = sorted(set(wanted) - set(self._names))
        if missing:
            raise ValueError(f"{self._name!r} cannot scope to {name!r}: it lacks {', '.join(missing)}")
        return RepositoryBundle(wanted, name=name, read_only=read_only, shared=self)

    @property
    def bundle_name(self) -> str:
        """The name of this bundle, used in error messages."""
        return self._name

    @property
    def repository_names(self) -> Tuple[str, ...]:
        """The repositories this bundle carries, in declaration order."""
        return self._names

    @property
    def read_only_names(self) -> Tuple[str, ...]:
        """The repositories this bundle refuses to write, in declaration order."""
        return tuple(name for name in self._names if name in self._read_only)

    def is_read_only(self, repository: str) -> bool:
        """Whether this bundle refuses writes through `repository`.

        Asked rather than discovered by catching a refusal, so a caller whose write
        is optional can skip it instead of having to tell a read-only grant apart
        from a genuine failure. A name this bundle does not carry answers `True`:
        the only honest answer for a repository that cannot be written here at all.
        """
        return repository not in self._names or repository in self._read_only

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
                self._built[item] = self._build(item)
            return self._built[item]

    def _build(self, item: str) -> Any:
        """Construct `item`, read only when declared so, else from the shared bundle."""
        if item in self._read_only:
            return REPOSITORY_SPECS[item].build(read_only=True)
        if self._shared is not None:
            return getattr(self._shared, item)
        return REPOSITORY_SPECS[item].build()

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
        teams: "TeamRepository"
        team_config: "TeamConfigRepository"
        counters: "CounterRepository"
        issues: "IssueRepository"
        relations: "RelationRepository"
        activity: "ActivityRepository"
        comments: "CommentRepository"
        views: "ViewRepository"
        inbox: "InboxRepository"
        search_index: "SearchIndexRepository"
        idempotency: "IdempotencyRepository"
        github: "GithubRepository"
        api_keys: "ApiKeyStoreRepository"
        share_links: "ShareTokenStoreRepository"


Repositories = RepositoryBundle


_default: Optional[RepositoryBundle] = None
_default_lock = threading.Lock()


def build_bundle(names: Iterable[str], *, name: str = "all", read_only: Iterable[str] = ()) -> RepositoryBundle:
    """A bundle carrying exactly `names`, building nothing yet."""
    return RepositoryBundle(names, name=name, read_only=read_only)


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
    override and not a module-level global. When `build_domain_app` recorded the
    application's declared scope, `bundle` is narrowed to it first, so a test
    binding the all-carrying fixture still sees exactly the function's grants.
    """
    scope = getattr(app.state, "repository_scope", None)
    if scope is not None:
        bundle = bundle.scoped(scope.names, read_only=scope.read_only, name=scope.name)
    app.dependency_overrides[get_repositories] = lambda: bundle
    return bundle


def repositories_for(request: "Any") -> RepositoryBundle:
    """The bundle serving `request`, honouring the application's binding.

    `Depends(get_repositories)` is the route's way in, and this is the same answer
    for code that holds only a request. Reads the application's override so a caller
    outside the dependency graph still sees the narrowed bundle rather than the
    all-carrying default, which is what keeps an ungranted table unreachable there
    too.
    """
    app = request.app
    override = app.dependency_overrides.get(get_repositories)
    return override() if override is not None else get_repositories()


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
    "repositories_for",
    "reset_default_repositories",
]
