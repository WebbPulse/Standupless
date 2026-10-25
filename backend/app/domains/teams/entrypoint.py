"""The teams domain's entrypoint, run as `python -m app.domains.teams.entrypoint`.

Teams, their members, statuses and labels, all nested under
`/api/workspaces/{workspace_id}`. Verifies identity access tokens through the
gateway authorizer's claims, so it needs no application secret.
"""

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import domain_entrypoint

DOMAIN = DOMAINS["teams"]

build_app, main = domain_entrypoint(DOMAIN)


if __name__ == "__main__":
    main()
