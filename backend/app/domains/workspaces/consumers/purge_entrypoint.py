"""The workspaces purge consumer's entrypoint, run as its own Lambda function.

Same image as the `workspaces` routes, a different command, behind the purge
chain's workspaces queue and the hourly sweep schedule, with no gateway route.
Unlike the other stages it carries write on the users table, because the account
purge marks and deletes the users row.
"""

from dataclasses import replace
from typing import TYPE_CHECKING

from app.common import team_purge

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import APIRouter, FastAPI

    from app.common.composition.wiring import Domain


def _router() -> "APIRouter":
    """This stage's consumer router alone."""
    from app.domains.workspaces.consumers.purge import build_router

    return build_router()


def _domain() -> "Domain":
    """The stage's descriptor, widened to the users table it writes."""
    from app.domains.workspaces.consumers.purge import REPOSITORIES

    return replace(
        team_purge.consumer_domain("workspaces", _router),
        repositories=REPOSITORIES,
        read_repositories=(),
    )


DOMAIN = _domain()


def build_app() -> "FastAPI":
    """The consumer route and the root probes, and nothing else."""
    return team_purge.build_app(DOMAIN)


def main() -> None:
    """Serve this stage's application."""
    team_purge.serve(DOMAIN)


if __name__ == "__main__":
    main()
