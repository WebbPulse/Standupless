"""The WebSocket API's function, run as its own Lambda function.

Same image as the `integrations` routes, a different command. API Gateway's
WebSocket integration invokes it for `$connect`, `$disconnect`, `heartbeat`,
`presence` and `presence_leave`, and the Lambda Web Adapter posts each event to the
pass-through path, so it serves that route and the root probes and nothing else.
Its grant is the connections and presence tables to write, the memberships table
to check a member against, and the issues and planning tables to learn who may
read the issue or document a page reports open.
"""

from typing import TYPE_CHECKING

from app.common.composition.consumers import CONSUMERS
from app.common.composition.wiring import Domain, domain_entrypoint

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import APIRouter

GRANT = CONSUMERS["integrations-realtime-consumer"]

DOMAIN = Domain(
    name="integrations-realtime-consumer",
    title="Standupless realtime connections",
    load_routers=lambda: [],
    load_unprefixed_routers=lambda _settings: _routers(),
    repositories=GRANT.repositories,
    read_repositories=GRANT.read_repositories,
)
"""A descriptor carrying this function's own grant and only the WebSocket route."""


def _routers() -> "list[APIRouter]":
    """The WebSocket event route alone."""
    from app.domains.integrations.realtime.websocket import build_router

    return [build_router(GRANT.bundle())]


build_app, main = domain_entrypoint(DOMAIN)


if __name__ == "__main__":
    main()
