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
