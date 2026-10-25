"""The workspaces domain's entrypoint, run as `python -m app.domains.workspaces.entrypoint`.

The workspace tenant routes under `/api/workspaces`. Verifies identity
access tokens through the gateway authorizer's claims, so it needs no
application secret.
"""

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import domain_entrypoint

DOMAIN = DOMAINS["workspaces"]

build_app, main = domain_entrypoint(DOMAIN)


if __name__ == "__main__":
    main()
