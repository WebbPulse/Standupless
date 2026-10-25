"""The issues domain's entrypoint, run as `python -m app.domains.issues.entrypoint`.

Issues, sub-issues, links and activity under `/api/workspaces/{workspace_id}`,
plus the rollup consumer at the adapter's pass-through path. Verifies identity
access tokens through the gateway authorizer's claims, so it needs no application
secret.
"""

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import domain_entrypoint

DOMAIN = DOMAINS["issues"]

build_app, main = domain_entrypoint(DOMAIN)


if __name__ == "__main__":
    main()
