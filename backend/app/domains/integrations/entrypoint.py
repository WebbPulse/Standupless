"""The integrations domain's entrypoint, run as `python -m app.domains.integrations.entrypoint`.

Serves the workspace-scoped GitHub, webhook and transition routes, plus the two
routes GitHub itself calls under `/api/github`. It needs `SECRET_KEY` because the
install flow's `state` is a signed token, and the GitHub App credentials because
the callback mints an installation token to read the repository list.
"""

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import domain_entrypoint

DOMAIN = DOMAINS["integrations"]

build_app, main = domain_entrypoint(DOMAIN)


if __name__ == "__main__":
    main()
