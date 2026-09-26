"""The users table: the row the identity package's hooks read and write.

`update` builds a real `UpdateExpression`, so these cover the paths the identity
flows drive: verifying an address, and keeping the lookup index in step with it.
"""

from __future__ import annotations

import pytest

from app.common.db.dynamo.users import User, UserRepository

EMAIL = "Someone@Example.COM"


@pytest.fixture
def users(dynamo_tables: None) -> UserRepository:
    """A users repository against the mocked table."""
    return UserRepository()


def _create(users: UserRepository, email: str = EMAIL) -> User:
    """Store one user and return it."""
    return users.create(User(id="user-1", email=email, display_name="Someone"))


def test_a_user_is_found_by_id(users: UserRepository) -> None:
    """The row round-trips through the table."""
    _create(users)
    stored = users.get("user-1")
    assert stored is not None
    assert stored.display_name == "Someone"


def test_a_user_is_found_by_address_case_insensitively(users: UserRepository) -> None:
    """Sign-in looks the address up lowercased, so the stored case cannot matter."""
    _create(users)
    assert users.get_by_email("someone@example.com") is not None
    assert users.get_by_email("SOMEONE@EXAMPLE.COM") is not None


def test_an_unknown_address_is_a_miss(users: UserRepository) -> None:
    """A miss is None rather than an error, which is what the hooks expect."""
    assert users.get_by_email("nobody@example.com") is None


def test_marking_an_address_verified_persists(users: UserRepository) -> None:
    """The write behind `mark_email_verified`, which the whole register flow needs."""
    _create(users)
    updated = users.update("user-1", email_verified=True)
    assert updated.email_verified is True
    stored = users.get("user-1")
    assert stored is not None and stored.email_verified is True


def test_changing_the_address_moves_the_index(users: UserRepository) -> None:
    """The lookup index cannot be left pointing at the old address.

    A stale index entry would let a user sign in under an address they no longer
    hold, so the update rewrites `email_lower` alongside `email`.
    """
    _create(users)
    users.update("user-1", email="Moved@Example.com")
    assert users.get_by_email("someone@example.com") is None
    found = users.get_by_email("moved@example.com")
    assert found is not None and found.id == "user-1"


def test_updating_an_unknown_user_raises(users: UserRepository) -> None:
    """An update naming nobody must not quietly create a row."""
    with pytest.raises(KeyError):
        users.update("no-such-user", email_verified=True)
    assert users.get("no-such-user") is None


def test_delete_reports_whether_a_row_was_there(users: UserRepository) -> None:
    """Deleting twice is not an error, and the second call reports the miss."""
    _create(users)
    assert users.delete("user-1") is True
    assert users.delete("user-1") is False


def test_a_reserved_word_attribute_updates(users: UserRepository) -> None:
    """`name`-like attributes are aliased, so a reserved word cannot break the write."""
    _create(users)
    updated = users.update("user-1", display_name="Renamed", disabled=True)
    assert updated.display_name == "Renamed"
    assert updated.disabled is True


def test_a_reserved_domain_address_is_stored(users: UserRepository) -> None:
    """The e2e suite's `@e2e.invalid` addresses have to reach the table.

    `User.email` was an `EmailStr`, whose email-validator refuses special-use
    domains, so every ephemeral user the identity package created raised here and
    `POST /api/auth/e2e/users` answered 500. The record accepts any `local@domain`
    string; deliverability belongs to the request boundary, not the stored row.
    """
    stored = users.create(User(id="user-e2e", email="someone@e2e.invalid"))
    assert stored.email == "someone@e2e.invalid"
    assert users.get_by_email("someone@e2e.invalid") is not None


def test_the_package_hook_creates_a_reserved_domain_user(dynamo_tables: None) -> None:
    """The path `POST /api/auth/e2e/users` actually takes, end to end.

    `webbpulse.identity`'s ephemeral users endpoint calls `flows.create_ephemeral_user`,
    which calls `IdentityHooks.create_user`. Driving the hook rather than the model
    is what would have caught the 500, because the model was only ever constructed
    with deliverable addresses in the product's own tests.
    """
    from app.domains.identity.identity_hooks import StanduplessIdentityHooks

    hooks = StanduplessIdentityHooks(UserRepository())
    created = hooks.create_user(email="ephemeral@e2e.invalid", attributes={"email_verified": True})
    assert created["email"] == "ephemeral@e2e.invalid"
    assert created["display_name"] == "ephemeral"
    assert hooks.load_user_by_email("ephemeral@e2e.invalid") is not None


@pytest.mark.parametrize("address", ["", "no-at-sign", "@example.com", "local@", "a@b@c.com", "local@nodot"])
def test_a_malformed_address_is_still_refused(address: str) -> None:
    """Dropping `EmailStr` must not let a shapeless value onto the lookup index."""
    with pytest.raises(ValueError):
        User(id="user-bad", email=address)


def test_a_registration_cannot_grant_itself_platform_admin(dynamo_tables: None) -> None:
    """The register route passes the client's `attributes` through, so the hook allowlists them.

    `is_admin` is the platform admin flag the Create GitHub App action checks, and
    `disabled` and `id` are the product's to set, so none of them may arrive from a
    registration body.
    """
    from app.domains.identity.identity_hooks import StanduplessIdentityHooks

    hooks = StanduplessIdentityHooks(UserRepository())
    created = hooks.create_user(
        email="climber@example.com",
        attributes={
            "is_admin": True,
            "disabled": False,
            "id": "chosen-id",
            "email_notifications": False,
            "display_name": "Climber",
            "email_verified": False,
        },
    )

    stored = UserRepository().get(str(created["id"]))
    assert stored is not None
    assert stored.is_admin is False
    assert stored.id != "chosen-id"
    assert stored.email_notifications is True
    assert stored.display_name == "Climber"
