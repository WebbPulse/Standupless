"""The admin domain's entrypoint, run as `python -m app.domains.admin.entrypoint`.

Platform administration under `/api/admin`, today the Create GitHub App action. A
function of its own because it is the only one allowed to write the `app` secret,
so that grant sits on a role no product route shares. It needs `SECRET_KEY` to sign
the manifest flow's state.
"""

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import domain_entrypoint

DOMAIN = DOMAINS["admin"]

build_app, main = domain_entrypoint(DOMAIN)


if __name__ == "__main__":
    main()
