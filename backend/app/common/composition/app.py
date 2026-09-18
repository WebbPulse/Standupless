"""Root A: every domain on one application, built by `build_domain_app`.

Composition is `include_router` and never `mount`, so both roots produce
identical paths and the same OpenAPI document.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import configure_logging

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import FastAPI


def build_app() -> "FastAPI":
    """Every domain's routers, plus the root routes, on one application.

    Called once at the bottom of this module; `app/main.py` re-exports the result
    so there is exactly one Root A application per process.
    """
    from app.common.composition.wiring import build_domain_app

    return build_domain_app(list(DOMAINS.values()))


configure_logging()

app = build_app()
