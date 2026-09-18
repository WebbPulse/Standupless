"""The identity domain's entrypoint, run as `python -m app.domains.identity.entrypoint`.

Login, refresh, email verification, password reset, TOTP, WebAuthn and
OAuth under `/api/auth`, all served by the `webbpulse.identity` package. Tokens
are RS256 signed in KMS, so it holds no `SECRET_KEY`.
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

DOMAIN = DOMAINS["identity"]


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
