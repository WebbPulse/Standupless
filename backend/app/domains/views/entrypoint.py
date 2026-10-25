"""The views domain's entrypoint, run as `python -m app.domains.views.entrypoint`.

The board, saved views, search and the inbox under `/api/workspaces/{workspace_id}`,
plus both stream consumers at the adapter's pass-through path. Verifies identity
access tokens through the gateway authorizer's claims, so it needs no application
secret.

The two consumers are deployed as their own functions from this same image under
`consumers.notify_entrypoint` and `consumers.search_entrypoint`. They are included
here as well so the merged OpenAPI document and the local stack serve the same
surface the deployed functions do, which is the invariant both composition roots
exist to hold.
"""

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import domain_entrypoint

DOMAIN = DOMAINS["views"]

build_app, main = domain_entrypoint(DOMAIN)


if __name__ == "__main__":
    main()
