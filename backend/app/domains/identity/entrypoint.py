"""The identity domain's entrypoint, run as `python -m app.domains.identity.entrypoint`.

Login, refresh, email verification, password reset, TOTP, WebAuthn and
OAuth under `/api/auth`, all served by the `webbpulse.identity` package. Tokens
are RS256 signed in KMS, so it holds no `SECRET_KEY`.
"""

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import domain_entrypoint

DOMAIN = DOMAINS["identity"]

build_app, main = domain_entrypoint(DOMAIN)


if __name__ == "__main__":
    main()
