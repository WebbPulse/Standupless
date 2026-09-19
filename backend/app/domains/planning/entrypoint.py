"""The planning domain's entrypoint, run as `python -m app.domains.planning.entrypoint`.

Cycles, milestones and the workspace roadmap under `/api/workspaces/{workspace_id}`.
Verifies identity access tokens through the gateway authorizer's claims, so it needs
no application secret. The rollup consumer is a separate function off the same image,
because it is driven by a stream event source rather than by the gateway.
"""

from typing import TYPE_CHECKING

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import (
    build_domain_app,
    check_signing_key,
    configure_logging,
    configure_tracing,
)

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import FastAPI

DOMAIN = DOMAINS["planning"]


def build_app() -> "FastAPI":
    """This domain's routers and the root routes, and nothing else."""
    return build_domain_app(DOMAIN, title=DOMAIN.title)


def main() -> None:
    """Configure logging and tracing process-wide, then serve the application.

    Tracing is configured before the app is built so the server span middleware
    can still be injected into an unbuilt middleware stack.
    """
    from webbpulse.lambda_entry import run_uvicorn

    configure_logging(service=DOMAIN.service_name)
    configure_tracing(DOMAIN)
    check_signing_key([DOMAIN])
    run_uvicorn(build_app())


if __name__ == "__main__":
    main()
