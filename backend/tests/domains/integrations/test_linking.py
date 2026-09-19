"""Key extraction and the transition decision, tested without a database.

These are pure functions on purpose: the rules from design section 4 are fiddly
enough that they deserve to be checkable without seeding a tenant, and keeping them
pure is what makes the cross-project cases below cheap enough to enumerate.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.domains.integrations import linking

PREFIXES = {"p-abc": "ABC", "p-xyz": "XYZ"}


def test_a_key_is_found_against_its_own_project_prefix() -> None:
    """`ABC-1` resolves to the project whose prefix is `ABC` and to no other."""
    found = linking.find_keys("fixes ABC-1 at last", PREFIXES)

    assert [(row.project_id, row.key) for row in found] == [("p-abc", "ABC-1")]


def test_matching_is_case_insensitive() -> None:
    """A branch name in lower case still names the issue, and the key is normalised."""
    found = linking.find_keys("abc-42-some-branch", PREFIXES)

    assert [(row.project_id, row.key) for row in found] == [("p-abc", "ABC-42")]


def test_a_key_for_an_unlinked_project_is_not_found() -> None:
    """A prefix that is not in the map contributes nothing.

    This is the rule that stops a branch in one installation naming an issue in a
    project that installation was never linked to: the caller passes only the
    prefixes it is allowed to match, so an unknown prefix cannot resolve.
    """
    found = linking.find_keys("DEF-9 and ABC-1", PREFIXES)

    assert [row.key for row in found] == ["ABC-1"]


def test_a_prefix_inside_a_longer_word_is_not_a_match() -> None:
    """`ABC-1` inside `XABC-12` is not a key, because the pattern is bounded."""
    assert linking.find_keys("XABC-12", PREFIXES) == []
    assert linking.find_keys("ABC-12345", PREFIXES)[0].key == "ABC-12345"


def test_the_same_key_twice_is_returned_once() -> None:
    """A key in both the branch and the title links once, not twice."""
    found = linking.extract(PREFIXES, branch="abc-1-fix", title="ABC-1 fix", body="ABC-1 again")

    assert [row.key for row in found] == ["ABC-1"]


def test_keys_from_several_projects_are_all_found() -> None:
    """One pull request may name issues in more than one project."""
    found = linking.extract(PREFIXES, title="ABC-1 and XYZ-2 together")

    assert sorted(row.key for row in found) == ["ABC-1", "XYZ-2"]


def test_a_magic_word_in_the_title_marks_the_key_as_closing() -> None:
    """`Fixes ABC-1` in the title is what makes a merge close the issue."""
    found = linking.extract(PREFIXES, title="Fixes ABC-1")

    assert found[0].magic_word == "fixes"


def test_a_magic_word_in_the_body_marks_the_key_as_closing() -> None:
    """The body counts the same as the title, which is where GitHub looks too."""
    found = linking.extract(PREFIXES, title="A change", body="Closes ABC-1 finally")

    assert found[0].magic_word == "closes"


def test_a_key_without_a_magic_word_does_not_close() -> None:
    """A mention alone links the issue and moves nothing on merge."""
    found = linking.extract(PREFIXES, title="Touches ABC-1 a bit")

    assert found[0].magic_word is None


def test_a_magic_word_in_a_commit_message_does_not_close() -> None:
    """Commit messages contribute a mention and never a close.

    A rebase rewrites commit messages wholesale, so letting one close an issue would
    mean a history rewrite could reclose something a person deliberately reopened.
    """
    found = linking.extract(PREFIXES, commit_messages=["fixes ABC-1"])

    assert [row.key for row in found] == ["ABC-1"]
    assert found[0].magic_word is None


def test_a_key_mentioned_after_the_word_but_not_next_to_it_does_not_close() -> None:
    """ "ABC-1 is not fixed" is a mention, not a close, because the order is wrong."""
    found = linking.extract(PREFIXES, title="ABC-1 is not fixed")

    assert found[0].magic_word is None


def test_the_trigger_for_each_pull_request_action() -> None:
    """Every action maps to the one trigger design section 4 gives it."""
    assert linking.trigger_for("opened", merged=False, draft=False) == "pr_opened"
    assert linking.trigger_for("reopened", merged=False, draft=False) == "pr_opened"
    assert linking.trigger_for("ready_for_review", merged=False, draft=False) == "pr_ready_for_review"
    assert linking.trigger_for("closed", merged=True, draft=False) == "pr_merged"
    assert linking.trigger_for("closed", merged=False, draft=False) == "pr_closed"
    assert linking.trigger_for("synchronize", merged=False, draft=False) is None


def test_a_draft_opening_fires_nothing() -> None:
    """Work that is not ready for review has not started in any sense a status claims."""
    assert linking.trigger_for("opened", merged=False, draft=True) is None


def test_the_recorded_pull_request_state() -> None:
    """Merged beats closed, and a draft is distinguished from an open pull request."""
    assert linking.pr_state(state="closed", merged=True, draft=False) == "merged"
    assert linking.pr_state(state="closed", merged=False, draft=False) == "closed"
    assert linking.pr_state(state="open", merged=False, draft=True) == "draft"
    assert linking.pr_state(state="open", merged=False, draft=False) == "open"


def test_a_transition_applies_when_the_issue_has_not_moved_since() -> None:
    """An issue last touched before the event is still the issue the event described."""
    event_at = datetime(2026, 9, 18, 12, 0, tzinfo=timezone.utc)

    assert linking.may_apply(event_at - timedelta(minutes=5), event_at) is True


def test_a_transition_is_skipped_when_a_person_moved_the_issue_after_the_event() -> None:
    """The manual-change guard: a queued transition never undoes a later hand edit.

    SQS is unordered and a retry can arrive minutes late, so without this a person
    who moved an issue back would watch it move itself forward again.
    """
    event_at = datetime(2026, 9, 18, 12, 0, tzinfo=timezone.utc)

    assert linking.may_apply(event_at + timedelta(minutes=1), event_at) is False


def test_a_missing_timestamp_allows_the_transition() -> None:
    """A delivery carrying no time is a first delivery, not a replay, so it applies."""
    assert linking.may_apply(None, datetime.now(timezone.utc)) is True
    assert linking.may_apply(datetime.now(timezone.utc), None) is True
