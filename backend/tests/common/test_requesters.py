"""The requester builders: what an intake keeps about someone it files an issue for."""

from __future__ import annotations

from app.common.api.schemas.issues import IssueRequesterRead
from app.common.db.dynamo.issues import IssueRequester
from app.common.requesters import AVATAR_MAX, NAME_MAX, email_requester, slack_requester


def test_an_email_requester_keeps_the_name_and_only_a_masked_address() -> None:
    """The display name stays, and the address is masked before it is kept."""
    requester = email_requester("Alice Example", "alice@example.com")

    assert requester.source == "email"
    assert requester.name == "Alice Example"
    assert requester.masked_email == "a***@example.com"
    assert "alice@example.com" not in requester.model_dump_json()
    assert requester.user_id is None


def test_an_email_requester_drops_a_name_that_is_an_address_and_keeps_a_member() -> None:
    """A display name that repeats the address would leak it, so it is dropped."""
    requester = email_requester("alice@example.com", "alice@example.com", user_id="01JBUSER")

    assert requester.name == ""
    assert requester.masked_email == "a***@example.com"
    assert requester.user_id == "01JBUSER"


def test_a_slack_requester_keeps_the_name_handle_avatar_and_slack_id() -> None:
    """The real name leads, the display name is the handle, and an https avatar is kept."""
    profile = {
        "user": {
            "name": "dana",
            "profile": {
                "real_name": "Dana  Scully",
                "display_name": "dscully",
                "image_72": "https://avatars.example.com/dana-72.png",
                "email": "dana@example.com",
            },
        }
    }

    requester = slack_requester(profile, "UDANA")

    assert requester is not None
    assert requester.source == "slack"
    assert requester.name == "Dana Scully"
    assert requester.handle == "dscully"
    assert requester.avatar_url == "https://avatars.example.com/dana-72.png"
    assert requester.external_id == "UDANA"
    assert requester.masked_email is None
    assert "dana@example.com" not in requester.model_dump_json()


def test_a_slack_requester_falls_back_to_the_user_name_and_skips_unsafe_avatars() -> None:
    """With no profile names the Slack username serves, and a non-https or oversized avatar is dropped."""
    profile = {
        "user": {
            "name": "fox",
            "profile": {"image_72": "http://avatars.example.com/fox.png", "image_48": "https://x/" + "a" * AVATAR_MAX},
        }
    }

    requester = slack_requester(profile, "UFOX", user_id="01JBFOX")

    assert requester is not None
    assert requester.name == "fox" and requester.handle == "fox"
    assert requester.avatar_url is None
    assert requester.user_id == "01JBFOX"


def test_a_slack_requester_trims_long_names_and_needs_someone() -> None:
    """Names are kept to one short line, and an empty answer gives no requester."""
    long = slack_requester({"user": {"profile": {"real_name": "x" * 500}}}, "ULONG")

    assert long is not None and len(long.name) == NAME_MAX
    assert slack_requester({"user": {"profile": {}}}, "UNONE") is None
    assert slack_requester({}, "UNONE") is None
    linked = slack_requester({"user": {"profile": {}}}, "UMEMBER", user_id="01JBMEMBER")
    assert linked is not None and linked.user_id == "01JBMEMBER" and linked.name == ""
    assert slack_requester({"user": {"name": "a"}}, "") is None


def test_the_read_shape_carries_the_source_and_skips_unknown_ones() -> None:
    """The response names the source, and a row from an unknown source is not shown."""
    read = IssueRequesterRead.from_requester(email_requester("Alice", "alice@example.com"))

    assert read is not None and read.source == "email" and read.masked_email == "a***@example.com"
    assert IssueRequesterRead.from_requester(None) is None
    assert IssueRequesterRead.from_requester(IssueRequester(source="api", name="x")) is None
