"""The views purge consumer's entrypoint, run as its own Lambda function.

Same image as the `views` routes, a different command, behind the team
purge's views queue and no gateway route.
"""

from typing import TYPE_CHECKING

from app.common import team_purge

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import APIRouter, FastAPI


def _router() -> "APIRouter":
    """This stage's consumer router alone."""
    from app.domains.views.consumers.purge import build_router

    return build_router()


DOMAIN = team_purge.consumer_domain("views", _router)


def build_app() -> "FastAPI":
    """The consumer route and the root probes, and nothing else."""
    return team_purge.build_app(DOMAIN)


def main() -> None:
    """Serve this stage's application."""
    team_purge.serve(DOMAIN)


if __name__ == "__main__":
    main()
