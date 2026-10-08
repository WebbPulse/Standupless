"""The repositories each consumer function is granted, declared once.

A consumer runs in its domain's image but under its own Lambda function and its
own IAM policy, which is narrower than the domain's. Each entry here is that
policy written in repository names: the Terraform block of the same name must
match it, the entrypoint serves it, and `narrow` makes any bundle handed to the
consumer refuse what the function could not reach, so a test driving a code path
the grant does not cover fails the way the deployed function would.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Dict, Tuple

if TYPE_CHECKING:  # pragma: no cover
    from app.common.api.dependencies.repositories import RepositoryBundle


@dataclass(frozen=True)
class ConsumerScope:
    """One consumer function's grant, as repository names."""

    name: str
    domain: str
    repositories: Tuple[str, ...]
    """Repositories the function writes. The Terraform `tables` grant."""
    read_repositories: Tuple[str, ...]
    """Repositories the function only reads. The Terraform `read_tables` grant."""

    @property
    def all_repositories(self) -> Tuple[str, ...]:
        """Every repository the function's bundle carries, written and read alike."""
        return tuple(dict.fromkeys((*self.repositories, *self.read_repositories)))

    @property
    def read_only(self) -> Tuple[str, ...]:
        """The carried repositories the function may not write."""
        return tuple(name for name in self.all_repositories if name not in self.repositories)

    @property
    def tables(self) -> Tuple[str, ...]:
        """The tables the function writes, sorted."""
        from app.common.db.dynamo.registry import tables_for

        return tables_for(self.repositories)

    @property
    def read_tables(self) -> Tuple[str, ...]:
        """The tables the function only reads, sorted, excluding any it writes."""
        from app.common.db.dynamo.registry import tables_for

        return tuple(t for t in tables_for(self.read_repositories) if t not in self.tables)

    def bundle(self) -> "RepositoryBundle":
        """The bundle the deployed function serves from."""
        from app.common.api.dependencies.repositories import build_bundle

        return build_bundle(self.all_repositories, name=self.name, read_only=self.read_only)

    def narrow(self, bundle: "RepositoryBundle") -> "RepositoryBundle":
        """`bundle` cut down to this grant, unchanged when it already is.

        Anything that is not a repository bundle passes through, so a test handing
        in a hand-written fake keeps working.
        """
        from app.common.api.dependencies.repositories import RepositoryBundle

        if not isinstance(bundle, RepositoryBundle) or bundle.bundle_name == self.name:
            return bundle
        return bundle.scoped(self.all_repositories, read_only=self.read_only, name=self.name)


_VIEWS_CONSUMER_READS = (
    "memberships",
    "workspaces",
    "users",
    "teams",
    "team_config",
    "issues",
    "comments",
    "subscriptions",
    "planning",
)

CONSUMERS: Dict[str, ConsumerScope] = {
    scope.name: scope
    for scope in (
        ConsumerScope(
            name="views-notify-consumer",
            domain="views",
            repositories=("views", "inbox", "search_index"),
            read_repositories=(*_VIEWS_CONSUMER_READS, "activity"),
        ),
        ConsumerScope(
            name="views-search-consumer",
            domain="views",
            repositories=("views", "inbox", "search_index"),
            read_repositories=_VIEWS_CONSUMER_READS,
        ),
        ConsumerScope(
            name="planning-rollup-consumer",
            domain="planning",
            repositories=("planning", "releases", "idempotency"),
            read_repositories=("memberships", "workspaces", "users", "teams", "team_config", "issues"),
        ),
        ConsumerScope(
            name="integrations-events-consumer",
            domain="integrations",
            repositories=("github", "idempotency", "issues", "comments", "counters", "activity"),
            read_repositories=("memberships", "workspaces", "users", "teams", "team_config", "oauth_links"),
        ),
        ConsumerScope(
            name="integrations-dispatch-consumer",
            domain="integrations",
            repositories=("github", "idempotency", "team_config", "inbox"),
            read_repositories=(
                "memberships",
                "workspaces",
                "users",
                "teams",
                "issues",
                "activity",
                "comments",
                "oauth_links",
                "planning",
            ),
        ),
        ConsumerScope(
            name="integrations-stream-consumer",
            domain="integrations",
            repositories=("github",),
            read_repositories=(
                "memberships",
                "workspaces",
                "users",
                "teams",
                "team_config",
                "issues",
                "activity",
                "comments",
                "planning",
            ),
        ),
    )
}
"""Every hand-written consumer block in `terraform/lambda_domains.tf`, by function name."""
