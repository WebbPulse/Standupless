"""The whole-API application, re-exported from Root A rather than built again.

Nothing deploys this module; it is what `uvicorn app.main:app` serves locally
and what the route-partition test compares the per-domain apps against.
"""

from app.common.composition.app import app

__all__ = ["app"]
