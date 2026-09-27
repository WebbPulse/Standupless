"""Seed the local stack's durable e2e user: a verified account with a password credential.

The `webbpulse.e2e` suite mints its admin token with the staging KMS key, which a local
stack does not have, so `admin_mint_token` is empty there and the run creates no ephemeral
user. It falls back to the durable user `E2E_USER_EMAIL` and `E2E_USER_PASSWORD` name, and
on a stack built from scratch that user does not exist. This creates it.

Local only. It refuses to run without `DYNAMODB_ENDPOINT_URL`, so it can never write a
user into a real account.

Usage, from backend/:
    DYNAMODB_ENDPOINT_URL=http://localhost:8001 python scripts/create_local_e2e_user.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.common.core.config import settings  # noqa: E402

EMAIL_VARIABLE = "E2E_USER_EMAIL"

PASSWORD_VARIABLE = "E2E_USER_PASSWORD"


def _credential_store() -> Any:
    """The package credential store over this stack's own prefix and endpoint."""
    from webbpulse.dynamodb import Repository
    from webbpulse.identity import CREDENTIALS_TABLE, DynamoCredentialStore

    return DynamoCredentialStore(
        Repository(
            CREDENTIALS_TABLE,
            prefix=settings.dynamodb_table_prefix,
            endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
        )
    )


def seed_user(email: str, password: str) -> str:
    """Create or update the user and its password credential, returning the user id.

    Re-runnable: an existing row is updated rather than recreated, so a second bootstrap
    against a warm table is not an error.

    `email_verified` is set because `may_authenticate` refuses an unverified address. No
    admin role is granted: the durable e2e user on staging is deliberately not an admin and
    the suite asserts the 403 that rule gives, so seeding an admin here would make the local
    stack pass a check the deployed one fails.
    """
    import bcrypt
    from webbpulse.identity.flows import PASSWORD_CREDENTIAL_TYPE
    from webbpulse.identity.passwords import check_password, normalise_password
    from webbpulse.identity.storage import CredentialRecord, now_iso

    from app.common.db.dynamo.users import User, UserRepository

    users = UserRepository()
    existing = users.get_by_email(email)
    if existing is None:
        user = users.create(
            User(
                email=email,
                display_name=email.split("@", 1)[0],
                email_verified=True,
            )
        )
    else:
        user = users.update(existing.id, email_verified=True, disabled=False, is_admin=False)

    secret = bcrypt.hashpw(normalise_password(check_password(password)).encode("utf-8"), bcrypt.gensalt()).decode()
    _credential_store().put(
        CredentialRecord(
            user_id=str(user.id),
            credential_type=PASSWORD_CREDENTIAL_TYPE,
            secret=secret,
            created_at=now_iso(),
            updated_at=now_iso(),
        )
    )
    return str(user.id)


def main() -> int:
    """Seed the user and return 0, or 1 when the environment does not describe a local stack."""
    if not settings.DYNAMODB_ENDPOINT_URL:
        print(
            "DYNAMODB_ENDPOINT_URL is not set; refusing to seed a user against a real AWS account.",
            file=sys.stderr,
        )
        return 1
    email = os.environ.get(EMAIL_VARIABLE, "").strip()
    password = os.environ.get(PASSWORD_VARIABLE, "")
    if not email or not password:
        print(f"{EMAIL_VARIABLE} and {PASSWORD_VARIABLE} must both be set.", file=sys.stderr)
        return 1
    print(f"seeded {email} as {seed_user(email, password)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
