"""The reaction routes: read one target's groups, add one, take one back.

Both writes are idempotent by key, so the tests that matter are the second tap and
the removal of something that was never there: a route that answered a conflict to
either would make a client reconcile state it cannot see.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.domains.discussion.schemas.discussion import REACTION_EMOJI, is_single_emoji
from scripts.export_reactions import REACTIONS_JSON, rendered
from tests.domains.helpers import ADMIN, MEMBER, sign_in

THUMBS_UP = "\N{THUMBS UP SIGN}"

ROCKET = "\N{ROCKET}"

HEART = "\N{HEAVY BLACK HEART}"

HEART_WITH_SELECTOR = HEART + "\N{VARIATION SELECTOR-16}"


def add(client: TestClient, workspace: str, **payload: Any) -> "dict[str, Any]":
    """React through the route, failing loudly on a refusal."""
    response = client.put(f"/api/workspaces/{workspace}/reactions", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def a_comment(client: TestClient, workspace: str, issue_id: str) -> str:
    """One comment to react to, created through the comment route."""
    response = client.post(
        f"/api/workspaces/{workspace}/issues/{issue_id}/comments",
        json={"body": "A comment"},
    )
    assert response.status_code == 201, response.text
    return response.json()["comment_id"]


def test_the_quick_picks_are_twenty_four_distinct_emoji() -> None:
    """Twenty four distinct quick picks, each one a single emoji the route accepts."""
    assert len(REACTION_EMOJI) == 24
    assert len(set(REACTION_EMOJI)) == 24
    assert all(is_single_emoji(emoji) for emoji in REACTION_EMOJI)


def test_the_exported_json_matches_the_backend_list() -> None:
    """The checked-in picker set is what the backend would write today.

    This is the whole point of generating it: the frontend imported its own copy
    and the two drifted to nine disagreements before anyone noticed. Run
    `uv run python -m scripts.export_reactions` when this fails.
    """
    assert REACTIONS_JSON.read_text(encoding="utf-8") == rendered()


def test_either_presentation_of_the_same_emoji_is_one_reaction(client: TestClient, workspace: str, issue: Any) -> None:
    """A trailing variation selector is stripped, so the picker's form is accepted.

    Two of the allow list's entries differ from each other by nothing else, which
    is why the raw comparison refused exactly the form the picker sends.
    """
    sign_in(client, MEMBER)
    add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=HEART_WITH_SELECTOR)
    group = add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=HEART)

    assert group["emoji"] == HEART
    assert group["count"] == 1

    removed = client.delete(
        f"/api/workspaces/{workspace}/reactions",
        params={"target_id": issue.issue_id, "target_kind": "issue", "emoji": HEART_WITH_SELECTOR},
    )
    assert removed.status_code == 204
    listed = client.get(
        f"/api/workspaces/{workspace}/reactions",
        params={"target_id": issue.issue_id, "target_kind": "issue"},
    )
    assert listed.json()["reactions"] == []


SINGLE_EMOJI = [
    pytest.param("\N{PILE OF POO}", id="outside-quick-picks"),
    pytest.param("\N{THUMBS UP SIGN}\N{EMOJI MODIFIER FITZPATRICK TYPE-4}", id="skin-tone"),
    pytest.param("\N{WAVING WHITE FLAG}\N{VARIATION SELECTOR-16}\N{ZERO WIDTH JOINER}\N{RAINBOW}", id="zwj-flag"),
    pytest.param(
        "\N{WOMAN}\N{ZERO WIDTH JOINER}\N{WOMAN}\N{ZERO WIDTH JOINER}\N{GIRL}\N{ZERO WIDTH JOINER}\N{BOY}",
        id="zwj-family",
    ),
    pytest.param(
        "\N{WOMAN}\N{EMOJI MODIFIER FITZPATRICK TYPE-4}\N{ZERO WIDTH JOINER}\N{HEAVY BLACK HEART}"
        "\N{VARIATION SELECTOR-16}\N{ZERO WIDTH JOINER}\N{KISS MARK}\N{ZERO WIDTH JOINER}"
        "\N{MAN}\N{EMOJI MODIFIER FITZPATRICK TYPE-6}",
        id="longest-sequence",
    ),
    pytest.param("\N{REGIONAL INDICATOR SYMBOL LETTER U}\N{REGIONAL INDICATOR SYMBOL LETTER S}", id="country-flag"),
    pytest.param("\U0001f3f4\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f", id="subdivision-flag"),
    pytest.param("1\N{VARIATION SELECTOR-16}\N{COMBINING ENCLOSING KEYCAP}", id="keycap"),
    pytest.param("\N{MELTING FACE}", id="recent-emoji"),
]
"""Single emoji of every shape Unicode builds one from, none of them a quick pick."""

NOT_ONE_EMOJI = [
    pytest.param("a", id="letter"),
    pytest.param("ok", id="word"),
    pytest.param("1", id="digit"),
    pytest.param("\N{THUMBS UP SIGN}\N{THUMBS UP SIGN}", id="two-emoji"),
    pytest.param("\N{THUMBS UP SIGN}\N{ROCKET}", id="two-different-emoji"),
    pytest.param("\N{THUMBS UP SIGN}a", id="emoji-and-text"),
    pytest.param("\N{REGIONAL INDICATOR SYMBOL LETTER U}", id="lone-regional-indicator"),
    pytest.param("\N{ZERO WIDTH JOINER}", id="lone-joiner"),
    pytest.param("\N{EMOJI MODIFIER FITZPATRICK TYPE-4}\N{THUMBS UP SIGN}", id="modifier-first"),
]
"""Values that are text, part of an emoji, or more than one emoji."""


@pytest.mark.parametrize("emoji", SINGLE_EMOJI)
def test_any_single_emoji_is_a_reaction(client: TestClient, workspace: str, issue: Any, emoji: str) -> None:
    """Skin tones, flags, keycaps and joined sequences are each one reaction."""
    sign_in(client, MEMBER)
    group = add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=emoji)
    assert group["count"] == 1
    assert group["emoji"] == emoji.replace("\N{VARIATION SELECTOR-16}", "")


@pytest.mark.parametrize("emoji", NOT_ONE_EMOJI)
def test_a_value_that_is_not_one_emoji_is_refused(client: TestClient, workspace: str, issue: Any, emoji: str) -> None:
    """Text and runs of emoji would let one caller mint arbitrary sort keys."""
    sign_in(client, MEMBER)
    response = client.put(
        f"/api/workspaces/{workspace}/reactions",
        json={"target_id": issue.issue_id, "target_kind": "issue", "emoji": emoji},
    )
    assert response.status_code == 422, response.text


def test_a_member_reacts_to_an_issue(client: TestClient, workspace: str, issue: Any) -> None:
    """The PUT answers with that emoji's group, counting the caller."""
    sign_in(client, MEMBER)
    group = add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=THUMBS_UP)

    assert group["emoji"] == THUMBS_UP
    assert group["count"] == 1
    assert group["user_ids"] == [MEMBER]
    assert group["reacted"] is True


def test_reacting_twice_is_the_same_single_reaction(client: TestClient, workspace: str, issue: Any) -> None:
    """The row is keyed by emoji and user, so a retry is not a second count."""
    sign_in(client, MEMBER)
    add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=THUMBS_UP)
    group = add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=THUMBS_UP)

    assert group["count"] == 1


def test_only_the_changed_group_comes_back(client: TestClient, workspace: str, issue: Any) -> None:
    """The PUT answers with one group, because the rest are already on screen."""
    sign_in(client, MEMBER)
    add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=THUMBS_UP)
    group = add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=ROCKET)

    assert group["emoji"] == ROCKET
    assert group["count"] == 1


def test_two_members_share_one_group(client: TestClient, workspace: str, issue: Any) -> None:
    """A group counts everyone, and `reacted` is resolved per reader."""
    sign_in(client, MEMBER)
    add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=THUMBS_UP)
    sign_in(client, ADMIN)
    group = add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=THUMBS_UP)

    assert group["count"] == 2
    assert sorted(group["user_ids"]) == sorted([MEMBER, ADMIN])
    assert group["reacted"] is True


def test_reacted_is_false_for_a_reader_who_did_not(client: TestClient, workspace: str, issue: Any) -> None:
    """`reacted` names the caller, not whoever wrote the row."""
    sign_in(client, MEMBER)
    add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=THUMBS_UP)

    sign_in(client, ADMIN)
    response = client.get(
        f"/api/workspaces/{workspace}/reactions",
        params={"target_id": issue.issue_id, "target_kind": "issue"},
    )
    assert response.status_code == 200, response.text
    group = response.json()["reactions"][0]
    assert group["count"] == 1
    assert group["reacted"] is False


def test_a_comment_is_a_reaction_target(client: TestClient, workspace: str, issue: Any) -> None:
    """A comment target carries its issue, because that is its partition."""
    sign_in(client, MEMBER)
    comment_id = a_comment(client, workspace, issue.issue_id)

    group = add(
        client,
        workspace,
        target_id=comment_id,
        target_kind="comment",
        emoji=THUMBS_UP,
        issue_id=issue.issue_id,
    )
    assert group["count"] == 1


def test_a_comment_target_without_its_issue_is_refused(client: TestClient, workspace: str, issue: Any) -> None:
    """No `issue_id` means no partition to read, so the target is simply unknown."""
    sign_in(client, MEMBER)
    comment_id = a_comment(client, workspace, issue.issue_id)

    response = client.put(
        f"/api/workspaces/{workspace}/reactions",
        json={"target_id": comment_id, "target_kind": "comment", "emoji": THUMBS_UP},
    )
    assert response.status_code == 404, response.text


def test_a_comment_reaction_round_trips_with_its_issue(client: TestClient, workspace: str, issue: Any) -> None:
    """Add, list and remove on a comment each carry `issue_id`, and each works.

    What the issue page's comment reactions send; without the id every one of the
    three is a 404, which is how comment reactions broke.
    """
    sign_in(client, MEMBER)
    comment_id = a_comment(client, workspace, issue.issue_id)
    target = {"target_id": comment_id, "target_kind": "comment"}

    add(client, workspace, **target, emoji=HEART_WITH_SELECTOR, issue_id=issue.issue_id)
    listed = client.get(f"/api/workspaces/{workspace}/reactions", params={**target, "issue_id": issue.issue_id})
    assert listed.status_code == 200, listed.text
    assert [group["emoji"] for group in listed.json()["reactions"]] == [HEART]

    missing = client.delete(f"/api/workspaces/{workspace}/reactions", params={**target, "emoji": HEART})
    assert missing.status_code == 404, missing.text

    removed = client.delete(
        f"/api/workspaces/{workspace}/reactions",
        params={**target, "emoji": HEART_WITH_SELECTOR, "issue_id": issue.issue_id},
    )
    assert removed.status_code == 204, removed.text
    listed = client.get(f"/api/workspaces/{workspace}/reactions", params={**target, "issue_id": issue.issue_id})
    assert listed.json()["reactions"] == []


def test_a_comment_paired_with_the_wrong_issue_is_refused(
    client: TestClient, repositories: Any, workspace: str, issue: Any
) -> None:
    """A comment id is held against the issue it was really written on.

    Otherwise a caller could pair a comment from a team they cannot see with an
    issue they can, and react across the boundary.
    """
    from tests.domains.discussion.conftest import TEAM, seed_issue

    other = seed_issue(repositories, workspace, TEAM, "01JB0000000000000000000IS9", 9)
    sign_in(client, MEMBER)
    comment_id = a_comment(client, workspace, issue.issue_id)

    response = client.put(
        f"/api/workspaces/{workspace}/reactions",
        json={
            "target_id": comment_id,
            "target_kind": "comment",
            "emoji": THUMBS_UP,
            "issue_id": other.issue_id,
        },
    )
    assert response.status_code == 404, response.text


def test_a_long_string_is_refused_as_an_emoji(client: TestClient, workspace: str, issue: Any) -> None:
    """An over-long value is malformed before the emoji table is consulted."""
    sign_in(client, MEMBER)
    response = client.put(
        f"/api/workspaces/{workspace}/reactions",
        json={"target_id": issue.issue_id, "target_kind": "issue", "emoji": THUMBS_UP * 20},
    )
    assert response.status_code == 422, response.text


def test_an_unknown_target_kind_is_refused(client: TestClient, workspace: str, issue: Any) -> None:
    """The kind is a closed set, so a third kind never reaches a repository."""
    sign_in(client, MEMBER)
    response = client.put(
        f"/api/workspaces/{workspace}/reactions",
        json={"target_id": issue.issue_id, "target_kind": "team", "emoji": THUMBS_UP},
    )
    assert response.status_code == 422, response.text


def test_a_member_takes_their_own_reaction_back(client: TestClient, workspace: str, issue: Any) -> None:
    """The delete removes the caller's row and the group goes with it."""
    sign_in(client, MEMBER)
    add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=THUMBS_UP)

    response = client.delete(
        f"/api/workspaces/{workspace}/reactions",
        params={"target_id": issue.issue_id, "target_kind": "issue", "emoji": THUMBS_UP},
    )
    assert response.status_code == 204, response.text

    listed = client.get(
        f"/api/workspaces/{workspace}/reactions",
        params={"target_id": issue.issue_id, "target_kind": "issue"},
    ).json()
    assert listed["reactions"] == []


def test_removing_a_reaction_that_is_not_there_is_still_204(client: TestClient, workspace: str, issue: Any) -> None:
    """The caller's intent is already satisfied, so there is nothing to report."""
    sign_in(client, MEMBER)
    response = client.delete(
        f"/api/workspaces/{workspace}/reactions",
        params={"target_id": issue.issue_id, "target_kind": "issue", "emoji": THUMBS_UP},
    )
    assert response.status_code == 204, response.text


def test_a_delete_touches_only_the_caller_s_row(client: TestClient, workspace: str, issue: Any) -> None:
    """The key names the reacting user, so nobody removes another's reaction."""
    sign_in(client, MEMBER)
    add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=THUMBS_UP)
    sign_in(client, ADMIN)
    add(client, workspace, target_id=issue.issue_id, target_kind="issue", emoji=THUMBS_UP)

    response = client.delete(
        f"/api/workspaces/{workspace}/reactions",
        params={"target_id": issue.issue_id, "target_kind": "issue", "emoji": THUMBS_UP},
    )
    assert response.status_code == 204, response.text

    sign_in(client, MEMBER)
    listed = client.get(
        f"/api/workspaces/{workspace}/reactions",
        params={"target_id": issue.issue_id, "target_kind": "issue"},
    ).json()
    assert listed["reactions"][0]["count"] == 1
    assert listed["reactions"][0]["user_ids"] == [MEMBER]


def test_a_comment_carries_its_reactions_into_the_thread(client: TestClient, workspace: str, issue: Any) -> None:
    """The thread read joins reactions, so rendering one costs no extra call."""
    sign_in(client, MEMBER)
    comment_id = a_comment(client, workspace, issue.issue_id)
    add(
        client,
        workspace,
        target_id=comment_id,
        target_kind="comment",
        emoji=ROCKET,
        issue_id=issue.issue_id,
    )

    rows = client.get(f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments").json()["comments"]
    assert rows[0]["reactions"][0]["emoji"] == ROCKET
    assert rows[0]["reactions"][0]["count"] == 1
