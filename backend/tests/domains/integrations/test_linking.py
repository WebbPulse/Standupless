"""Key extraction and the transition decision, tested without a database.

These are pure functions on purpose: the rules from design section 4 are fiddly
enough that they deserve to be checkable without seeding a tenant, and keeping them
pure is what makes the cross-team cases below cheap enough to enumerate.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from app.common.issue_key_search import moving_commit_keys
from app.domains.integrations import linking

PREFIXES = {"p-abc": "ABC", "p-xyz": "XYZ"}


def test_a_key_is_found_against_its_own_team_prefix() -> None:
    """`ABC-1` resolves to the team whose prefix is `ABC` and to no other."""
    found = linking.find_keys("fixes ABC-1 at last", PREFIXES)

    assert [(row.team_id, row.key) for row in found] == [("p-abc", "ABC-1")]


def test_matching_is_case_insensitive() -> None:
    """A branch name in lower case still names the issue, and the key is normalised."""
    found = linking.find_keys("abc-42-some-branch", PREFIXES)

    assert [(row.team_id, row.key) for row in found] == [("p-abc", "ABC-42")]


def test_a_key_for_an_unlinked_team_is_not_found() -> None:
    """A prefix that is not in the map contributes nothing.

    This is the rule that stops a branch in one installation naming an issue in a
    team that installation was never linked to: the caller passes only the
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


def test_keys_from_several_teams_are_all_found() -> None:
    """One pull request may name issues in more than one team."""
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


def test_a_bare_mention_in_the_body_links_without_moving() -> None:
    """A key the body names in passing is found but moves no status, as in Linear."""
    found = linking.extract(PREFIXES, title="A change", body="ABC-1 writes those")

    assert [row.key for row in found] == ["ABC-1"]
    assert found[0].moves_status is False
    assert found[0].magic_word is None


@pytest.mark.parametrize(
    ("branch", "title", "body"),
    [
        ("abc-1-a-change", "A change", ""),
        ("work", "ABC-1 a change", ""),
        ("work", "A change", "Fixes ABC-1"),
        ("work", "A change", "Closes: ABC-1"),
    ],
)
def test_the_branch_the_title_and_a_magic_word_move_the_status(branch: str, title: str, body: str) -> None:
    """Each source Linear reads for a transition marks the key as one that moves."""
    found = linking.extract(PREFIXES, branch=branch, title=title, body=body)

    assert [row.key for row in found] == ["ABC-1"]
    assert found[0].moves_status is True


@pytest.mark.parametrize("branch", ["abc-1-fix-login", "user/abc-1-fix-login", "abc-1"])
def test_every_branch_format_links_and_moves(branch: str) -> None:
    """Each branch name format a workspace can copy, the handle prefixed one included, names the issue."""
    found = linking.extract(PREFIXES, branch=branch, title="A change")

    assert [row.key for row in found] == ["ABC-1"]
    assert found[0].moves_status is True


def test_a_user_prefixed_branch_links_its_issue() -> None:
    """`user/stup-1-x`, the handle and slash Linear can put first, still links STUP-1."""
    found = linking.extract({"p-stup": "STUP"}, branch="user/stup-1-x")

    assert [(row.team_id, row.key) for row in found] == [("p-stup", "STUP-1")]


@pytest.mark.parametrize(
    "word", ["Refs", "ref", "References", "Part of", "Contributes to", "Toward", "Towards", "Update", "Updates"]
)
def test_a_reference_word_moves_the_status_without_closing(word: str) -> None:
    """A non-closing word ties the key to the pull request so it moves, and a merge does not close it."""
    found = linking.extract(PREFIXES, title="A change", body=f"{word} ABC-1")

    assert found[0].moves_status is True
    assert found[0].magic_word is None


@pytest.mark.parametrize("word", ["Related to", "Relates to", "relates  to", "Relates to:"])
def test_a_related_word_links_without_moving(word: str) -> None:
    """A key after `Relates to` or `Related to` links the pull request and moves nothing on any event."""
    found = linking.extract(PREFIXES, title="A change", body=f"{word} ABC-1")

    assert [row.key for row in found] == ["ABC-1"]
    assert found[0].moves_status is False
    assert found[0].magic_word is None
    assert found[0].holds_on_merge is False


def test_a_related_word_governs_every_key_in_its_list() -> None:
    """A list after a related word links each key without moving any."""
    found = linking.extract(PREFIXES, title="A change", body="Relates to ABC-1, ABC-2 and XYZ-3")

    assert {row.key: row.moves_status for row in found} == {"ABC-1": False, "ABC-2": False, "XYZ-3": False}


def test_a_related_word_wins_over_the_branch_and_title() -> None:
    """Saying a pull request only relates to an issue keeps it still, even when the branch and title carry the key."""
    found = linking.extract(PREFIXES, branch="abc-1-side", title="ABC-1 Side change", body="Relates to ABC-1")

    assert found[0].moves_status is False
    assert found[0].magic_word is None


def test_a_closing_word_wins_over_a_related_word() -> None:
    """A key both fixed and related closes, as the strongest word wins."""
    found = linking.extract(PREFIXES, title="Fixes ABC-1", body="Relates to ABC-1")

    assert found[0].magic_word == "fixes"
    assert found[0].moves_status is True
    assert found[0].holds_on_merge is False


def test_a_contributing_word_wins_over_a_related_word() -> None:
    """A key both updated and related moves on open and holds on merge."""
    found = linking.extract(PREFIXES, title="A change", body="Updates ABC-1. Related to ABC-1.")

    assert found[0].moves_status is True
    assert found[0].holds_on_merge is True


def test_a_mixed_body_sorts_each_key_by_its_word() -> None:
    """Closing, contributing, related and bare keys in one body each take their own class."""
    body = "Fixes ABC-1, updates ABC-2, relates to ABC-3.\n\nABC-4 is nearby."
    found = {row.key: row for row in linking.extract(PREFIXES, title="A change", body=body)}

    assert found["ABC-1"].magic_word == "fixes"
    assert (found["ABC-2"].moves_status, found["ABC-2"].holds_on_merge) == (True, True)
    assert (found["ABC-3"].moves_status, found["ABC-3"].holds_on_merge) == (False, False)
    assert found["ABC-4"].moves_status is False


def test_a_related_word_in_a_commit_quiets_that_commits_subject_only() -> None:
    """A commit that says `Relates to` keeps its key still, and another commit's subject still moves it."""
    alone = linking.extract(PREFIXES, commit_messages=["ABC-1 Side change (#4)\n\nRelates to ABC-1"])
    paired = linking.extract(
        PREFIXES, commit_messages=["ABC-1 Side change (#4)\n\nRelates to ABC-1", "ABC-1 Real work (#5)"]
    )

    assert alone[0].moves_status is False
    assert paired[0].moves_status is True


def test_moving_commit_keys_leaves_out_a_related_key() -> None:
    """Release stage automation follows the same rule, so a related commit key moves nothing."""
    moving = moving_commit_keys(["XYZ-2 Ship it (#9)\n\nRelated to ABC-1, fixes XYZ-2"], PREFIXES)

    assert [row.key for row in moving] == ["XYZ-2"]


def test_a_magic_word_does_not_carry_to_a_later_bare_mention() -> None:
    """Only the key right after the word moves; another key further on stays a mention."""
    found = linking.extract(PREFIXES, title="A change", body="Fixes ABC-1.\n\nXYZ-2 writes those")

    moves = {row.key: row.moves_status for row in found}
    assert moves == {"ABC-1": True, "XYZ-2": False}


@pytest.mark.parametrize("body", ["Fixes ABC-1. Refs XYZ-2.", "Fixes ABC-1, refs XYZ-2"])
def test_a_fixes_word_does_not_carry_past_a_sentence_break_or_another_word(body: str) -> None:
    """Only the key `Fixes` governs closes; the `Refs` key after it links, moves on open and holds on merge."""
    found = {row.key: row for row in linking.extract(PREFIXES, title="A change", body=body)}

    assert found["ABC-1"].magic_word == "fixes"
    assert found["ABC-1"].holds_on_merge is False
    assert found["XYZ-2"].magic_word is None
    assert found["XYZ-2"].moves_status is True
    assert found["XYZ-2"].holds_on_merge is True


@pytest.mark.parametrize("body", ["Fixes ABC-1, ABC-2", "Fixes ABC-1 and ABC-2", "Fixes ABC-1, ABC-2 & XYZ-3"])
def test_a_fixes_word_closes_every_key_in_its_list(body: str) -> None:
    """A list joined by commas, `and` or `&` is governed by the one closing word before it."""
    found = linking.extract(PREFIXES, title="A change", body=body)

    assert found
    assert all(row.magic_word == "fixes" and not row.holds_on_merge for row in found)


def test_a_refs_key_holds_on_merge_even_when_the_title_names_it() -> None:
    """Partial work puts its key in the title and says `Refs`, and a merge must not finish it."""
    found = linking.extract(PREFIXES, branch="abc-1-slice", title="ABC-1 A slice", body="Refs ABC-1")

    assert found[0].moves_status is True
    assert found[0].holds_on_merge is True


def test_a_key_both_fixed_and_referenced_closes() -> None:
    """A closing word anywhere wins over a `Refs` elsewhere for the same key."""
    found = linking.extract(PREFIXES, title="Fixes ABC-1", body="Refs ABC-1")

    assert found[0].magic_word == "fixes"
    assert found[0].holds_on_merge is False


def test_a_commit_that_says_refs_holds_its_key_on_a_promotion() -> None:
    """A promotion's commit that only references a key leaves that issue where it is."""
    found = {
        row.key: row
        for row in linking.extract(PREFIXES, commit_messages=["ABC-1 First slice (#4)\n\nRefs ABC-1", "XYZ-2 Done"])
    }

    assert found["ABC-1"].holds_on_merge is True
    assert found["XYZ-2"].holds_on_merge is False


def test_a_bare_key_in_the_title_does_not_hold_on_merge() -> None:
    """A key with no `Refs` word keeps moving on merge under a team's branch rules."""
    found = linking.extract(PREFIXES, title="ABC-1 a change")

    assert found[0].holds_on_merge is False


def test_a_key_in_a_commit_message_still_moves() -> None:
    """A merged promotion names its work only in commits, so those keys stay movable."""
    found = linking.extract(PREFIXES, commit_messages=["ABC-1 a change"])

    assert found[0].moves_status is True


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


ALIASED = {"p-abc": ["ABC", "OLD"], "p-xyz": "XYZ"}


def test_a_retired_prefix_names_its_team_under_the_current_key() -> None:
    """A branch cut before a key change still links, reported under today's key."""
    found = linking.find_keys("old-7-some-branch", ALIASED)

    assert [(row.team_id, row.key, row.number) for row in found] == [("p-abc", "ABC-7", 7)]


def test_the_current_and_retired_key_of_one_issue_link_once() -> None:
    """`OLD-7` and `ABC-7` are the same issue, so they come back as one key."""
    found = linking.extract(ALIASED, branch="old-7-fix", title="ABC-7 fix")

    assert [row.key for row in found] == ["ABC-7"]


def test_a_magic_word_before_a_retired_key_closes_the_issue() -> None:
    """Closing is decided by team and number, so `Fixes OLD-7` closes `ABC-7`."""
    found = linking.extract(ALIASED, title="Fixes OLD-7")

    assert [(row.key, row.magic_word) for row in found] == [("ABC-7", "fixes")]


def test_a_current_prefix_wins_over_another_teams_alias() -> None:
    """A prefix held today by one team is never read as another team's alias."""
    found = linking.find_keys("XYZ-3", {"p-abc": ["ABC", "XYZ"], "p-xyz": "XYZ"})

    assert [(row.team_id, row.key) for row in found] == [("p-xyz", "XYZ-3")]


@pytest.mark.parametrize(
    ("action", "state", "merged", "draft", "expected"),
    [
        ("edited", "open", False, False, "pr_opened"),
        ("edited", "open", False, True, None),
        ("edited", "closed", False, False, None),
        ("edited", "closed", True, False, None),
        ("synchronize", "open", False, False, None),
    ],
)
def test_a_new_link_on_edit_fires_the_opening_trigger_only_while_open(
    action: str,
    state: str,
    merged: bool,
    draft: bool,
    expected: str | None,
) -> None:
    """A key typed into an open pull request starts the issue, anything else moves nothing."""
    assert linking.trigger_for_new_link(action, state=state, merged=merged, draft=draft) == expected


class _Rule:
    """A stand-in transition rule, with just what `select_rule` reads."""

    def __init__(self, trigger: str, status_id: str, branch_pattern: str | None = None) -> None:
        self.trigger = trigger
        self.status_id = status_id
        self.branch_pattern = branch_pattern


def test_a_branch_pattern_is_normalized() -> None:
    """Whitespace and a leading `refs/heads/` are dropped, and nothing reads as any branch."""
    assert linking.normalize_branch_pattern("  refs/heads/main ") == "main"
    assert linking.normalize_branch_pattern(None) == ""
    assert linking.normalize_branch_pattern("release/*") == "release/*"


@pytest.mark.parametrize("pattern", ["has space", "a~b", "a^b", "a:b", "a\\b", "x" * 256])
def test_a_pattern_no_branch_could_match_is_refused(pattern: str) -> None:
    """Characters git refuses in a ref name, and an absurd length, raise."""
    with pytest.raises(ValueError):
        linking.normalize_branch_pattern(pattern)


def test_an_exact_branch_beats_a_glob_which_beats_any_branch() -> None:
    """The most specific matching rule is chosen, whatever order the rules come in."""
    rules = [
        _Rule("pr_merged", "any"),
        _Rule("pr_merged", "star", "*"),
        _Rule("pr_merged", "ma-star", "ma*"),
        _Rule("pr_merged", "main", "main"),
        _Rule("pr_opened", "opened"),
    ]
    assert linking.select_rule(rules, "pr_merged", "main").status_id == "main"
    assert linking.select_rule(rules, "pr_merged", "master").status_id == "ma-star"
    assert linking.select_rule(rules, "pr_merged", "staging").status_id == "star"
    assert linking.select_rule(rules[:1], "pr_merged", "staging").status_id == "any"
    assert linking.select_rule(rules, "pr_ready_for_review", "main") is None


def test_only_branch_rules_move_nothing_on_an_unnamed_branch() -> None:
    """A trigger with branch rules and no catch-all fires nothing into another branch."""
    rules = [_Rule("pr_merged", "staged", "staging"), _Rule("pr_merged", "done", "main")]
    assert linking.select_rule(rules, "pr_merged", "feature/x") is None
    assert linking.select_rule(rules, "pr_merged", "") is None


def test_branch_matching_is_case_sensitive_like_git() -> None:
    """`Main` and `main` are different branches."""
    assert linking.branch_matches("main", "main")
    assert not linking.branch_matches("main", "Main")
    assert linking.branch_matches("release/*", "release/2026.09")


def _status(status_id: str, category: str, position: int) -> Any:
    """A stand-in status carrying only what the forward check reads."""
    return SimpleNamespace(status_id=status_id, category=category, position=position)


IN_PROGRESS = _status("s-progress", "started", 2)
IN_REVIEW = _status("s-review", "started", 30)
ON_STAGING = _status("s-staging", "started", 31)
DONE = _status("s-done", "completed", 3)
CANCELLED = _status("s-cancelled", "cancelled", 4)
BACKLOG = _status("s-backlog", "backlog", 0)


@pytest.mark.parametrize(
    ("current", "target", "expected"),
    [
        (BACKLOG, IN_PROGRESS, True),
        (IN_PROGRESS, IN_REVIEW, True),
        (IN_REVIEW, ON_STAGING, True),
        (ON_STAGING, DONE, True),
        (ON_STAGING, IN_REVIEW, False),
        (DONE, IN_REVIEW, False),
        (DONE, ON_STAGING, False),
        (CANCELLED, DONE, False),
        (DONE, CANCELLED, False),
        (None, DONE, True),
        (DONE, None, True),
    ],
)
def test_moves_forward_orders_by_category_then_position(current: Any, target: Any, expected: bool) -> None:
    """A later category is forward, and a later position within one category is too."""
    assert linking.moves_forward(current, target) is expected


def test_a_closed_pull_request_is_not_forward_only() -> None:
    """Abandoning a pull request may send its issues back, so only open, ready and merge are held."""
    assert linking.FORWARD_ONLY_TRIGGERS == frozenset({"pr_opened", "pr_ready_for_review", "pr_merged"})


@pytest.mark.parametrize(
    ("message", "number"),
    [
        ("ABC-1 Add a thing (#474)", 474),
        ("ABC-1 Add a thing (#474)\n\nRefs ABC-1", 474),
        ("Merge pull request #12 from WebbPulse/abc-1-work\n\nABC-1 work", 12),
        ("ABC-1 Add a thing", None),
        ("Mentions (#5) in the middle of a title", None),
        ("", None),
    ],
)
def test_a_commit_names_the_pull_request_it_came_from(message: str, number: int | None) -> None:
    """A squash title's trailing `(#N)` and a merge commit's `#N` lead back to the pull request."""
    assert linking.cited_pull_number(message) == number


@pytest.mark.parametrize(
    ("magic_word", "moves_status", "holds_on_merge", "closes"),
    [
        ("fixes", True, True, True),
        (None, True, False, True),
        (None, True, True, False),
        (None, False, False, False),
        (None, True, None, None),
    ],
)
def test_a_merged_link_says_whether_it_closed_its_issue(
    magic_word: str | None, moves_status: bool, holds_on_merge: bool | None, closes: bool | None
) -> None:
    """A closing word closes, a held key does not, and a row from before the hold cannot say."""
    link = SimpleNamespace(magic_word=magic_word, moves_status=moves_status, holds_on_merge=holds_on_merge)

    assert linking.link_closes(link) == closes


def test_a_key_only_in_a_commit_body_links_without_moving() -> None:
    """A commit body that names a key in prose is a mention, so a merge never moves that issue."""
    found = {
        row.key: row
        for row in linking.extract(
            PREFIXES, commit_messages=["ABC-2: Cap entries at 120\n\nThe API lowered it in ABC-1 so it fits."]
        )
    }

    assert found["ABC-2"].moves_status is True
    assert found["ABC-1"].moves_status is False
    assert found["ABC-1"].magic_word is None


def test_a_closing_word_in_a_commit_body_still_moves() -> None:
    """A commit body that says `Fixes` is not a bare mention, so its key moves."""
    found = linking.extract(PREFIXES, commit_messages=["Fix the thing\n\nFixes ABC-1"])

    assert found[0].moves_status is True
    assert found[0].magic_word is None


def test_a_merge_commit_title_line_moves() -> None:
    """A merge commit carries the pull request's title on its second line, which moves like a squash title."""
    found = linking.extract(
        PREFIXES, commit_messages=["Merge pull request #12 from acme/work\n\nABC-1 a change\n\nSee ABC-2."]
    )

    assert {row.key: row.moves_status for row in found} == {"ABC-1": True, "ABC-2": False}


def test_a_commit_subject_splits_at_the_first_line() -> None:
    """A squash subject is its first line, and a merge commit's subject keeps the title after it."""
    assert linking.commit_subject("A (#1)\n\nbody") == ("A (#1)", "\nbody")
    assert linking.commit_subject("Merge pull request #2 from a/b\n\nTitle\n\nbody") == (
        "Merge pull request #2 from a/b\nTitle",
        "\nbody",
    )
    assert linking.commit_subject("") == ("", "")


def test_moving_commit_keys_skip_a_key_only_a_commit_body_mentions() -> None:
    """Release automation reads the same rule as a merge: subjects and closing words count, prose does not."""
    found = moving_commit_keys(
        [
            "ABC-2: Cap entries (#4)\n\nThe API lowered it in ABC-1 so it fits.",
            "Merge pull request #5 from acme/work\n\nABC-3 a change\n\nSee ABC-4.",
            "Tidy\n\nFixes ABC-5 and refs ABC-6",
        ],
        PREFIXES,
    )

    assert [row.key for row in found] == ["ABC-2", "ABC-3", "ABC-5", "ABC-6"]
