"""The planning domain's entrypoint, run as `python -m app.domains.planning.entrypoint`.

Cycles, projects and the workspace roadmap under `/api/workspaces/{workspace_id}`.
Verifies identity access tokens through the gateway authorizer's claims, so it needs
no application secret. The rollup consumer is a separate function off the same image,
because it is driven by a stream event source rather than by the gateway.
"""

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import domain_entrypoint

DOMAIN = DOMAINS["planning"]

build_app, main = domain_entrypoint(DOMAIN)


if __name__ == "__main__":
    main()
