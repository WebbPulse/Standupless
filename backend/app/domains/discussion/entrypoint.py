"""The discussion domain's entrypoint, run as `python -m app.domains.discussion.entrypoint`.

Comments, reactions and attachments under `/api/workspaces/{workspace_id}`.
Identity is verified from the gateway authorizer's claims, but this domain does
need `SECRET_KEY`: it signs the upload ticket that binds a presigned PUT to the
caller and the issue it was minted for.
"""

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import domain_entrypoint

DOMAIN = DOMAINS["discussion"]

build_app, main = domain_entrypoint(DOMAIN)


if __name__ == "__main__":
    main()
