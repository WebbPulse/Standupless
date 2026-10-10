"""Standupless's `IdentityHooks`: how the package reads and writes `users`.

Looks a user up, decides whether they may sign in, supplies this product's
claims, and creates the row a package registration needs. Credentials, passkeys
and OAuth links are the package's own tables, so none of them appear here.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from webbpulse.identity import AuthenticationRefused

from app.common.db.dynamo.users import User, UserRepository

REFUSAL_MESSAGE = "This account may not sign in."

ADMIN_ROLE = "admin"

DELETION_MARKS = ("deletion_scheduled_at", "purge_after", "purging_at")
"""The `users` fields any one of which means the account has been deleted."""

REGISTRATION_ATTRIBUTES = ("display_name", "email_verified")
"""The `users` fields a registration may set; every other field keeps its model default."""


class StanduplessIdentityHooks:
    """Standupless's `IdentityHooks`, satisfying the protocol structurally.

    Stateless apart from one repository, so a single instance is shared per
    process. Constructing it makes no AWS call and caches no boto3 object.
    """

    def __init__(self, users: UserRepository | None = None, totp_factors: Any = None, passkeys: Any = None) -> None:
        """Take an injected users repository, or build this product's own, and the package's factor stores.

        `totp_factors` is the TOTP store. `passkeys` is the passkey store, passed only
        when a passkey can answer the login MFA challenge. Without either store no
        session claims a second factor from it, which is the fail-closed reading of
        the workspace authentication policy.
        """
        self._users = users if users is not None else UserRepository()
        self._totp_factors = totp_factors
        self._passkeys = passkeys

    def load_user_by_id(self, user_id: str) -> Mapping[str, Any] | None:
        """The user whose id is this `sub`, or `None`."""
        user = self._users.get(user_id)
        return _as_mapping(user) if user is not None else None

    def load_user_by_email(self, email: str) -> Mapping[str, Any] | None:
        """The user holding this address, or `None`.

        The address arrives lowercased and stripped, and the repository queries the
        lowercased index, so a miss costs the same single query a hit does.
        """
        user = self._users.get_by_email(email)
        return _as_mapping(user) if user is not None else None

    def may_authenticate(self, user: Mapping[str, Any]) -> None:
        """Permit an enabled, verified account that has not been deleted, and refuse everything else.

        Returns `None` to permit and raises to refuse, which is the protocol's
        shape and the one where forgetting to return lands on the refusing side. A
        deleted account is refused from the moment it is marked, before its purge
        has removed the row, on every sign-in method and on every refresh.
        """
        if any(user.get(field) for field in DELETION_MARKS):
            raise AuthenticationRefused(REFUSAL_MESSAGE, error_code="ACCOUNT_DELETED")
        if user.get("disabled"):
            raise AuthenticationRefused(REFUSAL_MESSAGE, error_code="ACCOUNT_DISABLED")
        if not user.get("email_verified"):
            raise AuthenticationRefused(REFUSAL_MESSAGE, error_code="EMAIL_NOT_VERIFIED")

    def claims_for(self, user: Mapping[str, Any]) -> Mapping[str, Any]:
        """This product's claims: the roles list, the display name and `two_factor`.

        `roles` is always a list so a consumer's check is one shape. Consumers must
        test membership and never index. `two_factor` says the person has an active
        authenticator app or, with passkeys as a second factor, a registered passkey,
        which every password and OAuth sign-in of theirs is then challenged for. It is
        read again on every refresh, so removing the factor drops it from the next token.
        """
        roles: list[str] = [ADMIN_ROLE] if user.get("is_admin") else []
        return {
            "roles": roles,
            "display_name": user.get("display_name", ""),
            "two_factor": self.has_two_factor(str(user.get("id", "") or "")),
        }

    def has_two_factor(self, user_id: str) -> bool:
        """Whether this person has an activated TOTP factor or a passkey that answers the MFA challenge."""
        if not user_id:
            return False
        if self._totp_factors is not None:
            factor = self._totp_factors.get(user_id)
            if factor is not None and bool(factor.is_active):
                return True
        return self._passkeys is not None and bool(self._passkeys.list_for_user(user_id))

    def create_user(self, *, email: str, attributes: Mapping[str, Any]) -> Mapping[str, Any]:
        """Create a Standupless user row for a package registration and return it.

        Only the fields in `REGISTRATION_ATTRIBUTES` are taken from `attributes`,
        because the register route passes the client's own `attributes` object
        through: copying it whole would let anyone registering set `is_admin`, which
        is the platform admin flag, or `disabled`. The display name falls back to the
        address's local part when none is given.
        """
        record = {key: attributes[key] for key in REGISTRATION_ATTRIBUTES if key in attributes}
        record["email"] = email
        record["display_name"] = str(record.get("display_name") or _display_name_from(email))
        return _as_mapping(self._users.create(User(**record)))

    def mark_email_verified(self, user_id: str) -> None:
        """Record that this user's address is confirmed, on the `users` row.

        Raises `ValueError` for a missing row rather than passing silently: the link
        is already spent, so a failure has to be visible.
        """
        if self._users.get(user_id) is None:
            raise ValueError(
                f"mark_email_verified found no user with id {user_id!r}. The link was consumed, "
                "so the address is not verified and the user needs a new one."
            )
        self._users.update(user_id, email_verified=True)

    def delete_user(self, user_id: str) -> bool:
        """Hard-delete this product's users row, returning whether one was there.

        Only the users row. The identity rows are the users-table stream purge's to
        remove, so an ephemeral e2e user's teardown exercises the same deletion path
        a real account does.
        """
        return self._users.delete(user_id)

    def on_user_created(self, user: Mapping[str, Any], via: str) -> None:
        """No side effects to run.

        The verification email is sent by the package's own register flow, and a new
        Standupless account owns no default rows.
        """
        del user, via

    def has_other_sign_in_method(self, user_id: str) -> bool:
        """Whether this user holds a sign-in method the package cannot see.

        Standupless keeps none: every credential, passkey and OAuth link lives in the
        package's own tables, which `unlink` counts for itself.
        """
        del user_id
        return False

    def user_repository(self) -> object:
        """Standupless's users repository. Typed `object`, as the protocol has it."""
        return self._users


def _as_mapping(user: User) -> Mapping[str, Any]:
    """A user row as the plain mapping the hooks protocol returns.

    `mode="json"` so the id reaches the package as the string it becomes in the
    `sub` claim.
    """
    return user.model_dump(mode="json")


def _display_name_from(email: str) -> str:
    """A display name derived from the address's local part."""
    return email.partition("@")[0].strip() or "user"
